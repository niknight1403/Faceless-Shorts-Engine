import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export class MediaProviderError extends Error {
  constructor(code, message, publicMessage = "Der Medienanbieter hat eine ungültige Antwort geliefert.") {
    super(message);
    this.name = "MediaProviderError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export class MockMediaProvider {
  constructor({ baseUrl, timeoutMs = 15_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async healthCheck() {
    const response = await this.request("/health", { method: "GET" });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new MediaProviderError("PROVIDER_BAD_HEALTH", "Mock-Provider-Health-Antwort war kein JSON.");
    }
    if (!response.ok || body.status !== "ok") {
      throw new MediaProviderError("PROVIDER_UNHEALTHY", `Mock-Provider meldet keinen gesunden Status (${response.status}).`);
    }
    return { status: "ok" };
  }

  async fetchImage({ prompt, outputPath }) {
    const safePrompt = String(prompt || "scene").slice(0, 240);
    const response = await this.request(`/prompt/${encodeURIComponent(safePrompt)}`, { method: "GET" });
    return this.saveAsset(response, outputPath, "image/png");
  }

  async synthesizeSpeech({ text, outputPath }) {
    const response = await this.request("/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: String(text || "").slice(0, 2_000) }),
    });
    return this.saveAsset(response, outputPath, "audio/wav");
  }

  async request(route, options) {
    let response;
    try {
      response = await fetch(new URL(route, `${this.baseUrl}/`), {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout = error.name === "TimeoutError" || error.name === "AbortError";
      throw new MediaProviderError(
        timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        `Mock-Medienanbieter nicht erreichbar: ${error.message}`,
        timeout ? "Der Medienanbieter hat nicht rechtzeitig geantwortet." : "Der lokale Medienanbieter ist nicht erreichbar.",
      );
    }
    if (!response.ok) {
      throw new MediaProviderError(
        "PROVIDER_HTTP_ERROR",
        `Mock-Medienanbieter antwortete mit HTTP ${response.status}.`,
        "Der Medienanbieter konnte das Testmedium nicht bereitstellen.",
      );
    }
    return response;
  }

  async saveAsset(response, outputPath, expectedMimeType) {
    const actualMimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (actualMimeType !== expectedMimeType) {
      throw new MediaProviderError(
        "PROVIDER_BAD_CONTENT_TYPE",
        `Erwartet wurde ${expectedMimeType}, erhalten wurde ${actualMimeType || "kein Content-Type"}.`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_ASSET_BYTES) {
      throw new MediaProviderError("PROVIDER_ASSET_TOO_LARGE", `Asset überschreitet ${MAX_ASSET_BYTES} Bytes.`);
    }
    if (!response.body) throw new MediaProviderError("PROVIDER_EMPTY_BODY", "Provider-Antwort hatte keinen Body.");
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of response.body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_ASSET_BYTES) {
        throw new MediaProviderError("PROVIDER_ASSET_TOO_LARGE", `Asset überschreitet ${MAX_ASSET_BYTES} Bytes.`);
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    if (bytes.length === 0) {
      throw new MediaProviderError("PROVIDER_INVALID_ASSET_SIZE", `Ungültige Assetgröße: ${bytes.length} Bytes.`);
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes, { mode: 0o600 });
    return { mimeType: expectedMimeType, sizeBytes: bytes.length };
  }
}
