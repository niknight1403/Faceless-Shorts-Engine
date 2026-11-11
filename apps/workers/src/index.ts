import { PrismaClient, JobStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { LocalScriptProvider } from "./script-generator.js";
const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const scriptProvider = new LocalScriptProvider();
const worker = new Worker("video-generation", async task => {
  const { videoJobId } = task.data as { videoJobId?: string };
  if (!videoJobId) throw new Error("videoJobId_missing");
  const job = await prisma.videoJob.findUnique({ where: { id: videoJobId } });
  if (!job) throw new Error(`video_job_not_found:${videoJobId}`);
  if (job.status === JobStatus.CANCELLED || job.status === JobStatus.COMPLETED) return;
  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.GENERATING_SCRIPT, progress: 10, errorCode: null, errorMessage: null } });
  const script = await scriptProvider.generate({ topic: job.topic, language: job.language, targetDurationSeconds: job.targetDurationSeconds });
  console.log(`script planned for ${videoJobId}: ${script.scenes.length} scenes via ${scriptProvider.name}`);
  await prisma.videoJob.update({ where: { id: videoJobId }, data: {
    status: JobStatus.FAILED, progress: 10, errorCode: "MEDIA_PROVIDER_NOT_CONFIGURED",
    errorMessage: "Script planned locally; voice and visual generation providers are not configured yet."
  }});
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) });
worker.on("completed", task => console.log(`video job task completed: ${task.id}`));
worker.on("failed", (task, error) => console.error(`video job task failed: ${task?.id}`, error));
console.log("faceless video-generation worker started");
async function shutdown() {
  await worker.close(); await Promise.all([prisma.$disconnect(), connection.quit()]); process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
