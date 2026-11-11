import test from "node:test";
import assert from "node:assert/strict";
import { createSrt } from "./video-renderer.js";

test("SRT captions preserve scene order and cumulative timing", () => {
  const srt = createSrt([
    { imagePath: "a.jpg", audioPath: "a.wav", durationMs: 1500, narration: "Erste Szene" },
    { imagePath: "b.jpg", audioPath: "b.wav", durationMs: 2500, narration: "Zweite Szene" }
  ]);
  assert.match(srt, /00:00:00,000 --> 00:00:01,500/);
  assert.match(srt, /00:00:01,500 --> 00:00:04,000/);
  assert.ok(srt.indexOf("Erste Szene") < srt.indexOf("Zweite Szene"));
});
