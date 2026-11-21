import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../../src/jobs/job-store.mjs";

test("JobStore persistiert Jobs, dedupliziert Idempotency-Keys und serialisiert Updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-job-store-"));
  try {
    const store = await new JobStore(directory).initialize();
    const created = await store.create({
      topic: "Testthema",
      durationSeconds: 5,
      idempotencyKey: "same-request",
    });
    assert.equal(created.created, true);

    const duplicate = await store.create({
      topic: "anderes Thema",
      durationSeconds: 3,
      idempotencyKey: "same-request",
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, created.job.id);

    await Promise.all(Array.from({ length: 12 }, () => store.update(created.job.id, job => {
      job.progress += 1;
    })));
    assert.equal(store.get(created.job.id).progress, 12);
    assert.equal(store.writeLocks.size, 0);

    const reloaded = await new JobStore(directory).initialize();
    assert.equal(reloaded.get(created.job.id).progress, 12);
    assert.equal(reloaded.findByIdempotencyKey("same-request").id, created.job.id);
    assert.equal(reloaded.getJobDirectory("../../etc/passwd"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gleichzeitige Anlage mit gleichem Schlüssel erzeugt genau einen dauerhaften Auftrag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-job-store-"));
  try {
    const store = await new JobStore(directory).initialize();
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      store.create({ topic: `Thema ${index}`, durationSeconds: 5, idempotencyKey: "parallel" })));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.job.id)).size, 1);
    assert.equal(store.list().length, 1);
    const reloaded = await new JobStore(directory).initialize();
    assert.equal(reloaded.list().length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fehlgeschlagene Anlage bleibt unsichtbar und kann wiederholt werden", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-job-store-"));
  try {
    const store = await new JobStore(directory).initialize();
    const persist = store.persist.bind(store);
    store.persist = async () => { throw new Error("simulierter Schreibfehler"); };
    const input = { topic: "Test", durationSeconds: 5, idempotencyKey: "retry" };
    await assert.rejects(store.create(input), /simulierter Schreibfehler/);
    assert.equal(store.list().length, 0);
    assert.equal(store.findByIdempotencyKey("retry"), null);
    store.persist = persist;
    const result = await store.create(input);
    assert.equal(result.created, true);
    assert.equal((await new JobStore(directory).initialize()).list().length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
