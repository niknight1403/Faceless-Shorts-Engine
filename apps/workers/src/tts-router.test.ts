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
