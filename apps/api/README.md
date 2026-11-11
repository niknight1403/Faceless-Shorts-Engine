# API

Node.js HTTP API.

- `GET /health/live` and `GET /health/ready` provide liveness/readiness checks.
- `GET /v1/providers` exposes provider route status.
- Video-job create/read routes require the server-to-server `API_ACCESS_TOKEN`.
- Asset downloads use short-lived HMAC-signed URLs and require `ASSET_SIGNING_SECRET`.
- `MEDIA_STORAGE_DIR` must be an absolute persistent path mounted identically in the API and worker.

See [VIDEO_JOBS.md](./VIDEO_JOBS.md) for request payloads, signed asset delivery, configuration and security boundaries.

The current bearer token is a shared service credential, not end-user identity. Do not embed it in mobile clients; place a user-authenticated backend/API gateway in front of this service before public app launch.
