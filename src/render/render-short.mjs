import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export class RenderError extends Error {
  constructor(code, message, publicMessage = "Das Video konnte nicht gerendert werden.") {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      reject(new RenderError("RENDER_PROCESS_START_FAILED", error.message, "FFmpeg konnte nicht gestartet werden."));
      return;
    }

    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new RenderError("RENDER_TIMEOUT", `FFmpeg überschritt das Zeitlimit von ${timeoutMs} ms.`, "Das Rendern hat das Zeitlimit überschritten."));
      }
    }, timeoutMs);
    timeout.unref?.();

    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr = (stderr + chunk).slice(-8_000);
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new RenderError("RENDER_PROCESS_START_FAILED", error.message, "FFmpeg ist nicht verfügbar oder konnte nicht gestartet werden."));
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new RenderError("FFMPEG_FAILED", `FFmpeg endete mit Code ${code}: ${stderr}`, "FFmpeg konnte das Video nicht erzeugen."));
    });
  });
}

function escapeFilterPath(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export class VideoRenderer {
  constructor({ ffmpegBin = "ffmpeg", timeoutMs = 120_000 } = {}) {
    this.ffmpegBin = ffmpegBin;
    this.timeoutMs = timeoutMs;
  }

  async render({ imagePath, audioPath, outputPath, caption, durationSeconds, speech = false }) {
    await mkdir(dirname(outputPath), { recursive: true });
    const started = performance.now();
    const captionPath = join(dirname(outputPath), "caption.txt");
    const temporaryOutput = outputPath.replace(/\.mp4$/i, `.render-${process.pid}.tmp.mp4`);
    const safeCaption = String(caption || "").replace(/[\r\n\u0000-\u001f]+/g, " ").slice(0, 180);
    await writeFile(captionPath, `${safeCaption}\n`, { mode: 0o600 });

    const filter = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      `drawtext=expansion=none:font='sans':textfile='${escapeFilterPath(captionPath)}':fontcolor=white:fontsize=58:box=1:boxcolor=black@0.65:boxborderw=24:x=(w-text_w)/2:y=h*0.72`,
    ].join(",");

    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", "30", "-loop", "1", "-i", imagePath,
      ...(speech ? [] : ["-stream_loop", "-1"]), "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", filter,
      "-t", String(durationSeconds),
      "-r", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-af", speech ? "apad,volume=1" : "volume=0.08",
      "-movflags", "+faststart",
      temporaryOutput,
    ];

    try {
      await runProcess(this.ffmpegBin, args, this.timeoutMs);
      const info = await stat(temporaryOutput);
      if (info.size === 0) throw new RenderError("EMPTY_RENDER", "FFmpeg hat eine leere Datei erzeugt.");
      await rename(temporaryOutput, outputPath);
      return {
        sizeBytes: info.size,
        renderDurationMs: Math.round(performance.now() - started),
        width: 1080,
        height: 1920,
        framesPerSecond: 30,
      };
    } catch (error) {
      await rm(temporaryOutput, { force: true }).catch(() => {});
      throw error;
    }
  }
}
