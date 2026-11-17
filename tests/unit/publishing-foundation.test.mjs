import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canTransitionPublishingStatus, assertPublishingTransition } from "../../src/publishing/model.mjs";
import { PublishingJobStore } from "../../src/publishing/job-store.mjs";
import { validatePublishRequest } from "../../src/publishing/preflight.mjs";

test("Publishing-Statusmodell erlaubt nur definierte Übergänge", () => {
  assert.equal(canTransitionPublishingStatus("queued", "preflight"), true);
  assert.equal(canTransitionPublishingStatus("published", "uploading"), false);
  assert.throws(() => assertPublishingTransition("published", "uploading"), { code: "INVALID_PUBLISHING_TRANSITION" });
});

test("PublishingJobStore dedupliziert, persistiert und prüft Übergänge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-store-"));
  try {
    const store = await new PublishingJobStore(directory).initialize();
    const first = await store.create({ sourceJobId: "short-1", platform: "youtube", accountId: "channel-1", metadata: { title: "Demo" }, idempotencyKey: "publish-1" });
    assert.equal(first.created, true);
    const duplicate = await store.create({ sourceJobId: "short-2", platform: "youtube", accountId: "channel-1", metadata: {}, idempotencyKey: "publish-1" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);
    await store.transition(first.job.id, "preflight");
    await store.transition(first.job.id, "awaiting_confirmation");
    await store.confirm(first.job.id);
    assert.equal(store.get(first.job.id).status, "uploading");
    assert.equal(store.get(first.job.id).attempts, 1);
    const reloaded = await new PublishingJobStore(directory).initialize();
    assert.equal(reloaded.get(first.job.id).approvedAt !== null, true);
    await assert.rejects(() => reloaded.transition(first.job.id, "queued"), { code: "INVALID_PUBLISHING_TRANSITION" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Preflight erzwingt explizite YouTube-Sichtbarkeit und Shorts-Laufzeit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-video-"));
  const videoPath = join(directory, "video.mp4");
  try {
    await writeFile(videoPath, Buffer.alloc(1024));
    const base = { filePath: videoPath, video: { durationSeconds: 30, container: "mp4", videoCodec: "h264", width: 1080, height: 1920, framesPerSecond: 30 }, metadata: { privacyStatus: "private", containsSyntheticMedia: false } };
    assert.equal((await validatePublishRequest({ ...base, platform: "youtube" })).platform, "youtube");
    await assert.rejects(() => validatePublishRequest({ ...base, platform: "youtube", metadata: { containsSyntheticMedia: false } }), { code: "YOUTUBE_PRIVACY_REQUIRED" });
    await assert.rejects(() => validatePublishRequest({ ...base, platform: "youtube", video: { ...base.video, durationSeconds: 181 } }), { code: "YOUTUBE_SHORT_TOO_LONG" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TikTok Direct Post verlangt aktuelle Creator-Info, Privacy und Consent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-tiktok-"));
  const videoPath = join(directory, "video.mp4");
  try {
    await writeFile(videoPath, Buffer.alloc(1024));
    const base = { platform: "tiktok", mode: "direct_post", filePath: videoPath, video: { durationSeconds: 20, width: 1080, height: 1920, framesPerSecond: 30 }, metadata: { privacyLevel: "PUBLIC_TO_EVERYONE", isAigc: false, disableComment: true, disableDuet: true, disableStitch: true, brandContentToggle: false, brandOrganicToggle: false, confirmed: true }, creatorInfo: { max_video_post_duration_sec: 60, privacy_level_options: ["PUBLIC_TO_EVERYONE"] } };
    assert.equal((await validatePublishRequest(base)).mode, "direct_post");
    await assert.rejects(() => validatePublishRequest({ ...base, metadata: { ...base.metadata, confirmed: false } }), { code: "TIKTOK_CONSENT_REQUIRED" });
    await assert.rejects(() => validatePublishRequest({ ...base, creatorInfo: { ...base.creatorInfo, privacy_level_options: ["SELF_ONLY"] } }), { code: "TIKTOK_PRIVACY_NOT_ALLOWED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("PublishingJobStore protokolliert Quelle, sichere Metadatenfelder, Freigabe und Statuswechsel ohne Inhalte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-audit-"));
  try {
    const store = await new PublishingJobStore(directory).initialize();
    const created = await store.create({
      sourceJobId: "short-audit-1",
      platform: "tiktok",
      accountId: "tiktok:creator-1",
      sourceSnapshot: { sha256: "a".repeat(64), sizeBytes: 2048 },
      metadata: {
        title: "VERTRAULICHER-TITEL-1",
        description: "VERTRAULICHER-BESCHREIBUNG-1",
        accessToken: "GEHEIM-TOKEN-1",
        sessionUrl: "https://private.example/session-secret-1",
      },
    });
    await store.transition(created.job.id, "preflight");
    await store.transition(created.job.id, "awaiting_confirmation", {
      metadata: { ...created.job.metadata, title: "VERTRAULICHER-TITEL-2" },
    });
    await store.confirm(created.job.id, { ...created.job.metadata, title: "VERTRAULICHER-TITEL-3" });

    const job = store.get(created.job.id);
    assert.deepEqual(job.auditTrail.map(event => event.type), [
      "job_created",
      "status_transition",
      "metadata_changed",
      "status_transition",
      "metadata_changed",
      "approval_granted",
      "status_transition",
    ]);
    assert.deepEqual(job.auditTrail[0].fields, {
      platform: "tiktok",
      accountId: "tiktok:creator-1",
      sourceJobId: "short-audit-1",
      sourceSha256: "a".repeat(64),
      metadataFields: ["description", "title"],
    });
    assert.deepEqual(job.auditTrail[2].fields.changedFields, ["title"]);
    assert.deepEqual(job.auditTrail[5].fields.metadataFields, ["description", "title"]);

    const auditJson = JSON.stringify(job.auditTrail);
    for (const privateValue of ["VERTRAULICHER-TITEL-1", "VERTRAULICHER-BESCHREIBUNG-1", "GEHEIM-TOKEN-1", "private.example/session-secret-1", "accessToken", "sessionUrl"]) {
      assert.equal(auditJson.includes(privateValue), false, `Audit darf ${privateValue} nicht enthalten`);
    }

    const diskJob = JSON.parse(await readFile(join(store.getDirectory(job.id), "publish.json"), "utf8"));
    assert.equal(diskJob.status, job.status);
    assert.deepEqual(diskJob.auditTrail, job.auditTrail);
    const reloaded = await new PublishingJobStore(directory).initialize();
    assert.deepEqual(reloaded.get(job.id).auditTrail, job.auditTrail);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fehlgeschlagene atomare Persistenz lässt Status und Audit-Trail gemeinsam unverändert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-audit-atomic-"));
  try {
    const store = await new PublishingJobStore(directory).initialize();
    const created = await store.create({ sourceJobId: "short-atomic-1", platform: "youtube", accountId: "channel-atomic-1", metadata: { title: "Atomic" } });
    await store.transition(created.job.id, "preflight");
    await store.transition(created.job.id, "awaiting_confirmation");
    const before = store.get(created.job.id);
    const persist = store.persist.bind(store);
    store.persist = async job => {
      if (job.status === "uploading") throw new Error("simulierter Persistenzfehler");
      return persist(job);
    };

    await assert.rejects(() => store.confirm(created.job.id, { title: "not persisted" }), /simulierter Persistenzfehler/);
    assert.deepEqual(store.get(created.job.id), before);
    const diskJob = JSON.parse(await readFile(join(store.getDirectory(created.job.id), "publish.json"), "utf8"));
    assert.equal(diskJob.status, before.status);
    assert.deepEqual(diskJob.auditTrail, before.auditTrail);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("fehlgeschlagene Jobanlage reserviert weder Job-ID noch Idempotency-Key im Speicher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-publishing-audit-create-atomic-"));
  try {
    const store = await new PublishingJobStore(directory).initialize();
    const persist = store.persist.bind(store);
    store.persist = async () => { throw new Error("simulierter Erstellungsfehler"); };
    const input = { sourceJobId: "short-create-atomic", platform: "youtube", accountId: "channel-create-atomic", metadata: {}, idempotencyKey: "create-atomic-key" };

    await assert.rejects(() => store.create(input), /simulierter Erstellungsfehler/);
    assert.deepEqual(store.list(), []);

    store.persist = persist;
    const retry = await store.create(input);
    assert.equal(retry.created, true);
    assert.equal(store.list().length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
