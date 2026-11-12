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

test("visual provider rejects unbounded image dimensions before network access", async () => {
  let requested = false;
  const provider = new PollinationsVisualProvider(async () => {
    requested = true;
    return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  await assert.rejects(() => provider.generate({ prompt: "A scene", width: 8192, height: 1280 }), /visual_dimensions_must_be_integers/);
  assert.equal(requested, false);
});

test("visual provider rejects empty or excessively long prompts", async () => {
  const provider = new PollinationsVisualProvider(async () => {
    throw new Error("network_must_not_be_called");
  });
  await assert.rejects(() => provider.generate({ prompt: " " }), /visual_prompt_must_be_1_to_2000_characters/);
  await assert.rejects(() => provider.generate({ prompt: "x".repeat(2001) }), /visual_prompt_must_be_1_to_2000_characters/);
});

test("visual provider supports a configured endpoint for deterministic deployments", async () => {
  const original = process.env.VISUALS_BASE_URL;
  let requestedUrl = "";
  process.env.VISUALS_BASE_URL = "http://mock-providers:4010/prompt/";
  try {
    const provider = new PollinationsVisualProvider(async (input) => {
      requestedUrl = String(input);
      return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "image/png" } });
    });
    await provider.generate({ prompt: "A test scene" });
    assert.match(requestedUrl, /^http:\/\/mock-providers:4010\/prompt\/A%20test%20scene/);
    assert.match(requestedUrl, /width=720&height=1280/);
  } finally {
    if (original === undefined) delete process.env.VISUALS_BASE_URL;
    else process.env.VISUALS_BASE_URL = original;
  }
});
