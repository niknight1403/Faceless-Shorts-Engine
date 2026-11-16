# Mobile app

Expo React Native client for the Faceless Shorts Engine.

## Configure and run

Set `EXPO_PUBLIC_API_URL` to the reachable API origin before starting Expo.

- Android emulator: use `http://10.0.2.2:4000` when the API runs on the host machine.
- iOS simulator: use `http://localhost:4000` when the API runs on the same machine.
- Physical device and production builds: use a reachable HTTPS API origin. Do not expose a development API directly to the public internet.

Run `pnpm --filter @faceless/mobile dev` from the repository root. The Expo web export is a development convenience, not a production deployment.

## Included app capabilities

- Email/password login against `POST /v1/auth/login`.
- Session restoration and revocation through `GET /v1/auth/me` and `POST /v1/auth/logout`.
- Membership-scoped project list and organization-scoped project creation.
- Video job creation, automatic progress refresh, recent job status, and signed MP4 download links.
- Organization admin summary for OWNER/ADMIN members.

The bearer session is stored with `expo-secure-store` (Android Keystore-backed secure storage / iOS Keychain). Provider credentials and the internal `API_ACCESS_TOKEN` must never be embedded in the app.

## Android APK artifact

The repository workflow `.github/workflows/android-apk.yml` builds a native release APK with Gradle, verifies the embedded JavaScript bundle, packages the APK into `Faceless-Shorts-Android-APK.zip`, and uploads both files as a GitHub Actions artifact for 30 days.

To build, open **Actions → Android APK → Run workflow**, or push a change under `apps/mobile/**`. The artifact appears on the completed workflow run under **Artifacts**. This internal build is signed with the workflow's default debug signing configuration; configure a protected release keystore before distributing a store-ready build.

Set the repository Actions variable `EXPO_PUBLIC_API_URL` to the public HTTPS API origin before building a connected app. If it is missing, the workflow deliberately still creates an installable diagnostic APK, but the app will display a backend-configuration error and cannot sign in or create videos. The artifact is therefore not proof of a live backend deployment.

The built APK is installable and keeps working without a rebuild: the login screen shows the active backend and lets you enter or change the API origin (for example `https://api.example.com`, or `http://192.168.0.10:4000` for a backend on your own network). The address is stored with `expo-secure-store`, so the next start reuses it. `EXPO_PUBLIC_API_URL` only sets the default baked into the APK.

The API and worker are provisioned separately by the root `docker-compose.yml`. Follow the root README deployment steps, configure unique secrets in the server-side `.env`, place a TLS reverse proxy in front of the API, and verify `/health/ready` before setting the mobile API URL.
