export const PUBLISHING_STATUSES = Object.freeze([
  "queued",
  "preflight",
  "awaiting_confirmation",
  "uploading",
  "platform_processing",
  "awaiting_creator_action",
  "published",
  "failed",
  "cancelled",
  "needs_attention",
]);

const transitions = Object.freeze({
  queued: new Set(["preflight", "cancelled", "failed"]),
  preflight: new Set(["awaiting_confirmation", "cancelled", "failed"]),
  awaiting_confirmation: new Set(["uploading", "cancelled", "failed"]),
  uploading: new Set(["platform_processing", "awaiting_creator_action", "published", "failed", "needs_attention"]),
  platform_processing: new Set(["awaiting_creator_action", "published", "failed", "needs_attention"]),
  awaiting_creator_action: new Set(["published", "failed", "needs_attention"]),
  published: new Set(),
  failed: new Set(["queued", "needs_attention"]),
  cancelled: new Set(),
  needs_attention: new Set(["platform_processing", "awaiting_creator_action", "published", "failed", "cancelled"]),
});

export function canTransitionPublishingStatus(from, to) {
  return transitions[from]?.has(to) ?? false;
}

export function assertPublishingTransition(from, to) {
  if (!canTransitionPublishingStatus(from, to)) {
    const error = new Error(`Ungültiger Publishing-Statuswechsel: ${from} → ${to}.`);
    error.code = "INVALID_PUBLISHING_TRANSITION";
    throw error;
  }
}

export function isTerminalPublishingStatus(status) {
  return ["published", "cancelled"].includes(status);
}
