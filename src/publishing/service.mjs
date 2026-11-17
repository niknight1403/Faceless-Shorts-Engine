import { basename, join } from "node:path";
import { validatePublishRequest } from "./preflight.mjs";
import { YouTubePublisher } from "./platforms/youtube.mjs";
import { TikTokPublisher } from "./platforms/tiktok.mjs";
import { assertMediaSnapshot, captureMediaSnapshot } from "./media-identity.mjs";

const ACTIVE_TIKTOK_INBOX_STATUSES = new Set([
  "queued", "preflight", "awaiting_confirmation", "uploading", "platform_processing", "awaiting_creator_action", "needs_attention",
]);

export class PublishingServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "PublishingServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PublishingService {
  constructor({ shortJobStore, publishingJobStore, tokenManager, vault = null, fetchImpl = fetch, youtubePublisherFactory, tiktokPublisherFactory, tiktokInboxPendingLimit = 5, tiktokStatusPollIntervalMs = 60_000, clock = () => Date.now() }) {
    if (!Number.isInteger(tiktokInboxPendingLimit) || tiktokInboxPendingLimit < 1) throw new TypeError("tiktokInboxPendingLimit muss mindestens 1 sein.");
    if (!Number.isInteger(tiktokStatusPollIntervalMs) || tiktokStatusPollIntervalMs < 0) throw new TypeError("tiktokStatusPollIntervalMs muss nichtnegativ sein.");
    if (typeof clock !== "function") throw new TypeError("clock muss eine Funktion sein.");
    this.shortJobStore = shortJobStore;
    this.jobStore = publishingJobStore;
    this.tokenManager = tokenManager;
    this.vault = vault;
    this.youtubePublisherFactory = youtubePublisherFactory || (options => new YouTubePublisher({ ...options, fetchImpl }));
    this.tiktokPublisherFactory = tiktokPublisherFactory || (options => new TikTokPublisher({ ...options, fetchImpl }));
    this.tiktokInboxPendingLimit = tiktokInboxPendingLimit;
    this.tiktokStatusPollIntervalMs = tiktokStatusPollIntervalMs;
    this.clock = clock;
    this.tiktokInboxCreateLock = Promise.resolve();
    this.tiktokStatusPollLocks = new Map();
    this.queue = [];
    this.queued = new Set();
    this.running = false;
  }

  source(jobId) {
    const job = this.shortJobStore.get(jobId);
    if (!job) throw new PublishingServiceError("SOURCE_JOB_NOT_FOUND", "Videoauftrag wurde nicht gefunden.", 404);
    if (job.status !== "completed" || !job.output) throw new PublishingServiceError("SOURCE_VIDEO_NOT_READY", "Der Videoauftrag muss zuerst erfolgreich abgeschlossen sein.", 409);
    const filename = basename(job.output.filename || "final.mp4");
    if (filename !== "final.mp4") throw new PublishingServiceError("SOURCE_FILENAME_INVALID", "Unerwarteter Dateiname des Videoexports.");
    const directory = this.shortJobStore.getJobDirectory(jobId);
    if (!directory) throw new PublishingServiceError("SOURCE_JOB_NOT_FOUND", "Videoauftrag wurde nicht gefunden.", 404);
    return { job, filePath: join(directory, filename) };
  }

  async connection(connectionId, platform) {
    const connection = this.tokenManager.vault.get(connectionId);
    if (!connection || connection.platform !== platform) throw new PublishingServiceError("CONNECTION_NOT_FOUND", "Das ausgewählte Plattformkonto ist nicht verbunden.", 404);
    return connection;
  }

  async makePublisher(platform, connectionId, { onRetry } = {}) {
    const connection = await this.connection(connectionId, platform);
    const accessToken = await this.tokenManager.getAccessToken(connectionId);
    if (platform === "youtube") return this.youtubePublisherFactory({ accessToken, retryOptions: { onRetry } });
    return this.tiktokPublisherFactory({ accessToken, retryOptions: { onRetry } });
  }

  async recordRetry(jobId, event) {
    const safeEvent = {
      platform: event.platform,
      action: event.action,
      attempt: event.attempt,
      delayMs: event.delayMs,
      errorCode: event.errorCode,
    };
    await this.jobStore.update(jobId, current => {
      const existing = current.remote?.retryEvents || [];
      current.remote = { ...(current.remote || {}), retryEvents: [...existing, safeEvent].slice(-25) };
    });
  }

  remoteAfterUpload(jobId, values) {
    const remote = { ...(this.jobStore.get(jobId)?.remote || {}) };
    delete remote.encryptedSession;
    delete remote.sessionUri;
    return { ...remote, ...values };
  }

  async createTikTokInboxJob(input, accountId, idempotencyKey) {
    const previous = this.tiktokInboxCreateLock;
    let release;
    this.tiktokInboxCreateLock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (idempotencyKey) {
        const existing = this.jobStore.list().find(job => job.idempotencyKey === idempotencyKey);
        if (existing) return { job: existing, created: false };
      }
      const pending = this.jobStore.list().filter(job => (
        job.platform === "tiktok"
        && job.accountId === accountId
        && job.mode === "upload"
        && ACTIVE_TIKTOK_INBOX_STATUSES.has(job.status)
      )).length;
      if (pending >= this.tiktokInboxPendingLimit) {
        throw new PublishingServiceError("TIKTOK_INBOX_PENDING_LIMIT", "Für dieses TikTok-Konto sind bereits zu viele Inbox-Aufträge offen. Warte, bis ein Auftrag abgeschlossen oder manuell geklärt ist.", 429);
      }
      return await this.jobStore.create(input);
    } finally {
      release();
    }
  }

  tiktokStatusPollWindow(job, nowMs) {
    const latestPollMs = this.jobStore.list()
      .filter(candidate => candidate.platform === "tiktok" && candidate.accountId === job.accountId)
      .map(candidate => Date.parse(candidate.remote?.lastStatusPollAt || ""))
      .filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), 0);
    if (latestPollMs === 0) return null;
    const nextAllowedMs = latestPollMs + this.tiktokStatusPollIntervalMs;
    if (nowMs >= nextAllowedMs) return null;
    return { nextAllowedAt: new Date(nextAllowedMs).toISOString() };
  }

  tiktokStatusMessage(status, nextAllowedAt) {
    const lead = status === "awaiting_creator_action"
      ? "TikTok hat den Entwurf in deine Inbox gelegt. Öffne TikTok, prüfe ihn und schließe den Veröffentlichungsschritt dort ab."
      : "TikTok verarbeitet den Auftrag.";
    return `${lead} Die nächste Statusabfrage ist frühestens ab ${nextAllowedAt} möglich.`;
  }

  async withTikTokStatusPollLock(accountId, operation) {
    const previous = this.tiktokStatusPollLocks.get(accountId) || Promise.resolve();
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    this.tiktokStatusPollLocks.set(accountId, lock);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tiktokStatusPollLocks.get(accountId) === lock) this.tiktokStatusPollLocks.delete(accountId);
    }
  }

  async create({ sourceJobId, platform, connectionId, metadata = {}, idempotencyKey = null }) {
    const source = this.source(sourceJobId);
    const sourceSnapshot = await captureMediaSnapshot(source.filePath, source.job.output);
    await this.connection(connectionId, platform);
    const jobInput = { sourceJobId, platform, accountId: connectionId, metadata, idempotencyKey, sourceSnapshot };
    const created = platform === "tiktok" && (metadata.mode || "upload") === "upload"
      ? await this.createTikTokInboxJob(jobInput, connectionId, idempotencyKey)
      : await this.jobStore.create(jobInput);
    if (!created.created) return created;
    let job = await this.jobStore.transition(created.job.id, "preflight");
    try {
      let preparedMetadata = structuredClone(job.metadata);
      let creatorInfo = null;
      if (platform === "tiktok" && job.mode === "direct_post") {
        preparedMetadata.confirmed = false;
        const publisher = await this.makePublisher(platform, connectionId, { onRetry: event => this.recordRetry(job.id, event) });
        creatorInfo = await publisher.queryCreatorInfo();
        preparedMetadata = { ...preparedMetadata, creatorInfo };
      }
      const preflight = await validatePublishRequest({
        platform,
        filePath: source.filePath,
        video: source.job.output,
        metadata: preparedMetadata,
        creatorInfo,
        mode: job.mode,
        requireConsent: false,
      });
      job = await this.jobStore.transition(job.id, "awaiting_confirmation", { metadata: preparedMetadata, preflight, error: null });
      return { job, created: true };
    } catch (error) {
      await this.jobStore.transition(job.id, "failed", { error: this.safeError(error) });
      throw error;
    }
  }

  async confirm(jobId, metadata = null) {
    let job = this.jobStore.get(jobId);
    if (!job) throw new PublishingServiceError("PUBLISHING_JOB_NOT_FOUND", "Publishing-Auftrag wurde nicht gefunden.", 404);
    if (job.status !== "awaiting_confirmation") throw new PublishingServiceError("PUBLISHING_JOB_NOT_CONFIRMABLE", "Nur geprüfte Publishing-Aufträge können bestätigt werden.", 409);
    const source = this.source(job.sourceJobId);
    await assertMediaSnapshot(source.filePath, source.job.output, job.sourceSnapshot);
    let approvedMetadata = metadata ? { ...job.metadata, ...structuredClone(metadata) } : structuredClone(job.metadata);
    delete approvedMetadata.confirmed;
    if (job.platform === "tiktok" && job.mode === "direct_post") {
      const publisher = await this.makePublisher("tiktok", job.accountId, { onRetry: event => this.recordRetry(jobId, event) });
      const currentInfo = await publisher.queryCreatorInfo();
      approvedMetadata = { ...approvedMetadata, creatorInfo: currentInfo, confirmed: true };
      await validatePublishRequest({ platform: "tiktok", mode: "direct_post", filePath: source.filePath, video: source.job.output, metadata: approvedMetadata, creatorInfo: currentInfo });
    } else {
      await validatePublishRequest({ platform: job.platform, mode: job.mode, filePath: source.filePath, video: source.job.output, metadata: approvedMetadata });
    }
    job = await this.jobStore.confirm(jobId, approvedMetadata);
    this.enqueue(jobId);
    return job;
  }

  enqueue(jobId) {
    if (this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.queue.push(jobId);
    void this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        try {
          await this.process(id);
        } finally {
          this.queued.delete(id);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length) void this.pump();
    }
  }

  async process(jobId) {
    const job = this.jobStore.get(jobId);
    if (!job || job.status !== "uploading") return;
    try {
      const source = this.source(job.sourceJobId);
      await assertMediaSnapshot(source.filePath, source.job.output, job.sourceSnapshot);
      const publisher = await this.makePublisher(job.platform, job.accountId, { onRetry: event => this.recordRetry(jobId, event) });
      let uploadResult;
      if (job.platform === "youtube") {
        uploadResult = await publisher.uploadVideo({
          filePath: source.filePath,
          metadata: job.metadata,
          sessionUri: this.sessionUri(job),
          onSession: async sessionUri => {
            if (!this.vault) throw new PublishingServiceError("SESSION_ENCRYPTION_UNAVAILABLE", "Der verschlüsselte Upload-Session-Speicher ist nicht verfügbar.", 500);
            const encryptedSession = this.vault.encrypt({ uri: sessionUri });
            await this.jobStore.update(jobId, current => {
              current.remote = { ...(current.remote || {}), encryptedSession };
              delete current.remote.sessionUri;
            });
          },
        });
        await this.jobStore.transition(jobId, "platform_processing", { remote: this.remoteAfterUpload(jobId, { videoId: uploadResult.videoId }), error: null });
      } else {
        if (job.mode === "direct_post") {
          const creatorInfo = await publisher.queryCreatorInfo();
          const metadata = { ...job.metadata, creatorInfo, confirmed: true };
          await validatePublishRequest({ platform: "tiktok", mode: "direct_post", filePath: source.filePath, video: source.job.output, metadata, creatorInfo });
          uploadResult = await publisher.directPost({ filePath: source.filePath, metadata });
        } else {
          uploadResult = await publisher.uploadToInbox({ filePath: source.filePath });
        }
        await this.jobStore.transition(jobId, "platform_processing", { remote: this.remoteAfterUpload(jobId, { publishId: uploadResult.publishId }), error: null });
      }
      await this.refreshStatus(jobId);
    } catch (error) {
      const current = this.jobStore.get(jobId);
      if (!current || ["failed", "published", "cancelled"].includes(current.status)) return;
      const hasRemote = Boolean(current.remote?.videoId || current.remote?.publishId || current.remote?.sessionUri || current.remote?.encryptedSession || error.uncertainAcceptance === true);
      const status = hasRemote ? "needs_attention" : "failed";
      await this.jobStore.transition(jobId, status, { error: this.safeError(error) });
    }
  }

  async refreshStatus(jobId, pollLocked = false) {
    let job = this.jobStore.get(jobId);
    if (!job) throw new PublishingServiceError("PUBLISHING_JOB_NOT_FOUND", "Publishing-Auftrag wurde nicht gefunden.", 404);
    if (!["platform_processing", "awaiting_creator_action"].includes(job.status)) return job;
    if (job.platform === "tiktok" && !pollLocked) {
      return this.withTikTokStatusPollLock(job.accountId, () => this.refreshStatus(jobId, true));
    }
    let tiktokCheckedAt = null;
    if (job.platform === "tiktok") {
      const nowMs = this.clock();
      const pollWindow = this.tiktokStatusPollWindow(job, nowMs);
      if (pollWindow) {
        return this.jobStore.update(jobId, current => {
          current.remote = { ...(current.remote || {}), statusPolling: { ...(current.remote?.statusPolling || {}), nextAllowedAt: pollWindow.nextAllowedAt, limited: true } };
          current.statusMessage = this.tiktokStatusMessage(job.status, pollWindow.nextAllowedAt);
        });
      }
      tiktokCheckedAt = new Date(nowMs).toISOString();
      await this.jobStore.update(jobId, current => {
        current.remote = {
          ...(current.remote || {}),
          lastStatusPollAt: tiktokCheckedAt,
          statusPolling: { lastCheckedAt: tiktokCheckedAt, nextAllowedAt: new Date(nowMs + this.tiktokStatusPollIntervalMs).toISOString(), limited: false },
        };
      });
      job = this.jobStore.get(jobId);
    }
    const publisher = await this.makePublisher(job.platform, job.accountId, { onRetry: event => this.recordRetry(jobId, event) });
    const result = job.platform === "youtube"
      ? await publisher.getVideoStatus(job.remote?.videoId)
      : await publisher.getStatus(job.remote?.publishId);
    if (job.platform === "youtube") {
      const remote = { ...job.remote, platformStatus: result };
      if (["failed", "terminated", "rejected", "deleted"].includes(result.processingStatus) || ["failed", "rejected", "deleted"].includes(result.uploadStatus)) {
        return this.jobStore.transition(jobId, "failed", { remote, error: { code: "YOUTUBE_PROCESSING_FAILED", message: result.processingFailureReason || result.uploadStatus || "YouTube-Verarbeitung fehlgeschlagen." } });
      }
      if (result.processingStatus === "succeeded") return this.jobStore.transition(jobId, "published", { remote, error: null });
      return this.jobStore.update(jobId, current => { current.remote = remote; });
    }

    const remote = { ...job.remote, platformStatus: result };
    const nextAllowedAt = new Date(Date.parse(tiktokCheckedAt) + this.tiktokStatusPollIntervalMs).toISOString();
    if (result.status === "FAILED") return this.jobStore.transition(jobId, "failed", { remote, statusMessage: null, error: { code: result.failReason || "TIKTOK_PUBLISH_FAILED", message: "TikTok hat den Auftrag abgelehnt oder nicht verarbeitet." } });
    if (result.status === "PUBLISH_COMPLETE") return this.jobStore.transition(jobId, "published", { remote, statusMessage: null, error: null });
    if (result.status === "SEND_TO_USER_INBOX") {
      const fields = { remote, statusMessage: this.tiktokStatusMessage("awaiting_creator_action", nextAllowedAt), error: null };
      if (job.status === "awaiting_creator_action") return this.jobStore.update(jobId, current => Object.assign(current, fields));
      return this.jobStore.transition(jobId, "awaiting_creator_action", fields);
    }
    return this.jobStore.update(jobId, current => {
      current.remote = remote;
      current.statusMessage = this.tiktokStatusMessage(job.status, nextAllowedAt);
    });
  }

  async recover() {
    for (const job of this.jobStore.list()) {
      if (job.status === "uploading") {
        if (job.platform === "youtube" && job.remote?.encryptedSession) {
          try {
            if (this.sessionUri(job)) {
              this.enqueue(job.id);
              continue;
            }
          } catch {
            // A missing or undecryptable session is not permission to create a new upload.
          }
        }
        await this.jobStore.transition(job.id, "needs_attention", { error: { code: "PROCESS_INTERRUPTED", message: "Der Prozess wurde während eines externen Uploads beendet. Status abgleichen, bevor ein neuer Upload gestartet wird." } });
      } else if (job.status === "platform_processing") {
        try {
          await this.refreshStatus(job.id);
        } catch (error) {
          const current = this.jobStore.get(job.id);
          if (current?.status === "platform_processing") {
            const safe = this.safeError(error);
            safe.message = "Der Plattformstatus konnte nach dem Neustart nicht sicher abgeglichen werden; manuelle Prüfung erforderlich.";
            await this.jobStore.transition(job.id, "needs_attention", { error: safe });
          }
        }
      }
    }
  }

  safeError(error) {
    const safe = { code: error.code || "PUBLISHING_FAILED", message: error.message || "Veröffentlichungsauftrag fehlgeschlagen." };
    if (Number.isInteger(error.retryAttempts)) safe.retryAttempts = error.retryAttempts;
    if (error.retryExhausted === true) safe.retryExhausted = true;
    if (error.uncertainAcceptance === true) safe.uncertainAcceptance = true;
    if (Number.isInteger(error.statusCode)) safe.statusCode = error.statusCode;
    return safe;
  }

  sessionUri(job) {
    if (!job.remote?.encryptedSession) return null;
    if (!this.vault) throw new PublishingServiceError("SESSION_ENCRYPTION_UNAVAILABLE", "Der verschlüsselte Upload-Session-Speicher ist nicht verfügbar.", 500);
    const session = this.vault.decrypt(job.remote.encryptedSession);
    return typeof session.uri === "string" ? session.uri : null;
  }
}
