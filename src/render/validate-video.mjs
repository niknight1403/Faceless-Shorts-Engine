import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";

export class VideoValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VideoValidationError";
    this.code = code;
    this.publicMessage = "Die gerenderte Videodatei hat die Qualitätsprüfung nicht bestanden.";
  }
}

function runProbe(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new VideoValidationError("FFPROBE_START_FAILED", error.message));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new VideoValidationError("FFPROBE_TIMEOUT", `ffprobe überschritt ${timeoutMs} ms.`));
      }
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8").on("data", chunk => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-4_000); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new VideoValidationError("FFPROBE_START_FAILED", error.message));
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new VideoValidationError("FFPROBE_FAILED", `ffprobe exit ${code}: ${stderr}`));
    });
  });
}

function parseFrameRate(value) {
  if (!value) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

export class VideoValidator {
  constructor({ ffprobeBin = "ffprobe", timeoutMs = 15_000 } = {}) {
    this.ffprobeBin = ffprobeBin;
    this.timeoutMs = timeoutMs;
  }

  async validate({ filePath, expectedDurationSeconds }) {
    let fileInfo;
    try {
      fileInfo = await stat(filePath);
    } catch {
      throw new VideoValidationError("OUTPUT_MISSING", "Die gerenderte Ausgabedatei fehlt.");
    }
    if (!fileInfo.isFile() || fileInfo.size < 1_000) {
      throw new VideoValidationError("OUTPUT_EMPTY", `Videodatei ist leer oder ungültig (${fileInfo.size} Bytes).`);
    }

    const raw = await runProbe(this.ffprobeBin, [
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration",
      "-of", "json",
      filePath,
    ], this.timeoutMs);
    let probe;
    try {
      probe = JSON.parse(raw);
    } catch {
      throw new VideoValidationError("FFPROBE_INVALID_JSON", "ffprobe hat ungültige JSON-Metadaten geliefert.");
    }

    const formatName = probe.format?.format_name || "";
    if (!formatName.split(",").includes("mp4")) {
      throw new VideoValidationError("OUTPUT_NOT_MP4", `Unerwarteter Container: ${formatName || "unbekannt"}.`);
    }
    const video = probe.streams?.find(stream => stream.codec_type === "video");
    const audio = probe.streams?.find(stream => stream.codec_type === "audio");
    if (!video || !audio) throw new VideoValidationError("OUTPUT_MISSING_STREAM", "Video- oder Audio-Stream fehlt.");
    if (video.codec_name !== "h264" || audio.codec_name !== "aac") {
      throw new VideoValidationError("OUTPUT_UNSUPPORTED_CODEC", `Unerwartete Codecs: ${video.codec_name}/${audio.codec_name}.`);
    }
    if (video.width !== 1080 || video.height !== 1920) {
      throw new VideoValidationError("OUTPUT_WRONG_DIMENSIONS", `Erwartet 1080x1920, erhalten ${video.width}x${video.height}.`);
    }

    const durationSeconds = Number(probe.format?.duration || video.duration || audio.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new VideoValidationError("OUTPUT_INVALID_DURATION", "Videolaufzeit fehlt oder ist ungültig.");
    }
    const toleranceSeconds = Math.max(0.25, expectedDurationSeconds * 0.05);
    if (Math.abs(durationSeconds - expectedDurationSeconds) > toleranceSeconds) {
      throw new VideoValidationError(
        "OUTPUT_WRONG_DURATION",
        `Erwartet ${expectedDurationSeconds} s, erhalten ${durationSeconds.toFixed(3)} s.`,
      );
    }

    const framesPerSecond = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
    if (!framesPerSecond || Math.abs(framesPerSecond - 30) > 0.1) {
      throw new VideoValidationError("OUTPUT_WRONG_FRAME_RATE", `Erwartet 30 fps, erhalten ${framesPerSecond ?? "unbekannt"}.`);
    }

    return {
      sizeBytes: fileInfo.size,
      container: "mp4",
      videoCodec: video.codec_name,
      audioCodec: audio.codec_name,
      width: video.width,
      height: video.height,
      framesPerSecond: Number(framesPerSecond.toFixed(3)),
      durationSeconds: Number(durationSeconds.toFixed(3)),
    };
  }
}
