import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface RenderScene { imagePath: string; audioPath: string; durationMs: number; narration: string }
export interface RenderOptions { outputPath: string; width?: number; height?: number; fps?: number; ffmpegPath?: string }
function run(binary: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg_exit_" + code + ":" + stderr.slice(-1200))));
  });
}
function srtTime(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return [hours, minutes, seconds].map(part => String(part).padStart(2, "0")).join(":") + "," + String(millis).padStart(3, "0");
}
export function createSrt(scenes: RenderScene[]): string {
  let offset = 0;
  return scenes.map((scene, index) => {
    const start = offset; offset += scene.durationMs;
    return String(index + 1) + "\n" + srtTime(start) + " --> " + srtTime(offset) + "\n" + scene.narration.trim() + "\n";
  }).join("\n");
}

/** Creates one H.264/AAC segment per scene, then joins them into a vertical MP4. */
export async function renderVideo(scenes: RenderScene[], options: RenderOptions): Promise<void> {
  if (!scenes.length) throw new Error("render_requires_scenes");
  const directory = join(options.outputPath, "..", ".render-" + Date.now());
  const width = options.width ?? 720, height = options.height ?? 1280, fps = options.fps ?? 30;
  await mkdir(directory, { recursive: true });
  try {
    const segmentPaths: string[] = [];
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index]!;
      const segment = join(directory, String(index).padStart(3, "0") + ".mp4");
      const duration = Math.max(1, scene.durationMs / 1000);
      const subtitleName = "scene-" + String(index).padStart(3, "0") + ".srt";
      await writeFile(join(directory, subtitleName), createSrt([scene]), "utf8");
      await run(options.ffmpegPath ?? "ffmpeg", [
        "-y", "-loop", "1", "-framerate", String(fps), "-i", scene.imagePath, "-i", scene.audioPath,
        "-vf", "subtitles=" + subtitleName + ",scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height + ",setsar=1",
        "-r", String(fps), "-t", String(duration), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-af", "apad", "-shortest", "-movflags", "+faststart", segment
      ], directory);
      segmentPaths.push(segment);
    }
    const listPath = join(directory, "concat.txt");
    await writeFile(listPath, segmentPaths.map(path => "file '" + path.replace(/'/g, "'\\''") + "'").join("\n"));
    await mkdir(join(options.outputPath, ".."), { recursive: true });
    await run(options.ffmpegPath ?? "ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", options.outputPath]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
