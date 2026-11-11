# Video job API

- `POST /v1/video-jobs`: creates a durable job and enqueues it in BullMQ.
- `GET /v1/video-jobs/:id`: returns the persisted job and associated assets.
- `GET /health/live`: process liveness.
- `GET /health/ready`: checks PostgreSQL and Redis connectivity.

Create payload: `{ "projectId": "existing-id", "topic": "video topic", "language": "de", "targetDurationSeconds": 45, "targetPlatforms": ["youtube_shorts"], "idempotencyKey": "unique-client-key" }`.

Duration is restricted to 10–180 seconds. Reusing an idempotency key returns the existing job. A project must exist. Configure `DATABASE_URL` and `REDIS_URL` for both services and run Prisma generate/migrations before startup.

The worker currently persists an explicit `GENERATION_PROVIDER_NOT_CONFIGURED` failure after claiming a job. This is intentional until script, voice, visual and render providers are implemented; the API does not pretend a video was generated.
