import { readBoundedResponse } from "./http-response.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function runPiper(binary: string, model: string, output: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--model", model, "--output_file", output], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("piper_exit_" + code + ":" + stderr.slice(0, 500))));
    child.stdin.end(text);
  });
}
export interface TtsResult { provider: string; mimeType: string; extension: string; audio: Buffer }
export interface TtsRoute { id: string; synthesize(text: string, language: string): Promise<TtsResult> }
const env = (name: string) => process.env[name]?.trim() || undefined;
let lastTtsAiRequestAt = 0;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function createRoutes(): TtsRoute[] {
  const routes: TtsRoute[] = [];
  const piperModel = env("PIPER_MODEL");
  if (piperModel) routes.push({ id: "piper-local", async synthesize(text) {
    const dir = await mkdtemp(join(tmpdir(), "faceless-piper-"));
    const output = join(dir, "speech.wav");
    try {
      await runPiper(env("PIPER_BIN") ?? "piper", piperModel, output, text);
      return { provider: "piper-local", mimeType: "audio/wav", extension: "wav", audio: await readFile(output) };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }});
  const kokoroUrl = env("KOKORO_TTS_BASE_URL");
  if (kokoroUrl && env("KOKORO_TTS_VOICE")) routes.push({ id: "kokoro-local", async synthesize(text) {
    const response = await fetch(kokoroUrl.replace(/\/+$/, "") + "/audio/speech", {
      method: "POST", headers: { "content-type": "application/json", ...(env("KOKORO_TTS_API_KEY") ? { authorization: "Bearer " + env("KOKORO_TTS_API_KEY") } : {}) },
      body: JSON.stringify({ model: env("KOKORO_TTS_MODEL") ?? "kokoro", input: text, voice: env("KOKORO_TTS_VOICE"), response_format: "wav" }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw new Error("kokoro_http_" + response.status);
    return { provider: "kokoro-local", mimeType: response.headers.get("content-type") ?? "audio/wav", extension: "wav", audio: await readBoundedResponse(response, 26214400, "audio_payload") };
  }});
  const openRouterKey = env("OPENROUTER_API_KEY"), openRouterTtsModel = env("OPENROUTER_TTS_MODEL");
  if (openRouterKey && openRouterTtsModel?.endsWith(":free") && env("OPENROUTER_TTS_VOICE")) routes.push({ id: "openrouter-free-tts", async synthesize(text) {
    const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + openRouterKey, "HTTP-Referer": "https://github.com/niknight1403/Faceless-Shorts-Engine", "X-Title": "Faceless Shorts Engine" },
      body: JSON.stringify({ model: openRouterTtsModel, input: text, voice: env("OPENROUTER_TTS_VOICE"), response_format: "wav" }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw new Error("openrouter_tts_http_" + response.status);
    const mimeType = response.headers.get("content-type") ?? "audio/wav";
    return { provider: "openrouter-free-tts", mimeType, extension: mimeType.includes("mpeg") ? "mp3" : "wav", audio: await readBoundedResponse(response, 25 * 1024 * 1024, "audio_payload") };
  }});
  if (env("TTS_AI_ENABLED") !== "false") routes.push({ id: "tts-ai-free", async synthesize(text, language) {
    if (text.length > 500) throw new Error("tts_ai_anonymous_limit_500_chars");
    const waitMs = Math.max(0, 6_100 - (Date.now() - lastTtsAiRequestAt));
    if (waitMs) await delay(waitMs);
    lastTtsAiRequestAt = Date.now();
    const response = await fetch("https://api.tts.ai/v1/tts/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "piper", text, voice: env("TTS_AI_VOICE") ?? "de_DE-thorsten-medium", language, format: "wav" }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw new Error("tts_ai_http_" + response.status);
    return { provider: "tts-ai-free", mimeType: response.headers.get("content-type") ?? "audio/wav", extension: "wav", audio: Buffer.from(await response.arrayBuffer()) };
  }});
  return routes;
}

/** Free-only TTS cascade. Paid model IDs are never admitted. */
export class TtsRouter {
  constructor(private readonly routes: TtsRoute[] = createRoutes()) {}
  availableRoutes(): string[] { return this.routes.map(route => route.id); }
  async synthesize(text: string, language: string): Promise<TtsResult> {
    const errors: string[] = [];
    for (const route of this.routes) {
      try {
        const result = await route.synthesize(text, language);
        if (!result.audio.length) throw new Error("empty_audio");
        if (result.audio.byteLength > 25 * 1024 * 1024) throw new Error("audio_payload_too_large");
        if (!/^audio\/[a-z0-9.+-]+$/i.test(result.mimeType.split(";")[0]!.trim())) {
          throw new Error("unsupported_audio_content_type:" + result.mimeType.slice(0, 100));
        }
        if (!/^[a-z0-9]{2,5}$/i.test(result.extension)) throw new Error("invalid_audio_extension");
        return result;
      } catch (error) { errors.push(route.id + ":" + (error instanceof Error ? error.message : "failed")); }
    }
    throw new Error("no_free_tts_route_available:" + (errors.join("|") || "no_routes_configured"));
  }
}
