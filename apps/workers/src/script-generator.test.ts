import test from "node:test";
import assert from "node:assert/strict";
import { LocalScriptProvider, validateScript } from "./script-generator.js";

test("local provider creates ordered scenes matching requested runtime", async () => {
  const result = await new LocalScriptProvider().generate({ topic: "KI im Alltag", language: "de", targetDurationSeconds: 45 });
  assert.ok(result.scenes.length >= 3);
  assert.deepEqual(result.scenes.map(scene => scene.order), result.scenes.map((_, index) => index + 1));
  assert.equal(result.scenes.reduce((sum, scene) => sum + scene.durationMs, 0), 45_000);
});

test("validator rejects incomplete scenes", () => {
  assert.throws(() => validateScript({ title: "x", hook: "y", callToAction: "z", scenes: [] }, 30), /script_scene_count_invalid/);
});

test("provider clamps duration to supported bounds", async () => {
  const result = await new LocalScriptProvider().generate({ topic: "Test", language: "de", targetDurationSeconds: 2 });
  assert.equal(result.scenes.reduce((sum, scene) => sum + scene.durationMs, 0), 10_000);
});

test("validator rejects oversized narration and visual prompts before provider calls", async () => {
  const valid = await new LocalScriptProvider().generate({ topic: "Test", language: "de", targetDurationSeconds: 10 });
  const longNarration = structuredClone(valid);
  longNarration.scenes[0]!.narration = "x".repeat(1001);
  assert.throws(() => validateScript(longNarration, 10), /script_scene_invalid/);
  const longVisual = structuredClone(valid);
  longVisual.scenes[0]!.visualPrompt = "x".repeat(2001);
  assert.throws(() => validateScript(longVisual, 10), /script_scene_invalid/);
});

test("validator rejects malformed metadata types", async () => {
  const valid = await new LocalScriptProvider().generate({ topic: "Test", language: "de", targetDurationSeconds: 10 });
  const malformed = { ...valid, title: 42 } as unknown as typeof valid;
  assert.throws(() => validateScript(malformed, 10), /script_metadata_invalid/);
});
