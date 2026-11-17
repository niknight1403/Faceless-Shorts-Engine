import assert from "node:assert/strict";
import test from "node:test";
import { retryDelayMs, withBoundedRetry } from "../../src/publishing/retry.mjs";

test("Retry-Hilfe begrenzt Versuche und verwendet exponentielles, injizierbares Backoff", async () => {
  let calls = 0;
  const waits = [];
  const events = [];
  const result = await withBoundedRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("transient");
      error.code = "TEMPORARY_NETWORK";
      error.retryable = true;
      throw error;
    }
    return "ok";
  }, {
    platform: "youtube",
    action: "video-status",
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 15,
    wait: async delay => waits.push(delay),
    onRetry: async event => events.push(event),
  });

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 15]);
  assert.deepEqual(events.map(({ platform, action, attempt, delayMs, errorCode }) => ({ platform, action, attempt, delayMs, errorCode })), [
    { platform: "youtube", action: "video-status", attempt: 1, delayMs: 10, errorCode: "TEMPORARY_NETWORK" },
    { platform: "youtube", action: "video-status", attempt: 2, delayMs: 15, errorCode: "TEMPORARY_NETWORK" },
  ]);
  assert.equal(retryDelayMs(4, { baseDelayMs: 10, maxDelayMs: 25 }), 25);
});

test("Retry-Hilfe stoppt am Limit und wiederholt endgültige Authfehler nicht", async () => {
  let calls = 0;
  const waits = [];
  const retryable = Object.assign(new Error("temporary"), { code: "TEMPORARY", retryable: true });
  await assert.rejects(() => withBoundedRetry(async () => {
    calls += 1;
    throw retryable;
  }, { platform: "tiktok", action: "status-fetch", maxAttempts: 3, baseDelayMs: 5, wait: async delay => waits.push(delay) }), error => {
    assert.equal(error, retryable);
    assert.equal(error.retryAttempts, 3);
    assert.equal(error.retryExhausted, true);
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);

  let authCalls = 0;
  const authError = Object.assign(new Error("forbidden"), { code: "AUTH_REVOKED", retryable: false });
  await assert.rejects(() => withBoundedRetry(async () => {
    authCalls += 1;
    throw authError;
  }, { platform: "youtube", action: "video-status", wait: async () => assert.fail("kein Backoff für Authfehler") }), { code: "AUTH_REVOKED" });
  assert.equal(authCalls, 1);
  assert.equal(authError.retryAttempts, 1);
});
