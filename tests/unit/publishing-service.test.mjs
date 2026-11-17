import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PublishingJobStore } from "../../src/publishing/job-store.mjs";
import { PublishingService } from "../../src/publishing/service.mjs";
import { TokenVault } from "../../src/publishing/token-vault.mjs";

const SESSION_URI = "https://upload.example.test/session/secret-capability";

async function makeIdentityFixture({ youtubePublisherFactory = null, tiktokPublisherFactory = null, tiktokInboxPendingLimit = 5, tiktokStatusPollIntervalMs = 60_000, clock = () => Date.now() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "faceless-media-identity-"));
  const sourceDirectory = join(root, "source");
  const sourceFile = join(sourceDirectory, "final.mp4");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(sourceFile, Buffer.alloc(2048));

  const sourceId = "identity-source-job";
  const sourceJob = {
    id: sourceId,
    status: "completed",
    output: { filename: "final.mp4", fileSizeBytes: 2048, durationSeconds: 30, container: "mp4", videoCodec: "h264", width: 1080, height: 1920, framesPerSecond: 30 },
  };
  const shortJobStore = { get: id => id === sourceId ? sourceJob : null, getJobDirectory: id => id === sourceId ? sourceDirectory : null };
  const vault = await new TokenVault({ filePath: join(root, "tokens.json"), key: Buffer.alloc(32, 0x22) }).initialize();
  await vault.put({ id: "youtube:channel-1", platform: "youtube", accountId: "channel-1", accessToken: "test-access", refreshToken: "test-refresh" });
  await vault.put({ id: "tiktok:creator-1", platform: "tiktok", accountId: "creator-1", accessToken: "test-access", refreshToken: "test-refresh" });
  const jobStore = await new PublishingJobStore(join(root, "publish-jobs")).initialize();
  let publisherFactoryCalls = 0;
  const service = new PublishingService({
    shortJobStore,
    publishingJobStore: jobStore,
    tokenManager: { vault, getAccessToken: async () => "test-access" },
    vault,
    youtubePublisherFactory: options => {
      publisherFactoryCalls += 1;
      return youtubePublisherFactory ? youtubePublisherFactory(options) : {};
    },
    tiktokPublisherFactory: options => tiktokPublisherFactory ? tiktokPublisherFactory(options) : {},
    tiktokInboxPendingLimit,
    tiktokStatusPollIntervalMs,
    clock,
  });
  return {
    root,
    sourceFile,
    sourceJob,
    jobStore,
    service,
    publisherFactoryCalls: () => publisherFactoryCalls,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("PublishingService hält Upload bis Bestätigung zurück und verschlüsselt die Resume-URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "faceless-publishing-service-"));
  const sourceDirectory = join(root, "source");
  const sourceFile = join(sourceDirectory, "final.mp4");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDirectory, { recursive: true }));
  await writeFile(sourceFile, Buffer.alloc(2048));

  const sourceId = "source-job-1";
  const sourceJob = {
    id: sourceId,
    status: "completed",
    output: { filename: "final.mp4", durationSeconds: 30, container: "mp4", videoCodec: "h264", width: 1080, height: 1920, framesPerSecond: 30 },
  };
  const shortJobStore = { get: id => id === sourceId ? sourceJob : null, getJobDirectory: id => id === sourceId ? sourceDirectory : null };
  const vault = await new TokenVault({ filePath: join(root, "tokens.json"), key: Buffer.alloc(32, 0x22) }).initialize();
  await vault.put({ id: "youtube:channel-1", platform: "youtube", accountId: "channel-1", accessToken: "test-access", refreshToken: "test-refresh" });
  const tokenManager = { vault, getAccessToken: async () => "test-access" };
  const jobStore = await new PublishingJobStore(join(root, "publish-jobs")).initialize();

  let notifySession;
  const sessionReady = new Promise(resolve => { notifySession = resolve; });
  let releaseUpload;
  const uploadPaused = new Promise(resolve => { releaseUpload = resolve; });
  const service = new PublishingService({
    shortJobStore,
    publishingJobStore: jobStore,
    tokenManager,
    vault,
    youtubePublisherFactory: () => ({
      uploadVideo: async ({ onSession, sessionUri }) => {
        assert.equal(sessionUri, null);
        await onSession(SESSION_URI);
        notifySession();
        await uploadPaused;
        return { videoId: "platform-video-1" };
      },
      getVideoStatus: async () => ({ videoId: "platform-video-1", uploadStatus: "processed", processingStatus: "succeeded" }),
    }),
  });

  try {
    const created = await service.create({
      sourceJobId: sourceId,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Private test", privacyStatus: "private", containsSyntheticMedia: false },
    });
    assert.equal(created.job.status, "awaiting_confirmation");
    assert.equal(created.job.sourceSnapshot.sha256, createHash("sha256").update(Buffer.alloc(2048)).digest("hex"));
    assert.equal(created.job.sourceSnapshot.sizeBytes, 2048);
    assert.deepEqual(created.job.sourceSnapshot.videoMetadata, sourceJob.output);
    const reloadedStore = await new PublishingJobStore(join(root, "publish-jobs")).initialize();
    assert.deepEqual(reloadedStore.get(created.job.id).sourceSnapshot, created.job.sourceSnapshot);
    await assert.rejects(() => jobStore.update(created.job.id, current => { current.sourceSnapshot.sha256 = "0".repeat(64); }), { code: "SOURCE_SNAPSHOT_IMMUTABLE" });

    const confirmed = await service.confirm(created.job.id);
    assert.equal(confirmed.status, "uploading");
    await sessionReady;

    const persisted = jobStore.get(created.job.id);
    assert.ok(persisted.remote.encryptedSession);
    assert.equal(persisted.remote.sessionUri, undefined);
    const disk = await readFile(join(jobStore.getDirectory(created.job.id), "publish.json"), "utf8");
    assert.equal(disk.includes(SESSION_URI), false);
    assert.equal(vault.decrypt(persisted.remote.encryptedSession).uri, SESSION_URI);

    releaseUpload();
    for (let attempt = 0; attempt < 100 && jobStore.get(created.job.id).status !== "published"; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(jobStore.get(created.job.id).status, "published");
  } finally {
    releaseUpload?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("PublishingService blockiert Bestätigung, wenn Videodatei oder Exportmetadaten geändert wurden", async () => {
  const fixture = await makeIdentityFixture();
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Identity check", privacyStatus: "private", containsSyntheticMedia: false },
    });

    fixture.sourceJob.output.durationSeconds = 31;
    await assert.rejects(() => fixture.service.confirm(created.job.id), { code: "MEDIA_IDENTITY_MISMATCH" });
    fixture.sourceJob.output.durationSeconds = 30;
    await writeFile(fixture.sourceFile, Buffer.alloc(2048, 0x7f));
    await assert.rejects(() => fixture.service.confirm(created.job.id), { code: "MEDIA_IDENTITY_MISMATCH" });
    assert.equal(fixture.jobStore.get(created.job.id).status, "awaiting_confirmation");
    assert.equal(fixture.publisherFactoryCalls(), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("PublishingService prüft den Medien-Snapshot unmittelbar vor dem Plattformaufruf", async () => {
  const fixture = await makeIdentityFixture();
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Upload identity check", privacyStatus: "private", containsSyntheticMedia: false },
    });
    fixture.service.enqueue = () => {};
    await fixture.service.confirm(created.job.id);
    await writeFile(fixture.sourceFile, Buffer.alloc(2048, 0x23));

    await fixture.service.process(created.job.id);
    const job = fixture.jobStore.get(created.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "MEDIA_IDENTITY_MISMATCH");
    assert.equal(fixture.publisherFactoryCalls(), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("PublishingService markiert unterbrochene externe Uploads zur manuellen Statusprüfung", async () => {
  const root = await mkdtemp(join(tmpdir(), "faceless-publishing-recovery-"));
  try {
    const store = await new PublishingJobStore(join(root, "publish-jobs")).initialize();
    const created = await store.create({
      sourceJobId: "source-job-2",
      platform: "youtube",
      accountId: "youtube:channel-1",
      metadata: { title: "Recovery check", privacyStatus: "private", containsSyntheticMedia: false },
    });
    await store.transition(created.job.id, "preflight");
    await store.transition(created.job.id, "awaiting_confirmation");
    await store.confirm(created.job.id);

    const service = new PublishingService({ shortJobStore: {}, publishingJobStore: store, tokenManager: {}, vault: {} });
    await service.recover();
    const recovered = store.get(created.job.id);
    assert.equal(recovered.status, "needs_attention");
    assert.equal(recovered.error.code, "PROCESS_INTERRUPTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PublishingService setzt beim Neustart dieselbe gespeicherte YouTube-Session fort", async () => {
  const resumedSessions = [];
  const fixture = await makeIdentityFixture({
    youtubePublisherFactory: () => ({
      uploadVideo: async ({ sessionUri }) => {
        resumedSessions.push(sessionUri);
        return { videoId: "resumed-video-1" };
      },
      getVideoStatus: async () => ({ videoId: "resumed-video-1", uploadStatus: "processed", processingStatus: "succeeded" }),
    }),
  });
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Resume existing session", privacyStatus: "private", containsSyntheticMedia: false },
    });
    fixture.service.enqueue = () => {};
    await fixture.service.confirm(created.job.id);
    await fixture.jobStore.update(created.job.id, current => {
      current.remote = { encryptedSession: fixture.service.vault.encrypt({ uri: SESSION_URI }) };
    });

    const recoveredIds = [];
    fixture.service.enqueue = id => recoveredIds.push(id);
    await fixture.service.recover();
    assert.deepEqual(recoveredIds, [created.job.id]);
    assert.equal(fixture.jobStore.get(created.job.id).status, "uploading");

    await fixture.service.process(created.job.id);
    assert.deepEqual(resumedSessions, [SESSION_URI]);
    assert.equal(fixture.jobStore.get(created.job.id).status, "published");
  } finally {
    await fixture.cleanup();
  }
});

test("PublishingService belässt einen mehrdeutigen Chunkabbruch in needs_attention und startet ihn nicht erneut", async () => {
  let uploadCalls = 0;
  const fixture = await makeIdentityFixture({
    youtubePublisherFactory: () => ({
      uploadVideo: async ({ onSession }) => {
        uploadCalls += 1;
        await onSession(SESSION_URI);
        throw Object.assign(new Error("Chunkannahme unbekannt."), { code: "YOUTUBE_UPLOAD_STATE_UNKNOWN", uncertainAcceptance: true });
      },
    }),
  });
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Interrupted chunk", privacyStatus: "private", containsSyntheticMedia: false },
    });
    fixture.service.enqueue = () => {};
    await fixture.service.confirm(created.job.id);
    await fixture.service.process(created.job.id);

    const interrupted = fixture.jobStore.get(created.job.id);
    assert.equal(interrupted.status, "needs_attention");
    assert.ok(interrupted.remote.encryptedSession);
    await fixture.service.recover();
    assert.equal(fixture.jobStore.get(created.job.id).status, "needs_attention");
    assert.equal(uploadCalls, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("PublishingService gleicht platform_processing nach Neustart per Statusabfrage ab", async () => {
  const fixture = await makeIdentityFixture({
    youtubePublisherFactory: () => ({
      getVideoStatus: async () => ({ videoId: "processing-video", uploadStatus: "processed", processingStatus: "succeeded" }),
    }),
  });
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Reconcile processing state", privacyStatus: "private", containsSyntheticMedia: false },
    });
    await fixture.jobStore.confirm(created.job.id);
    await fixture.jobStore.transition(created.job.id, "platform_processing", { remote: { videoId: "processing-video" } });

    await fixture.service.recover();
    assert.equal(fixture.jobStore.get(created.job.id).status, "published");
  } finally {
    await fixture.cleanup();
  }
});

test("PublishingService setzt bei fehlgeschlagenem Statusabgleich nach Neustart needs_attention", async () => {
  const fixture = await makeIdentityFixture({
    youtubePublisherFactory: () => ({ getVideoStatus: async () => { throw Object.assign(new Error("temporary"), { code: "YOUTUBE_NETWORK_ERROR" }); } }),
  });
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Unreconciled processing state", privacyStatus: "private", containsSyntheticMedia: false },
    });
    await fixture.jobStore.confirm(created.job.id);
    await fixture.jobStore.transition(created.job.id, "platform_processing", { remote: { videoId: "processing-video" } });

    await fixture.service.recover();
    const recovered = fixture.jobStore.get(created.job.id);
    assert.equal(recovered.status, "needs_attention");
    assert.equal(recovered.error.code, "YOUTUBE_NETWORK_ERROR");
    assert.match(recovered.error.message, /manuelle Prüfung erforderlich/);
  } finally {
    await fixture.cleanup();
  }
});

test("PublishingService speichert Retry-Beobachtung pro Plattform und blockiert unklare Uploads zur manuellen Prüfung", async () => {
  const fixture = await makeIdentityFixture({
    youtubePublisherFactory: ({ retryOptions }) => ({
      uploadVideo: async () => {
        await retryOptions.onRetry({ platform: "youtube", action: "video-status", attempt: 1, delayMs: 25, errorCode: "YOUTUBE_TRANSIENT_RESPONSE" });
        throw Object.assign(new Error("Uploadannahme unklar; manuell abgleichen."), { code: "YOUTUBE_UPLOAD_STATE_UNKNOWN", uncertainAcceptance: true });
      },
    }),
  });
  try {
    const created = await fixture.service.create({
      sourceJobId: fixture.sourceJob.id,
      platform: "youtube",
      connectionId: "youtube:channel-1",
      metadata: { title: "Retry observability", privacyStatus: "private", containsSyntheticMedia: false },
    });
    fixture.service.enqueue = () => {};
    await fixture.service.confirm(created.job.id);
    await fixture.service.process(created.job.id);

    const job = fixture.jobStore.get(created.job.id);
    assert.equal(job.status, "needs_attention");
    assert.deepEqual(job.remote.retryEvents, [{
      platform: "youtube",
      action: "video-status",
      attempt: 1,
      delayMs: 25,
      errorCode: "YOUTUBE_TRANSIENT_RESPONSE",
    }]);
    assert.equal(job.error.uncertainAcceptance, true);
  } finally {
    await fixture.cleanup();
  }
});


async function createProcessingTikTokJob(fixture, publishId) {
  const { job } = await fixture.jobStore.create({
    sourceJobId: fixture.sourceJob.id,
    platform: "tiktok",
    accountId: "tiktok:creator-1",
    metadata: { mode: "upload" },
    idempotencyKey: `processing-${publishId}`,
  });
  await fixture.jobStore.transition(job.id, "preflight");
  await fixture.jobStore.transition(job.id, "awaiting_confirmation");
  await fixture.jobStore.confirm(job.id);
  return fixture.jobStore.transition(job.id, "platform_processing", { remote: { publishId } });
}

test("TikTok-Inbox-Limit sperrt konkurrierende Jobs pro Konto, erhält aber Idempotenz", async () => {
  const fixture = await makeIdentityFixture({ tiktokInboxPendingLimit: 2 });
  const createInboxJob = idempotencyKey => fixture.service.create({
    sourceJobId: fixture.sourceJob.id,
    platform: "tiktok",
    connectionId: "tiktok:creator-1",
    metadata: { mode: "upload" },
    idempotencyKey,
  });
  try {
    const [first, second] = await Promise.all([createInboxJob("tiktok-first"), createInboxJob("tiktok-second")]);
    assert.equal(first.job.status, "awaiting_confirmation");
    assert.equal(second.job.status, "awaiting_confirmation");
    assert.equal(fixture.jobStore.list().filter(job => job.platform === "tiktok" && job.status === "awaiting_confirmation").length, 2);

    const duplicate = await createInboxJob("tiktok-first");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);

    await assert.rejects(createInboxJob("tiktok-third"), error => {
      assert.equal(error.code, "TIKTOK_INBOX_PENDING_LIMIT");
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /zu viele Inbox-Aufträge offen/);
      return true;
    });
    assert.equal(fixture.jobStore.list().length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("TikTok-Statuspolling serialisiert Konten, hält Cooldown ein und erklärt Inbox-Aktion", async () => {
  const clockState = { now: Date.parse("2026-01-01T00:00:00.000Z") };
  let statusCalls = 0;
  let signalStatusStarted;
  const statusStarted = new Promise(resolve => { signalStatusStarted = resolve; });
  let releaseStatus;
  const statusGate = new Promise(resolve => { releaseStatus = resolve; });
  const fixture = await makeIdentityFixture({
    tiktokStatusPollIntervalMs: 60_000,
    clock: () => clockState.now,
    tiktokPublisherFactory: () => ({
      getStatus: async publishId => {
        statusCalls += 1;
        if (statusCalls === 1) signalStatusStarted();
        await statusGate;
        return { publishId, status: "SEND_TO_USER_INBOX" };
      },
    }),
  });
  try {
    const first = await createProcessingTikTokJob(fixture, "tiktok-publish-first");
    const second = await createProcessingTikTokJob(fixture, "tiktok-publish-second");

    const firstRefresh = fixture.service.refreshStatus(first.id);
    await statusStarted;
    const secondRefresh = fixture.service.refreshStatus(second.id);
    releaseStatus();
    const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);

    assert.equal(statusCalls, 1);
    assert.equal(firstResult.status, "awaiting_creator_action");
    assert.match(firstResult.statusMessage, /TikTok hat den Entwurf in deine Inbox gelegt/);
    assert.match(firstResult.statusMessage, /schließe den Veröffentlichungsschritt dort ab/);
    assert.match(firstResult.statusMessage, /2026-01-01T00:01:00.000Z/);
    assert.equal(secondResult.status, "platform_processing");
    assert.equal(secondResult.remote.statusPolling.limited, true);
    assert.match(fixture.jobStore.get(second.id).statusMessage, /frühestens ab 2026-01-01T00:01:00.000Z/);

    clockState.now += 59_999;
    await fixture.service.refreshStatus(second.id);
    assert.equal(statusCalls, 1);

    clockState.now += 1;
    const secondResultAtLimit = await fixture.service.refreshStatus(second.id);
    assert.equal(statusCalls, 2);
    assert.equal(secondResultAtLimit.status, "awaiting_creator_action");
    assert.match(secondResultAtLimit.statusMessage, /Öffne TikTok/);

    clockState.now += 60_000;
    const repeatedInboxResult = await fixture.service.refreshStatus(second.id);
    assert.equal(statusCalls, 3);
    assert.equal(repeatedInboxResult.status, "awaiting_creator_action");
    assert.match(repeatedInboxResult.statusMessage, /Entwurf in deine Inbox gelegt/);
  } finally {
    releaseStatus?.();
    await fixture.cleanup();
  }
});
