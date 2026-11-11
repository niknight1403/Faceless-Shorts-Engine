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
