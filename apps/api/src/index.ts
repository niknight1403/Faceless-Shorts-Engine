import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createSessionToken, hashSessionToken, SESSION_TTL_MS, verifyPassword } from "./auth.js";
import { readJsonBody } from "./http-body.js";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { PrismaClient, JobStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const port = Number(process.env.API_PORT ?? 4000);
const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const prisma = new PrismaClient();
const queue = new Queue("video-generation", { connection });
const mediaStoragePath = process.env.MEDIA_STORAGE_DIR ?? "";
if (!isAbsolute(mediaStoragePath)) throw new Error("MEDIA_STORAGE_DIR_must_be_an_absolute_shared_path");
const mediaRoot = resolve(mediaStoragePath);
const assetSigningSecret = process.env.ASSET_SIGNING_SECRET ?? "";
const apiAccessToken = process.env.API_ACCESS_TOKEN ?? "";
const downloadUrlTtlSeconds = 15 * 60;

type CreateJobBody = { projectId?: string; topic?: string; language?: string; targetDurationSeconds?: number; targetPlatforms?: string[]; idempotencyKey?: string };
type AssetRecord = { id: string; storageKey: string; mimeType: string; sizeBytes: bigint | null };
function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body));
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(req: import("node:http").IncomingMessage): boolean {
  const supplied = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  return Boolean(apiAccessToken) && safeEqual(supplied, apiAccessToken);
}
function assetSignature(assetId: string, expires: number): string {
  return createHmac("sha256", assetSigningSecret).update(assetId + ":" + expires).digest("hex");
}
function assetDownloadUrl(asset: AssetRecord): string | null {
  if (assetSigningSecret.length < 32) return null;
  const expires = Math.floor(Date.now() / 1000) + downloadUrlTtlSeconds;
  const signature = assetSignature(asset.id, expires);
  return "/v1/assets/" + encodeURIComponent(asset.id) + "?expires=" + expires + "&signature=" + signature;
}
async function readBody<T = CreateJobBody>(req: import("node:http").IncomingMessage): Promise<T> {
  return readJsonBody<T>(req);
}
type AuthenticatedSession = { id: string; userId: string; expiresAt: Date; user: { id: string; email: string; name: string | null; memberships: Array<{ organizationId: string; role: string; organization: { id: string; name: string; slug: string } }> } };
async function authenticate(req: import("node:http").IncomingMessage): Promise<AuthenticatedSession | null> {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(token) }, include: { user: { include: { memberships: { include: { organization: true } } } } } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  return session as AuthenticatedSession;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/auth/login") {
      const body = await readBody<{ email?: string; password?: string }>(req);
      const email = body.email?.trim().toLowerCase() ?? "";
      const password = body.password ?? "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 1024) { json(res, 400, { error: "email_and_password_required" }); return; }
      const now = Date.now();
      const throttleKey = "faceless:auth:login:" + createHash("sha256").update((req.socket.remoteAddress ?? "unknown") + ":" + email).digest("hex");
      const attempts = await connection.get(throttleKey);
      if (Number(attempts ?? 0) >= 10) { json(res, 429, { error: "too_many_login_attempts" }); return; }
      const user = await prisma.user.findUnique({ where: { email }, include: { memberships: { include: { organization: true } } } });
      const valid = await verifyPassword(password, user?.passwordHash ?? null);
      if (!user || !valid) {
        const count = await connection.incr(throttleKey);
        if (count === 1) await connection.expire(throttleKey, 15 * 60);
        json(res, 401, { error: "invalid_credentials" }); return;
      }
      await connection.del(throttleKey);
      const token = createSessionToken(), expiresAt = new Date(now + SESSION_TTL_MS);
      await prisma.session.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt } });
      json(res, 200, { accessToken: token, tokenType: "Bearer", expiresAt: expiresAt.toISOString(), user: { id: user.id, email: user.email, name: user.name }, organizations: user.memberships.map(m => ({ id: m.organization.id, name: m.organization.name, slug: m.organization.slug, role: m.role })) }); return;
    }
    if (req.method === "GET" && url.pathname === "/v1/auth/me") {
      const session = await authenticate(req);
      if (!session) { json(res, 401, { error: "unauthorized" }); return; }
      json(res, 200, { user: { id: session.user.id, email: session.user.email, name: session.user.name }, organizations: session.user.memberships.map(m => ({ id: m.organization.id, name: m.organization.name, slug: m.organization.slug, role: m.role })), expiresAt: session.expiresAt.toISOString() }); return;
    }
    if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
      const session = await authenticate(req);
      if (!session) { json(res, 401, { error: "unauthorized" }); return; }
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      json(res, 200, { status: "signed_out" }); return;
    }
    if (req.method === "GET" && url.pathname === "/v1/admin/overview") {
      const session = await authenticate(req);
      if (!session) { json(res, 401, { error: "unauthorized" }); return; }
      const organizationId = req.headers["x-organization-id"];
      if (typeof organizationId !== "string" || !organizationId) { json(res, 400, { error: "x-organization-id_required" }); return; }
      const membership = session.user.memberships.find(m => m.organizationId === organizationId);
      if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) { json(res, 403, { error: "admin_role_required" }); return; }
      const [projectCount, jobCount, completedCount, failedCount] = await Promise.all([
        prisma.project.count({ where: { organizationId } }),
        prisma.videoJob.count({ where: { project: { organizationId } } }),
        prisma.videoJob.count({ where: { project: { organizationId }, status: JobStatus.COMPLETED } }),
        prisma.videoJob.count({ where: { project: { organizationId }, status: JobStatus.FAILED } })
      ]);
      json(res, 200, { organizationId, role: membership.role, counts: { projects: projectCount, jobs: jobCount, completedJobs: completedCount, failedJobs: failedCount } }); return;
    }
    if (req.method === "GET" && url.pathname === "/v1/projects") {
      const session = await authenticate(req);
      if (!session) { json(res, 401, { error: "unauthorized" }); return; }
      const organizationIds = session.user.memberships.map(m => m.organizationId);
      const projects = organizationIds.length ? await prisma.project.findMany({
        where: { organizationId: { in: organizationIds } },
        orderBy: { updatedAt: "desc" },
        include: { jobs: { orderBy: { createdAt: "desc" }, take: 12, select: {
          id: true, topic: true, language: true, status: true, progress: true,
          errorCode: true, errorMessage: true, createdAt: true, updatedAt: true,
          assets: { select: { id: true, kind: true, mimeType: true, sizeBytes: true, storageKey: true } }
        } } }
      }) : [];
      json(res, 200, { projects: projects.map(project => ({
        id: project.id, name: project.name, description: project.description,
        organizationId: project.organizationId, createdAt: project.createdAt,
        jobs: project.jobs.map(job => ({ ...job, assets: job.assets.map(asset => ({
          id: asset.id, kind: asset.kind, mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes?.toString() ?? null, downloadUrl: assetDownloadUrl(asset)
        })) }))
      })) }); return;
    }
    if (req.method === "POST" && url.pathname === "/v1/projects") {
      const session = await authenticate(req);
      if (!session) { json(res, 401, { error: "unauthorized" }); return; }
      const body = await readBody<{ organizationId?: string; name?: string; description?: string }>(req);
      const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (!organizationId || name.length < 2 || name.length > 80 ||
          (body.description !== undefined && typeof body.description !== "string") || description.length > 500) {
        json(res, 400, { error: "organizationId_and_valid_project_name_required" }); return;
      }
      const membership = session.user.memberships.find(m => m.organizationId === organizationId);
      if (!membership) { json(res, 404, { error: "organization_not_found" }); return; }
      if (!["OWNER", "ADMIN", "EDITOR"].includes(membership.role)) {
        json(res, 403, { error: "project_write_access_required" }); return;
      }
      const project = await prisma.project.create({ data: {
        organizationId, name, description: description || null
      }});
      json(res, 201, { project }); return;
    }
    if (req.method === "GET" && url.pathname === "/v1/providers") {
      const [llm, tts, hub, visuals] = await Promise.all([connection.get("faceless:providers:llm"), connection.get("faceless:providers:tts"), connection.get("faceless:providers:hub"), connection.get("faceless:providers:visuals")]);
      json(res, 200, { freeOnly: true, llm: llm ? JSON.parse(llm) : [], tts: tts ? JSON.parse(tts) : [], visuals: visuals ? JSON.parse(visuals) : [], agentforgeHub: hub ? JSON.parse(hub) : null }); return;
    }
    if (req.method === "GET" && url.pathname === "/health/live") { json(res, 200, { status: "ok", service: "faceless-api" }); return; }
    if (req.method === "GET" && url.pathname === "/health/ready") {
      await Promise.all([prisma.$queryRaw`SELECT 1`, connection.ping()]); json(res, 200, { status: "ready" }); return;
    }
    const isJobRoute = (req.method === "POST" && url.pathname === "/v1/video-jobs") ||
      (req.method === "GET" && url.pathname.startsWith("/v1/video-jobs/") && /^[a-zA-Z0-9_-]+$/.test(url.pathname.slice("/v1/video-jobs/".length)));
    const serviceAuthorized = isJobRoute && authorized(req);
    const jobSession = isJobRoute && !serviceAuthorized ? await authenticate(req) : null;
    if (isJobRoute && !serviceAuthorized && !jobSession) {
      json(res, apiAccessToken ? 401 : 503, { error: apiAccessToken ? "unauthorized" : "API_ACCESS_TOKEN_not_configured_or_session_required" }); return;
    }
    if (req.method === "POST" && url.pathname === "/v1/video-jobs") {
      const body = await readBody(req);
      if (typeof body.projectId !== "string" || !body.projectId.trim() ||
          typeof body.topic !== "string" || !body.topic.trim() || body.topic.trim().length > 500) {
        json(res, 400, { error: "projectId_and_topic_required_topic_max_500_chars" }); return;
      }
      const duration = body.targetDurationSeconds ?? 45;
      if (!Number.isInteger(duration) || duration < 10 || duration > 180) { json(res, 400, { error: "targetDurationSeconds_must_be_10_to_180" }); return; }
      const language = body.language ?? "de";
      if (typeof language !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) {
        json(res, 400, { error: "language_must_be_a_valid_language_tag" }); return;
      }
      const allowedPlatforms = new Set(["youtube_shorts", "tiktok", "instagram"]);
      const platforms = body.targetPlatforms ?? ["youtube_shorts"];
      if (!Array.isArray(platforms) || !platforms.length || platforms.length > 3 ||
          platforms.some(p => typeof p !== "string" || !allowedPlatforms.has(p)) ||
          new Set(platforms).size !== platforms.length) {
        json(res, 400, { error: "targetPlatforms_must_be_unique_supported_platforms" }); return;
      }
      if (body.idempotencyKey !== undefined &&
          (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.idempotencyKey))) {
        json(res, 400, { error: "idempotencyKey_must_be_8_to_128_safe_characters" }); return;
      }
      const project = await prisma.project.findUnique({ where: { id: body.projectId } });
      if (!project) { json(res, 404, { error: "project_not_found" }); return; }
      if (jobSession) {
        const membership = jobSession.user.memberships.find(m => m.organizationId === project.organizationId);
        if (!membership) { json(res, 404, { error: "project_not_found" }); return; }
        if (!["OWNER", "ADMIN", "EDITOR"].includes(membership.role)) { json(res, 403, { error: "project_write_access_required" }); return; }
      }
      if (body.idempotencyKey) {
        const existing = await prisma.videoJob.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
        if (existing) {
          if (existing.projectId !== project.id) { json(res, 409, { error: "idempotency_key_conflict" }); return; }
          json(res, 200, existing); return;
        }
      }
      let job: Awaited<ReturnType<typeof prisma.videoJob.create>>;
      try {
        job = await prisma.videoJob.create({ data: {
          projectId: body.projectId, topic: body.topic.trim(), language,
          targetDurationSeconds: duration, targetPlatforms: platforms, status: JobStatus.QUEUED,
          idempotencyKey: body.idempotencyKey
        }});
      } catch (error) {
        // Concurrent requests can both pass the initial lookup. Resolve the
        // unique-key race as an idempotent replay instead of returning 500.
        if (body.idempotencyKey && typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
          const existing = await prisma.videoJob.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
          if (existing) {
            if (existing.projectId !== project.id) { json(res, 409, { error: "idempotency_key_conflict" }); return; }
            json(res, 200, existing); return;
          }
        }
        throw error;
      }
      try {
        await queue.add("generate-video", { videoJobId: job.id }, { jobId: job.id, attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 });
      } catch (error) {
        await prisma.videoJob.update({ where: { id: job.id }, data: { status: JobStatus.FAILED, errorCode: "QUEUE_ENQUEUE_FAILED", errorMessage: error instanceof Error ? error.message : "Queue unavailable" } });
        throw error;
      }
      json(res, 201, job); return;
    }
    const jobMatch = url.pathname.match(/^\/v1\/video-jobs\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = await prisma.videoJob.findUnique({ where: { id: jobMatch[1] }, include: { assets: true } });
      if (!job) { json(res, 404, { error: "video_job_not_found" }); return; }
      if (jobSession) {
        const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { organizationId: true } });
        const membership = project ? jobSession.user.memberships.find(m => m.organizationId === project.organizationId) : null;
        if (!membership) { json(res, 404, { error: "video_job_not_found" }); return; }
      }
      json(res, 200, { ...job, assets: job.assets.map(asset => { const { storageKey, ...publicAsset } = asset; void storageKey; return { ...publicAsset, sizeBytes: asset.sizeBytes?.toString() ?? null, downloadUrl: assetDownloadUrl(asset) }; }) }); return;
    }
    const assetMatch = url.pathname.match(/^\/v1\/assets\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "GET" && assetMatch) {
      if (assetSigningSecret.length < 32) { json(res, 503, { error: "ASSET_SIGNING_SECRET_not_configured" }); return; }
      const expires = Number(url.searchParams.get("expires"));
      const signature = url.searchParams.get("signature") ?? "";
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(expires) || expires <= now || expires > now + downloadUrlTtlSeconds || !safeEqual(signature, assetSignature(assetMatch[1]!, expires))) {
        json(res, 403, { error: "asset_link_invalid_or_expired" }); return;
      }
      const asset = await prisma.asset.findUnique({ where: { id: assetMatch[1] } });
      if (!asset) { json(res, 404, { error: "asset_not_found" }); return; }
      const candidatePath = resolve(mediaRoot, asset.storageKey);
      const relativeCandidate = relative(mediaRoot, candidatePath);
      if (!relativeCandidate || relativeCandidate === ".." || relativeCandidate.startsWith(".." + sep) || isAbsolute(relativeCandidate)) {
        json(res, 404, { error: "asset_not_found" }); return;
      }
      let filePath: string, fileInfo;
      try {
        const [actualRoot, actualFile] = await Promise.all([realpath(mediaRoot), realpath(candidatePath)]);
        const relativeActual = relative(actualRoot, actualFile);
        if (!relativeActual || relativeActual === ".." || relativeActual.startsWith(".." + sep) || isAbsolute(relativeActual)) {
          json(res, 404, { error: "asset_not_found" }); return;
        }
        filePath = actualFile;
        fileInfo = await stat(actualFile);
      } catch { json(res, 404, { error: "asset_file_missing" }); return; }
      if (!fileInfo.isFile()) { json(res, 404, { error: "asset_file_missing" }); return; }
      const range = req.headers.range;
      const rangeMatch = range?.match(/^bytes=(\d*)-(\d*)$/);
      let start = 0, end = fileInfo.size - 1, status = 200;
      if (range && !rangeMatch) { res.writeHead(416, { "content-range": "bytes */" + fileInfo.size }); res.end(); return; }
      if (rangeMatch) {
        start = rangeMatch[1] ? Number(rangeMatch[1]) : Math.max(0, fileInfo.size - Number(rangeMatch[2] || 0));
        end = rangeMatch[2] ? Number(rangeMatch[2]) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileInfo.size) {
          res.writeHead(416, { "content-range": "bytes */" + fileInfo.size }); res.end(); return;
        }
        end = Math.min(end, fileInfo.size - 1); status = 206;
      }
      const headers: Record<string, string | number> = {
        "content-type": asset.mimeType, "content-length": end - start + 1,
        "content-disposition": "attachment; filename=\"" + basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_") + "\"",
        "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff"
      };
      if (status === 206) headers["content-range"] = "bytes " + start + "-" + end + "/" + fileInfo.size;
      res.writeHead(status, headers);
      const stream = createReadStream(filePath, { start, end });
      stream.on("error", error => res.destroy(error));
      stream.pipe(res); return;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    if (message === "body_too_large") { json(res, 413, { error: message }); return; }
    if (error instanceof SyntaxError) { json(res, 400, { error: "invalid_json" }); return; }
    console.error(error); if (!res.headersSent) json(res, 500, { error: "internal_error" }); else res.destroy();
  }
});
server.listen(port, "0.0.0.0", () => console.log(`faceless-api listening on :${port}`));
async function shutdown() {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  await Promise.all([queue.close(), prisma.$disconnect(), connection.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
