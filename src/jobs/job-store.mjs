import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JobNotFoundError extends Error {
  constructor(jobId) {
    super(`Auftrag ${jobId} wurde nicht gefunden.`);
    this.name = "JobNotFoundError";
  }
}

export class JobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobs = new Map();
    this.idempotencyIndex = new Map();
    this.writeLocks = new Map();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
      const jobPath = join(this.dataDir, entry.name, "job.json");
      try {
        const job = JSON.parse(await readFile(jobPath, "utf8"));
        if (job.id !== entry.name) continue;
        this.jobs.set(job.id, job);
        if (job.idempotencyKey) this.idempotencyIndex.set(job.idempotencyKey, job.id);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw new Error(`Job-Datei konnte nicht geladen werden (${entry.name}): ${error.message}`);
      }
    }
    return this;
  }

  async create({ topic, durationSeconds, idempotencyKey = null }) {
    if (idempotencyKey) {
      const existingId = this.idempotencyIndex.get(idempotencyKey);
      if (existingId) return { job: this.get(existingId), created: false };
    }

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      topic,
      durationSeconds,
      idempotencyKey,
      status: "queued",
      progress: 0,
      currentStep: "queued",
      steps: [],
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.jobs.set(job.id, job);
    if (idempotencyKey) this.idempotencyIndex.set(idempotencyKey, job.id);
    await this.persist(job);
    return { job: structuredClone(job), created: true };
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(job => structuredClone(job));
  }

  findByIdempotencyKey(key) {
    const jobId = this.idempotencyIndex.get(key);
    return jobId ? this.get(jobId) : null;
  }

  getJobDirectory(jobId) {
    if (!JOB_ID_PATTERN.test(jobId)) return null;
    return join(this.dataDir, jobId);
  }

  async update(jobId, mutate) {
    const previous = this.writeLocks.get(jobId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = this.jobs.get(jobId);
      if (!current) throw new JobNotFoundError(jobId);
      const next = structuredClone(current);
      await mutate(next);
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.jobs.set(jobId, next);
      if (next.idempotencyKey) this.idempotencyIndex.set(next.idempotencyKey, jobId);
      return structuredClone(next);
    });
    const lock = operation.catch(() => {});
    this.writeLocks.set(jobId, lock);
    try {
      return await operation;
    } finally {
      if (this.writeLocks.get(jobId) === lock) this.writeLocks.delete(jobId);
    }
  }

  async persist(job) {
    const directory = this.getJobDirectory(job.id);
    if (!directory) throw new Error("Ungültige Job-ID.");
    await mkdir(directory, { recursive: true });
    const target = join(directory, "job.json");
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
