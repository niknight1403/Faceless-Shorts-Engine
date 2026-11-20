import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.mjs";
import { createApiServer } from "../../src/api/server.mjs";
import { PublishingJobStore } from "../../src/publishing/job-store.mjs";
import { PublishingStudioFlow } from "../../src/ui/publishing-studio-flow.mjs";

const apiKey = "test-local-publishing-api-key-long-enough";
const tokenKey = Buffer.alloc(32, 0x61).toString("base64url");

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start(config, { fetchImpl = fetch, healthCheck = async () => ({ status: "ok" }) } = {}) {
  const application = await createApiServer({
    config,
    provider: { healthCheck },
    renderer: {},
    validator: {},
    fetchImpl,
  });
  await new Promise((resolve, reject) => application.server.listen(0, "127.0.0.1", resolve).once("error", reject));
  return { application, url: `http://127.0.0.1:${application.server.address().port}` };
}

async function close(application) {
  if (application?.server.listening) await new Promise(resolve => application.server.close(resolve));
}

test("Publishing-Routen bleiben standardmäßig verborgen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-api-off-"));
  let application;
  try {
    const config = loadConfig({ JOB_DATA_DIR: join(directory, "jobs") });
    ({ application } = await start(config));
    const response = await fetch(`http://127.0.0.1:${application.server.address().port}/api/v1/connections`);
    assert.equal(response.status, 404);
    const studio = await fetch(`http://127.0.0.1:${application.server.address().port}/publishing-studio`);
    assert.equal(studio.status, 404);
    const health = await fetch(`http://127.0.0.1:${application.server.address().port}/api/v1/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.publishing.enabled, false);
    assert.equal(healthBody.publishing.status, "disabled");
    assert.equal(healthBody.readiness, "ready");
  } finally {
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Health meldet Providerstörung ohne interne Fehlerdetails oder Secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-health-outage-"));
  let application;
  try {
    const config = loadConfig({ JOB_DATA_DIR: join(directory, "jobs") });
    let url;
    ({ application, url } = await start(config, { healthCheck: async () => { throw new Error("provider secret token leaked"); } }));
    const response = await fetch(`${url}/api/v1/health`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "degraded");
    assert.equal(body.readiness, "not_ready");
    assert.equal(body.dependencies.mockMediaProvider, "unavailable");
    assert.equal(JSON.stringify(body).includes("secret"), false);
    assert.equal(JSON.stringify(body).includes("token"), false);
  } finally {
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Health und OAuth-Fehler melden Teilkonfiguration ohne Schlüsselwerte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-health-partial-oauth-"));
  let application;
  try {
    const config = loadConfig({
      HOST: "127.0.0.1",
      JOB_DATA_DIR: join(directory, "jobs"),
      PUBLISHING_DATA_DIR: join(directory, "publishing"),
      PUBLISHING_ENABLED: "true",
      PUBLISHING_API_KEY: apiKey,
      PUBLISHING_TOKEN_KEY: tokenKey,
      YOUTUBE_OAUTH_CLIENT_ID: "synthetic-youtube-client-id",
      YOUTUBE_OAUTH_CLIENT_SECRET: "synthetic-youtube-client-secret",
      YOUTUBE_OAUTH_REDIRECT_URI: "",
      TIKTOK_OAUTH_CLIENT_ID: "synthetic-tiktok-client-id",
      TIKTOK_OAUTH_CLIENT_SECRET: "synthetic-tiktok-client-secret",
      TIKTOK_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/callback",
    });
    let url;
    ({ application, url } = await start(config));

    const health = await fetch(`${url}/api/v1/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.publishing.status, "partially_configured");
    assert.deepEqual(body.publishing.platforms, { youtube: false, tiktok: true });
    const serialized = JSON.stringify(body);
    for (const secret of [apiKey, tokenKey, "synthetic-youtube-client-id", "synthetic-youtube-client-secret", "synthetic-tiktok-client-id", "synthetic-tiktok-client-secret"]) {
      assert.equal(serialized.includes(secret), false);
    }

    const oauthStart = await fetch(`${url}/api/v1/connections/youtube/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "upload" }),
    });
    assert.equal(oauthStart.status, 503);
    const oauthError = await oauthStart.json();
    assert.equal(oauthError.error.code, "OAUTH_NOT_CONFIGURED");
    const errorText = JSON.stringify(oauthError);
    for (const secret of [apiKey, tokenKey, "synthetic-youtube-client-id", "synthetic-youtube-client-secret"]) {
      assert.equal(errorText.includes(secret), false);
    }
  } finally {
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Publishing-API verlangt Bearer-Key und gated Direct Post", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-api-on-"));
  let application;
  try {
    const config = loadConfig({
      HOST: "127.0.0.1",
      JOB_DATA_DIR: join(directory, "jobs"),
      PUBLISHING_DATA_DIR: join(directory, "publishing"),
      PUBLISHING_ENABLED: "true",
      PUBLISHING_API_KEY: apiKey,
      PUBLISHING_TOKEN_KEY: tokenKey,
      YOUTUBE_OAUTH_CLIENT_ID: "yt-client",
      YOUTUBE_OAUTH_CLIENT_SECRET: "yt-secret",
      YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/connections/youtube/oauth/callback",
      TIKTOK_OAUTH_CLIENT_ID: "tt-client",
      TIKTOK_OAUTH_CLIENT_SECRET: "tt-secret",
      TIKTOK_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/connections/tiktok/oauth/callback",
      TIKTOK_UPLOAD_APPROVED: "true",
    });
    let url;
    ({ application, url } = await start(config));

    const unauthorized = await fetch(`${url}/api/v1/connections`);
    assert.equal(unauthorized.status, 401);

    const connections = await fetch(`${url}/api/v1/connections`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(connections.status, 200);
    assert.deepEqual((await connections.json()).connections, []);

    const startOAuth = await fetch(`${url}/api/v1/connections/tiktok/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "upload" }),
    });
    assert.equal(startOAuth.status, 200);
    const authBody = await startOAuth.json();
    const authUrl = new URL(authBody.authorizationUrl);
    assert.equal(authUrl.searchParams.get("scope"), "user.info.basic,video.upload");
    assert.equal(authUrl.searchParams.get("state"), authBody.state);

    const invalidMode = await fetch(`${url}/api/v1/connections/tiktok/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "unexpected" }),
    });
    assert.equal(invalidMode.status, 400);
    assert.equal((await invalidMode.json()).error.code, "PUBLISHING_MODE_INVALID");

    const jobs = await fetch(`${url}/api/v1/publishing-jobs`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(jobs.status, 200);
    assert.deepEqual((await jobs.json()).jobs, []);

    const studio = await fetch(`${url}/publishing-studio`);
    assert.equal(studio.status, 200);
    assert.match(studio.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal((await studio.text()).includes(apiKey), false);
    const studioScript = await fetch(`${url}/publishing-studio.mjs`);
    assert.equal(studioScript.status, 200);
    assert.match(studioScript.headers.get("content-type"), /javascript/);

    const unsupportedPlatform = await fetch(`${url}/api/v1/shorts-jobs/11111111-1111-4111-8111-111111111111/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "other", connectionId: "ignored" }),
    });
    assert.equal(unsupportedPlatform.status, 400);
    assert.equal((await unsupportedPlatform.json()).error.code, "UNSUPPORTED_PLATFORM");

    const directPost = await fetch(`${url}/api/v1/connections/tiktok/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "direct_post" }),
    });
    assert.equal(directPost.status, 403);
    assert.equal((await directPost.json()).error.code, "TIKTOK_DIRECT_POST_DISABLED");
  } finally {
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth-API hält alte Verbindung bei fehlgeschlagenem Reconnect und redigiert Widerruffehler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-oauth-api-"));
  let application;
  let channelFails = false;
  let revokeFails = false;
  const revokedTokens = [];
  const firstAccessToken = "access-first-code-secret";
  const firstRefreshToken = "refresh-first-code-secret";
  const secondAccessToken = "access-second-code-secret";
  const secondRefreshToken = "refresh-second-code-secret";
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com" && url.pathname.endsWith("/token")) {
      const code = options.body.get("code");
      return new Response(JSON.stringify({
        access_token: code === "first-code" ? firstAccessToken : secondAccessToken,
        refresh_token: code === "first-code" ? firstRefreshToken : secondRefreshToken,
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      }), { status: 200 });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/youtube/v3/channels")) {
      if (channelFails) return new Response(JSON.stringify({ error: "simulated lookup failure" }), { status: 503 });
      return new Response(JSON.stringify({ items: [{ id: "channel-1", snippet: { title: "Test channel" } }] }), { status: 200 });
    }
    if (url.hostname === "oauth2.googleapis.com" && url.pathname.endsWith("/revoke")) {
      revokedTokens.push(options.body.get("token"));
      return new Response(null, { status: revokeFails ? 503 : 200 });
    }
    throw new Error(`Unexpected mocked OAuth request: ${url.hostname}${url.pathname}`);
  };
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values.join(" "));

  try {
    const config = loadConfig({
      HOST: "127.0.0.1",
      JOB_DATA_DIR: join(directory, "jobs"),
      PUBLISHING_DATA_DIR: join(directory, "publishing"),
      PUBLISHING_ENABLED: "true",
      PUBLISHING_API_KEY: apiKey,
      PUBLISHING_TOKEN_KEY: tokenKey,
      YOUTUBE_OAUTH_CLIENT_ID: "yt-client",
      YOUTUBE_OAUTH_CLIENT_SECRET: "yt-secret",
      YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/connections/youtube/oauth/callback",
    });
    let url;
    ({ application, url } = await start(config, { fetchImpl }));

    const startOAuth = async () => {
      const response = await fetch(`${url}/api/v1/connections/youtube/oauth/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "upload" }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).state;
    };
    const finishOAuth = (state, code) => fetch(`${url}/api/v1/connections/youtube/oauth/callback?${new URLSearchParams({ state, code })}`);
    const listConnections = () => fetch(`${url}/api/v1/connections`, { headers: { Authorization: `Bearer ${apiKey}` } });

    const firstCallback = await finishOAuth(await startOAuth(), "first-code");
    assert.equal(firstCallback.status, 200);
    const firstBody = await firstCallback.json();
    assert.equal(firstBody.connection.accountId, "channel-1");
    assert.equal(JSON.stringify(firstBody).includes(firstAccessToken), false);
    assert.equal(JSON.stringify(firstBody).includes(firstRefreshToken), false);

    channelFails = true;
    const reconnectResponse = await finishOAuth(await startOAuth(), "second-code");
    assert.equal(reconnectResponse.status, 502);
    const reconnectBody = await reconnectResponse.json();
    assert.equal(reconnectBody.error.code, "YOUTUBE_CHANNEL_LOOKUP_FAILED");
    assert.equal(JSON.stringify(reconnectBody).includes(secondAccessToken), false);
    assert.equal(JSON.stringify(reconnectBody).includes(secondRefreshToken), false);
    assert.deepEqual(revokedTokens, [secondAccessToken]);

    const retained = await listConnections();
    assert.equal(retained.status, 200);
    const retainedBody = await retained.json();
    assert.equal(retainedBody.connections.length, 1);
    assert.equal(JSON.stringify(retainedBody).includes(firstAccessToken), false);
    assert.equal(JSON.stringify(retainedBody).includes(firstRefreshToken), false);

    revokeFails = true;
    const disconnect = await fetch(`${url}/api/v1/connections?connectionId=youtube%3Achannel-1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(disconnect.status, 502);
    const disconnectBody = await disconnect.json();
    assert.equal(disconnectBody.error.code, "CONNECTION_DISCONNECTED_REVOCATION_FAILED");
    assert.equal(JSON.stringify(disconnectBody).includes(firstAccessToken), false);
    assert.equal(JSON.stringify(disconnectBody).includes(firstRefreshToken), false);
    assert.deepEqual(revokedTokens, [secondAccessToken, firstAccessToken]);

    const afterDisconnect = await listConnections();
    assert.deepEqual((await afterDisconnect.json()).connections, []);
    assert.equal(logs.join("\n").includes("secret"), false);
  } finally {
    console.error = originalError;
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Publishing-API gibt verständliche TikTok-Creator-Statusmeldung und sicheren Audit-Trail aus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-api-status-message-"));
  const publishingDataDir = join(directory, "publishing");
  let application;
  try {
    const jobs = await new PublishingJobStore(join(publishingDataDir, "jobs")).initialize();
    const created = await jobs.create({ sourceJobId: "source-job", platform: "tiktok", accountId: "tiktok:creator-1", metadata: { mode: "upload" } });
    await jobs.transition(created.job.id, "preflight");
    await jobs.transition(created.job.id, "awaiting_confirmation");
    await jobs.confirm(created.job.id);
    await jobs.transition(created.job.id, "platform_processing", { remote: { publishId: "publish-1" } });
    await jobs.transition(created.job.id, "awaiting_creator_action", {
      statusMessage: "TikTok hat den Entwurf in deine Inbox gelegt. Öffne TikTok und schließe den Veröffentlichungsschritt dort ab.",
    });

    const config = loadConfig({
      HOST: "127.0.0.1",
      JOB_DATA_DIR: join(directory, "shorts-jobs"),
      PUBLISHING_DATA_DIR: publishingDataDir,
      PUBLISHING_ENABLED: "true",
      PUBLISHING_API_KEY: apiKey,
      PUBLISHING_TOKEN_KEY: tokenKey,
    });
    let url;
    ({ application, url } = await start(config));

    const response = await fetch(`${url}/api/v1/publishing-jobs/${created.job.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.job.status, "awaiting_creator_action");
    assert.match(body.job.statusMessage, /Entwurf in deine Inbox gelegt/);
    assert.equal(body.job.remote.publishId, "publish-1");
    assert.deepEqual(body.job.auditTrail.map(event => event.type), [
      "job_created", "status_transition", "status_transition", "approval_granted", "status_transition", "status_transition", "status_transition",
    ]);
    assert.equal(JSON.stringify(body.job.auditTrail).includes("publish-1"), false);
  } finally {
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Publishing-Diagnostik redigiert Geheimnisse, markiert manuelle Jobs und schlägt nur alte terminale Bereinigung vor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-diagnostics-"));
  const publishingDataDir = join(directory, "publishing");
  const oldTimestamp = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();
  let application;
  try {
    const jobs = await new PublishingJobStore(join(publishingDataDir, "jobs")).initialize();
    const attention = await jobs.create({ sourceJobId: "diagnostic-source", platform: "tiktok", accountId: "tiktok:diagnostic", metadata: { caption: "private caption", token: "never-return-this" } });
    await jobs.transition(attention.job.id, "preflight");
    await jobs.transition(attention.job.id, "awaiting_confirmation");
    await jobs.confirm(attention.job.id);
    await jobs.transition(attention.job.id, "needs_attention", { error: { message: "private error" } });

    const published = await jobs.create({ sourceJobId: "old-published", platform: "youtube", accountId: "youtube:diagnostic" });
    await jobs.transition(published.job.id, "preflight");
    await jobs.transition(published.job.id, "awaiting_confirmation");
    await jobs.confirm(published.job.id);
    await jobs.transition(published.job.id, "published");
    await jobs.update(published.job.id, job => { job.completedAt = oldTimestamp; });

    const failed = await jobs.create({ sourceJobId: "old-failed", platform: "youtube", accountId: "youtube:diagnostic" });
    await jobs.transition(failed.job.id, "preflight");
    await jobs.transition(failed.job.id, "awaiting_confirmation");
    await jobs.transition(failed.job.id, "failed");
    await jobs.update(failed.job.id, job => { job.completedAt = oldTimestamp; });

    const creatorAction = await jobs.create({ sourceJobId: "creator-action", platform: "tiktok", accountId: "tiktok:diagnostic" });
    await jobs.transition(creatorAction.job.id, "preflight");
    await jobs.transition(creatorAction.job.id, "awaiting_confirmation");
    await jobs.confirm(creatorAction.job.id);
    await jobs.transition(creatorAction.job.id, "platform_processing");
    await jobs.transition(creatorAction.job.id, "awaiting_creator_action", { statusMessage: "private platform detail" });

    const config = loadConfig({
      HOST: "127.0.0.1",
      JOB_DATA_DIR: join(directory, "shorts-jobs"),
      PUBLISHING_DATA_DIR: publishingDataDir,
      PUBLISHING_ENABLED: "true",
      PUBLISHING_API_KEY: apiKey,
      PUBLISHING_TOKEN_KEY: tokenKey,
    });
    let url;
    ({ application, url } = await start(config));

    const noAuth = await fetch(`${url}/api/v1/publishing/diagnostics`);
    assert.equal(noAuth.status, 401);

    const health = await fetch(`${url}/api/v1/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.publishing.status, "oauth_not_configured");
    assert.deepEqual(healthBody.publishing.platforms, { youtube: false, tiktok: false });

    const oauthStart = await fetch(`${url}/api/v1/connections/youtube/oauth/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "upload" }),
    });
    assert.equal(oauthStart.status, 503);
    const oauthError = await oauthStart.json();
    assert.equal(oauthError.error.code, "OAUTH_NOT_CONFIGURED");
    assert.match(oauthError.error.message, /OAuth-Zugangsdaten sind nicht konfiguriert/);

    const response = await fetch(`${url}/api/v1/publishing/diagnostics`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "attention_required");
    assert.equal(body.platforms.youtube.oauth, "not_configured");
    assert.equal(body.jobs.total, 4);
    assert.equal(body.jobs.manualAttention.length, 2);
    assert.ok(body.jobs.manualAttention.some(job => job.id === attention.job.id && job.status === "needs_attention"));
    assert.ok(body.jobs.manualAttention.some(job => job.id === creatorAction.job.id && job.status === "awaiting_creator_action"));
    assert.equal(body.jobs.cleanupSuggestions.length, 1);
    assert.equal(body.jobs.cleanupSuggestions[0].id, published.job.id);
    assert.equal(body.jobs.cleanupSuggestions[0].ageDays, 61);
    assert.equal(body.cleanupPolicy.automaticDeletion, false);
    assert.equal(JSON.stringify(body).includes("private caption"), false);
    assert.equal(JSON.stringify(body).includes("never-return-this"), false);
    assert.equal(JSON.stringify(body).includes("private error"), false);
    assert.equal(JSON.stringify(body).includes("private platform detail"), false);
    assert.equal(jobs.get(attention.job.id).status, "needs_attention");
    assert.equal(jobs.get(published.job.id).status, "published");
  } finally {
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Publishing-Studio blockiert Preflight vor Vorschauprüfung und Upload vor separater Bestätigung", async () => {
  const calls = [];
  const flow = new PublishingStudioFlow(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith("/publish")) return { job: { id: "preflight-job-1", status: "awaiting_confirmation", platform: "youtube" } };
    return { job: { id: "preflight-job-1", status: "uploading" } };
  });
  flow.select({
    sourceJobId: "short-job-1",
    connectionId: "youtube:channel-1",
    platform: "youtube",
    metadata: { title: "Reviewed Short", privacyStatus: "private", containsSyntheticMedia: false },
    previewUrl: "/api/v1/shorts-jobs/short-job-1/download",
  });

  await assert.rejects(() => flow.createPreflight(), /geladen, abgespielt und ausdrücklich geprüft/);
  assert.equal(calls.length, 0);
  flow.markPreviewLoaded();
  assert.throws(() => flow.markReviewed(true), /starte die Wiedergabe/);
  flow.markPreviewPlayed();
  flow.markReviewed(true);
  flow.updateMetadata({ title: "Updated after review", privacyStatus: "private", containsSyntheticMedia: false });
  assert.equal(flow.snapshot().reviewed, false);
  await assert.rejects(() => flow.createPreflight(), /ausdrücklich geprüft/);
  flow.markReviewed(true);

  const preflight = await flow.createPreflight();
  assert.equal(preflight.id, "preflight-job-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/publish$/);
  assert.equal(calls[0].options.body.mode, "upload");
  assert.equal(calls[0].options.body.metadata.title, "Updated after review");

  const current = await flow.getPublishingJob();
  assert.equal(current.job.id, "preflight-job-1");
  assert.equal(calls.length, 2);
  assert.match(calls[1].path, /\/api\/v1\/publishing-jobs\/preflight-job-1$/);
  assert.equal(calls[1].options?.method || "GET", "GET");

  await assert.rejects(() => flow.confirmPublish({ confirmed: false }), /separate, ausdrückliche Bestätigung/);
  assert.equal(calls.length, 2);
  const confirmed = await flow.confirmPublish({ confirmed: true });
  assert.equal(confirmed.job.status, "uploading");
  assert.equal(calls.length, 3);
  assert.match(calls[2].path, /\/confirm$/);
  assert.deepEqual(calls[2].options.body, { confirmed: true });
  await assert.rejects(() => flow.confirmPublish({ confirmed: true }), /bereits angefordert/);
  assert.equal(calls.length, 3);
});

test("Publishing-Studio verhindert blinden zweiten Upload nach unklarer Freigabeantwort", async () => {
  let confirmCalls = 0;
  let statusCalls = 0;
  const flow = new PublishingStudioFlow(async (path, options = {}) => {
    if (path.endsWith("/publish")) return { job: { id: "preflight-uncertain", status: "awaiting_confirmation" } };
    if ((options.method || "GET") === "GET") {
      statusCalls += 1;
      return { job: { id: "preflight-uncertain", status: "uploading" } };
    }
    confirmCalls += 1;
    throw new Error("Verbindung während der Antwort unterbrochen");
  });
  flow.select({ sourceJobId: "short-2", connectionId: "tiktok:creator-1", platform: "tiktok", metadata: { caption: "Caption" }, previewUrl: "/short.mp4" });
  flow.markPreviewLoaded();
  flow.markPreviewPlayed();
  flow.markReviewed(true);
  await flow.createPreflight();
  await assert.rejects(() => flow.confirmPublish({ confirmed: true }), /Antwort unterbrochen/);
  const reconciled = await flow.getPublishingJob();
  assert.equal(reconciled.job.status, "uploading");
  await assert.rejects(() => flow.confirmPublish({ confirmed: true }), /bereits angefordert/);
  assert.equal(confirmCalls, 1);
  assert.equal(statusCalls, 1);
});
