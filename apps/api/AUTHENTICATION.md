# Authentication and administrator access

## End-user authentication

- `POST /v1/auth/login` accepts `{ "email": "...", "password": "..." }` and returns a random 256-bit bearer session token.
- `GET /v1/auth/me` returns the authenticated user and organization memberships.
- `POST /v1/auth/logout` revokes the current session.
- Sessions expire after 12 hours. Only a SHA-256 hash of each opaque token is stored in PostgreSQL. Passwords use the scrypt format created by `pnpm admin:bootstrap`; password verification uses constant-time comparison.
- Login failures return a generic error. A process-local throttle limits repeated failures; deploy behind a trusted proxy and add a shared Redis-backed rate limiter before running multiple API replicas.

## Administrator access

- `GET /v1/admin/overview` requires a valid session and an `x-organization-id` header for an organization where the caller is OWNER or ADMIN.
- Role membership is reloaded from PostgreSQL for every admin request. A role in a client token is never trusted.
- The admin overview returns counts only; it does not expose secrets, password hashes, or session tokens.

## Bootstrap

Set `BOOTSTRAP_ADMIN_EMAIL` and a NEW password in the deployment's secret manager, configure `DATABASE_URL`, then run `pnpm admin:bootstrap` once. Do not pass secrets as command-line arguments or commit them. The earlier password shared in chat must not be reused; rotate it and use a new unique password. The bootstrap operation changes the password hash and grants ADMIN in the selected organization.

The bootstrap script provisions the identity and membership; it does not create a hosted environment, set GitHub Actions secrets, or deploy the API. API access is only active after applying Prisma migrations and deploying the API with database connectivity.
