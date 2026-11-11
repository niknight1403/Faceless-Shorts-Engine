import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { PrismaClient, JobStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const port = Number(process.env.API_PORT ?? 4000);
const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const prisma = new PrismaClient();
const queue = new Queue("video-generation", { connection });
const mediaRoot = resolve(process.env.MEDIA_STORAGE_DIR ?? "./data/media");
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
async function readBody(req: import("node:http").IncomingMessage): Promise<CreateJobBody> {
  let raw = "";
  for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 16_384) throw new Error("body_too_large"); }
  return JSON.parse(raw || "{}") as CreateJobBody;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1/providers") {
      const [llm, tts, hub, visuals] = await Promise.all([connection.get("faceless:providers:llm"), connection.get("faceless:providers:tts"), connection.get("faceless:providers:hub"), connection.get("faceless:providers:visuals")]);
      json(res, 200, { freeOnly: true, llm: llm ? JSON.parse(llm) : [], tts: tts ? JSON.parse(tts) : [], visuals: visuals ? JSON.parse(visuals) : [], agentforgeHub: hub ? JSON.parse(hub) : null }); return;
    }
    if (req.method === "GET" && url.pathname === "/health/live") { json(res, 200, { status: "ok", service: "faceless-api" }); return; }
    if (req.method === "GET" && url.pathname === "/health/ready") {
      await Promise.all([prisma.$queryRaw`SELECT 1`, connection.ping()]); json(res, 200, { status: "ready" }); return;
    }
    if ((req.method === "POST" && url.pathname === "/v1/video-jobs") || (req.method === "GET" && /^\/v1\/video-jobs\/[a-zA-Z0-9_-]+$/.test(url.pathname))) {
      if (!apiAccessToken) { json(res, 503, { error: "API_ACCESS_TOKEN_not_configured" }); return; }
      if (!authorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
    }
    if (req.method === "POST" && url.pathname === "/v1/video-jobs") {
      const body = await readBody(req);
      if (!body.projectId || !body.topic?.trim()) { json(res, 400, { error: "projectId_and_topic_required" }); return; }
      const duration = body.targetDurationSeconds ?? 45;
      if (!Number.isInteger(duration) || duration < 10 || duration > 180) { json(res, 400, { error: "targetDurationSeconds_must_be_10_to_180" }); return; }
      const platforms = body.targetPlatforms ?? ["youtube_shorts"];
      if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => typeof p !== "string")) { json(res, 400, { error: "targetPlatforms_must_be_non_empty_strings" }); return; }
      if (body.idempotencyKey) {
        const existing = await prisma.videoJob.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
        if (existing) { json(res, 200, existing); return; }
      }
      if (!await prisma.project.findUnique({ where: { id: body.projectId } })) { json(res, 404, { error: "project_not_found" }); return; }
      const job = await prisma.videoJob.create({ data: {
        projectId: body.projectId, topic: body.topic.trim(), language: body.language ?? "de",
        targetDurationSeconds: duration, targetPlatforms: platforms, status: JobStatus.QUEUED,
        idempotencyKey: body.idempotencyKey
      }});
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
      json(res, 200, { ...job, assets: job.assets.map(asset => ({ ...asset, sizeBytes: asset.sizeBytes?.toString() ?? null, downloadUrl: assetDownloadUrl(asset) })) }); return;
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
      const filePath = resolve(mediaRoot, asset.storageKey);
      const relativePath = relative(mediaRoot, filePath);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) {
        json(res, 404, { error: "asset_not_found" }); return;
      }
      let fileInfo;
      try { fileInfo = await stat(filePath); } catch { json(res, 404, { error: "asset_file_missing" }); return; }
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
