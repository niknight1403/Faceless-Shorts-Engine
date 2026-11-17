import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function integerSetting(env, name, fallback, min, max) {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const configuredDataDir = env.JOB_DATA_DIR || "./data/jobs";
  const dataDir = isAbsolute(configuredDataDir)
    ? configuredDataDir
    : resolve(projectRoot, configuredDataDir);
  const providerBaseUrl = (env.MOCK_MEDIA_URL || "http://127.0.0.1:4010").replace(/\/+$/, "");

  let parsedProviderUrl;
  try {
    parsedProviderUrl = new URL(providerBaseUrl);
  } catch {
    throw new Error("MOCK_MEDIA_URL muss eine gültige absolute URL sein.");
  }
  if (!["http:", "https:"].includes(parsedProviderUrl.protocol)) {
    throw new Error("MOCK_MEDIA_URL muss HTTP oder HTTPS verwenden.");
  }

  return Object.freeze({
    host: env.HOST || "127.0.0.1",
    port: integerSetting(env, "PORT", 3000, 1, 65535),
    providerBaseUrl,
    dataDir,
    defaultDurationSeconds: integerSetting(env, "DEFAULT_DURATION_SECONDS", 5, 1, 60),
    maxDurationSeconds: 60,
    ffmpegBin: env.FFMPEG_BIN || "ffmpeg",
    ffprobeBin: env.FFPROBE_BIN || "ffprobe",
    providerTimeoutMs: 15_000,
    renderTimeoutMs: 120_000,
    maxRequestBytes: 64 * 1024,
  });
}
