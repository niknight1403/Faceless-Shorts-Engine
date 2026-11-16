# API

Node.js HTTP API for the Faceless Shorts Engine.

## Health and provider status

- `GET /health/live` reports process liveness.
- `GET /health/ready` checks PostgreSQL and Redis connectivity.
- `GET /v1/providers` reports published LLM, TTS, visual and Agentforge2 route identifiers/status. It does not prove upstream availability; provider requests can still fail or be rate-limited.

## Authentication and authorization

- `POST /v1/auth/login`, `GET /v1/auth/me`, and `POST /v1/auth/logout` manage revocable user sessions.
- Session tokens are stored server-side as hashes. The mobile client stores its bearer session in SecureStore.
- Project reads require organization membership. Project writes and video-job creation require EDITOR, ADMIN, or OWNER membership in the project's organization.
- `GET /v1/admin/overview` requires OWNER or ADMIN membership for the requested organization.
- Video-job create/read routes accept either an authorized end-user session or the optional internal `API_ACCESS_TOKEN`. The service token is privileged server-to-server access and must never be embedded in a mobile app.

## Video jobs and assets

See [VIDEO_JOBS.md](./VIDEO_JOBS.md) for job payloads, queue behavior, stage-specific failures, signed asset delivery, byte-range support, and storage requirements.

Asset downloads use short-lived HMAC-signed URLs. Configure `ASSET_SIGNING_SECRET` with a unique random secret of at least 32 characters. `MEDIA_STORAGE_DIR` must be an absolute persistent path mounted identically in the API and worker.

## Deployment

The supported self-hosted stack is the root `docker-compose.yml`, which runs PostgreSQL, Redis, API, and worker with a shared media volume. Follow the root [deployment instructions](../../README.md). Do not use the older `docker-compose.production.yml` as a complete deployment recipe: it does not define the video worker and is not the validated stack.
