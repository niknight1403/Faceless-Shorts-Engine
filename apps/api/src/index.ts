import { createServer } from "node:http";
import { PrismaClient, JobStatus } from "@prisma/client";
import { Queue } from "bullmq";
import Redis from "ioredis";

const port = Number(process.env.API_PORT ?? 4000);
const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const prisma = new PrismaClient();
const queue = new Queue("video-generation", { connection });

type CreateJobBody = { projectId?: string; topic?: string; language?: string; targetDurationSeconds?: number; targetPlatforms?: string[]; idempotencyKey?: string };
function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body));
}
async function readBody(req: import("node:http").IncomingMessage): Promise<CreateJobBody> {
  let raw = "";
  for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 16_384) throw new Error("body_too_large"); }
  return JSON.parse(raw || "{}") as CreateJobBody;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health/live") { json(res, 200, { status: "ok", service: "faceless-api" }); return; }
    if (req.method === "GET" && url.pathname === "/health/ready") {
      await Promise.all([prisma.$queryRaw`SELECT 1`, connection.ping()]); json(res, 200, { status: "ready" }); return;
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
    const match = url.pathname.match(/^\/v1\/video-jobs\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "GET" && match) {
      const job = await prisma.videoJob.findUnique({ where: { id: match[1] }, include: { assets: true } });
      if (!job) { json(res, 404, { error: "video_job_not_found" }); return; }
      json(res, 200, job); return;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    if (message === "body_too_large") { json(res, 413, { error: message }); return; }
    if (error instanceof SyntaxError) { json(res, 400, { error: "invalid_json" }); return; }
    console.error(error); json(res, 500, { error: "internal_error" });
  }
});
server.listen(port, "0.0.0.0", () => console.log(`faceless-api listening on :${port}`));
async function shutdown() {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all([queue.close(), prisma.$disconnect(), connection.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
