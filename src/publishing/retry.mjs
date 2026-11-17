const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function annotate(error, values) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.assign(error, values);
  } catch {
    // Keep the original failure if a provider error object is immutable.
  }
}

export function retryDelayMs(attempt, { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError("attempt muss eine positive Ganzzahl sein.");
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new TypeError("Backoff-Grenzen müssen nichtnegative Zahlen sein.");
  }
  return Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
}

export async function withBoundedRetry(operation, {
  platform,
  action,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  wait = sleep,
  onRetry = async () => {},
} = {}) {
  if (typeof operation !== "function") throw new TypeError("operation muss eine Funktion sein.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError("maxAttempts muss zwischen 1 und 5 liegen.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const canRetry = error?.retryable === true && attempt < maxAttempts;
      annotate(error, { retryAttempts: attempt, retryExhausted: error?.retryable === true && attempt >= maxAttempts });
      if (!canRetry) throw error;

      const delayMs = retryDelayMs(attempt, { baseDelayMs, maxDelayMs });
      const event = {
        platform,
        action,
        attempt,
        delayMs,
        errorCode: typeof error.code === "string" ? error.code : "RETRYABLE_ERROR",
      };
      try {
        await onRetry(event);
      } catch {
        // Observability must not cause an otherwise safe request to be repeated or abandoned.
      }
      await wait(delayMs);
    }
  }
}
