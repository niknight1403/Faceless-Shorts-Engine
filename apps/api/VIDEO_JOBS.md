# Video job API

## Endpoints

- `POST /v1/video-jobs`: creates a durable job and enqueues it in BullMQ. Requires `Authorization: Bearer <API_ACCESS_TOKEN>`.
- `GET /v1/video-jobs/:id`: returns persisted job and asset metadata plus short-lived signed download URLs. Requires the same bearer token.
- `GET /v1/assets/:assetId?expires=...&signature=...`: streams an asset using a signed URL; supports byte-range requests for video/audio playback.
- `GET /v1/providers`: reports the currently published free LLM, TTS, visual and Agentforge2 route status.
- `GET /health/live`: process liveness.
- `GET /health/ready`: checks PostgreSQL and Redis connectivity.

Configure `API_ACCESS_TOKEN` with a long random server-to-server secret and `ASSET_SIGNING_SECRET` with a separate random secret of at least 32 characters. The API fails closed (503) for job routes if the bearer token is unset and does not issue asset URLs if the signing key is unset. Never embed `API_ACCESS_TOKEN` in a mobile binary or public frontend. The bearer token is currently a shared service credential, not end-user authentication or per-user authorization; expose the API to a mobile app only through a trusted backend that authenticates users and checks project membership.

Signed asset URLs expire after 15 minutes. They are bearer links: anyone who obtains one can access that asset until expiry. Keep them private. The API does not return internal filesystem storage keys. Asset paths are resolved beneath `MEDIA_STORAGE_DIR`; traversal outside that directory is rejected. The endpoint supports HTTP byte ranges and sends `nosniff` and private/no-store headers.

## Create a job

Payload: `{ "projectId": "existing-id", "topic": "video topic", "language": "de", "targetDurationSeconds": 45, "targetPlatforms": ["youtube_shorts"], "idempotencyKey": "unique-client-key" }`.

Duration is restricted to 10–180 seconds. Reusing an idempotency key returns the existing job. A project must exist. Configure `DATABASE_URL` and `REDIS_URL` for both services and run Prisma generate/migrations before startup.

## Worker pipeline

The worker attempts script generation through the free LLM route cascade, then generates scene audio and visuals, burns scene narration into the MP4 with FFmpeg/libass, and stores the MP4, source assets and complete SRT captions in `MEDIA_STORAGE_DIR/<job-id>/`. A job is marked `COMPLETED` only after the rendered MP4 has been checked for a non-empty file and its VIDEO asset has been persisted.

Failures are recorded with stage-specific codes such as `SCRIPT_GENERATION_FAILED`, `TTS_NO_FREE_ROUTE_AVAILABLE`, `VISUAL_GENERATION_FAILED`, and `VIDEO_RENDER_FAILED`. Provider availability is best-effort: free upstreams can rate-limit or become unavailable, and a configured route is not proof that a live request will succeed.

## Storage

The API and worker must share the same persistent, absolute `MEDIA_STORAGE_DIR` path; both processes fail at startup if it is missing or relative. Mount the same volume at that exact path in both containers. For multi-host production deployments, replace shared local storage with private object storage and equivalent short-lived signed URLs.
