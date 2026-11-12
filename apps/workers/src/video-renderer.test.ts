import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createSrt, renderVideo, runRendererProcess } from "./video-renderer.js";

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error("command_exit_" + code + ":" + stderr.slice(-1000))),
    );
  });
}

test("SRT captions preserve scene order and cumulative timing", () => {
  const srt = createSrt([
    { imagePath: "a.jpg", audioPath: "a.wav", durationMs: 1500, narration: "Erste Szene" },
    { imagePath: "b.jpg", audioPath: "b.wav", durationMs: 2500, narration: "Zweite Szene" },
  ]);
  assert.match(srt, /00:00:00,000 --> 00:00:01,500/);
  assert.match(srt, /00:00:01,500 --> 00:00:04,000/);
  assert.ok(srt.indexOf("Erste Szene") < srt.indexOf("Zweite Szene"));
});

test("FFmpeg renderer produces a probeable vertical MP4 from image and audio assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-render-test-"));
  try {
    const imagePath = join(directory, "scene.png");
    const audioPath = join(directory, "voice.wav");
    const outputPath = join(directory, "final.mp4");
    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=blue:s=360x640:d=1",
      "-frames:v", "1", imagePath,
    ]);
    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:a", "pcm_s16le", audioPath,
    ]);
    await renderVideo(
      [{ imagePath, audioPath, durationMs: 1200, narration: "Integrationstest" }],
      { outputPath, width: 360, height: 640, fps: 24 },
    );
    const outputStat = await stat(outputPath);
    assert.ok(outputStat.size > 1024, "MP4 output must contain encoded media");
    const probe = await run("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,width,height",
      "-show_entries", "format=duration", "-of", "json", outputPath,
    ]);
    const metadata = JSON.parse(probe) as {
      streams: Array<{ codec_type: string; width?: number; height?: number }>;
      format: { duration: string };
    };
    assert.ok(metadata.streams.some((stream) => stream.codec_type === "video"));
    assert.ok(metadata.streams.some((stream) => stream.codec_type === "audio"));
    const video = metadata.streams.find((stream) => stream.codec_type === "video");
    assert.equal(video?.width, 360);
    assert.equal(video?.height, 640);
    assert.ok(Number(metadata.format.duration) >= 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("renderer process is killed when its execution deadline expires", async () => {
  await assert.rejects(
    () => runRendererProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, 50),
    /ffmpeg_timeout/,
  );
});

test("renderer process bounds captured stderr on failure", async () => {
  await assert.rejects(
    () => runRendererProcess(process.execPath, ["-e", "process.stderr.write('x'.repeat(5000)); process.exit(2)"], undefined, 2_000),
    (error: unknown) => error instanceof Error && error.message.startsWith("ffmpeg_exit_2:") && error.message.length <= 1_220,
  );
});
