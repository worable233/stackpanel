# syntax=docker/dockerfile:1
# StackPanel monorepo image. Build once, then run either the API or the Web
# app by overriding the entrypoint (see docker-compose.yml).
#
#   docker build --target runtime -t stackpanel .

ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS base
ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PATH}:${PNPM_HOME}"
# pnpm 11 defaults `verifyDepsBeforeRun` to `prompt`; in a non-interactive
# container that turns into an implicit `pnpm install` before every `pnpm run`
# and `pnpm exec`. With the devDependencies stripped (see `prod-deps`) that
# install re-resolves the full lockfile, re-runs the workspace `prepare` hooks
# and aborts on `tsc: command not found` — which would break the entrypoints'
# `pnpm --filter @stackpanel/db migrate:deploy` and the worker's
# `pnpm build:frontend`. The modules tree in this image is intentionally frozen
# at build time, so the check is disabled for every stage.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
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
# Rebuild the modules directory from the lockfile as production-only. Running
# `pnpm install --prod` over the tree the `build` stage already populated is NOT
# enough — it only reconciles what is missing, leaving every dev-only entry in
# `.pnpm` untouched (verified on a clean workspace: still 1183 packages /
# 1.3 GB). Deleting the `node_modules` directories first forces the production
# install to materialise the tree from scratch, which drops eslint, vitest,
# playwright, pm2, license-checker and friends (→ 521 packages).
# `pnpm prune --prod` is deliberately NOT used: it rebuilds the modules
# directory in a way that drops the workspace links and `.bin` shims the runtime
# needs (`prisma` and `next` both became unresolvable). A wipe + production
# install keeps them (verified: `prisma --version` → 7.9.1, `next` shim present).
# Lifecycle scripts are skipped on purpose: the workspace `prepare` hooks need
# dev-only compilers (tsc/tsup) that are absent in this mode, and everything they
# emit (built `dist/`, generated Prisma client) is already in place from `build`.
RUN find . -maxdepth 4 -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

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
