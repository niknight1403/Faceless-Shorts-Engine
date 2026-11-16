# Faceless-Shorts-Engine

## Android APK build

The GitHub Actions workflow **Android APK** creates a standalone Android release-variant APK and a ZIP containing that APK. The workflow verifies that the embedded `assets/index.android.bundle` is present, so the app does not depend on a running Metro server. It uses Expo Prebuild and Gradle directly; no Expo account, EAS project ID, or `EXPO_TOKEN` is required.

- Run it manually from **Actions → Android APK → Run workflow**, or push a change under `apps/mobile/`.
- Download the `Faceless-Shorts-Android-APK` artifact from the successful run.
- The artifact contains both `Faceless-Shorts.apk` and `Faceless-Shorts-Android-APK.zip`.
- The current release-variant artifact is signed with the generated debug key for direct device testing. It embeds the JavaScript bundle and does not require Metro. A Play Store release still requires a managed production signing key, release configuration, and store checks.

### Mobile backend configuration

For a preconfigured build, add the repository Actions variable `EXPO_PUBLIC_API_URL` with the public HTTPS origin of the deployed API (for example `https://api.your-domain.de`, without a trailing slash). The Android workflow injects this value at build time and rejects non-HTTPS public origins.

The APK can also be built without this variable for setup/testing: on first launch, open the backend setup field on the login screen and enter the reachable API origin. The app persists this setting in Android SecureStore. Bare hostnames default to HTTPS. Plain HTTP is accepted only for localhost and private/LAN IPv4 addresses; remote endpoints must use HTTPS. Do not enter credentials, query parameters, or tokens in the URL.

This repository does not currently contain a deployed production API URL. A reachable API, PostgreSQL, Redis, worker, and shared media storage must be provisioned before end-to-end video generation can work. A successful APK build and emulator launch prove the mobile package starts; they do not prove a production backend or external media providers are live.

## Initial administrator

Create or promote an organization administrator with a one-time bootstrap command:

```bash
BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="<new-random-password>" \
pnpm admin:bootstrap
```

Use a newly generated password (at least 14 characters); do not reuse a password that has been pasted into chat, source code, shell history, or issue trackers. The script stores a salted scrypt hash, creates the default `Faceless Shorts` organization if needed, and assigns the account the organization-scoped `ADMIN` role. It never prints the password or hash.

For a remote one-time bootstrap, add these **repository Actions secrets**:
- `FACELESS_DATABASE_URL`: PostgreSQL connection string for the target database
- `FACELESS_ADMIN_EMAIL`: administrator email address
- `FACELESS_ADMIN_PASSWORD`: new random password with at least 14 characters

Then run **Actions → Admin bootstrap → Run workflow**. The workflow maps the database secret to Prisma's `DATABASE_URL`, validates that all three secrets exist, and runs the same bootstrap command. It does not print secret values. The operation is intentionally manual; it will not reset an existing password unless the trusted bootstrap script is explicitly run with its reset flag.

After bootstrap, the mobile app can sign in through `POST /v1/auth/login`; the API issues a short-lived session token and stores only its hash. The app keeps the token in Android SecureStore. Project and video-job routes accept this user session and enforce organization membership and write roles. `API_ACCESS_TOKEN` remains an optional server-to-server credential for trusted integrations; never put it in a mobile app.

## Self-hosted API and worker stack

The default `docker-compose.yml` runs PostgreSQL, Redis, the API, and the video worker as separate services. The API and worker share the persistent `media_data` volume, so completed MP4 assets can be served by the API.
Redis uses AOF persistence and `maxmemory-policy noeviction`, as required by BullMQ: queue keys must not be evicted under memory pressure. If Redis reaches its memory cap, writes fail visibly rather than silently discarding queued jobs; monitor Redis memory and size the instance accordingly.

1. Copy `.env.production.example` to `.env` and replace every placeholder with unique random secrets. Keep the file local; never commit the populated `.env`. Set provider credentials only for routes you intend to enable.
2. Run `pnpm preflight:production` before starting services. It blocks placeholder/reused secrets, invalid URLs, and configurations without a TTS route; warnings identify external-provider processing and local-template fallback. A successful preflight is a configuration check, not proof that upstream providers or a deployed service are reachable.
3. Start the stack with `docker compose up -d --build`.
4. Confirm readiness with `curl http://127.0.0.1:4000/health/ready`.
5. Create the first organization administrator with `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and `pnpm admin:bootstrap` from a trusted one-off environment that has the same database URL.
6. Put a TLS reverse proxy in front of the API and set the Android build variable `EXPO_PUBLIC_API_URL` to that public HTTPS origin.

The API binds to loopback by default; expose it publicly only behind a TLS reverse proxy and firewall. PostgreSQL and Redis are not published on host ports. The example credentials are placeholders, not production secrets. This Compose file provisions the application stack but does not provision a domain, TLS certificate, external object storage, or paid cloud services.
