import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, hashSessionToken, verifyPassword } from "./auth.js";

const knownHash = "scrypt$16384$8$1$00112233445566778899aabbccddeeff$8790852f0ed9b776ec52cc470a780af8a3c38d9f0b13fcc29cc5a8ff902a3f1dcbb8e2808a4d570158466644a9686b90191bd1fae2c3bfa9bc16a7d80f829673";

test("verifies bootstrap scrypt hashes and rejects wrong passwords", async () => {
  assert.equal(await verifyPassword("TestPassword-2026!", knownHash), true);
  assert.equal(await verifyPassword("wrong-password", knownHash), false);
  assert.equal(await verifyPassword("TestPassword-2026!", null), false);
});

test("session tokens are random opaque values and stored as one-way hashes", () => {
  const first = createSessionToken(), second = createSessionToken();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,60}$/);
  assert.notEqual(hashSessionToken(first), first);
  assert.equal(hashSessionToken(first), hashSessionToken(first));
  assert.notEqual(hashSessionToken(first), hashSessionToken(second));
});
