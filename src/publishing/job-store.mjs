import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertPublishingTransition } from "./model.mjs";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORM_SET = new Set(["youtube", "tiktok"]);
const SENSITIVE_FIELD_NAME = /(token|secret|authorization|cookie|password|credential|session|key|uri|url)/i;

function safeMetadataFieldNames(metadata) {
  return Object.keys(metadata || {}).filter(name => !SENSITIVE_FIELD_NAME.test(name)).sort();
}

function changedMetadataFieldNames(previous = {}, next = {}) {
  const names = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  return [...names]
    .filter(name => !SENSITIVE_FIELD_NAME.test(name) && !isDeepStrictEqual(previous?.[name], next?.[name]))
    .sort();
}

function appendAuditEvents(previous, events) {
  const additions = events.map(({ type, fields = {} }) => ({ at: new Date().toISOString(), type, fields: structuredClone(fields) }));
  return [...previous, ...additions];
}

export class PublishingJobNotFoundError extends Error {
  constructor(id) {
    super(`Publishing-Auftrag ${id} wurde nicht gefunden.`);
    this.name = "PublishingJobNotFoundError";
  }
}

export class PublishingJobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobs = new Map();
    this.idempotencyIndex = new Map();
    this.writeLocks = new Map();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        const job = JSON.parse(await readFile(join(this.dataDir, entry.name, "publish.json"), "utf8"));
        if (job.id !== entry.name || !PLATFORM_SET.has(job.platform)) continue;
        this.jobs.set(job.id, job);
        if (job.idempotencyKey) this.idempotencyIndex.set(job.idempotencyKey, job.id);
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Publishing-Auftrag konnte nicht geladen werden (${entry.name}): ${error.message}`);
      }
    }
    return this;
  }

  async create({ sourceJobId, platform, accountId, metadata = {}, idempotencyKey = null, sourceSnapshot = null }) {
    if (!sourceJobId || typeof sourceJobId !== "string") throw new TypeError("sourceJobId ist erforderlich.");
    if (!PLATFORM_SET.has(platform)) throw new TypeError("platform muss youtube oder tiktok sein.");
    if (!accountId || typeof accountId !== "string") throw new TypeError("accountId ist erforderlich.");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("metadata muss ein Objekt sein.");
    if (idempotencyKey && this.idempotencyIndex.has(idempotencyKey)) {
      return { job: this.get(this.idempotencyIndex.get(idempotencyKey)), created: false };
    }

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      sourceJobId,
      platform,
      accountId,
      metadata: structuredClone(metadata),
      sourceSnapshot: sourceSnapshot ? structuredClone(sourceSnapshot) : null,
      idempotencyKey,
      status: "queued",
      mode: platform === "tiktok" ? (metadata.mode || "upload") : "upload",
      approvedAt: null,
      attempts: 0,
      remote: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      auditTrail: [{
        at: now,
        type: "job_created",
        fields: {
          platform,
          accountId,
          sourceJobId,
          sourceSha256: typeof sourceSnapshot?.sha256 === "string" ? sourceSnapshot.sha256 : null,
          metadataFields: safeMetadataFieldNames(metadata),
        },
      }],
    };
    await this.persist(job);
    this.jobs.set(job.id, job);
    if (idempotencyKey) this.idempotencyIndex.set(idempotencyKey, job.id);
    return { job: structuredClone(job), created: true };
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => structuredClone(job));
  }

  getDirectory(id) {
    return ID_PATTERN.test(id) ? join(this.dataDir, id) : null;
  }

  async update(id, mutate) {
    const previous = this.writeLocks.get(id) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = this.jobs.get(id);
      if (!current) throw new PublishingJobNotFoundError(id);
      const next = structuredClone(current);
      const additionalAuditEvents = await mutate(next);
      if (!isDeepStrictEqual(next.sourceSnapshot, current.sourceSnapshot)) {
        const error = new Error("Der Medien-Snapshot eines Publishing-Auftrags ist unveränderlich.");
        error.code = "SOURCE_SNAPSHOT_IMMUTABLE";
        throw error;
      }
      const auditEvents = [];
      if (!isDeepStrictEqual(next.metadata, current.metadata)) {
        auditEvents.push({ type: "metadata_changed", fields: { changedFields: changedMetadataFieldNames(current.metadata, next.metadata) } });
      }
      if (Array.isArray(additionalAuditEvents) && additionalAuditEvents.some(event => event?.type === "approval_granted")) {
        auditEvents.push({ type: "approval_granted", fields: { metadataFields: safeMetadataFieldNames(next.metadata) } });
      }
      if (next.status !== current.status) {
        auditEvents.push({ type: "status_transition", fields: { from: current.status, to: next.status } });
      }
      next.auditTrail = appendAuditEvents(Array.isArray(current.auditTrail) ? current.auditTrail : [], auditEvents);
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.jobs.set(id, next);
      return structuredClone(next);
    });
    const lock = operation.catch(() => {});
    this.writeLocks.set(id, lock);
    try {
      return await operation;
    } finally {
      if (this.writeLocks.get(id) === lock) this.writeLocks.delete(id);
    }
  }

  async transition(id, status, fields = {}) {
    return this.update(id, job => {
      assertPublishingTransition(job.status, status);
      job.status = status;
      Object.assign(job, structuredClone(fields));
      if (["published", "failed", "cancelled"].includes(status)) job.completedAt = new Date().toISOString();
    });
  }

  async confirm(id, metadata = null) {
    return this.update(id, job => {
      assertPublishingTransition(job.status, "uploading");
      if (metadata) job.metadata = structuredClone(metadata);
      job.status = "uploading";
      job.approvedAt = new Date().toISOString();
      job.attempts += 1;
      job.error = null;
      return [{ type: "approval_granted" }];
    });
  }

  async persist(job) {
    const directory = this.getDirectory(job.id);
    if (!directory) throw new Error("Ungültige Publishing-Job-ID.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, "publish.json");
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
