import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const execFileAsync = promisify(execFile);
export interface TtsResult { provider: string; mimeType: string; extension: string; audio: Buffer }
type TtsRoute = { id: string; synthesize(text: string, language: string): Promise<TtsResult> };
const env = (name: string) => process.env[name]?.trim() || undefined;

function createRoutes(): TtsRoute[] {
  const routes: TtsRoute[] = [];
  const piperModel = env("PIPER_MODEL");
  if (piperModel) routes.push({ id: "piper-local", async synthesize(text) {
    const dir = await mkdtemp(join(tmpdir(), "faceless-piper-"));
    const output = join(dir, "speech.wav");
    try {
      await execFileAsync(env("PIPER_BIN") ?? "piper", ["--model", piperModel, "--output_file", output], { input: text, timeout: 120_000, maxBuffer: 1024 * 1024 });
      return { provider: "piper-local", mimeType: "audio/wav", extension: "wav", audio: await readFile(output) };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }});
  const kokoroUrl = env("KOKORO_TTS_BASE_URL");
  if (kokoroUrl && env("KOKORO_TTS_VOICE")) routes.push({ id: "kokoro-local", async synthesize(text) {
    const response = await fetch(`${kokoroUrl.replace(/\\/+$/, "")}/audio/speech`, {
      method: "POST", headers: { "content-type": "application/json", ...(env("KOKORO_TTS_API_KEY") ? { authorization: `Bearer ${env("KOKORO_TTS_API_KEY")}` } : {}) },
      body: JSON.stringify({ model: env("KOKORO_TTS_MODEL") ?? "kokoro", input: text, voice: env("KOKORO_TTS_VOICE"), response_format: "wav" }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw new Error(`kokoro_http_${response.status}`);
    return { provider: "kokoro-local", mimeType: response.headers.get("content-type") ?? "audio/wav", extension: "wav", audio: Buffer.from(await response.arrayBuffer()) };
  }});
  if (env("TTS_AI_ENABLED") !== "false") routes.push({ id: "tts-ai-free", async synthesize(text, language) {
    if (text.length > 500) throw new Error("tts_ai_anonymous_limit_500_chars");
    const response = await fetch("https://api.tts.ai/v1/tts/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "piper", text, voice: env("TTS_AI_VOICE") ?? "de_DE-thorsten-medium", language, format: "wav" }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) throw new Error(`tts_ai_http_${response.status}`);
    return { provider: "tts-ai-free", mimeType: response.headers.get("content-type") ?? "audio/wav", extension: "wav", audio: Buffer.from(await response.arrayBuffer()) };
  }});
  return routes;
}

/** Free-only TTS cascade. A provider is used only when configured or explicitly listed here. */
export class TtsRouter {
  constructor(private readonly routes: TtsRoute[] = createRoutes()) {}
  availableRoutes(): string[] { return this.routes.map(route => route.id); }
  async synthesize(text: string, language: string): Promise<TtsResult> {
    const errors: string[] = [];
    for (const route of this.routes) {
      try {
        const result = await route.synthesize(text, language);
        if (!result.audio.length) throw new Error("empty_audio");
        return result;
      } catch (error) { errors.push(`${route.id}:${error instanceof Error ? error.message : "failed"}`); }
    }
    throw new Error(`no_free_tts_route_available:${errors.join("|") || "no_routes_configured"}`);
  }
}
