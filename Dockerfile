# syntax=docker/dockerfile:1
# StackPanel monorepo image. Build once, then run either the API or the Web
# app by overriding the entrypoint (see docker-compose.yml).
#
#   docker build --target runtime -t stackpanel .

ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS base
ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PATH}:${PNPM_HOME}"
# Corepack caches the prepared pnpm under `$HOME` by default, which would break
# when we run as a non-root user with a different HOME. Pin an absolute cache
# location that the runtime stage can hand to that user.
ENV COREPACK_HOME=/opt/corepack
# pnpm 11 defaults `verifyDepsBeforeRun` to `prompt`; in a non-interactive
# container that turns into an implicit `pnpm install` before every `pnpm run`
# and `pnpm exec`. With the devDependencies stripped (see `prod-deps`) that
# install re-resolves the full lockfile, re-runs the workspace `prepare` hooks
# and aborts on `tsc: command not found` — which would break the entrypoints'
# `pnpm --filter @stackpanel/db migrate:deploy`. The modules tree in this image is
# intentionally frozen at build time, so the check is disabled for every stage.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
# 下载缓存挂到 BuildKit cache mount：本地慢网/CI 重试时不必把 1.2k 个包重下一遍
# （之前一次断流就整层重跑，20 分钟的构建全白做）。
ENV PNPM_CONFIG_STORE_DIR=/pnpm-store
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

# ---- deps ---------------------------------------------------------------
# pnpm runs workspace `prepare` scripts during install (db: prisma generate,
# sdk/ui: build, plugins: tsc), so the full source must be present. node_modules
# and build output are excluded via .dockerignore.
FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile


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
# behind `pnpm --filter @stackpanel/db migrate:deploy` and the Next server that
# only the web role invokes — so those are declared as regular dependencies and
# survive this step. Everything else (eslint, vitest, playwright, pm2,
# license-checker, …) stays out of the image.
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
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    find . -maxdepth 4 -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

# Next does NOT put `.next/static` (or `public/`) inside the standalone tree, and
# the standalone server only serves build assets from *within* it. The kernel
# artifact builder already patches this
# (`scripts/release/build-kernel-artifact.mjs` step 2); the image did not, so
# every `/_next/static/*.js|*.css` request 404'd: the page rendered with no
# styles and never hydrated (v0.1.0 and v0.1.1 both shipped that way). The
# presence check keeps the build honest if the Next output layout ever changes.
RUN cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/public; fi \
 && test -n "$(ls -A apps/web/.next/standalone/apps/web/.next/static)"

# Pre-download the Prisma **schema engine** into the image.
#
# Why: `prisma migrate deploy` needs `schema-engine-<platform>` at runtime, but
# `prisma generate` only fetches the query engine. Without it, every migration
# downloads from binaries.prisma.sh at *upgrade time*:
#
#   prisma:fetch-engine:download https://binaries.prisma.sh/all_commits/<hash>/...
#     → hangs indefinitely on a blocked/slow network (no timeout)
#
# A real upgrade drill sat in `migrating` for 30+ minutes because of this: the
# updater's migrate step just waited, the instance stayed in maintenance, and no
# log line said why. Offline / air-gapped deployments could never migrate at all.
# Doing it at build time makes runtime deterministic and keeps upgrades offline-safe.
#
# Downloaded *after* the production install (which wipes node_modules) into a
# directory outside the pnpm store, then pinned via PRISMA_SCHEMA_ENGINE_BINARY
# so the CLI never looks for a cache path we cannot control. The helper verifies
# the artifact is a real (non-truncated) executable and fails the build otherwise.
ENV PRISMA_SCHEMA_ENGINE_BINARY=/app/.prisma-engines/schema-engine
RUN node docker/fetch-schema-engine.mjs /app/.prisma-engines/schema-engine \
 && test -x /app/.prisma-engines/schema-engine

# ---- pruned ---------------------------------------------------------------
# 在**单独一层**里做裁剪，再整体拷进 runtime。
#
# 为什么不能直接在 runtime 里 `find -delete`：`COPY` 已经把那 13 MB map 写进
# 下面一层了，后一层再删只会新增 whiteout，镜像**一点没小**（实测
# `SOURCE_MAPS=0` 反而 4.09 GB > 4.08 GB）。要让体积真的掉下去，删除必须发生在
# 拷贝之前。
FROM prod-deps AS pruned

# Source maps.
#
# `apps/api/tsup.config.ts` emits `sourcemap: true`, so `dist/` is 20 MB of JS +
# **13 MB of `.map`** — 65% of the artifact. Those maps shipped into the image
# but nothing ever read them: `--enable-source-maps` was not set anywhere, so a
# production stack trace pointed at tsup's chunk names (`bowser-KGNXATBQ.js:1:2`)
# while 13 MB of every layer did nothing. Either they are used or they are dead
# weight — this ARG makes that a decision:
#
#   --build-arg STACKPANEL_SOURCE_MAPS=0   → maps dropped (~13 MB smaller image,
#                                             stack traces lose original lines)
#   default (1)                            → maps kept **and** enabled by the
#                                             entrypoints, so traces resolve
ARG STACKPANEL_SOURCE_MAPS=1
RUN if [ "$STACKPANEL_SOURCE_MAPS" = "0" ]; then \
      find /app -name '*.map' -type f -delete && echo "source maps stripped"; \
    fi

# 裁掉源码与构建期残留：镜像里只需要构建产物。`*.ts` 里含开发注释与内部路径，
# `*.tsbuildinfo` 是 tsc 的增量缓存，运行时一概不读。
#
# 排除 `node_modules` 是必须的：里面有带 `.ts` 源码的包，删掉会打穿依赖。
# **不能用 `-prune`**：`-delete` 隐含 `-depth`，而 `-depth` 下 `-prune` 完全失效
# —— 本地实测会连 `node_modules/x/f.ts` 一起删掉。用 `! -path '*/node_modules/*'`。
#
# `prisma.config.ts` 必须留下：Prisma 7 把 datasource URL 从 schema.prisma 挪到了
# 这个**运行时读取**的配置文件里。把它当源码删掉，`prisma migrate deploy` 直接报
# 「The datasource.url property is required in your Prisma config file」——镜像能起来，
# 但 `migrate` 服务一次都跑不成功（发布前冒烟抓到的，v0.1.2 差点带着它上线）。
RUN find /app -type f \( -name '*.ts' ! -name '*.d.ts' ! -name 'prisma.config.ts' \
        -o -name '*.tsbuildinfo' \) \
      ! -path '*/node_modules/*' -delete

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
COPY --chown=node:node --from=pruned /app /app

# 镜像身份：写一份与自包含产物同格式的 `RELEASE.json`，让 `GET /version` 直接回答
# 「这个容器跑的是哪一次构建」。不传参数（本地 `docker build`）时不写文件，代码侧
# 回落到编译期的 `KERNEL_VERSION`——两种情况下 `/version` 都不会是 `unknown`。
ARG STACKPANEL_VERSION=""
ARG STACKPANEL_COMMIT=""
ARG STACKPANEL_BUILT_AT=""
RUN if [ -n "$STACKPANEL_VERSION" ]; then \
      printf '{"version":"%s","gitCommit":"%s","builtAt":"%s"}\n' \
        "$STACKPANEL_VERSION" "$STACKPANEL_COMMIT" "$STACKPANEL_BUILT_AT" > /app/RELEASE.json \
      && chown node:node /app/RELEASE.json; \
    fi
# Point the Prisma CLI at the engine baked in by the prod-deps stage. This ENV
# must be repeated here: `FROM base AS runtime` starts a fresh stage, so the
# prod-deps ENV does not carry over. Without it the CLI ignores the baked engine
# and downloads from binaries.prisma.sh on first migrate (hangs on restricted
# networks — the exact failure this fixes).
ENV PRISMA_SCHEMA_ENGINE_BINARY=/app/.prisma-engines/schema-engine
COPY docker/entrypoint-api.sh /usr/local/bin/entrypoint-api
COPY docker/entrypoint-web.sh /usr/local/bin/entrypoint-web
COPY docker/entrypoint-worker.sh /usr/local/bin/entrypoint-worker
COPY docker/entrypoint-migrate.sh /usr/local/bin/entrypoint-migrate
RUN chmod +x /usr/local/bin/entrypoint-api /usr/local/bin/entrypoint-web /usr/local/bin/entrypoint-worker /usr/local/bin/entrypoint-migrate
# Run as a non-privileged user (security audit M-3). The node base image already
# ships a `node` user (uid/gid 1000); reuse it. `COPY --chown` hands ownership of
# the app tree to it without an extra (image-doubling) recursive `chown` layer,
# and the writable paths the runtime needs (the `/app/data` mountpoint and the
# corepack cache) are chowned to match. Pre-owning these as `node` also lets
# fresh named volumes inherit the right ownership. `HOME` must point at a
# writable directory because pnpm writes its store/cache under `$HOME`.
# NOTE: named volumes created by an earlier root image keep root ownership; run a
# one-off `chown -R node:node` on them when upgrading (see docker/README.md).
# `/app/data` 必须以**空目录**进镜像。构建过程中它会被播种（prod-deps 阶段跑过
# 构建脚本），带着 `data/themes/*`、`data/plugins/*` 一起发布；Docker 首次挂载命名卷
# 时会把镜像里的内容复制进卷，而 api 与 worker 是同时启动的两个容器——两个守护进程
# 线程并发 `mkdir .../themes` 就会撞 `failed to mkdir .../themes: file exists`，
# `docker compose up` 直接失败（实测复现）。内置插件与主题在启动时从 `packages/`
# 播种，不依赖这份快照，所以删干净是安全的。
RUN rm -rf /app/data \
 && install -d -o node -g node -m 755 /app/data \
 && chown node:node /app /app/data \
 && chown -R node:node /opt/corepack
ENV HOME=/home/node
USER node
WORKDIR /app
EXPOSE 3000 3001
CMD ["/bin/sh", "-c", "echo \"stackpanel image ready (override entrypoint via compose)\""]
