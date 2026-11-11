# Mobile app

Expo React Native client for the Faceless Shorts Engine.

## Configure and run

Set `EXPO_PUBLIC_API_URL` to the reachable API origin before starting Expo.

- Android emulator: use `http://10.0.2.2:4000` when the API runs on the host machine.
- iOS simulator: use `http://localhost:4000` when the API runs on the same machine.
- Physical device: use the API host's LAN HTTPS address; do not expose a development API directly to the public internet.

Run `pnpm --filter @faceless/mobile dev` from the repository root. The Expo web export is a development convenience, not a production deployment.

## Included screens

- Email/password login against `POST /v1/auth/login`.
- Membership-scoped project list from `GET /v1/projects`.
- Video job creation through `POST /v1/video-jobs`.
- Recent job status/progress and an organization admin summary for OWNER/ADMIN members.

The bearer session is kept in memory and cleared on logout or app restart. A future release should use the platform secure credential store and configure a production HTTPS API origin. Provider credentials and the internal `API_ACCESS_TOKEN` must never be embedded in the app.
