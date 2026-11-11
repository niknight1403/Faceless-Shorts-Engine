# Self-hosted production deployment

This repository can be run as one API + video-worker container with PostgreSQL, Redis, and a persistent MP4 media volume. The Compose stack does not publish the database or Redis ports.

## 1. Prepare secrets

On a Linux host with Docker Engine and the Compose plugin, clone the repository and create a local `.env.production` file (never commit it):

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-password
DATABASE_URL=postgresql://shorts:URL_ENCODED_PASSWORD@postgres:5432/shorts_engine?schema=public
REDIS_URL=redis://redis:6379
ASSET_SIGNING_SECRET=replace-with-at-least-32-random-characters
# Optional server-to-server credential; do not ship it in the Android app
API_ACCESS_TOKEN=
BOOTSTRAP_ADMIN_EMAIL=your-admin-email@example.com
BOOTSTRAP_ADMIN_PASSWORD=use-a-new-random-password-at-least-14-characters
```

Use a URL-encoded password in `DATABASE_URL` if it contains reserved URL characters. Generate separate random values for the database password and asset signing secret. Keep this file readable only by the deployment account.

## 2. Start the stack

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.yml ps
```

The app container waits for healthy PostgreSQL and Redis, applies Prisma migrations, and starts the API and worker under one supervisor. The `media_data` named volume persists generated MP4 files across container replacements. Back up all three named volumes.

## 3. Bootstrap the first administrator

Run this once after the stack is healthy:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec app pnpm admin:bootstrap
```

The bootstrap script reads `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from the container environment. If you use the command above, add those two variables to the app service's `environment` section in the Compose file (or use a one-off `docker compose run --rm` invocation with the same image and variables). Do not reuse credentials previously pasted into chat or source control.

## 4. Verify API and configure Android

```bash
curl --fail https://YOUR_API_HOST/health/ready
```

Put the public HTTPS API origin (no trailing slash) into GitHub repository **Settings → Secrets and variables → Actions → Variables** as `EXPO_PUBLIC_API_URL`, then run **Actions → Android APK → Run workflow**. The APK embeds this URL at build time. Keep `API_ACCESS_TOKEN`, database credentials, and signing secrets server-side.

## Important production requirements

- Put the API behind HTTPS using a reverse proxy or managed TLS endpoint.
- The Compose media volume is persistent on this host, but it is not replicated; configure off-host backups.
- Restrict host firewall access to port 10000 to the reverse proxy. PostgreSQL and Redis are internal-only.
- This stack is self-hosted. It does not create a cloud account, DNS record, TLS certificate, VPS, or paid service.
- The CI Docker build verifies that images build; it does not prove a live deployment or a completed MP4 render. Verify a real login, project, job, rendered MP4, and signed download after deployment.
