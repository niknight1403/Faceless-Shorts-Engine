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

test("Publishing akzeptiert nur die dokumentierten Loopback-Adressen", () => {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(enabled({ HOST: host }).host, host);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
    assert.throws(() => enabled({ HOST: host }), /Loopback-Adresse/);
  }
});

test("Fehlende oder ungültige Schlüssel werden ohne Rückgabe ihrer Werte abgewiesen", () => {
  const cases = [
    { overrides: { PUBLISHING_API_KEY: "" }, expected: /PUBLISHING_API_KEY/ },
    { overrides: { PUBLISHING_TOKEN_KEY: "" }, expected: /PUBLISHING_TOKEN_KEY/ },
    { overrides: { PUBLISHING_API_KEY: "synthetic-short-key-value" }, expected: /PUBLISHING_API_KEY/ },
    { overrides: { PUBLISHING_TOKEN_KEY: "synthetic-invalid-token-key" }, expected: /PUBLISHING_TOKEN_KEY/ },
  ];

  for (const { overrides, expected } of cases) {
    let message = "";
    assert.throws(() => enabled(overrides), error => {
      message = error.message;
      assert.match(message, expected);
      return true;
    });
    for (const value of Object.values(overrides).filter(Boolean)) {
      assert.equal(message.includes(value), false);
    }
    assert.equal(message.includes(apiKey), false);
    assert.equal(message.includes(tokenKey), false);
  }
});

test("OAuth- und TikTok-Gates aktivieren Publishing nicht ohne Hauptschalter", () => {
  const config = loadConfig({
    PUBLISHING_API_KEY: apiKey,
    PUBLISHING_TOKEN_KEY: tokenKey,
    YOUTUBE_OAUTH_CLIENT_ID: "synthetic-youtube-client",
    YOUTUBE_OAUTH_CLIENT_SECRET: "synthetic-youtube-secret",
    YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/callback",
    TIKTOK_UPLOAD_APPROVED: "true",
    TIKTOK_DIRECT_POST_APPROVED: "true",
  });
  assert.equal(config.publishingEnabled, false);
  assert.equal(config.tiktokUploadApproved, true);
  assert.equal(config.tiktokDirectPostApproved, true);
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
