import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

export class PublishingPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublishingPreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublishingPreflightError(code, message);
}

export async function validatePublishRequest({
  platform,
  filePath,
  video,
  metadata,
  creatorInfo = null,
  mode = "upload",
  requireConsent = true,
}) {
  if (!["youtube", "tiktok"].includes(platform)) fail("UNSUPPORTED_PLATFORM", "Plattform wird nicht unterstützt.");
  if (!filePath || typeof filePath !== "string") fail("VIDEO_FILE_REQUIRED", "Ein lokaler Videopfad ist erforderlich.");
  if (!isAbsolute(filePath) || !basename(filePath).toLowerCase().endsWith(".mp4") || filePath.includes("\0") || filePath.split("/").includes("..")) fail("VIDEO_PATH_INVALID", "Es ist ausschließlich ein absoluter lokaler MP4-Exportpfad zulässig.");
  if (!video || typeof video !== "object") fail("VIDEO_METADATA_REQUIRED", "Videometadaten fehlen.");
  if (!metadata || typeof metadata !== "object") fail("PUBLISH_METADATA_REQUIRED", "Veröffentlichungsmetadaten fehlen.");

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    fail("VIDEO_FILE_NOT_FOUND", "Die fertige Videodatei ist nicht verfügbar.");
  }
  if (!fileInfo.isFile() || fileInfo.size < 1) fail("VIDEO_FILE_INVALID", "Die Videodatei ist leer oder ungültig.");
  if (fileInfo.size > 4 * 1024 * 1024 * 1024) fail("VIDEO_FILE_TOO_LARGE", "Die lokale Videodatei überschreitet die zulässige Größe.");

  const duration = Number(video.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) fail("INVALID_VIDEO_DURATION", "Die Videolaufzeit fehlt oder ist ungültig.");
  if (video.container && !String(video.container).toLowerCase().includes("mp4")) {
    fail("UNSUPPORTED_VIDEO_CONTAINER", "Für den Publishing-PoC werden MP4-Dateien erwartet.");
  }
  if (video.videoCodec && video.videoCodec !== "h264") {
    fail("UNSUPPORTED_VIDEO_CODEC", "Für den Publishing-PoC wird H.264-Video erwartet.");
  }

  if (platform === "youtube") {
    if (duration > 180) fail("YOUTUBE_SHORT_TOO_LONG", "Ein YouTube Short darf in diesem Profil höchstens 180 Sekunden dauern.");
    if (!["public", "private", "unlisted"].includes(metadata.privacyStatus)) {
      fail("YOUTUBE_PRIVACY_REQUIRED", "Die YouTube-Sichtbarkeit muss explizit public, private oder unlisted sein.");
    }
    if (metadata.publishAt && metadata.privacyStatus !== "private") {
      fail("YOUTUBE_SCHEDULE_REQUIRES_PRIVATE", "Ein geplanter YouTube-Upload muss zunächst privat sein.");
    }
    if (typeof metadata.containsSyntheticMedia !== "boolean") {
      fail("YOUTUBE_AI_DISCLOSURE_REQUIRED", "Die Entscheidung zur Offenlegung realistischer KI-Inhalte muss ausdrücklich angegeben werden.");
    }
    if (metadata.title !== undefined && (typeof metadata.title !== "string" || metadata.title.length > 100)) {
      fail("YOUTUBE_TITLE_INVALID", "Der YouTube-Titel darf höchstens 100 Zeichen enthalten.");
    }
  }

  if (platform === "tiktok") {
    if (fileInfo.size > 4 * 1024 * 1024 * 1024) fail("TIKTOK_FILE_TOO_LARGE", "TikTok-Uploads dürfen höchstens 4 GB groß sein.");
    const fps = Number(video.framesPerSecond);
    if (Number.isFinite(fps) && (fps < 23 || fps > 60)) fail("TIKTOK_FRAME_RATE_UNSUPPORTED", "TikTok unterstützt in diesem Profil 23 bis 60 Bilder pro Sekunde.");
    for (const dimension of [video.width, video.height]) {
      if (Number.isFinite(Number(dimension)) && (Number(dimension) < 360 || Number(dimension) > 4096)) {
        fail("TIKTOK_DIMENSION_UNSUPPORTED", "TikTok erwartet Bildabmessungen zwischen 360 und 4096 Pixeln.");
      }
    }
    if (mode === "direct_post") {
      if (!creatorInfo) fail("TIKTOK_CREATOR_INFO_REQUIRED", "Creator-Informationen müssen vor Direct Post frisch abgefragt werden.");
      if (!Number.isFinite(Number(creatorInfo.max_video_post_duration_sec))) {
        fail("TIKTOK_DURATION_LIMIT_UNKNOWN", "Die maximale Videolaufzeit des TikTok-Kontos ist unbekannt.");
      }
      if (duration > Number(creatorInfo.max_video_post_duration_sec)) {
        fail("TIKTOK_CREATOR_DURATION_EXCEEDED", "Das Video überschreitet die aktuelle Laufzeitgrenze des TikTok-Kontos.");
      }
      if (!Array.isArray(creatorInfo.privacy_level_options) || !creatorInfo.privacy_level_options.includes(metadata.privacyLevel)) {
        fail("TIKTOK_PRIVACY_NOT_ALLOWED", "Die TikTok-Sichtbarkeit muss ausdrücklich aus den aktuell erlaubten Optionen gewählt werden.");
      }
      if (typeof metadata.isAigc !== "boolean") fail("TIKTOK_AI_DISCLOSURE_REQUIRED", "Die KI-Kennzeichnung für TikTok muss ausdrücklich festgelegt werden.");
      for (const field of ["disableComment", "disableDuet", "disableStitch", "brandContentToggle", "brandOrganicToggle"]) {
        if (typeof metadata[field] !== "boolean") fail("TIKTOK_POST_OPTION_REQUIRED", `Die TikTok-Option ${field} muss ausdrücklich festgelegt werden.`);
      }
      if (requireConsent && metadata.confirmed !== true) fail("TIKTOK_CONSENT_REQUIRED", "Direct Post benötigt die ausdrückliche Bestätigung der veröffentlichenden Person.");
    }
  }

  return {
    fileSizeBytes: fileInfo.size,
    durationSeconds: duration,
    platform,
    mode,
  };
}
