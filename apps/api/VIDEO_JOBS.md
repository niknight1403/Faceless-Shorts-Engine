# Video job API

- `POST /v1/video-jobs`: creates a durable job and enqueues it in BullMQ.
- `GET /v1/video-jobs/:id`: returns the persisted job and associated asset metadata.
- `GET /v1/providers`: reports the currently published free LLM, TTS, visual and Agentforge2 route status.
- `GET /health/live`: process liveness.
- `GET /health/ready`: checks PostgreSQL and Redis connectivity.

Create payload: `{ "projectId": "existing-id", "topic": "video topic", "language": "de", "targetDurationSeconds": 45, "targetPlatforms": ["youtube_shorts"], "idempotencyKey": "unique-client-key" }`.

Duration is restricted to 10–180 seconds. Reusing an idempotency key returns the existing job. A project must exist. Configure `DATABASE_URL` and `REDIS_URL` for both services and run Prisma generate/migrations before startup.

## Worker pipeline

The worker attempts script generation through the free LLM route cascade, then generates scene audio and visuals, burns scene narration into the MP4 with FFmpeg/libass, and stores the MP4, source assets and complete SRT captions in `MEDIA_STORAGE_DIR/<job-id>/`. A job is marked `COMPLETED` only after the rendered MP4 has been checked for a non-empty file and its VIDEO asset has been persisted.

Failures are recorded with stage-specific codes such as `SCRIPT_GENERATION_FAILED`, `TTS_NO_FREE_ROUTE_AVAILABLE`, `VISUAL_GENERATION_FAILED`, and `VIDEO_RENDER_FAILED`. Provider availability is best-effort: free upstreams can rate-limit or become unavailable, and a configured route is not proof that a live request will succeed.

## Delivery limitation

The job response currently exposes asset metadata and storage keys; a secured HTTP download/stream endpoint and authenticated ownership checks are not implemented yet. Clients must not treat a storage key as a public URL. Keep `MEDIA_STORAGE_DIR` on persistent storage shared with the API and worker until the authenticated delivery layer is added.
