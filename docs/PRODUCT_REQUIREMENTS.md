# Product requirements

## Core workflow
1. Create a project with topic, language, target platform and duration.
2. Plan a structured script with scene beats and source notes.
3. Review and edit the script.
4. Generate voice and licensed/owned visual assets through replaceable provider adapters.
5. Align captions and render a 9:16 video.
6. Validate dimensions, duration, audio peaks, caption bounds and missing assets.
7. Require explicit user approval before public publishing by default.

## Non-functional requirements
- Durable jobs, retries with backoff, idempotency and cancellation.
- Tenant isolation and auditable credit ledger.
- Secrets protected; OAuth tokens never returned to clients.
- Provider usage and estimated costs recorded per job.
- No simulated publishing or payment success.
