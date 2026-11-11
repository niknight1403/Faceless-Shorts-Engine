import test from "node:test";
import assert from "node:assert/strict";
import { TtsRouter, type TtsRoute } from "./tts-router.js";

test("TTS router falls back to next free provider", async () => {
  const routes: TtsRoute[] = [
    { id: "local-piper", async synthesize() { throw new Error("not-installed"); } },
    { id: "free-cloud", async synthesize() { return { provider: "free-cloud", mimeType: "audio/wav", extension: "wav", audio: Buffer.from("audio") }; } }
  ];
  const result = await new TtsRouter(routes).synthesize("Hallo Welt", "de");
  assert.equal(result.provider, "free-cloud");
  assert.equal(result.audio.toString(), "audio");
});

test("TTS router fails clearly when no free provider is configured", async () => {
  await assert.rejects(() => new TtsRouter([]).synthesize("Hallo", "de"), /no_free_tts_route_available/);
});

test("TTS router rejects non-audio provider payloads and tries the next route", async () => {
  const routes: TtsRoute[] = [
    { id: "bad-provider", async synthesize() { return { provider: "bad-provider", mimeType: "application/json", extension: "json", audio: Buffer.from("{}") }; } },
    { id: "valid-provider", async synthesize() { return { provider: "valid-provider", mimeType: "audio/wav", extension: "wav", audio: Buffer.from("RIFF-audio") }; } }
  ];
  const result = await new TtsRouter(routes).synthesize("Hallo", "de");
  assert.equal(result.provider, "valid-provider");
});

test("TTS router rejects payloads above the memory safety limit", async () => {
  const routes: TtsRoute[] = [
    { id: "oversized", async synthesize() { return { provider: "oversized", mimeType: "audio/wav", extension: "wav", audio: Buffer.alloc(25 * 1024 * 1024 + 1) }; } }
  ];
  await assert.rejects(() => new TtsRouter(routes).synthesize("Hallo", "de"), /audio_payload_too_large/);
});
