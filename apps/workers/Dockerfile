FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm exec prisma generate
RUN pnpm --filter @faceless/workers build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@faceless/workers", "start"]
