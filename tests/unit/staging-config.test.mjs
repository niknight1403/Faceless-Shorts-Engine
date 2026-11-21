import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.mjs";

test("Staging- und production-safe-Profile bleiben lokal und ohne Publishing", () => {
  for (const profile of ["staging", "production-safe"]) {
    const config = loadConfig({ APP_PROFILE: profile });
    assert.equal(config.profile, profile);
    assert.equal(config.runtimeMode, "synthetic-staging");
    assert.equal(config.providerAdapter, "mock-http");
    assert.equal(config.storageAdapter, "local-filesystem");
    assert.equal(config.livePublishingAllowed, false);
    assert.equal(config.publishingEnabled, false);
  }
});

test("Staging lehnt aktiviertes Publishing und externe Provider ab", () => {
  assert.throws(() => loadConfig({ APP_PROFILE: "staging", PUBLISHING_ENABLED: "true" }), /deaktiviert bleiben/);
  assert.throws(() => loadConfig({ APP_PROFILE: "staging", MOCK_MEDIA_URL: "https://provider.example.test" }), /lokalen Mock/);
  assert.throws(() => loadConfig({ APP_PROFILE: "unknown" }), /APP_PROFILE/);
});

test("Development bleibt der rückwärtskompatible Standard", () => {
  const config = loadConfig({});
  assert.equal(config.profile, "development");
  assert.equal(config.runtimeMode, "local-development");
  assert.equal(config.publishingEnabled, false);
});
