# Authentication and administrator access

## End-user authentication

- `POST /v1/auth/login` accepts `{ "email": "...", "password": "..." }` and returns a random 256-bit bearer session token.
- `GET /v1/auth/me` returns the authenticated user and organization memberships.
- `POST /v1/auth/logout` revokes the current session.
- Sessions expire after 12 hours. Only a SHA-256 hash of each opaque token is stored in PostgreSQL. Passwords use the scrypt format created by `pnpm admin:bootstrap`; password verification uses constant-time comparison.
- Login failures return a generic error. A shared Redis-backed throttle allows at most 10 failed attempts per 15-minute window for each source-IP/email pair and clears the counter after a successful login. Keep Redis private to the application network; also enforce request-size limits and edge rate limits at the trusted reverse proxy.

## Administrator access

- End-user sessions can create video jobs only with EDITOR, ADMIN, or OWNER membership in the target project's organization; reading a job requires organization membership. Internal `API_ACCESS_TOKEN` requests remain privileged service-to-service operations.
- `GET /v1/projects` returns only projects belonging to the authenticated user's organizations, with the latest 12 jobs and safe asset metadata. Video assets include short-lived signed `downloadUrl` values when `ASSET_SIGNING_SECRET` is configured; internal storage keys are never returned.
- `POST /v1/projects` accepts `{ "organizationId": "...", "name": "...", "description": "..." }`; it requires a valid session and OWNER, ADMIN, or EDITOR membership in that organization. Names are limited to 2–80 characters and descriptions to 500 characters.
- `GET /v1/admin/overview` requires a valid session and an `x-organization-id` header for an organization where the caller is OWNER or ADMIN.
- Role membership is reloaded from PostgreSQL for every admin request. A role in a client token is never trusted.
- The admin overview returns counts only; it does not expose secrets, password hashes, or session tokens.

## Bootstrap

Set `BOOTSTRAP_ADMIN_EMAIL` and a NEW password in the deployment's secret manager, configure `DATABASE_URL`, then run `pnpm admin:bootstrap` once. Do not pass secrets as command-line arguments or commit them. The earlier password shared in chat must not be reused; rotate it and use a new unique password. The bootstrap operation creates the identity and grants ADMIN in the selected organization. It refuses to overwrite an existing password by default; set `BOOTSTRAP_ADMIN_FORCE_RESET=true` only for an intentional password rotation.

Apply the migration with `pnpm exec prisma migrate deploy` before starting the API. The bootstrap script provisions the identity and membership; it does not create a hosted environment, set GitHub Actions secrets, or deploy the API. API access is only active after applying Prisma migrations and deploying the API with database connectivity.
