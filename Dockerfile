FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm --filter @faceless/api build
RUN pnpm --filter @faceless/workers build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=10000
ENV API_PORT=10000
ENV MEDIA_STORAGE_DIR=/var/lib/faceless/media
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY --from=build /app /app
RUN mkdir -p /var/lib/faceless/media
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","scripts/start-production.mjs"]
