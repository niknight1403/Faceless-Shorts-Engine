import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedResponse } from "./http-response.js";

test("bounded response reader returns complete small payloads", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } });
  const result = await readBoundedResponse(response, 16, "payload");
  assert.deepEqual([...result], [1, 2, 3]);
});

test("bounded response reader rejects oversized content-length before buffering", async () => {
  const response = new Response(new Uint8Array(128), { headers: { "content-length": "128" } });
  await assert.rejects(() => readBoundedResponse(response, 64, "audio_payload"), /audio_payload_too_large/);
});

test("bounded response reader cancels chunked streams once the limit is exceeded", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40));
      controller.enqueue(new Uint8Array(40));
    },
    cancel() { cancelled = true; }
  });
  const response = new Response(body);
  await assert.rejects(() => readBoundedResponse(response, 64, "visual_provider_image"), /visual_provider_image_too_large/);
  assert.equal(cancelled, true);
});

test("bounded response reader rejects empty bodies", async () => {
  await assert.rejects(() => readBoundedResponse(new Response(null), 64, "payload"), /payload_empty_body/);
});
