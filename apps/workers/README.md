# Workers

Redis-backed workers own long-running generation and rendering tasks. Jobs must be idempotent, retryable and observable; provider failures must never be reported as successful output.
