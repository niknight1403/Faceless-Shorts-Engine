import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { JobStore } from "../jobs/job-store.mjs";
import { JobNotFoundError } from "../jobs/job-store.mjs";
import { JobRunner } from "../jobs/job-runner.mjs";
import { MockMediaProvider } from "../providers/mock-media-provider.mjs";
import { VideoRenderer } from "../render/render-short.mjs";
import { VideoValidator } from "../render/validate-video.mjs";

class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendJson(response, statusCode, body) {
  if (response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readJson(request, maxBytes) {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Bitte JSON mit Content-Type application/json senden.");

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new ApiError(413, "REQUEST_TOO_LARGE", `Anfrage darf höchstens ${maxBytes} Bytes groß sein.`);
    chunks.push(chunk);
  }
  if (total === 0) throw new ApiError(400, "EMPTY_BODY", "Der JSON-Anfragetext fehlt.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Der Anfragetext ist kein gültiges JSON.");
  }
}

function publicJob(job) {
  return {
    id: job.id,
    topic: job.topic,
    durationSeconds: job.durationSeconds,
    status: job.status,
    progress: job.progress,
    currentStep: job.currentStep,
    steps: job.steps,
    output: job.output ? { ...job.output, downloadUrl: `/api/v1/shorts-jobs/${job.id}/download` } : null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function validateJobInput(body, config) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_REQUEST", "Der JSON-Inhalt muss ein Objekt sein.");
  }
  if (typeof body.topic !== "string") {
    throw new ApiError(400, "INVALID_TOPIC", "topic muss eine Zeichenkette sein.");
  }
  const topic = body.topic.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!topic || topic.length > 240) {
    throw new ApiError(400, "INVALID_TOPIC", "topic muss zwischen 1 und 240 Zeichen lang sein.");
  }
  const durationSeconds = body.durationSeconds === undefined ? config.defaultDurationSeconds : body.durationSeconds;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > config.maxDurationSeconds) {
    throw new ApiError(400, "INVALID_DURATION", `durationSeconds muss eine ganze Zahl zwischen 1 und ${config.maxDurationSeconds} sein.`);
  }
  return { topic, durationSeconds };
}

export async function createApiServer({
  config = loadConfig(),
  provider = new MockMediaProvider({ baseUrl: config.providerBaseUrl, timeoutMs: config.providerTimeoutMs }),
  renderer = new VideoRenderer({ ffmpegBin: config.ffmpegBin, timeoutMs: config.renderTimeoutMs }),
  validator = new VideoValidator({ ffprobeBin: config.ffprobeBin }),
} = {}) {
  const store = await new JobStore(config.dataDir).initialize();
  const runner = new JobRunner({ store, provider, renderer, validator, config });
  await runner.recover();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/api/v1/health" && request.method === "GET") {
        try {
          const providerHealth = await provider.healthCheck();
          sendJson(response, 200, {
            status: "ok",
            service: "faceless-shorts-engine",
            dependencies: { mockMediaProvider: providerHealth.status },
          });
        } catch {
          sendJson(response, 503, {
            status: "degraded",
            service: "faceless-shorts-engine",
            dependencies: { mockMediaProvider: "unavailable" },
          });
        }
        return;
      }

      if (pathname === "/api/v1/shorts-jobs" && request.method === "GET") {
        sendJson(response, 200, { jobs: store.list().map(publicJob) });
        return;
      }

      if (pathname === "/api/v1/shorts-jobs" && request.method === "POST") {
        const body = await readJson(request, config.maxRequestBytes);
        const input = validateJobInput(body, config);
        const rawKey = request.headers["idempotency-key"];
        const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : null;
        if (idempotencyKey && idempotencyKey.length > 128) {
          throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key darf höchstens 128 Zeichen lang sein.");
        }
        if (idempotencyKey) {
          const existing = store.findByIdempotencyKey(idempotencyKey);
          if (existing) {
            sendJson(response, 200, { job: publicJob(existing), deduplicated: true });
            return;
          }
        }
        const { job, created } = await store.create({ ...input, idempotencyKey });
        if (created) runner.enqueue(job.id);
        sendJson(response, 202, { job: publicJob(job), deduplicated: false });
        return;
      }

      const match = pathname.match(/^\/api\/v1\/shorts-jobs\/([0-9a-f-]{36})(?:\/(download|retry))?$/i);
      if (match) {
        const [, jobId, action] = match;
        const job = store.get(jobId);
        if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Auftrag wurde nicht gefunden.");

        if (!action && request.method === "GET") {
          sendJson(response, 200, { job: publicJob(job) });
          return;
        }

        if (action === "retry" && request.method === "POST") {
          try {
            const retried = await runner.retry(jobId);
            if (!retried) throw new ApiError(404, "JOB_NOT_FOUND", "Auftrag wurde nicht gefunden.");
            sendJson(response, 202, { job: publicJob(retried) });
          } catch (error) {
            if (error.code === "JOB_NOT_RETRYABLE") throw new ApiError(409, error.code, error.message);
            throw error;
          }
          return;
        }

        if (action === "download" && request.method === "GET") {
          if (job.status !== "completed" || !job.output) {
            throw new ApiError(409, "JOB_NOT_COMPLETED", "Der Auftrag ist noch nicht erfolgreich abgeschlossen.");
          }
          const outputPath = join(store.getJobDirectory(jobId), "final.mp4");
          let outputInfo;
          try {
            outputInfo = await stat(outputPath);
          } catch {
            throw new ApiError(404, "OUTPUT_MISSING", "Die fertige Videodatei ist nicht mehr verfügbar.");
          }
          response.writeHead(200, {
            "content-type": "video/mp4",
            "content-length": outputInfo.size,
            "content-disposition": `attachment; filename="faceless-short-${jobId}.mp4"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          });
          const downloadStream = createReadStream(outputPath);
          downloadStream.on("error", error => {
            console.error(`[download:${jobId}] ${error.message}`);
            response.destroy(error);
          });
          downloadStream.pipe(response);
          return;
        }
      }

      throw new ApiError(404, "NOT_FOUND", "Endpunkt wurde nicht gefunden.");
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      } else if (error instanceof JobNotFoundError) {
        sendJson(response, 404, { error: { code: "JOB_NOT_FOUND", message: "Auftrag wurde nicht gefunden." } });
      } else {
        console.error(`[api] ${error.name || "Error"}: ${error.message || "unknown error"}`);
        sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Interner Serverfehler." } });
      }
    }
  });

  server.requestTimeout = 30_000;
  return { server, store, runner };
}
