import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

function mediaError(code, message) {
  const error = new Error(message);
  error.name = "MediaIdentityError";
  error.code = code;
  error.statusCode = 409;
  return error;
}

function fileSignature(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
}

function copyMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Videometadaten müssen ein Objekt sein.");
  }
  const json = JSON.stringify(metadata);
  if (json === undefined) throw new TypeError("Videometadaten sind nicht serialisierbar.");
  return JSON.parse(json);
}

export async function captureMediaSnapshot(filePath, videoMetadata) {
  let file;
  try {
    file = await open(filePath, "r");
  } catch {
    throw mediaError("SOURCE_MEDIA_UNAVAILABLE", "Die fertige Videodatei ist nicht verfügbar.");
  }

  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n) {
      throw mediaError("SOURCE_MEDIA_INVALID", "Die fertige Videodatei ist leer oder ungültig.");
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw mediaError("SOURCE_MEDIA_SIZE_INVALID", "Die Videodatei ist für einen sicheren Snapshot zu groß.");
    }

    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);

    const after = await file.stat({ bigint: true });
    const pathAfter = await stat(filePath, { bigint: true });
    if (fileSignature(before) !== fileSignature(after) || fileSignature(before) !== fileSignature(pathAfter)) {
      throw mediaError("SOURCE_MEDIA_CHANGED_DURING_SNAPSHOT", "Die Videodatei wurde während der Identitätsprüfung geändert.");
    }

    return {
      sha256: hash.digest("hex"),
      sizeBytes: Number(before.size),
      videoMetadata: copyMetadata(videoMetadata),
    };
  } finally {
    await file.close();
  }
}

export async function assertMediaSnapshot(filePath, videoMetadata, expectedSnapshot) {
  if (!expectedSnapshot || typeof expectedSnapshot.sha256 !== "string" || !Number.isSafeInteger(expectedSnapshot.sizeBytes)) {
    throw mediaError("MEDIA_SNAPSHOT_MISSING", "Für diesen Publishing-Auftrag fehlt ein gültiger Medien-Snapshot.");
  }
  const actual = await captureMediaSnapshot(filePath, videoMetadata);
  if (
    actual.sha256 !== expectedSnapshot.sha256 ||
    actual.sizeBytes !== expectedSnapshot.sizeBytes ||
    !isDeepStrictEqual(actual.videoMetadata, expectedSnapshot.videoMetadata)
  ) {
    throw mediaError("MEDIA_IDENTITY_MISMATCH", "Die Quelldatei oder ihre Exportmetadaten haben sich seit dem Preflight geändert. Bitte Auftrag erneut prüfen.");
  }
  return true;
}
