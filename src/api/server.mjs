import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat, access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config.mjs";
import { JobStore } from "../jobs/job-store.mjs";
import { JobNotFoundError } from "../jobs/job-store.mjs";
import { JobRunner } from "../jobs/job-runner.mjs";
import { createTextRegistry } from "../providers/text-registry.mjs";
import { LocalSpeech } from "../providers/local-speech.mjs";
import { MockMediaProvider } from "../providers/mock-media-provider.mjs";
import { VideoRenderer } from "../render/render-short.mjs";
import { VideoValidator } from "../render/validate-video.mjs";
import { PublishingJobStore } from "../publishing/job-store.mjs";
import { TokenVault } from "../publishing/token-vault.mjs";
import { OAuthProviderClient } from "../publishing/oauth.mjs";
import { OAuthTokenManager } from "../publishing/token-manager.mjs";
import { PlatformConnectionService } from "../publishing/connection-service.mjs";
import { PublishingService } from "../publishing/service.mjs";
import { buildPublishingDiagnostics } from "../publishing/diagnostics.mjs";

const execFileAsync = promisify(execFile);

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

function requirePublishingAccess(request, config) {
  if (!config.publishingEnabled) throw new ApiError(404, "NOT_FOUND", "Endpunkt wurde nicht gefunden.");
  const header = request.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : Buffer.alloc(0);
  const expected = Buffer.from(config.publishingApiKey);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApiError(401, "PUBLISHING_AUTH_REQUIRED", "Für Publishing-Endpunkte ist ein gültiger lokaler API-Schlüssel erforderlich.");
  }
}

function publicPublishingJob(job) {
  const remote = job.remote ? structuredClone(job.remote) : null;
  if (remote) {
    delete remote.sessionUri;
    delete remote.encryptedSession;
    delete remote.uploadUrl;
    delete remote.upload_url;
  }
  return {
    id: job.id,
    sourceJobId: job.sourceJobId,
    platform: job.platform,
    accountId: job.accountId,
    mode: job.mode,
    metadata: job.metadata,
    preflight: job.preflight || null,
    status: job.status,
    attempts: job.attempts,
    approvedAt: job.approvedAt,
    statusMessage: job.statusMessage || null,
    auditTrail: job.auditTrail || [],
    remote,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

const PUBLISH_METADATA_FIELDS = new Set([
  "title", "description", "tags", "categoryId", "privacyStatus", "publishAt", "containsSyntheticMedia", "notifySubscribers",
  "caption", "privacyLevel", "disableComment", "disableDuet", "disableStitch", "brandContentToggle", "brandOrganicToggle", "isAigc", "videoCoverTimestampMs",
]);

const METADATA_LIMITS = Object.freeze({ title: 100, description: 5000, caption: 2200, tags: 30 });

const PUBLISHING_STUDIO_ASSETS = new Map([
  ["/publishing-studio", { file: "publishing-studio.html", contentType: "text/html; charset=utf-8" }],
  ["/publishing-studio.css", { file: "publishing-studio.css", contentType: "text/css; charset=utf-8" }],
  ["/publishing-studio.mjs", { file: "publishing-studio.mjs", contentType: "text/javascript; charset=utf-8" }],
  ["/publishing-studio-flow.mjs", { file: "publishing-studio-flow.mjs", contentType: "text/javascript; charset=utf-8" }],
]);

function validatePublishMetadata(value, mode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_METADATA", "metadata muss ein JSON-Objekt sein.");
  const metadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (!PUBLISH_METADATA_FIELDS.has(key)) throw new ApiError(400, "UNKNOWN_METADATA_FIELD", `Unbekanntes Metadatenfeld: ${key}.`);
    if (["title", "description", "caption", "categoryId", "privacyStatus", "privacyLevel"].includes(key)) {
      if (typeof item !== "string" || item.length > (METADATA_LIMITS[key] || 200)) throw new ApiError(400, "INVALID_METADATA_VALUE", `Metadatenfeld ${key} ist ungültig oder zu lang.`);
    }
    if (key === "tags" && (!Array.isArray(item) || item.length > METADATA_LIMITS.tags || item.some(tag => typeof tag !== "string" || tag.length > 100))) throw new ApiError(400, "INVALID_METADATA_VALUE", "tags muss eine kurze Liste gültiger Zeichenketten sein.");
    if (["containsSyntheticMedia", "notifySubscribers", "disableComment", "disableDuet", "disableStitch", "brandContentToggle", "brandOrganicToggle", "isAigc"].includes(key) && typeof item !== "boolean") throw new ApiError(400, "INVALID_METADATA_VALUE", `Metadatenfeld ${key} muss boolean sein.`);
    if (key === "publishAt" && (typeof item !== "string" || !Number.isFinite(Date.parse(item)))) throw new ApiError(400, "INVALID_METADATA_VALUE", "publishAt muss ein gültiger Zeitstempel sein.");
    if (key === "videoCoverTimestampMs" && (!Number.isInteger(item) || item < 0 || item > 180000)) throw new ApiError(400, "INVALID_METADATA_VALUE", "videoCoverTimestampMs ist ungültig.");
    metadata[key] = typeof item === "string" ? item.normalize("NFC") : structuredClone(item);
  }
  if (mode) metadata.mode = mode;
  return metadata;
}

function requireObject(value, label = "Anfrage") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_REQUEST", `${label} muss ein JSON-Objekt sein.`);
  return value;
}

async function dependencyStatus(path, args = ["-version"]) {
  try {
    await execFileAsync(path, args, { timeout: 3_000, windowsHide: true });
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function storageStatus(directory) {
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return "ok";
  } catch {
    return "unavailable";
  }
}

export async function createApiServer({
  config = loadConfig(),
  provider = new MockMediaProvider({ baseUrl: config.providerBaseUrl, timeoutMs: config.providerTimeoutMs }),
  renderer = new VideoRenderer({ ffmpegBin: config.ffmpegBin, timeoutMs: config.renderTimeoutMs }),
  validator = new VideoValidator({ ffprobeBin: config.ffprobeBin }),
  fetchImpl = fetch,
  textRegistry = process.env.SHORTS_AI_ENABLED === "true" ? createTextRegistry(process.env, {fetchImpl}) : null,
  speechProvider = process.env.SHORTS_LOCAL_SPEECH === "true" ? new LocalSpeech({voice:process.env.SHORTS_SPEECH_VOICE || "de"}) : null,
} = {}) {
  if (textRegistry && textRegistry.configuredRoutes === 0) throw new Error("AI enabled but no text routes configured");
  if ((textRegistry || speechProvider) && !["127.0.0.1","localhost","::1"].includes(config.host)) throw new Error("AI production requires local binding");
  const store = await new JobStore(config.dataDir).initialize();
  const runner = new JobRunner({ store, provider, renderer, validator, config, textRegistry, speechProvider });
  await runner.recover();

  let publishing = null;
  if (config.publishingEnabled) {
    const vault = await new TokenVault({
      filePath: join(config.publishingDataDir, "tokens.json"),
      key: config.publishingTokenKey,
    }).initialize();
    const clientFactory = platform => {
      const values = config.oauth?.[platform];
      if (!values?.clientId || !values?.clientSecret || !values?.redirectUri) {
        const error = new Error(`${platform} OAuth-Zugangsdaten sind nicht konfiguriert.`);
        error.code = "OAUTH_NOT_CONFIGURED";
        error.statusCode = 503;
        throw error;
      }
      return new OAuthProviderClient({ platform, ...values, fetchImpl });
    };
    const tokenManager = new OAuthTokenManager({ vault, clientFactory });
    const connectionService = new PlatformConnectionService({ config, vault, tokenManager, clientFactory, fetchImpl });
    const publishingJobStore = await new PublishingJobStore(join(config.publishingDataDir, "jobs")).initialize();
    const service = new PublishingService({ shortJobStore: store, publishingJobStore, tokenManager, vault, fetchImpl });
    await service.recover();
    publishing = { vault, tokenManager, connectionService, publishingJobStore, service };
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const pathname = url.pathname;

      const studioAsset = PUBLISHING_STUDIO_ASSETS.get(pathname);
      if (studioAsset && request.method === "GET") {
        if (!publishing) throw new ApiError(404, "NOT_FOUND", "Endpunkt wurde nicht gefunden.");
        const content = await readFile(new URL(`../ui/${studioAsset.file}`, import.meta.url));
        response.writeHead(200, {
          "content-type": studioAsset.contentType,
          "content-length": content.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        response.end(content);
        return;
      }

      const oauthCallback = pathname.match(/^\/api\/v1\/connections\/(youtube|tiktok)\/oauth\/callback$/);
      if (oauthCallback && request.method === "GET") {
        if (!publishing) throw new ApiError(404, "NOT_FOUND", "Endpunkt wurde nicht gefunden.");
        const [, platform] = oauthCallback;
        const connection = await publishing.connectionService.finish(platform, {
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          providerError: url.searchParams.get("error"),
        });
        sendJson(response, 200, { connected: true, connection });
        return;
      }

      if (pathname.startsWith("/api/v1/connections") || pathname.startsWith("/api/v1/publishing-jobs") || pathname === "/api/v1/publishing/diagnostics" || /^\/api\/v1\/shorts-jobs\/[0-9a-f-]{36}\/publish$/i.test(pathname)) {
        requirePublishingAccess(request, config);
      }

      if (pathname === "/api/v1/connections" && request.method === "GET") {
        sendJson(response, 200, { connections: publishing.vault.list() });
        return;
      }

      if (pathname === "/api/v1/connections" && request.method === "DELETE") {
        const connectionId = url.searchParams.get("connectionId");
        if (!connectionId) throw new ApiError(400, "CONNECTION_ID_REQUIRED", "connectionId fehlt.");
        const disconnected = await publishing.connectionService.disconnect(connectionId);
        sendJson(response, disconnected ? 200 : 404, { disconnected });
        return;
      }

      const oauthStart = pathname.match(/^\/api\/v1\/connections\/(youtube|tiktok)\/oauth\/start$/);
      if (oauthStart && request.method === "POST") {
        const body = requireObject(await readJson(request, config.maxRequestBytes));
        const [, platform] = oauthStart;
        const mode = body.mode || "upload";
        if ((platform === "youtube" && mode !== "upload") || (platform === "tiktok" && !["upload", "direct_post"].includes(mode))) {
          throw new ApiError(400, "PUBLISHING_MODE_INVALID", "Der Publishing-Modus ist für diese Plattform ungültig.");
        }
        const result = publishing.connectionService.start(platform, { mode });
        sendJson(response, 200, result);
        return;
      }

      const publishRequest = pathname.match(/^\/api\/v1\/shorts-jobs\/([0-9a-f-]{36})\/publish$/i);
      if (publishRequest && request.method === "POST") {
        const body = requireObject(await readJson(request, config.maxRequestBytes));
        const platform = body.platform;
        if (!["youtube", "tiktok"].includes(platform)) throw new ApiError(400, "UNSUPPORTED_PLATFORM", "Plattform muss youtube oder tiktok sein.");
        const mode = platform === "youtube" ? "upload" : (body.mode || "upload");
        if (platform === "tiktok" && !["upload", "direct_post"].includes(mode)) throw new ApiError(400, "PUBLISHING_MODE_INVALID", "TikTok-Modus muss upload oder direct_post sein.");
        if (mode === "direct_post" && !config.tiktokDirectPostApproved) throw new ApiError(403, "TIKTOK_DIRECT_POST_DISABLED", "TikTok Direct Post ist erst nach App-Prüfung und ausdrücklicher Aktivierung verfügbar.");
        if (typeof body.connectionId !== "string" || !body.connectionId) throw new ApiError(400, "CONNECTION_ID_REQUIRED", "connectionId fehlt.");
        const metadata = validatePublishMetadata(body.metadata || {}, mode);
        const rawKey = request.headers["idempotency-key"];
        const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : null;
        if (idempotencyKey && idempotencyKey.length > 128) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key darf höchstens 128 Zeichen lang sein.");
        const result = await publishing.service.create({ sourceJobId: publishRequest[1], platform, connectionId: body.connectionId, metadata, idempotencyKey });
        sendJson(response, result.created ? 202 : 200, { job: publicPublishingJob(result.job), deduplicated: !result.created });
        return;
      }

      if (pathname === "/api/v1/publishing-jobs" && request.method === "GET") {
        sendJson(response, 200, { jobs: publishing.publishingJobStore.list().map(publicPublishingJob) });
        return;
      }

      if (pathname === "/api/v1/publishing/diagnostics" && request.method === "GET") {
        sendJson(response, 200, buildPublishingDiagnostics({
          jobs: publishing.publishingJobStore.list(),
          oauth: config.oauth,
          persistence: publishing.publishingJobStore.diagnostics(),
        }));
        return;
      }

      const publishingJobRoute = pathname.match(/^\/api\/v1\/publishing-jobs\/([0-9a-f-]{36})(?:\/(confirm|refresh))?$/i);
      if (publishingJobRoute) {
        const [, jobId, action] = publishingJobRoute;
        const job = publishing.publishingJobStore.get(jobId);
        if (!job) throw new ApiError(404, "PUBLISHING_JOB_NOT_FOUND", "Publishing-Auftrag wurde nicht gefunden.");
        if (!action && request.method === "GET") {
          sendJson(response, 200, { job: publicPublishingJob(job) });
          return;
        }
        if (action === "confirm" && request.method === "POST") {
          const body = requireObject(await readJson(request, config.maxRequestBytes));
          if (body.confirmed !== true) throw new ApiError(400, "EXPLICIT_CONFIRMATION_REQUIRED", "Die Anfrage muss confirmed: true enthalten.");
          const metadata = body.metadata === undefined ? null : validatePublishMetadata(body.metadata, job.mode);
          const confirmed = await publishing.service.confirm(jobId, metadata);
          sendJson(response, 202, { job: publicPublishingJob(confirmed) });
          return;
        }
        if (action === "refresh" && request.method === "POST") {
          const refreshed = await publishing.service.refreshStatus(jobId);
          sendJson(response, 200, { job: publicPublishingJob(refreshed) });
          return;
        }
      }

      if (pathname === "/api/v1/health" && request.method === "GET") {
        let providerStatus = "ok";
        try {
          const providerHealth = await provider.healthCheck();
          if (providerHealth?.status !== "ok") providerStatus = "unavailable";
        } catch {
          providerStatus = "unavailable";
        }
        const oauthConfigured = platform => {
          const values = config.oauth?.[platform];
          return Boolean(values?.clientId && values?.clientSecret && values?.redirectUri);
        };
        const platformReadiness = {
          youtube: oauthConfigured("youtube"),
          tiktok: oauthConfigured("tiktok"),
        };
        const [jobStorageStatus, ffmpegStatus, ffprobeStatus] = await Promise.all([
          storageStatus(config.dataDir),
          dependencyStatus(config.ffmpegBin),
          dependencyStatus(config.ffprobeBin),
        ]);
        const configuredCount = Object.values(platformReadiness).filter(Boolean).length;
        const publishingStatus = !publishing
          ? "disabled"
          : configuredCount === 2 ? "ready" : configuredCount === 1 ? "partially_configured" : "oauth_not_configured";
        const healthy = [providerStatus, jobStorageStatus, ffmpegStatus, ffprobeStatus].every(status => status === "ok");
        sendJson(response, healthy ? 200 : 503, {
          status: healthy ? "ok" : "degraded",
          readiness: healthy ? "ready" : "not_ready",
          service: "faceless-shorts-engine",
          profile: {
            name: config.profile,
            runtimeMode: config.runtimeMode,
            providerAdapter: config.providerAdapter,
            storageAdapter: config.storageAdapter,
            livePublishingAllowed: config.livePublishingAllowed,
          },
          dependencies: {
            mockMediaProvider: providerStatus,
            jobStorage: jobStorageStatus,
            ffmpeg: ffmpegStatus,
            ffprobe: ffprobeStatus,
          },
          publishing: {
            enabled: Boolean(publishing),
            status: publishingStatus,
            platforms: publishing ? platformReadiness : undefined,
          },
        });
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
      } else if (error.code === "OAUTH_STATE_INVALID") {
        sendJson(response, 400, { error: { code: error.code, message: "OAuth-State fehlt, ist abgelaufen oder ungültig." } });
      } else if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
        sendJson(response, error.statusCode, { error: { code: error.code || "PUBLISHING_ERROR", message: error.message || "Publishing-Anfrage konnte nicht verarbeitet werden." } });
      } else {
        console.error(`[api] ${error.name || "Error"}: ${error.message || "unknown error"}`);
        sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Interner Serverfehler." } });
      }
    }
  });

  server.requestTimeout = 30_000;
  return { server, store, runner };
}
