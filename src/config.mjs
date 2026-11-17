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

function booleanSetting(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} muss true oder false sein.`);
}

function configuredPath(value, fallback) {
  const path = value || fallback;
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

export function loadConfig(env = process.env) {
  const dataDir = configuredPath(env.JOB_DATA_DIR, "./data/jobs");
  const publishingDataDir = configuredPath(env.PUBLISHING_DATA_DIR, "./data/publishing");
  const providerBaseUrl = (env.MOCK_MEDIA_URL || "http://127.0.0.1:4010").replace(/\/+$/, "");
  const host = env.HOST || "127.0.0.1";
  const publishingEnabled = booleanSetting(env, "PUBLISHING_ENABLED");
  const publishingApiKey = env.PUBLISHING_API_KEY || "";
  const publishingTokenKey = env.PUBLISHING_TOKEN_KEY || "";

  let parsedProviderUrl;
  try {
    parsedProviderUrl = new URL(providerBaseUrl);
  } catch {
    throw new Error("MOCK_MEDIA_URL muss eine gültige absolute URL sein.");
  }
  if (!["http:", "https:"].includes(parsedProviderUrl.protocol)) {
    throw new Error("MOCK_MEDIA_URL muss HTTP oder HTTPS verwenden.");
  }

  if (publishingEnabled) {
    if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
      throw new Error("Publishing darf nur an eine Loopback-Adresse gebunden werden.");
    }
    if (publishingApiKey.length < 32) throw new Error("PUBLISHING_API_KEY muss bei aktiviertem Publishing mindestens 32 Zeichen lang sein.");
    const decodedKey = Buffer.from(publishingTokenKey, "base64url");
    if (decodedKey.length !== 32 || decodedKey.toString("base64url") !== publishingTokenKey) {
      throw new Error("PUBLISHING_TOKEN_KEY muss bei aktiviertem Publishing ein base64url-kodierter 32-Byte-Schlüssel sein.");
    }
  }

  return Object.freeze({
    host,
    port: integerSetting(env, "PORT", 3000, 1, 65535),
    providerBaseUrl,
    dataDir,
    publishingEnabled,
    publishingApiKey,
    publishingTokenKey,
    publishingDataDir,
    tiktokUploadApproved: booleanSetting(env, "TIKTOK_UPLOAD_APPROVED"),
    tiktokDirectPostApproved: booleanSetting(env, "TIKTOK_DIRECT_POST_APPROVED"),
    oauth: Object.freeze({
      youtube: Object.freeze({
        clientId: env.YOUTUBE_OAUTH_CLIENT_ID || "",
        clientSecret: env.YOUTUBE_OAUTH_CLIENT_SECRET || "",
        redirectUri: env.YOUTUBE_OAUTH_REDIRECT_URI || "",
      }),
      tiktok: Object.freeze({
        clientId: env.TIKTOK_OAUTH_CLIENT_ID || "",
        clientSecret: env.TIKTOK_OAUTH_CLIENT_SECRET || "",
        redirectUri: env.TIKTOK_OAUTH_REDIRECT_URI || "",
      }),
    }),
    defaultDurationSeconds: integerSetting(env, "DEFAULT_DURATION_SECONDS", 5, 1, 60),
    maxDurationSeconds: 60,
    ffmpegBin: env.FFMPEG_BIN || "ffmpeg",
    ffprobeBin: env.FFPROBE_BIN || "ffprobe",
    providerTimeoutMs: 15_000,
    renderTimeoutMs: 120_000,
    maxRequestBytes: 64 * 1024,
  });
}
