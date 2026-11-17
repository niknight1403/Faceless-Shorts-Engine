import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.mjs";

const tokenKey = Buffer.alloc(32, 0x5a).toString("base64url");
const apiKey = "local-publishing-api-key-that-is-long-enough";

function enabled(overrides = {}) {
  return loadConfig({
    PUBLISHING_ENABLED: "true",
    PUBLISHING_API_KEY: apiKey,
    PUBLISHING_TOKEN_KEY: tokenKey,
    HOST: "127.0.0.1",
    ...overrides,
  });
}

test("Publishing ist standardmäßig ausgeschaltet", () => {
  assert.equal(loadConfig({}).publishingEnabled, false);
  assert.throws(() => loadConfig({ PUBLISHING_ENABLED: "yes" }), /true oder false/);
});

test("Aktiviertes Publishing benötigt starke Schlüssel und Loopback-Bindung", () => {
  assert.equal(enabled().publishingEnabled, true);
  assert.throws(() => enabled({ PUBLISHING_API_KEY: "short" }), /mindestens 32 Zeichen/);
  assert.throws(() => enabled({ PUBLISHING_TOKEN_KEY: "not-a-key" }), /32-Byte-Schlüssel/);
  assert.throws(() => enabled({ HOST: "0.0.0.0" }), /Loopback-Adresse/);
});

test("OAuth-Zugangsdaten und Publishing-Datenpfad werden getrennt konfiguriert", () => {
  const config = enabled({
    PUBLISHING_DATA_DIR: "/tmp/publishing-test",
    YOUTUBE_OAUTH_CLIENT_ID: "yt-id",
    YOUTUBE_OAUTH_CLIENT_SECRET: "yt-secret",
    YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/connections/youtube/oauth/callback",
    TIKTOK_DIRECT_POST_APPROVED: "false",
  });
  assert.equal(config.publishingDataDir, "/tmp/publishing-test");
  assert.equal(config.oauth.youtube.clientId, "yt-id");
  assert.equal(config.tiktokDirectPostApproved, false);
});
