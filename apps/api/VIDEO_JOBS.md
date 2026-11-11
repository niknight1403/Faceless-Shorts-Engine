# Video job API

## Endpoints

- `POST /v1/video-jobs`: creates a durable job and enqueues it in BullMQ. Accepts an end-user session token or the internal `API_ACCESS_TOKEN`; user sessions require EDITOR, ADMIN, or OWNER membership in the project's organization.
- `GET /v1/video-jobs/:id`: returns persisted job and asset metadata plus short-lived signed download URLs. Accepts an end-user session token (organization membership required) or the internal `API_ACCESS_TOKEN`.
- `GET /v1/assets/:assetId?expires=...&signature=...`: streams an asset using a signed URL; supports byte-range requests for video/audio playback.
- `GET /v1/providers`: reports the currently published free LLM, TTS, visual and Agentforge2 route status.
- `GET /health/live`: process liveness.
- `GET /health/ready`: checks PostgreSQL and Redis connectivity.

Configure `API_ACCESS_TOKEN` with a long random server-to-server secret and `ASSET_SIGNING_SECRET` with a separate random secret of at least 32 characters. The API fails closed (503) for job routes if the bearer token is unset and does not issue asset URLs if the signing key is unset. Never embed `API_ACCESS_TOKEN` in a mobile binary or public frontend. The bearer token is a shared server-to-server credential, not end-user authentication; never embed it in a mobile binary. End-user login, revocable sessions, organization membership checks, and the organization-scoped ADMIN overview are documented in [AUTHENTICATION.md](./AUTHENTICATION.md). End-user sessions can create jobs only in organizations where the user is EDITOR, ADMIN, or OWNER, and can read jobs only in organizations where they have membership. Service-token requests remain privileged internal requests.

Signed asset URLs expire after 15 minutes. They are bearer links: anyone who obtains one can access that asset until expiry. Keep them private. The API does not return internal filesystem storage keys. Asset paths are resolved beneath `MEDIA_STORAGE_DIR`; traversal outside that directory is rejected. The endpoint supports HTTP byte ranges and sends `nosniff` and private/no-store headers.

## Create a job

Payload: `{ "projectId": "existing-id", "topic": "video topic", "language": "de", "targetDurationSeconds": 45, "targetPlatforms": ["youtube_shorts"], "idempotencyKey": "unique-client-key" }`.

Duration is restricted to 10–180 seconds; topic text is limited to 500 characters; language must be a BCP-47-like tag such as `de` or `en-US`; and platforms are limited to unique values from `youtube_shorts`, `tiktok`, and `instagram` (maximum three). An optional idempotency key must contain 8–128 safe ASCII characters. Reusing an idempotency key returns the existing job for the same project and returns `409` if it belongs to another project. A project must exist. Configure `DATABASE_URL` and `REDIS_URL` for both services and run Prisma generate/migrations before startup.

## Worker pipeline

The worker attempts script generation through the free LLM route cascade, then generates scene audio and visuals, burns scene narration into the MP4 with FFmpeg/libass, and stores the MP4, source assets and complete SRT captions in `MEDIA_STORAGE_DIR/<job-id>/`. A job is marked `COMPLETED` only after the rendered MP4 has been checked for a non-empty file and its VIDEO asset has been persisted.

Failures are recorded with stage-specific codes such as `SCRIPT_GENERATION_FAILED`, `TTS_NO_FREE_ROUTE_AVAILABLE`, `VISUAL_GENERATION_FAILED`, and `VIDEO_RENDER_FAILED`. Provider availability is best-effort: free upstreams can rate-limit or become unavailable, and a configured route is not proof that a live request will succeed.

## Storage

The API and worker must share the same persistent, absolute `MEDIA_STORAGE_DIR` path; both processes fail at startup if it is missing or relative. Mount the same volume at that exact path in both containers. For multi-host production deployments, replace shared local storage with private object storage and equivalent short-lived signed URLs.
