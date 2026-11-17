import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenVault } from "../../src/publishing/token-vault.mjs";
import { OAuthProviderClient, OAuthStateStore } from "../../src/publishing/oauth.mjs";

const key = Buffer.alloc(32, 0x37);

test("TokenVault verschlüsselt persistente Tokens und listet nie Geheimnisse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-token-vault-"));
  const filePath = join(directory, "tokens.json");
  try {
    const vault = await new TokenVault({ filePath, key }).initialize();
    await vault.put({ id: "youtube:channel-1", platform: "youtube", accountId: "channel-1", displayName: "Testkanal", scopes: ["youtube.upload"], accessToken: "secret-access", refreshToken: "secret-refresh" });
    const serialized = await readFile(filePath, "utf8");
    assert.equal(serialized.includes("secret-access"), false);
    assert.equal(serialized.includes("secret-refresh"), false);
    assert.equal(vault.list()[0].accessToken, undefined);
    assert.equal(vault.get("youtube:channel-1").refreshToken, "secret-refresh");
    const wrongKeyVault = await new TokenVault({ filePath, key: Buffer.alloc(32, 0x38) }).initialize();
    assert.throws(() => wrongKeyVault.get("youtube:channel-1"), /nicht entschlüsselt werden/);

    await vault.put({ id: "youtube:channel-1", platform: "youtube", accountId: "channel-1", accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    const reloaded = await new TokenVault({ filePath, key }).initialize();
    assert.equal(reloaded.get("youtube:channel-1").accessToken, "rotated-access");
    assert.equal(await reloaded.remove("youtube:channel-1"), true);
    assert.equal(reloaded.get("youtube:channel-1"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuthStateStore bindet State an Plattform, Redirect und nur einmalige Nutzung", () => {
  let now = 1_000;
  const states = new OAuthStateStore({ ttlMs: 5_000, now: () => now });
  const state = states.issue({ platform: "youtube", redirectUri: "http://127.0.0.1/callback" });
  assert.equal(states.consume(state, "youtube").redirectUri, "http://127.0.0.1/callback");
  assert.throws(() => states.consume(state, "youtube"), { code: "OAUTH_STATE_INVALID" });
  const expired = states.issue({ platform: "tiktok", redirectUri: "https://example.test/callback" });
  now += 5_001;
  assert.throws(() => states.consume(expired, "tiktok"), { code: "OAUTH_STATE_INVALID" });
});

test("OAuthProviderClient baut scopesichere URLs und behandelt Tokenantworten ohne Token-Leaks", async () => {
  const calls = [];
  const client = new OAuthProviderClient({
    platform: "youtube",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1/callback",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 });
    },
  });
  const authorization = new URL(client.authorizationUrl({ state: "random-state", forceConsent: true }));
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("state"), "random-state");
  assert.equal(authorization.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.upload");
  const tokens = await client.exchangeCode("auth-code");
  assert.equal(tokens.refresh_token, "refresh");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /oauth2.googleapis.com\/token/);
});

test("TokenVault behält den letzten gespeicherten Zustand bei fehlgeschlagener Ersetzung oder Entfernung", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-token-vault-atomic-"));
  const filePath = join(directory, "tokens.json");
  try {
    const vault = await new TokenVault({ filePath, key }).initialize();
    await vault.put({ id: "youtube:channel-1", platform: "youtube", accountId: "channel-1", accessToken: "old-access", refreshToken: "old-refresh" });
    const persist = vault.persist.bind(vault);
    vault.persist = async () => { throw new Error("simulated disk failure"); };

    await assert.rejects(() => vault.put({ id: "youtube:channel-1", platform: "youtube", accountId: "channel-1", accessToken: "new-access", refreshToken: "new-refresh" }), /simulated disk failure/);
    assert.equal(vault.get("youtube:channel-1").accessToken, "old-access");
    await assert.rejects(() => vault.remove("youtube:channel-1"), /simulated disk failure/);
    assert.equal(vault.get("youtube:channel-1").refreshToken, "old-refresh");

    vault.persist = persist;
    const reloaded = await new TokenVault({ filePath, key }).initialize();
    assert.equal(reloaded.get("youtube:channel-1").accessToken, "old-access");
    assert.equal(reloaded.get("youtube:channel-1").refreshToken, "old-refresh");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
