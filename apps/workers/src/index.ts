import { PrismaClient, JobStatus, AssetKind } from "@prisma/client";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FreeRoutedScriptProvider } from "./routed-script-generator.js";
import { TtsRouter } from "./tts-router.js";
import { VisualRouter } from "./visual-router.js";
import { createSrt, renderVideo } from "./video-renderer.js";

const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const scriptProvider = new FreeRoutedScriptProvider();
const ttsRouter = new TtsRouter();
const visualRouter = new VisualRouter();
const mediaRoot = resolve(process.env.MEDIA_STORAGE_DIR ?? "./data/media");

const worker = new Worker("video-generation", async task => {
  const { videoJobId } = task.data as { videoJobId?: string };
  if (!videoJobId) throw new Error("videoJobId_missing");
  const job = await prisma.videoJob.findUnique({ where: { id: videoJobId } });
  if (!job) throw new Error("video_job_not_found:" + videoJobId);
  if (job.status === JobStatus.CANCELLED || job.status === JobStatus.COMPLETED) return;

  const jobDirectory = join(mediaRoot, videoJobId);
  await mkdir(jobDirectory, { recursive: true });
  const fail = async (code: string, error: unknown, progress: number) => {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.videoJob.update({ where: { id: videoJobId }, data: {
      status: JobStatus.FAILED, progress, errorCode: code, errorMessage: message.slice(0, 1000)
    }});
  };

  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.GENERATING_SCRIPT, progress: 10, errorCode: null, errorMessage: null } });
  let script;
  try {
    script = await scriptProvider.generate({ topic: job.topic, language: job.language, targetDurationSeconds: job.targetDurationSeconds });
  } catch (error) { await fail("SCRIPT_GENERATION_FAILED", error, 10); return; }
  console.log("script planned for " + videoJobId + ": " + script.scenes.length + " scenes via " + scriptProvider.name);

  await connection.set("faceless:providers:llm", JSON.stringify(scriptProvider.routeStatus()), "EX", 300);
  await connection.set("faceless:providers:hub", JSON.stringify(scriptProvider.hubStatus()), "EX", 300);
  await connection.set("faceless:providers:tts", JSON.stringify(ttsRouter.availableRoutes()), "EX", 300);
  await connection.set("faceless:providers:visuals", JSON.stringify(visualRouter.availableRoutes()), "EX", 300);

  const renderScenes: Array<{ imagePath: string; audioPath: string; durationMs: number; narration: string }> = [];
  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.GENERATING_VOICE, progress: 20 } });
  for (let index = 0; index < script.scenes.length; index += 1) {
    const scene = script.scenes[index]!;
    try {
      const result = await ttsRouter.synthesize(scene.narration, job.language);
      const audioName = String(index + 1).padStart(3, "0") + "." + result.extension;
      const audioPath = join(jobDirectory, audioName);
      await writeFile(audioPath, result.audio);
      await prisma.asset.create({ data: {
        jobId: videoJobId, kind: AssetKind.AUDIO, storageKey: videoJobId + "/" + audioName,
        mimeType: result.mimeType, sizeBytes: BigInt(result.audio.byteLength), durationMs: scene.durationMs
      }});
      renderScenes.push({ imagePath: "", audioPath, durationMs: scene.durationMs, narration: scene.narration });
      console.log("voice scene " + (index + 1) + "/" + script.scenes.length + " generated via " + result.provider);
    } catch (error) { await fail("TTS_NO_FREE_ROUTE_AVAILABLE", error, 20); return; }
  }

  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.GENERATING_VISUALS, progress: 45 } });
  for (let index = 0; index < script.scenes.length; index += 1) {
    const scene = script.scenes[index]!;
    try {
      const result = await visualRouter.generate({ prompt: scene.visualPrompt, width: 720, height: 1280 });
      const imageName = String(index + 1).padStart(3, "0") + "." + result.extension;
      const imagePath = join(jobDirectory, imageName);
      await writeFile(imagePath, result.image);
      await prisma.asset.create({ data: {
        jobId: videoJobId, kind: AssetKind.IMAGE, storageKey: videoJobId + "/" + imageName,
        mimeType: result.mimeType, sizeBytes: BigInt(result.image.byteLength), durationMs: scene.durationMs
      }});
      renderScenes[index]!.imagePath = imagePath;
      console.log("visual scene " + (index + 1) + "/" + script.scenes.length + " generated via " + result.provider);
    } catch (error) { await fail("VISUAL_GENERATION_FAILED", error, 45); return; }
  }

  await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.RENDERING, progress: 75 } });
  try {
    const captionText = createSrt(renderScenes);
    const captionName = "captions.srt";
    await writeFile(join(jobDirectory, captionName), captionText, "utf8");
    await prisma.asset.create({ data: {
      jobId: videoJobId, kind: AssetKind.CAPTION, storageKey: videoJobId + "/" + captionName,
      mimeType: "application/x-subrip", sizeBytes: BigInt(Buffer.byteLength(captionText))
    }});
    const videoName = "final.mp4";
    const videoPath = join(jobDirectory, videoName);
    await renderVideo(renderScenes, { outputPath: videoPath, width: 720, height: 1280, fps: 30, ffmpegPath: process.env.FFMPEG_BIN ?? "ffmpeg" });
    const { stat } = await import("node:fs/promises");
    const videoStat = await stat(videoPath);
    if (videoStat.size < 1024) throw new Error("rendered_video_too_small");
    await prisma.asset.create({ data: {
      jobId: videoJobId, kind: AssetKind.VIDEO, storageKey: videoJobId + "/" + videoName,
      mimeType: "video/mp4", sizeBytes: BigInt(videoStat.size), durationMs: script.scenes.reduce((sum, scene) => sum + scene.durationMs, 0)
    }});
    await prisma.videoJob.update({ where: { id: videoJobId }, data: { status: JobStatus.COMPLETED, progress: 100, errorCode: null, errorMessage: null }});
    console.log("video job completed: " + videoJobId + " (" + videoStat.size + " bytes)");
  } catch (error) { await fail("VIDEO_RENDER_FAILED", error, 75); return; }
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) });

worker.on("completed", task => console.log("video job task completed: " + task.id));
worker.on("failed", (task, error) => console.error("video job task failed: " + task?.id, error));
console.log("faceless video-generation worker started");
console.log("free routes:", { llm: scriptProvider.routeStatus(), tts: ttsRouter.availableRoutes(), visuals: visualRouter.availableRoutes() });
void scriptProvider.refreshHub().then(() => Promise.all([
  connection.set("faceless:providers:llm", JSON.stringify(scriptProvider.routeStatus()), "EX", 300),
  connection.set("faceless:providers:hub", JSON.stringify(scriptProvider.hubStatus()), "EX", 300),
  connection.set("faceless:providers:tts", JSON.stringify(ttsRouter.availableRoutes()), "EX", 300),
  connection.set("faceless:providers:visuals", JSON.stringify(visualRouter.availableRoutes()), "EX", 300)
])).catch(error => console.error("could not publish initial provider status", error));
async function shutdown() {
  await worker.close(); await Promise.all([prisma.$disconnect(), connection.quit()]); process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
