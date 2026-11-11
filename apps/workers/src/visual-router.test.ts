import test from "node:test";
import assert from "node:assert/strict";
import { PollinationsVisualProvider, VisualRouter } from "./visual-router.js";

test("Pollinations provider validates image response and returns bytes", async () => {
  const provider = new PollinationsVisualProvider(async () => new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "image/jpeg" } }));
  const result = await provider.generate({ prompt: "A mountain landscape" });
  assert.equal(result.provider, "pollinations-free");
  assert.equal(result.extension, "jpg");
  assert.equal(result.image.byteLength, 2048);
});
test("visual router fails closed when provider is unavailable", async () => {
  const router = new VisualRouter([{ id: "offline", async generate() { throw new Error("offline"); } }]);
  await assert.rejects(router.generate({ prompt: "test" }), /no_visual_route_available:offline:offline/);
});
