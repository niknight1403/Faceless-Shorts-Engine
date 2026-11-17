import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../../src/config.mjs";
import { createApiServer } from "../../src/api/server.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const apiKey = "local-e2e-publishing-api-key-000000000000";
const tokenKey = Buffer.alloc(32, 0x73).toString("base64url");
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function waitForHealth(url, processHandle) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Lokaler Mock-Medienanbieter endete mit Code ${processHandle.exitCode}.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Der lokale Server startet eventuell noch.
    }
    await wait(100);
  }
  throw new Error("Lokaler Mock-Medienanbieter wurde nicht rechtzeitig bereit.");
}

async function waitForShort(baseUrl, jobId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/shorts-jobs/${jobId}`);
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (["completed", "failed"].includes(job.status)) return job;
    await wait(100);
  }
  throw new Error("Renderauftrag wurde innerhalb von 30 Sekunden nicht abgeschlossen.");
}

async function waitForPublishing(baseUrl, jobId, authorization, expectedStatuses) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/publishing-jobs/${jobId}`, { headers: { Authorization: authorization } });
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (expectedStatuses.includes(job.status)) return job;
    if (["failed", "needs_attention"].includes(job.status)) {
      throw new Error(`Publishing endete unerwartet mit ${job.status}: ${job.error?.code || "unbekannter Fehler"} · ${job.error?.message || "keine Fehlermeldung"}`);
    }
    await wait(100);
  }
  throw new Error(`Publishingauftrag erreichte keinen erwarteten Status: ${expectedStatuses.join(", ")}.`);
}

function createPlatformMock() {
  const calls = [];
  let youtubeStatusCalls = 0;
  let youtubeChunkCalls = 0;
  let tiktokInitCalls = 0;
  let uncertainTiktokChunkCalls = 0;

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ host: url.hostname, path: url.pathname, method: options.method || "GET" });

    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      const code = options.body.get("code");
      assert.equal(code, "mock-youtube-code");
      return new Response(JSON.stringify({
        access_token: "mock-youtube-access-token",
        refresh_token: "mock-youtube-refresh-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/channels") {
      assert.match(options.headers.Authorization, /^Bearer mock-youtube-access-token$/);
      return new Response(JSON.stringify({ items: [{ id: "mock-channel-1", snippet: { title: "Lokaler Mock-Kanal" } }] }), { status: 200 });
    }

    if (url.hostname === "open.tiktokapis.com" && url.pathname === "/v2/oauth/token/") {
      const form = options.body;
      assert.equal(form.get("code"), "mock-tiktok-code");
      return new Response(JSON.stringify({ data: {
        access_token: "mock-tiktok-access-token",
        refresh_token: "mock-tiktok-refresh-token",
        expires_in: 3600,
        open_id: "mock-creator-1",
        display_name: "Lokaler TikTok-Mock",
        scope: "user.info.basic,video.upload",
      }, error: { code: "ok" } }), { status: 200 });
    }

    if (url.hostname === "www.googleapis.com" && url.pathname === "/upload/youtube/v3/videos" && options.method === "POST") {
      assert.equal(options.headers.Authorization, "Bearer mock-youtube-access-token");
      const metadata = JSON.parse(options.body);
      assert.equal(metadata.status.privacyStatus, "private");
      return new Response(null, { status: 200, headers: { location: "https://youtube-upload.local/session/mock-session" } });
    }

    if (url.hostname === "youtube-upload.local" && options.method === "PUT") {
      youtubeChunkCalls += 1;
      return new Response(JSON.stringify({ id: "mock-youtube-video-1" }), { status: 201 });
    }

    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
      youtubeStatusCalls += 1;
      if (youtubeStatusCalls === 1) return new Response(JSON.stringify({ error: { code: "rateLimitExceeded" } }), { status: 429 });
      return new Response(JSON.stringify({ items: [{
        id: "mock-youtube-video-1",
        status: { uploadStatus: "processed", privacyStatus: "private" },
        processingDetails: { processingStatus: "succeeded" },
      }] }), { status: 200 });
    }

    if (url.hostname === "open.tiktokapis.com" && url.pathname === "/v2/post/publish/inbox/video/init/") {
      assert.equal(options.headers.Authorization, "Bearer mock-tiktok-access-token");
      tiktokInitCalls += 1;
      const uploadUrl = tiktokInitCalls === 1
        ? "https://tiktok-upload.local/success"
        : "https://tiktok-upload.local/uncertain";
      return new Response(JSON.stringify({ data: {
        publish_id: `mock-tiktok-publish-${tiktokInitCalls}`,
        upload_url: uploadUrl,
      }, error: { code: "ok" } }), { status: 200 });
    }

    if (url.hostname === "tiktok-upload.local" && url.pathname === "/success" && options.method === "PUT") {
      return new Response(null, { status: 201 });
    }

    if (url.hostname === "tiktok-upload.local" && url.pathname === "/uncertain" && options.method === "PUT") {
      uncertainTiktokChunkCalls += 1;
      return new Response("simulated ambiguous acceptance", { status: 503 });
    }

    if (url.hostname === "open.tiktokapis.com" && url.pathname === "/v2/post/publish/status/fetch/") {
      return new Response(JSON.stringify({ data: { status: "SEND_TO_USER_INBOX", uploaded_bytes: 1 }, error: { code: "ok" } }), { status: 200 });
    }

    throw new Error(`Nicht gemockter Plattformaufruf im E2E-Test: ${url.hostname}${url.pathname}`);
  };

  return {
    fetchImpl,
    calls,
    counts: () => ({ youtubeStatusCalls, youtubeChunkCalls, tiktokInitCalls, uncertainTiktokChunkCalls }),
  };
}

test("E2E: lokaler Render durchläuft OAuth-Mocks, YouTube- und TikTok-Inbox-Uploads samt Fault Injection", async t => {
  const root = await mkdtemp(join(tmpdir(), "faceless-shorts-publishing-e2e-"));
  const mockPort = await reservePort();
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const mockProcess = spawn(process.execPath, [join(projectRoot, "scripts/mock-media-provider.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, MOCK_MEDIA_PORT: String(mockPort) },
    stdio: "ignore",
  });
  const platformMock = createPlatformMock();
  let application;

  try {
    await waitForHealth(`${mockUrl}/health`, mockProcess);
    const config = loadConfig({
      HOST: "127.0.0.1",
      JOB_DATA_DIR: join(root, "shorts-jobs"),
      MOCK_MEDIA_URL: mockUrl,
      PUBLISHING_DATA_DIR: join(root, "publishing"),
      PUBLISHING_ENABLED: "true",
      PUBLISHING_API_KEY: apiKey,
      PUBLISHING_TOKEN_KEY: tokenKey,
      YOUTUBE_OAUTH_CLIENT_ID: "local-youtube-client",
      YOUTUBE_OAUTH_CLIENT_SECRET: "local-youtube-secret",
      YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/connections/youtube/oauth/callback",
      TIKTOK_OAUTH_CLIENT_ID: "local-tiktok-client",
      TIKTOK_OAUTH_CLIENT_SECRET: "local-tiktok-secret",
      TIKTOK_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/connections/tiktok/oauth/callback",
      TIKTOK_UPLOAD_APPROVED: "true",
    });
    application = await createApiServer({ config, fetchImpl: platformMock.fetchImpl });
    await new Promise((resolveListen, rejectListen) => {
      application.server.once("error", rejectListen);
      application.server.listen(0, "127.0.0.1", resolveListen);
    });
    const apiUrl = `http://127.0.0.1:${application.server.address().port}`;
    const authorization = `Bearer ${apiKey}`;
    const authHeaders = { Authorization: authorization };
    const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

    await t.test("Health zeigt nur lokale Mocks und vollständig simulierte OAuth-Konfiguration", async () => {
      const response = await fetch(`${apiUrl}/api/v1/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.readiness, "ready");
      assert.equal(body.publishing.status, "ready");
      assert.deepEqual(body.publishing.platforms, { youtube: true, tiktok: true });
    });

    const renderResponse = await fetch(`${apiUrl}/api/v1/shorts-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "local-render-to-publish" },
      body: JSON.stringify({ topic: "Ein vollständig lokaler Publishing-Test", durationSeconds: 1 }),
    });
    assert.equal(renderResponse.status, 202);
    const sourceId = (await renderResponse.json()).job.id;
    const rendered = await waitForShort(apiUrl, sourceId);
    assert.equal(rendered.status, "completed", JSON.stringify(rendered.error));
    assert.equal(rendered.output.container, "mp4");

    async function connect(platform, code) {
      const startResponse = await fetch(`${apiUrl}/api/v1/connections/${platform}/oauth/start`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ mode: "upload" }),
      });
      assert.equal(startResponse.status, 200);
      const { state } = await startResponse.json();
      const callback = new URL(`${apiUrl}/api/v1/connections/${platform}/oauth/callback`);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      const callbackResponse = await fetch(callback);
      assert.equal(callbackResponse.status, 200);
      return (await callbackResponse.json()).connection;
    }

    const youtubeConnection = await connect("youtube", "mock-youtube-code");
    const tiktokConnection = await connect("tiktok", "mock-tiktok-code");
    assert.equal(youtubeConnection.id, "youtube:mock-channel-1");
    assert.equal(tiktokConnection.id, "tiktok:mock-creator-1");

    const connectionResponse = await fetch(`${apiUrl}/api/v1/connections`, { headers: authHeaders });
    assert.equal(connectionResponse.status, 200);
    const connections = await connectionResponse.json();
    assert.equal(connections.connections.length, 2);
    assert.equal(JSON.stringify(connections).includes("mock-youtube-access-token"), false);
    assert.equal(JSON.stringify(connections).includes("mock-tiktok-refresh-token"), false);

    async function createAndConfirm({ platform, connectionId, idempotencyKey, metadata }) {
      const preflightResponse = await fetch(`${apiUrl}/api/v1/shorts-jobs/${sourceId}/publish`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ platform, mode: "upload", connectionId, metadata }),
      });
      assert.equal(preflightResponse.status, 202);
      const preflight = (await preflightResponse.json()).job;
      assert.equal(preflight.status, "awaiting_confirmation");
      const confirmResponse = await fetch(`${apiUrl}/api/v1/publishing-jobs/${preflight.id}/confirm`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ confirmed: true }),
      });
      assert.equal(confirmResponse.status, 202);
      return preflight.id;
    }

    const youtubeJobId = await createAndConfirm({
      platform: "youtube",
      connectionId: youtubeConnection.id,
      idempotencyKey: "e2e-youtube-upload",
      metadata: { title: "E2E-Mock-Short", description: "Nur lokal", privacyStatus: "private", containsSyntheticMedia: false },
    });
    const youtubeJob = await waitForPublishing(apiUrl, youtubeJobId, authorization, ["published"]);
    assert.equal(youtubeJob.remote.videoId, "mock-youtube-video-1");

    const tiktokJobId = await createAndConfirm({
      platform: "tiktok",
      connectionId: tiktokConnection.id,
      idempotencyKey: "e2e-tiktok-inbox",
      metadata: { caption: "Nur lokaler E2E-Test" },
    });
    const tiktokJob = await waitForPublishing(apiUrl, tiktokJobId, authorization, ["awaiting_creator_action"]);
    assert.match(tiktokJob.statusMessage, /Entwurf in deine Inbox gelegt/);

    const uncertainJobId = await createAndConfirm({
      platform: "tiktok",
      connectionId: tiktokConnection.id,
      idempotencyKey: "e2e-tiktok-uncertain-chunk",
      metadata: { caption: "Fault-Injection: unklare Chunkannahme" },
    });
    const uncertainJob = await waitForPublishing(apiUrl, uncertainJobId, authorization, ["needs_attention"]);
    assert.equal(uncertainJob.error.code, "TIKTOK_UPLOAD_STATE_UNKNOWN");
    assert.equal(uncertainJob.error.uncertainAcceptance, true);

    const beforeReconcile = platformMock.counts();
    assert.equal(beforeReconcile.youtubeStatusCalls, 2, "429 wird vorübergehend wiederholt und danach erfolgreich abgeglichen");
    assert.equal(beforeReconcile.youtubeChunkCalls, 1);
    assert.equal(beforeReconcile.uncertainTiktokChunkCalls, 1, "unklare TikTok-Chunks werden nicht blind wiederholt");

    const reconcileResponse = await fetch(`${apiUrl}/api/v1/publishing-jobs/${uncertainJobId}/refresh`, {
      method: "POST",
      headers: authHeaders,
    });
    assert.equal(reconcileResponse.status, 200);
    assert.equal((await reconcileResponse.json()).job.status, "needs_attention");
    assert.equal(platformMock.counts().uncertainTiktokChunkCalls, 1);

    const allowedHosts = new Set(["oauth2.googleapis.com", "www.googleapis.com", "youtube-upload.local", "open.tiktokapis.com", "tiktok-upload.local"]);
    assert.ok(platformMock.calls.length > 0);
    assert.ok(platformMock.calls.every(call => allowedHosts.has(call.host)), "Jeder OAuth-/Plattformaufruf muss vom lokalen Mock beantwortet werden");
    t.diagnostic(`Lokaler Render ${sourceId}; YouTube ${youtubeJob.status}; TikTok ${tiktokJob.status}; Fault-Injection ${uncertainJob.status}.`);
  } finally {
    if (application?.server.listening) await new Promise(resolveClose => application.server.close(resolveClose));
    if (mockProcess.exitCode === null) {
      mockProcess.kill("SIGTERM");
      await Promise.race([once(mockProcess, "exit"), wait(2_000)]);
    }
    await rm(root, { recursive: true, force: true });
  }
});
