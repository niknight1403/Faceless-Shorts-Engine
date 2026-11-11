import { PrismaClient, JobStatus, AssetKind } from "@prisma/client";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { FreeRoutedScriptProvider } from "./routed-script-generator.js";
import { TtsRouter } from "./tts-router.js";

const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const scriptProvider = new FreeRoutedScriptProvider();
const ttsRouter = new TtsRouter();
const mediaRoot = resolve(process.env.MEDIA_STORAGE_DIR ?? "./data/media");

function chunkText(text: string, maxChars = 450): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      for (let offset = 0; offset < word.length; offset += maxChars) chunks.push(word.slice(offset, offset + maxChars));
      continue;
    }
    if (current && (current.length + word.length + 1) > maxChars) { chunks.push(current); current = word; }
    else current = current ? current + " " + word : word;
  }
  if (current) chunks.push(current);
  return chunks;
}

const worker = new Worker("video-generation", async task => {
  const { videoJobId } = task.data as { videoJobId?: string };
  if (!videoJobId) throw new Error("videoJobId_missing");
  const job = await prisma.videoJob.findUnique({ where: { id: videoJobId } });
  if (!job) throw new Error("video_job_not_found:" + videoJobId);
  if (job.status === JobStatus.CANCELLED || job.status === JobStatus.COMPLETED) return;

  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.GENERATING_SCRIPT, progress: 10, errorCode: null, errorMessage: null } });
  const script = await scriptProvider.generate({ topic: job.topic, language: job.language, targetDurationSeconds: job.targetDurationSeconds });
  console.log("script planned for " + videoJobId + ": " + script.scenes.length + " scenes via " + scriptProvider.name);
  await connection.set("faceless:providers:llm", JSON.stringify(scriptProvider.routeStatus()), "EX", 300);
  await connection.set("faceless:providers:tts", JSON.stringify(ttsRouter.availableRoutes()), "EX", 300);

  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.GENERATING_VOICE, progress: 20 } });
  const narration = script.scenes.map(scene => scene.narration).join(" ");
  const chunks = chunkText(narration);
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await ttsRouter.synthesize(chunks[index]!, job.language);
      const fileName = String(index + 1).padStart(3, "0") + "." + result.extension;
      const absolutePath = join(mediaRoot, videoJobId, fileName);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, result.audio);
      await prisma.asset.create({ data: {
        jobId: videoJobId, kind: AssetKind.AUDIO,
        storageKey: videoJobId + "/" + fileName, mimeType: result.mimeType,
        sizeBytes: BigInt(result.audio.byteLength)
      }});
      console.log("voice segment " + (index + 1) + "/" + chunks.length + " generated via " + result.provider);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "tts_generation_failed";
    await prisma.videoJob.update({ where: { id: videoJobId }, data: {
      status: JobStatus.FAILED, progress: 20, errorCode: "TTS_NO_FREE_ROUTE_AVAILABLE", errorMessage: message.slice(0, 1000)
    }});
    return;
  }

  await prisma.videoJob.update({ where: { id: videoJobId }, data: {
    status: JobStatus.FAILED, progress: 35, errorCode: "VISUAL_PROVIDER_NOT_CONFIGURED",
    errorMessage: "Script and narration audio were generated. Visual generation and final rendering are not configured yet."
  }});
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) });

worker.on("completed", task => console.log("video job task completed: " + task.id));
worker.on("failed", (task, error) => console.error("video job task failed: " + task?.id, error));
console.log("faceless video-generation worker started");
console.log("free LLM routes:", scriptProvider.routeStatus(), "free TTS routes:", ttsRouter.availableRoutes());
void Promise.all([
  connection.set("faceless:providers:llm", JSON.stringify(scriptProvider.routeStatus()), "EX", 300),
  connection.set("faceless:providers:tts", JSON.stringify(ttsRouter.availableRoutes()), "EX", 300)
]).catch(error => console.error("could not publish initial provider status", error));
async function shutdown() {
  await worker.close(); await Promise.all([prisma.$disconnect(), connection.quit()]); process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
