import { open, stat } from "node:fs/promises";
import { withBoundedRetry } from "../retry.mjs";

const API_ROOT = "https://open.tiktokapis.com/v2";
const MIB = 1024 * 1024;
const MIN_CHUNK = 5 * MIB;
const MAX_CHUNK = 64 * MIB;
const MAX_FINAL_CHUNK = 128 * MIB;

export class TikTokApiError extends Error {
  constructor(code, message, { retryable = false, statusCode = null, uncertainAcceptance = false, retryAttempts = null, retryExhausted = false } = {}) {
    super(message);
    this.name = "TikTokApiError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.uncertainAcceptance = uncertainAcceptance;
    this.retryAttempts = retryAttempts;
    this.retryExhausted = retryExhausted;
  }
}

async function jsonResponse(response, fallbackCode, { safeToRetry = false, uncertainOnTransient = false } = {}) {
  let body;
  try {
    body = await response.json();
  } catch {
    const transient = response.status >= 500 || response.status === 429;
    throw new TikTokApiError(fallbackCode, "TikTok lieferte eine ungültige JSON-Antwort.", {
      retryable: safeToRetry && transient,
      statusCode: response.status,
      uncertainAcceptance: uncertainOnTransient && transient,
    });
  }
  if (!response.ok || (body.error?.code && body.error.code !== "ok")) {
    const transient = response.status >= 500 || response.status === 429;
    const code = uncertainOnTransient && transient ? "TIKTOK_UPLOAD_INIT_STATE_UNKNOWN" : (body.error?.code || fallbackCode);
    throw new TikTokApiError(code, `TikTok-API-Aufruf fehlgeschlagen (${code}).`, {
      retryable: safeToRetry && transient,
      statusCode: response.status,
      uncertainAcceptance: uncertainOnTransient && transient,
    });
  }
  return body.data || {};
}

export function chooseTikTokChunkPlan(fileSize) {
  if (!Number.isInteger(fileSize) || fileSize < 1) throw new TypeError("fileSize muss positiv sein.");
  if (fileSize > 4 * 1024 * MIB) throw new TikTokApiError("TIKTOK_FILE_TOO_LARGE", "TikTok-Uploads dürfen höchstens 4 GB groß sein.");
  let chunkSize;
  if (fileSize < MIN_CHUNK) chunkSize = fileSize;
  else if (fileSize <= MAX_CHUNK) chunkSize = fileSize;
  else chunkSize = Math.min(MAX_CHUNK, Math.floor(fileSize / 2));
  const totalChunkCount = Math.max(1, Math.floor(fileSize / chunkSize));
  if (totalChunkCount > 1000) throw new TikTokApiError("TIKTOK_TOO_MANY_CHUNKS", "Der TikTok-Upload würde die Grenze von 1000 Chunks überschreiten.");
  const finalChunkSize = fileSize - chunkSize * (totalChunkCount - 1);
  if (totalChunkCount > 1 && (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK || finalChunkSize < MIN_CHUNK || finalChunkSize > MAX_FINAL_CHUNK)) {
    throw new TikTokApiError("TIKTOK_CHUNK_PLAN_INVALID", "Die Videogröße lässt sich nicht in gültige TikTok-Chunks aufteilen.");
  }
  return { chunkSize, totalChunkCount };
}

export class TikTokPublisher {
  constructor({ accessToken, fetchImpl = fetch, retryOptions = {} }) {
    if (!accessToken) throw new TypeError("TikTok accessToken ist erforderlich.");
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.retryOptions = retryOptions;
  }

  async postJson(path, body = undefined, { safeToRetry = false, uncertainAcceptance = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${API_ROOT}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new TikTokApiError(
        uncertainAcceptance ? "TIKTOK_UPLOAD_INIT_STATE_UNKNOWN" : "TIKTOK_NETWORK_ERROR",
        uncertainAcceptance ? "TikTok hat die Uploadinitialisierung nicht eindeutig bestätigt; nicht automatisch wiederholen." : "Die TikTok-Verbindung ist vorübergehend fehlgeschlagen.",
        { retryable: safeToRetry, uncertainAcceptance },
      );
    }
    return jsonResponse(response, "TIKTOK_API_ERROR", { safeToRetry, uncertainOnTransient: uncertainAcceptance });
  }

  async readOnlyPostJson(path, body = undefined) {
    return withBoundedRetry(() => this.postJson(path, body, { safeToRetry: true }), {
      ...this.retryOptions,
      platform: "tiktok",
      action: path,
    });
  }

  async queryCreatorInfo() {
    return this.readOnlyPostJson("/post/publish/creator_info/query/");
  }

  async initializeUpload({ fileSize, mode = "inbox", metadata = {}, chunkPlan = chooseTikTokChunkPlan(fileSize) }) {
    const sourceInfo = { source: "FILE_UPLOAD", video_size: fileSize, chunk_size: chunkPlan.chunkSize, total_chunk_count: chunkPlan.totalChunkCount };
    let path;
    let body;
    if (mode === "inbox") {
      path = "/post/publish/inbox/video/init/";
      body = { source_info: sourceInfo };
    } else if (mode === "direct_post") {
      path = "/post/publish/video/init/";
      if (metadata.confirmed !== true) throw new TikTokApiError("TIKTOK_CONSENT_REQUIRED", "Direct Post benötigt eine ausdrückliche Bestätigung.");
      if (!metadata.creatorInfo || !metadata.creatorInfo.privacy_level_options?.includes(metadata.privacyLevel)) {
        throw new TikTokApiError("TIKTOK_PRIVACY_NOT_ALLOWED", "Die TikTok-Sichtbarkeit ist nicht in den aktuellen Creator-Optionen enthalten.");
      }
      for (const key of ["disableDuet", "disableStitch", "disableComment", "brandContentToggle", "brandOrganicToggle", "isAigc"]) {
        if (typeof metadata[key] !== "boolean") throw new TikTokApiError("TIKTOK_POST_OPTIONS_REQUIRED", `Direct Post benötigt die ausdrückliche Auswahl für ${key}.`);
      }
      const postInfo = {
        privacy_level: metadata.privacyLevel,
        title: metadata.title || "",
        disable_duet: metadata.disableDuet,
        disable_stitch: metadata.disableStitch,
        disable_comment: metadata.disableComment,
        brand_content_toggle: metadata.brandContentToggle,
        brand_organic_toggle: metadata.brandOrganicToggle,
        is_aigc: metadata.isAigc,
      };
      if (metadata.videoCoverTimestampMs !== undefined) postInfo.video_cover_timestamp_ms = metadata.videoCoverTimestampMs;
      body = { post_info: postInfo, source_info: sourceInfo };
    } else {
      throw new TypeError("mode muss inbox oder direct_post sein.");
    }
    const data = await this.postJson(path, body, { uncertainAcceptance: true });
    if (!data.publish_id || !data.upload_url) throw new TikTokApiError("TIKTOK_UPLOAD_SESSION_INVALID", "TikTok lieferte keine vollständige Upload-Session.", { uncertainAcceptance: true });
    return { publishId: data.publish_id, uploadUrl: data.upload_url, chunkPlan };
  }

  async uploadChunks({ filePath, uploadUrl, fileSize, chunkPlan = chooseTikTokChunkPlan(fileSize), onProgress = async () => {} }) {
    const file = await open(filePath, "r");
    let offset = 0;
    try {
      for (let index = 0; index < chunkPlan.totalChunkCount; index += 1) {
        const length = index === chunkPlan.totalChunkCount - 1 ? fileSize - offset : chunkPlan.chunkSize;
        if (length < 1 || length > MAX_FINAL_CHUNK) throw new TikTokApiError("TIKTOK_CHUNK_PLAN_INVALID", "TikTok-Chunklänge außerhalb der erlaubten Grenze.");
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(chunk, 0, length, offset);
        if (bytesRead !== length) throw new TikTokApiError("TIKTOK_FILE_READ_FAILED", "Videodatei konnte nicht vollständig gelesen werden.");
        const end = offset + length - 1;
        let response;
        try {
          response = await this.fetchImpl(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(length),
              "Content-Range": `bytes ${offset}-${end}/${fileSize}`,
            },
            body: chunk,
            signal: AbortSignal.timeout(120_000),
            redirect: "manual",
          });
        } catch {
          throw new TikTokApiError("TIKTOK_UPLOAD_STATE_UNKNOWN", "TikTok-Chunk konnte nicht bestätigt werden; Status abgleichen, bevor erneut gesendet wird.", { uncertainAcceptance: true });
        }
        const expectedStatus = index === chunkPlan.totalChunkCount - 1 ? 201 : 206;
        if (response.status !== expectedStatus) {
          const uncertainAcceptance = response.status >= 500 || response.status === 429;
          throw new TikTokApiError(
            uncertainAcceptance ? "TIKTOK_UPLOAD_STATE_UNKNOWN" : "TIKTOK_CHUNK_UPLOAD_FAILED",
            uncertainAcceptance ? "TikTok hat die Chunk-Annahme nicht eindeutig bestätigt; Status abgleichen, bevor erneut gesendet wird." : `TikTok hat Chunk ${index + 1} nicht bestätigt (HTTP ${response.status}).`,
            { statusCode: response.status, uncertainAcceptance },
          );
        }
        offset += length;
        await onProgress({ uploadedBytes: offset, totalBytes: fileSize, chunk: index + 1, chunks: chunkPlan.totalChunkCount });
      }
    } finally {
      await file.close();
    }
    return { uploadedBytes: offset };
  }

  async uploadToInbox({ filePath, onProgress }) {
    const info = await stat(filePath);
    const chunkPlan = chooseTikTokChunkPlan(info.size);
    const session = await this.initializeUpload({ fileSize: info.size, mode: "inbox", chunkPlan });
    await this.uploadChunks({ filePath, uploadUrl: session.uploadUrl, fileSize: info.size, chunkPlan, onProgress });
    return { publishId: session.publishId, status: "PROCESSING_UPLOAD", uploadedBytes: info.size };
  }

  async directPost({ filePath, metadata, onProgress }) {
    const info = await stat(filePath);
    const chunkPlan = chooseTikTokChunkPlan(info.size);
    const session = await this.initializeUpload({ fileSize: info.size, mode: "direct_post", metadata, chunkPlan });
    await this.uploadChunks({ filePath, uploadUrl: session.uploadUrl, fileSize: info.size, chunkPlan, onProgress });
    return { publishId: session.publishId, status: "PROCESSING_UPLOAD", uploadedBytes: info.size };
  }

  async getStatus(publishId) {
    const data = await this.readOnlyPostJson("/post/publish/status/fetch/", { publish_id: publishId });
    return {
      publishId,
      status: data.status,
      failReason: data.fail_reason || null,
      postIds: data.publicaly_available_post_id || [],
      uploadedBytes: data.uploaded_bytes ?? null,
      downloadedBytes: data.downloaded_bytes ?? null,
    };
  }
}
