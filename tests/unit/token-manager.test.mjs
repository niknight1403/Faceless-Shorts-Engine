import assert from "node:assert/strict";
import test from "node:test";
import { OAuthProviderClient } from "../../src/publishing/oauth.mjs";
import { OAuthTokenManager } from "../../src/publishing/token-manager.mjs";

const now = Date.UTC(2026, 10, 17);

function expiredConnection() {
  return {
    id: "youtube:channel-1",
    platform: "youtube",
    accountId: "channel-1",
    displayName: "Demo channel",
    scopes: ["youtube.upload", "youtube.readonly"],
    accessToken: "old-access-secret",
    refreshToken: "old-refresh-secret",
    accessTokenExpiresAt: new Date(now - 1_000).toISOString(),
    refreshTokenExpiresAt: new Date(now - 1_000).toISOString(),
  };
}

test("OAuthTokenManager refreshes expiring tokens and persists rotated TikTok refresh token", async () => {
  let saved;
  let refreshCalls = 0;
  const vault = {
    get: () => ({ id: "tiktok:user-1", platform: "tiktok", accountId: "user-1", displayName: "Creator", scopes: ["video.upload"], accessToken: "old-access", refreshToken: "old-refresh", accessTokenExpiresAt: new Date(now + 5_000).toISOString(), refreshTokenExpiresAt: null }),
    put: async connection => { saved = connection; },
  };
  const manager = new OAuthTokenManager({
    vault,
    now: () => now,
    refreshSkewMs: 10_000,
    clientFactory: () => ({ refresh: async token => { refreshCalls += 1; assert.equal(token, "old-refresh"); await new Promise(resolve => setTimeout(resolve, 2)); return { access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 86400, refresh_expires_in: 31536000, scope: "video.upload,video.publish" }; } }),
  });
  const [one, two] = await Promise.all([manager.getAccessToken("tiktok:user-1"), manager.getAccessToken("tiktok:user-1")]);
  assert.equal(one, "new-access");
  assert.equal(two, "new-access");
  assert.equal(refreshCalls, 1);
  assert.equal(saved.refreshToken, "rotated-refresh");
  assert.deepEqual(saved.scopes, ["video.upload", "video.publish"]);
  assert.equal(Date.parse(saved.accessTokenExpiresAt), now + 86_400_000);
});

test("abgelehnter Refresh-Token wird lokal entfernt und verlangt erneute Verbindung ohne Secret-Leak", async () => {
  let connection = expiredConnection();
  let removeCalls = 0;
  const vault = {
    get: () => connection,
    remove: async id => { assert.equal(id, connection.id); removeCalls += 1; connection = null; return true; },
  };
  const client = new OAuthProviderClient({
    platform: "youtube",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://127.0.0.1/callback",
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "rejected old-refresh-secret" }), { status: 400 }),
  });
  const manager = new OAuthTokenManager({ vault, now: () => now, clientFactory: () => client });

  await assert.rejects(() => manager.getAccessToken("youtube:channel-1"), error => {
    assert.equal(error.code, "REAUTHENTICATION_REQUIRED");
    assert.equal(error.statusCode, 401);
    assert.equal(error.message.includes("old-refresh-secret"), false);
    assert.equal(error.message.includes("test-client-secret"), false);
    return true;
  });
  assert.equal(removeCalls, 1);
  assert.equal(connection, null);
});

test("vorübergehender Refresh-Ausfall erhält lokale Tokens und meldet einen redigierten Fehler", async () => {
  const connection = expiredConnection();
  let removeCalls = 0;
  const vault = { get: () => connection, remove: async () => { removeCalls += 1; return true; } };
  const client = new OAuthProviderClient({
    platform: "youtube",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://127.0.0.1/callback",
    fetchImpl: async () => new Response(JSON.stringify({ error: "server_error", error_description: "temporary failure old-refresh-secret" }), { status: 503 }),
  });
  const manager = new OAuthTokenManager({ vault, now: () => now, clientFactory: () => client });

  await assert.rejects(() => manager.getAccessToken(connection.id), error => {
    assert.equal(error.code, "TOKEN_REFRESH_FAILED");
    assert.equal(error.statusCode, 502);
    assert.equal(error.message.includes("old-refresh-secret"), false);
    return true;
  });
  assert.equal(removeCalls, 0);
  assert.equal(vault.get(connection.id).refreshToken, "old-refresh-secret");
});

test("Disconnect entfernt lokale Tokens vor erfolgreichem Provider-Widerruf", async () => {
  let connection = expiredConnection();
  const order = [];
  const vault = {
    get: () => connection,
    remove: async () => { order.push("remove"); connection = null; return true; },
  };
  const manager = new OAuthTokenManager({
    vault,
    clientFactory: () => ({ revoke: async token => { order.push("revoke"); assert.equal(token, "old-access-secret"); } }),
  });

  assert.equal(await manager.disconnect("youtube:channel-1"), true);
  assert.deepEqual(order, ["remove", "revoke"]);
  assert.equal(connection, null);
});

test("fehlgeschlagener Provider-Widerruf meldet lokales Disconnect und behält kein Secret", async () => {
  let connection = expiredConnection();
  const vault = {
    get: () => connection,
    remove: async () => { connection = null; return true; },
  };
  const manager = new OAuthTokenManager({
    vault,
    clientFactory: () => ({ revoke: async () => { throw new Error("provider error old-access-secret"); } }),
  });

  await assert.rejects(() => manager.disconnect("youtube:channel-1"), error => {
    assert.equal(error.code, "CONNECTION_DISCONNECTED_REVOCATION_FAILED");
    assert.equal(error.statusCode, 502);
    assert.equal(error.message.includes("old-access-secret"), false);
    return true;
  });
  assert.equal(connection, null);
});
