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
- Recent job status/progress, signed MP4 download links, and an organization admin summary for OWNER/ADMIN members.
- Organization-scoped project creation for OWNER/ADMIN/EDITOR members.

The bearer session is stored with `expo-secure-store` (Android Keystore-backed secure storage / iOS Keychain) and restored on app start by validating it through `GET /v1/auth/me`. Logout revokes the server session and deletes the local credential. Configure a production HTTPS API origin before release. Provider credentials and the internal `API_ACCESS_TOKEN` must never be embedded in the app.
