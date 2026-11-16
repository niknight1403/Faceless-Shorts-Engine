import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJsonBody } from "./http-body.js";

test("JSON body parser preserves UTF-8 characters split across network chunks", async () => {
  const bytes = Buffer.from(JSON.stringify({ topic: "Grüße aus Köln 🌍" }));
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  const request = Readable.from(chunks);
  const parsed = await readJsonBody<{ topic: string }>(request);
  assert.equal(parsed.topic, "Grüße aus Köln 🌍");
});

test("JSON body parser enforces its limit using raw byte length", async () => {
  const request = Readable.from([Buffer.alloc(8), Buffer.alloc(9)]);
  await assert.rejects(() => readJsonBody(request, 16), /body_too_large/);
});

test("JSON body parser maps an empty body to an empty object", async () => {
  const parsed = await readJsonBody<Record<string, unknown>>(Readable.from([]));
  assert.deepEqual(parsed, {});
});

test("JSON body parser rejects malformed JSON", async () => {
  await assert.rejects(() => readJsonBody(Readable.from(["{broken"])), SyntaxError);
});
