# syntax=docker/dockerfile:1
# StackPanel monorepo image. Build once, then run either the API or the Web
# app by overriding the entrypoint (see docker-compose.yml).
#
#   docker build --target runtime -t stackpanel .

ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS base
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

# ---- prod-deps ----------------------------------------------------------
# Strip devDependencies from the built tree before it is shipped. The runtime
# roles only need the handful of tools that run in production — the Prisma CLI
# behind `pnpm --filter @stackpanel/db migrate:deploy`, and the frontend builder
# the worker drives (`pnpm build:frontend` plus `next build`) — so those are
# declared as regular dependencies and survive this step. Everything else
# (eslint, vitest, playwright, pm2, license-checker, …) stays out of the image.
FROM build AS prod-deps
# Remove the dev-only packages from the modules directory the build stage already
# populated. `pnpm prune --prod` is deliberately NOT used: it rebuilds that
# directory from the lockfile in a way that drops the workspace links and `.bin`
# shims the runtime needs (`prisma` and `next` both became unresolvable), while a
# production install keeps them intact and still removes the dev tree.
# Lifecycle scripts are skipped on purpose: the workspace `prepare` hooks need
# dev-only compilers (tsc/tsup) that are absent in this mode, and everything they
# emit is already in place from the build stage.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ---- runtime ------------------------------------------------------------
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
COPY --from=prod-deps /app /app
COPY docker/entrypoint-api.sh /usr/local/bin/entrypoint-api
COPY docker/entrypoint-web.sh /usr/local/bin/entrypoint-web
COPY docker/entrypoint-worker.sh /usr/local/bin/entrypoint-worker
RUN chmod +x /usr/local/bin/entrypoint-api /usr/local/bin/entrypoint-web /usr/local/bin/entrypoint-worker
WORKDIR /app
EXPOSE 3000 3001
CMD ["/bin/sh", "-c", "echo \"stackpanel image ready (override entrypoint via compose)\""]
