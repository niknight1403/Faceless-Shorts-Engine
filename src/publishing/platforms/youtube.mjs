import { open, stat } from "node:fs/promises";
import { retryDelayMs, withBoundedRetry } from "../retry.mjs";

const API_ROOT = "https://www.googleapis.com/youtube/v3";
const UPLOAD_ROOT = "https://www.googleapis.com/upload/youtube/v3/videos";
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export class YouTubeApiError extends Error {
  constructor(code, message, { retryable = false, statusCode = null, uncertainAcceptance = false, retryAttempts = null, retryExhausted = false } = {}) {
    super(message);
    this.name = "YouTubeApiError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.uncertainAcceptance = uncertainAcceptance;
    this.retryAttempts = retryAttempts;
    this.retryExhausted = retryExhausted;
  }
}

function parseRange(value) {
  const match = /^bytes=0-(\d+)$/.exec(value || "");
  return match ? Number(match[1]) + 1 : 0;
}

async function responseJson(response, code) {
  try {
    return await response.json();
  } catch {
    throw new YouTubeApiError(code, "YouTube lieferte eine ungültige JSON-Antwort.", { statusCode: response.status });
  }
}

export class YouTubePublisher {
  constructor({ accessToken, fetchImpl = fetch, chunkSize = DEFAULT_CHUNK_SIZE, maxNoProgress = 3, retryOptions = {} }) {
    if (!accessToken) throw new TypeError("YouTube accessToken ist erforderlich.");
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.chunkSize = Math.max(256 * 1024, Math.floor(chunkSize / (256 * 1024)) * (256 * 1024));
    this.maxNoProgress = maxNoProgress;
    this.retryOptions = retryOptions;
  }

  async retrySafeRequest(action, request) {
    return withBoundedRetry(async () => {
      let response;
      try {
        response = await request();
      } catch {
        throw new YouTubeApiError("YOUTUBE_NETWORK_ERROR", "Die YouTube-Verbindung ist vorübergehend fehlgeschlagen.", { retryable: true });
      }
      if (response.status >= 500 || response.status === 429) {
        throw new YouTubeApiError("YOUTUBE_TRANSIENT_RESPONSE", "YouTube meldet einen vorübergehenden Fehler.", { retryable: true, statusCode: response.status });
      }
      return response;
    }, { ...this.retryOptions, platform: "youtube", action });
  }

  async waitBeforeChunkRetry(attempt) {
    const delayMs = retryDelayMs(attempt, this.retryOptions);
    const event = { platform: "youtube", action: "upload-chunk-confirmed-not-accepted", attempt, delayMs, errorCode: "YOUTUBE_UPLOAD_NO_PROGRESS" };
    try { await this.retryOptions.onRetry?.(event); } catch { /* Observability must not affect a safe confirmed retry. */ }
    const wait = this.retryOptions.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    await wait(delayMs);
  }

  metadataResource(metadata) {
    const snippet = { title: metadata.title, description: metadata.description || "" };
    if (Array.isArray(metadata.tags) && metadata.tags.length) snippet.tags = metadata.tags;
    if (metadata.categoryId) snippet.categoryId = String(metadata.categoryId);
    const status = {
      privacyStatus: metadata.privacyStatus,
      containsSyntheticMedia: metadata.containsSyntheticMedia,
    };
    if (metadata.publishAt) status.publishAt = metadata.publishAt;
    return { snippet, status };
  }

  async startResumableSession({ fileSize, metadata, sessionUri = null, onSession = async () => {} }) {
    if (sessionUri) return sessionUri;
    const url = new URL(UPLOAD_ROOT);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("part", "snippet,status");
    url.searchParams.set("notifySubscribers", metadata.notifySubscribers === true ? "true" : "false");
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(fileSize),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify(this.metadataResource(metadata)),
        signal: AbortSignal.timeout(30_000),
        redirect: "manual",
      });
    } catch {
      throw new YouTubeApiError("YOUTUBE_SESSION_INIT_STATE_UNKNOWN", "YouTube hat die Upload-Session-Anfrage nicht eindeutig bestätigt; nicht automatisch wiederholen.", { uncertainAcceptance: true });
    }
    if (!response.ok) {
      const uncertainAcceptance = response.status >= 500 || response.status === 429;
      throw new YouTubeApiError(
        uncertainAcceptance ? "YOUTUBE_SESSION_INIT_STATE_UNKNOWN" : "YOUTUBE_SESSION_INIT_FAILED",
        uncertainAcceptance ? "YouTube hat die Upload-Session-Anfrage nicht eindeutig bestätigt; nicht automatisch wiederholen." : `YouTube-Upload-Session konnte nicht gestartet werden (HTTP ${response.status}).`,
        { statusCode: response.status, uncertainAcceptance },
      );
    }
    const location = response.headers.get("location");
    if (!location) throw new YouTubeApiError("YOUTUBE_SESSION_URL_MISSING", "YouTube lieferte keine Upload-Session-URL.", { uncertainAcceptance: true });
    try {
      await onSession(location);
    } catch (error) {
      if (error && typeof error === "object") error.uncertainAcceptance = true;
      throw error;
    }
    return location;
  }

  async uploadVideo({ filePath, metadata, sessionUri = null, onSession = async () => {}, onProgress = async () => {} }) {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < 1) throw new YouTubeApiError("YOUTUBE_FILE_INVALID", "Die Videodatei fehlt oder ist leer.");
    const session = await this.startResumableSession({ fileSize: info.size, metadata, sessionUri, onSession });
    let offset = 0;
    if (sessionUri) {
      const status = await this.probeSession(session, info.size);
      if (status.status === 308) {
        offset = Math.min(parseRange(status.headers.get("range")), info.size);
        if (offset > 0) await onProgress({ uploadedBytes: offset, totalBytes: info.size });
      } else if (status.ok) {
        let resource;
        try {
          resource = await responseJson(status, "YOUTUBE_UPLOAD_RESPONSE_INVALID");
        } catch {
          throw new YouTubeApiError("YOUTUBE_UPLOAD_STATE_UNKNOWN", "Die gespeicherte YouTube-Session lieferte keinen prüfbaren Abschluss; manuell abgleichen.", { uncertainAcceptance: true });
        }
        if (!resource.id) throw new YouTubeApiError("YOUTUBE_UPLOAD_STATE_UNKNOWN", "Die gespeicherte YouTube-Session lieferte keine Video-ID; manuell abgleichen.", { uncertainAcceptance: true });
        await onProgress({ uploadedBytes: info.size, totalBytes: info.size });
        return { videoId: resource.id, resource, uploadedBytes: info.size, resumed: true };
      } else {
        throw new YouTubeApiError("YOUTUBE_UPLOAD_STATE_UNKNOWN", "Die gespeicherte YouTube-Session ist nicht eindeutig abgleichbar; keinen neuen Upload starten.", { statusCode: status.status, uncertainAcceptance: true });
      }
    }
    const file = await open(filePath, "r");
    let noProgress = 0;
    try {
      while (offset < info.size) {
        const length = Math.min(this.chunkSize, info.size - offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(chunk, 0, length, offset);
        if (bytesRead !== length) throw new YouTubeApiError("YOUTUBE_FILE_READ_FAILED", "Die Videodatei konnte nicht vollständig gelesen werden.");
        const end = offset + length - 1;
        let response;
        let statusUncertain = false;
        try {
          response = await this.fetchImpl(session, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "Content-Type": "video/mp4",
              "Content-Length": String(length),
              "Content-Range": `bytes ${offset}-${end}/${info.size}`,
            },
            body: chunk,
            signal: AbortSignal.timeout(120_000),
            redirect: "manual",
          });
        } catch {
          statusUncertain = true;
          response = await this.probeSession(session, info.size);
        }

        if (response.status >= 500 || response.status === 429) {
          statusUncertain = true;
          response = await this.probeSession(session, info.size);
        }

        if (response.status === 308) {
          const nextOffset = parseRange(response.headers.get("range"));
          if (nextOffset <= offset) {
            noProgress += 1;
            if (noProgress >= this.maxNoProgress) throw new YouTubeApiError("YOUTUBE_UPLOAD_NO_PROGRESS", "Der YouTube-Upload macht keinen Fortschritt; der Auftrag muss geprüft werden.", { retryAttempts: noProgress, retryExhausted: true });
            await this.waitBeforeChunkRetry(noProgress);
          } else {
            offset = Math.min(nextOffset, info.size);
            noProgress = 0;
            await onProgress({ uploadedBytes: offset, totalBytes: info.size });
          }
          continue;
        }
        if (statusUncertain && !response.ok) {
          throw new YouTubeApiError("YOUTUBE_UPLOAD_STATE_UNKNOWN", "Der YouTube-Uploadstatus konnte nicht bestätigt werden; vor einem neuen Upload manuell abgleichen.", { statusCode: response.status, uncertainAcceptance: true });
        }
        if (!response.ok) throw new YouTubeApiError("YOUTUBE_UPLOAD_FAILED", `YouTube hat den Video-Upload abgelehnt (HTTP ${response.status}).`, { statusCode: response.status });
        const resource = await responseJson(response, "YOUTUBE_UPLOAD_RESPONSE_INVALID");
        await onProgress({ uploadedBytes: info.size, totalBytes: info.size });
        return { videoId: resource.id, resource, uploadedBytes: info.size };
      }
      throw new YouTubeApiError("YOUTUBE_UPLOAD_INCOMPLETE", "YouTube hat den Upload nicht mit einer Abschlussantwort bestätigt.", { uncertainAcceptance: true });
    } finally {
      await file.close();
    }
  }

  async probeSession(sessionUri, totalBytes) {
    try {
      return await this.retrySafeRequest("upload-session-status", () => this.fetchImpl(sessionUri, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Length": "0",
          "Content-Range": `bytes */${totalBytes}`,
        },
        signal: AbortSignal.timeout(30_000),
        redirect: "manual",
      }));
    } catch (error) {
      throw new YouTubeApiError("YOUTUBE_UPLOAD_STATE_UNKNOWN", "Der Uploadstatus bei YouTube ist unbekannt; vor einem erneuten Upload manuell abgleichen.", {
        statusCode: error.statusCode || null,
        uncertainAcceptance: true,
        retryAttempts: error.retryAttempts || null,
        retryExhausted: error.retryExhausted === true,
      });
    }
  }

  async getVideoStatus(videoId) {
    const url = new URL(`${API_ROOT}/videos`);
    url.searchParams.set("part", "status,processingDetails");
    url.searchParams.set("id", videoId);
    const response = await this.retrySafeRequest("video-status", () => this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    }));
    if (!response.ok) throw new YouTubeApiError("YOUTUBE_STATUS_FAILED", `YouTube-Statusabfrage fehlgeschlagen (HTTP ${response.status}).`, { statusCode: response.status });
    const body = await responseJson(response, "YOUTUBE_STATUS_RESPONSE_INVALID");
    const item = body.items?.[0];
    if (!item) throw new YouTubeApiError("YOUTUBE_VIDEO_NOT_FOUND", "YouTube hat das Video bei der Statusabfrage nicht gefunden.");
    return { videoId: item.id, uploadStatus: item.status?.uploadStatus || null, privacyStatus: item.status?.privacyStatus || null, processingStatus: item.processingDetails?.processingStatus || null, processingFailureReason: item.processingDetails?.processingFailureReason || null };
  }
}
