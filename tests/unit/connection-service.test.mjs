import assert from "node:assert/strict";
import test from "node:test";
import { PlatformConnectionService } from "../../src/publishing/connection-service.mjs";
import { OAuthProviderClient } from "../../src/publishing/oauth.mjs";

function fixture({ scopes = "user.info.basic,video.upload", directPostApproved = true, uploadApproved = true } = {}) {
  const saved = [];
  const clients = new Map();
  const vault = {
    put: async entry => { saved.push(entry); return { id: entry.id, platform: entry.platform, accountId: entry.accountId }; },
    get: () => null,
  };
  const tokenManager = { disconnect: async () => true };
  const service = new PlatformConnectionService({
    config: { tiktokDirectPostApproved: directPostApproved, tiktokUploadApproved: uploadApproved },
    vault,
    tokenManager,
    clientFactory: platform => {
      if (!clients.has(platform)) clients.set(platform, {
        redirectUri: `http://127.0.0.1/${platform}/callback`,
        authorizationUrl: options => {
          const url = new URL("https://oauth.example/authorize");
          url.searchParams.set("scope", options.scopes.join(","));
          url.searchParams.set("state", options.state);
          return url.toString();
        },
        exchangeCode: async () => ({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600, scope: typeof scopes === "function" ? scopes() : scopes, open_id: "creator-1", display_name: "Demo" }),
        revoke: async () => {},
      });
      return clients.get(platform);
    },
  });
  return { service, saved };
}

test("TikTok OAuth-State bindet den Upload-Modus und verlangt genau die nötigen Scopes", async () => {
  const { service, saved } = fixture({ scopes: "user.info.basic, video.upload" });
  const started = service.start("tiktok", { mode: "upload" });
  const authorizationUrl = new URL(started.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("scope"), "user.info.basic,video.upload");
  const connection = await service.finish("tiktok", { code: "authorization-code", state: started.state });
  assert.equal(connection.platform, "tiktok");
  assert.equal(saved[0].accountId, "creator-1");
});

test("TikTok Direct Post erkennt fehlenden Scope unabhängig von den erteilten Scopes", async () => {
  const { service, saved } = fixture({ scopes: "user.info.basic,video.upload" });
  const started = service.start("tiktok", { mode: "direct_post" });
  assert.equal(new URL(started.authorizationUrl).searchParams.get("scope"), "user.info.basic,video.publish");
  await assert.rejects(
    () => service.finish("tiktok", { code: "authorization-code", state: started.state }),
    { code: "OAUTH_SCOPE_MISSING", statusCode: 403 },
  );
  assert.equal(saved.length, 0);
});

test("TikTok Direct Post ist ohne explizite App-Freigabe deaktiviert", () => {
  const { service } = fixture({ directPostApproved: false });
  assert.throws(() => service.start("tiktok", { mode: "direct_post" }), { code: "TIKTOK_DIRECT_POST_DISABLED", statusCode: 403 });
});

test("TikTok Inbox-Upload ist ohne App-Freigabe deaktiviert", () => {
  const { service } = fixture({ uploadApproved: false });
  assert.throws(() => service.start("tiktok", { mode: "upload" }), { code: "TIKTOK_UPLOAD_DISABLED", statusCode: 403 });
});

test("Callback-Abbruch verbraucht und prüft den State vor der Meldung", async () => {
  const { service } = fixture();
  const started = service.start("tiktok", { mode: "upload" });
  await assert.rejects(
    () => service.finish("tiktok", { state: started.state, providerError: "access_denied" }),
    { code: "OAUTH_PROVIDER_DENIED" },
  );
  await assert.rejects(
    () => service.finish("tiktok", { state: started.state, providerError: "access_denied" }),
    { code: "OAUTH_STATE_INVALID" },
  );
});

test("TikTok OAuthProviderClient entpackt die offizielle data-Antwort", async () => {
  const client = new OAuthProviderClient({
    platform: "tiktok",
    clientId: "client-key",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1/callback",
    fetchImpl: async () => new Response(JSON.stringify({
      data: { access_token: "access", refresh_token: "refresh", open_id: "creator", scope: "user.info.basic,video.upload" },
      error: { code: "ok", message: "", log_id: "redacted" },
    }), { status: 200 }),
  });
  const token = await client.exchangeCode("code");
  assert.equal(token.access_token, "access");
  assert.equal(token.open_id, "creator");
  assert.equal(token.scope, "user.info.basic,video.upload");
});
