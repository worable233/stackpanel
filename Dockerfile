# syntax=docker/dockerfile:1
# StackPanel monorepo image. Build once, then run either the API or the Web
# app by overriding the entrypoint (see docker-compose.yml).
#
#   docker build --target runtime -t stackpanel .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PATH}:${PNPM_HOME}"
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

# ---- deps ---------------------------------------------------------------
# pnpm runs workspace `prepare` scripts during install (db: prisma generate,
# sdk/ui: build, plugins: tsc), so the full source must be present. node_modules
# and build output are excluded via .dockerignore.
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------
FROM deps AS build
# Next.js reads API_BASE_URL at build time (CSP style-src origin). It must be
# the externally reachable API origin for the deployment (same-origin reverse
# proxy is fine too; the value only affects the generated CSP header).
ARG API_BASE_URL=http://api:3001
ENV API_BASE_URL="${API_BASE_URL}"
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runtime ------------------------------------------------------------
# Ships the full workspace incl. dev tooling on purpose: `prisma migrate
# deploy` (Prisma CLI) runs in the API entrypoint. Prune node_modules for a
# smaller image only if you keep `prisma` available some other way.
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# pg_dump / pg_restore for self-service export/import (ADR-0018 §3). The Debian
# bookworm client is PG15, which refuses to dump the PG16 server we ship with,
# so install the matching client from the PostgreSQL APT repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
COPY docker/entrypoint-api.sh /usr/local/bin/entrypoint-api
COPY docker/entrypoint-web.sh /usr/local/bin/entrypoint-web
COPY docker/entrypoint-worker.sh /usr/local/bin/entrypoint-worker
RUN chmod +x /usr/local/bin/entrypoint-api /usr/local/bin/entrypoint-web /usr/local/bin/entrypoint-worker
WORKDIR /app
EXPOSE 3000 3001
CMD ["/bin/sh", "-c", "echo \"stackpanel image ready (override entrypoint via compose)\""]
