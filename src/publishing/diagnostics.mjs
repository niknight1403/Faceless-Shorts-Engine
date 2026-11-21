const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_RETENTION_DAYS = 30;
const CLEANUP_STATUSES = new Set(["published", "cancelled"]);
const MANUAL_ACTIONS = Object.freeze({
  needs_attention: "Manuell prüfen, bevor der Auftrag fortgesetzt oder beendet wird.",
  awaiting_creator_action: "In der Plattform-App fertigstellen und den Status anschließend abgleichen.",
});

function oauthConfigured(values) {
  return Boolean(values?.clientId && values?.clientSecret && values?.redirectUri);
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildPublishingDiagnostics({ jobs = [], oauth = {}, persistence = {}, now = Date.now() } = {}) {
  const platforms = Object.fromEntries(["youtube", "tiktok"].map(platform => [
    platform,
    { oauth: oauthConfigured(oauth[platform]) ? "configured" : "not_configured" },
  ]));
  const manualAttention = jobs
    .filter(job => Object.hasOwn(MANUAL_ACTIONS, job.status))
    .map(job => ({
      id: job.id,
      platform: job.platform,
      status: job.status,
      updatedAt: job.updatedAt || null,
      nextAction: MANUAL_ACTIONS[job.status],
    }))
    .sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));

  const cleanupSuggestions = jobs.flatMap(job => {
    if (!CLEANUP_STATUSES.has(job.status)) return [];
    const finishedAt = timestamp(job.completedAt) ?? timestamp(job.updatedAt);
    if (finishedAt === null || now - finishedAt < CLEANUP_RETENTION_DAYS * DAY_MS) return [];
    return [{
      id: job.id,
      platform: job.platform,
      status: job.status,
      finishedAt: new Date(finishedAt).toISOString(),
      ageDays: Math.floor((now - finishedAt) / DAY_MS),
      reason: "terminal_job_older_than_retention_period",
    }];
  }).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));

  const configurationIncomplete = Object.values(platforms).some(platform => platform.oauth !== "configured");
  return {
    status: manualAttention.length ? "attention_required" : configurationIncomplete ? "configuration_incomplete" : "ready",
    platforms,
    jobs: {
      total: jobs.length,
      manualAttention,
      cleanupSuggestions,
    },
    cleanupPolicy: {
      retentionDays: CLEANUP_RETENTION_DAYS,
      automaticDeletion: false,
    },
    persistence: {
      unreadableJobs: Array.isArray(persistence.unreadableJobs) ? persistence.unreadableJobs.map(({ id, code, message }) => ({ id, code, message })) : [],
      automaticDeletion: false,
    },
  };
}
