# Faceless-Shorts-Engine

## Android APK build

The GitHub Actions workflow **Android APK** creates a standalone Android release-variant APK and a ZIP containing that APK. The workflow verifies that the embedded `assets/index.android.bundle` is present, so the app does not depend on a running Metro server. It uses Expo Prebuild and Gradle directly; no Expo account, EAS project ID, or `EXPO_TOKEN` is required.

- Run it manually from **Actions → Android APK → Run workflow**, or push a change under `apps/mobile/`.
- Download the `Faceless-Shorts-Android-APK` artifact from the successful run.
- The artifact contains both `Faceless-Shorts.apk` and `Faceless-Shorts-Android-APK.zip`.
- The current release-variant artifact is signed with the generated debug key for direct device testing. It embeds the JavaScript bundle and does not require Metro. A Play Store release still requires a managed production signing key, release configuration, and store checks.

## Initial administrator

Create or promote an organization administrator with a one-time bootstrap command:

```bash
BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="<new-random-password>" \
pnpm admin:bootstrap
```

Use a newly generated password (at least 14 characters); do not reuse a password that has been pasted into chat, source code, shell history, or issue trackers. The script stores a salted scrypt hash, creates the default `Faceless Shorts` organization if needed, and assigns the account the organization-scoped `ADMIN` role. It never prints the password or hash.

This bootstrap only creates the database identity and membership. It does not yet provide a user-password login/session flow: the current video-job API still uses its separate server-to-server `API_ACCESS_TOKEN`. Never put that token in a mobile app.


## Production runtime (API + worker + PostgreSQL + Redis)

The production stack is defined in `docker-compose.production.yml`. It builds the API and FFmpeg worker from the same repository, runs Prisma migrations before starting the API, persists PostgreSQL/Redis/media data, and gives the API and worker the same media volume.

1. Copy `.env.production.example` to `.env` and replace every `CHANGE_...` value with unique random secrets. Never commit `.env`.
2. Put a TLS reverse proxy (for example Caddy) in front of the API. Keep `API_BIND=127.0.0.1` unless the host firewall and proxy are configured deliberately.
3. Set the GitHub repository Actions variable `EXPO_PUBLIC_API_URL` to the public HTTPS API origin (for example `https://api.example.com`). The standalone APK workflow now refuses to package an APK without a valid HTTPS API origin, avoiding a mobile app that silently points to localhost.
4. Start the stack with `docker compose -f docker-compose.production.yml up -d --build`.
5. Create the first administrator using the documented `pnpm admin:bootstrap` command from a trusted one-off environment with the production `DATABASE_URL`. Do not put credentials in the image or mobile app.
6. Verify `/health/ready`, log in from the installed app, create a video job, and confirm a non-empty MP4 download before treating the deployment as accepted.

Important: the compose file is deployment infrastructure, not proof that a live server has been provisioned. Configure a real TLS hostname, secrets, a persistent host, and eligible provider credentials first. Mock/default provider settings are not a claim of production-grade AI output; route availability depends on valid provider configuration and current free-tier limits.
