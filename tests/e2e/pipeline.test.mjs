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
  for (let attempt = 0; attempt < 60; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`Mock-Server beendete sich vorzeitig mit Code ${processHandle.exitCode}.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Der Server kann während seiner FFmpeg-Testmediengenerierung noch starten.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error("Mock-Server wurde nicht rechtzeitig bereit.");
}

async function waitForJob(baseUrl, jobId) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await fetch(`${baseUrl}/api/v1/shorts-jobs/${jobId}`);
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error("Job wurde innerhalb von 30 Sekunden nicht abgeschlossen.");
}

test("PoC: Auftrag durchläuft Mock-Medienanbieter, FFmpeg-Render und Download", async t => {
  const root = await mkdtemp(join(tmpdir(), "faceless-shorts-e2e-"));
  const mockPort = await reservePort();
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const mockProcess = spawn(process.execPath, [join(projectRoot, "scripts/mock-media-provider.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, MOCK_MEDIA_PORT: String(mockPort) },
    stdio: "ignore",
  });
  let application;

  try {
    await waitForHealth(`${mockUrl}/health`, mockProcess);
    const config = {
      ...loadConfig({ MOCK_MEDIA_URL: mockUrl, JOB_DATA_DIR: join(root, "jobs") }),
      providerBaseUrl: mockUrl,
      dataDir: join(root, "jobs"),
    };
    application = await createApiServer({ config });
    await new Promise((resolveListen, rejectListen) => {
      application.server.once("error", rejectListen);
      application.server.listen(0, "127.0.0.1", resolveListen);
    });
    const apiUrl = `http://127.0.0.1:${application.server.address().port}`;

    await t.test("health endpoint meldet beide lokalen Komponenten", async () => {
      const response = await fetch(`${apiUrl}/api/v1/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "ok");
      assert.equal(body.dependencies.mockMediaProvider, "ok");
    });

    await t.test("Eingaben werden validiert und Idempotency-Key dedupliziert", async () => {
      const invalid = await fetch(`${apiUrl}/api/v1/shorts-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "   " }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "INVALID_TOPIC");

      const options = {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "e2e-poc-job-001" },
        body: JSON.stringify({ topic: "Warum der Himmel blau ist", durationSeconds: 1 }),
      };
      const first = await fetch(`${apiUrl}/api/v1/shorts-jobs`, options);
      assert.equal(first.status, 202);
      const firstBody = await first.json();
      assert.ok(firstBody.job.id);
      assert.equal(firstBody.job.topic, "Warum der Himmel blau ist");

      const duplicate = await fetch(`${apiUrl}/api/v1/shorts-jobs`, options);
      assert.equal(duplicate.status, 200);
      const duplicateBody = await duplicate.json();
      assert.equal(duplicateBody.job.id, firstBody.job.id);
      assert.equal(duplicateBody.deduplicated, true);

      t.diagnostic(`Testauftrag: ${firstBody.job.id}`);
    });

    const created = application.store.list()[0];
    assert.ok(created, "Job wurde persistiert");
    const finished = await waitForJob(apiUrl, created.id);
    assert.equal(finished.status, "completed", JSON.stringify(finished.error));
    assert.equal(finished.progress, 100);
    assert.deepEqual(finished.steps.map(step => step.name), ["fetch_image", "fetch_audio", "render_video", "validate_video"]);
    assert.equal(finished.output.width, 1080);
    assert.equal(finished.output.height, 1920);
    assert.equal(finished.output.container, "mp4");
    assert.equal(finished.output.videoCodec, "h264");
    assert.equal(finished.output.audioCodec, "aac");

    await t.test("fertiges MP4 wird über den Download-Endpunkt geliefert", async () => {
      const response = await fetch(`${apiUrl}/api/v1/shorts-jobs/${created.id}/download`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /video\/mp4/);
      assert.ok(Number(response.headers.get("content-length")) > 1_000);
      const video = Buffer.from(await response.arrayBuffer());
      assert.ok(video.length > 1_000);
      assert.equal(video.toString("ascii", 4, 8), "ftyp");
    });

    await t.test("Auftragsliste enthält den abgeschlossenen Job", async () => {
      const response = await fetch(`${apiUrl}/api/v1/shorts-jobs`);
      assert.equal(response.status, 200);
      const { jobs } = await response.json();
      assert.ok(jobs.some(job => job.id === created.id && job.status === "completed"));
    });

    await t.test("fehlgeschlagener Auftrag kann nach einem Providerfehler erneut gestartet werden", async () => {
      const delegate = application.runner.provider;
      let failImageOnce = true;
      application.runner.provider = {
        healthCheck: delegate.healthCheck.bind(delegate),
        fetchImage: async request => {
          if (failImageOnce) {
            failImageOnce = false;
            throw Object.assign(new Error("Absichtlich simulierter Providerfehler."), {
              code: "TEST_PROVIDER_FAILURE",
              publicMessage: "Simulierter Providerfehler.",
            });
          }
          return delegate.fetchImage(request);
        },
        synthesizeSpeech: delegate.synthesizeSpeech.bind(delegate),
      };

      const createdResponse = await fetch(`${apiUrl}/api/v1/shorts-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Retry-Test", durationSeconds: 1 }),
      });
      assert.equal(createdResponse.status, 202);
      const failedId = (await createdResponse.json()).job.id;
      const failed = await waitForJob(apiUrl, failedId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error.code, "TEST_PROVIDER_FAILURE");

      const retryResponse = await fetch(`${apiUrl}/api/v1/shorts-jobs/${failedId}/retry`, { method: "POST" });
      assert.equal(retryResponse.status, 202);
      const retried = await waitForJob(apiUrl, failedId);
      assert.equal(retried.status, "completed", JSON.stringify(retried.error));
      assert.equal(retried.progress, 100);
    });
  } finally {
    if (application?.server.listening) {
      await new Promise(resolveClose => application.server.close(resolveClose));
    }
    if (mockProcess.exitCode === null) {
      mockProcess.kill("SIGTERM");
      await Promise.race([once(mockProcess, "exit"), new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))]);
    }
    await rm(root, { recursive: true, force: true });
  }
});
