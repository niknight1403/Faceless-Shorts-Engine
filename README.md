# Faceless-Shorts-Engine

## Android APK build

The GitHub Actions workflow **Android APK** creates a standalone Android release-variant APK and a ZIP containing that APK. The workflow verifies that the embedded `assets/index.android.bundle` is present, so the app does not depend on a running Metro server. It uses Expo Prebuild and Gradle directly; no Expo account, EAS project ID, or `EXPO_TOKEN` is required.

- Run it manually from **Actions → Android APK → Run workflow**, or push a change under `apps/mobile/`.
- Download the `Faceless-Shorts-Android-APK` artifact from the successful run.
- The artifact contains both `Faceless-Shorts.apk` and `Faceless-Shorts-Android-APK.zip`.
- The current release-variant artifact is signed with the generated debug key for direct device testing. It embeds the JavaScript bundle and does not require Metro. A Play Store release still requires a managed production signing key, release configuration, and store checks.

### Mobile backend configuration

Before building a usable phone app, add the repository Actions variable `EXPO_PUBLIC_API_URL` with the public HTTPS origin of the deployed API (for example `https://api.example.com`, without a trailing slash). The Android workflow injects this value at build time. If it is missing, the app now displays a clear configuration error and does not silently call `localhost` on the phone. This repository does not currently contain a deployed production API URL; a reachable API, PostgreSQL, Redis, worker, and shared media storage must be provisioned before end-to-end video generation can work.

## Initial administrator

Create or promote an organization administrator with a one-time bootstrap command:

```bash
BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="<new-random-password>" \
pnpm admin:bootstrap
```

Use a newly generated password (at least 14 characters); do not reuse a password that has been pasted into chat, source code, shell history, or issue trackers. The script stores a salted scrypt hash, creates the default `Faceless Shorts` organization if needed, and assigns the account the organization-scoped `ADMIN` role. It never prints the password or hash.

After bootstrap, the mobile app can sign in through `POST /v1/auth/login`; the API issues a short-lived session token and stores only its hash. The app keeps the token in Android SecureStore. Project and video-job routes accept this user session and enforce organization membership and write roles. `API_ACCESS_TOKEN` remains an optional server-to-server credential for trusted integrations; never put it in a mobile app.

## Self-hosted API and worker stack

The default `docker-compose.yml` runs PostgreSQL, Redis, the API, and the video worker as separate services. The API and worker share the persistent `media_data` volume, so completed MP4 assets can be served by the API.

1. Copy `.env.production.example` to `.env` and replace every placeholder with unique random secrets. Keep the file local; never commit the populated `.env`. Set provider credentials only for routes you intend to enable.
2. Start the stack with `docker compose up -d --build`.
3. Confirm readiness with `curl http://127.0.0.1:4000/health/ready`.
4. Create the first organization administrator with `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and `pnpm admin:bootstrap` from a trusted one-off environment that has the same database URL.
5. Put a TLS reverse proxy in front of the API and set the Android build variable `EXPO_PUBLIC_API_URL` to that public HTTPS origin.

The API binds to loopback by default; expose it publicly only behind a TLS reverse proxy and firewall. PostgreSQL and Redis are not published on host ports. The example credentials are placeholders, not production secrets. This Compose file provisions the application stack but does not provision a domain, TLS certificate, external object storage, or paid cloud services.
