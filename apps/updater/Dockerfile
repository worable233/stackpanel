# syntax=docker/dockerfile:1
# 独立升级执行器镜像（PLAN-github-distribution-and-updates §5.1）。
#
# 这是**独立、预构建**的镜像：内置固定版本的 Docker CLI + Compose 插件、PostgreSQL
# 备份恢复客户端与验签器；不包含待升级内核的源码，也**不做任何构建**（§5.1「生产基线
# 使用已构建镜像，运行 Compose 不含 build」）。它只依赖 `@stackpanel/spec` 契约。
#
#   docker build -f apps/updater/Dockerfile -t stackpanel-updater .

ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS build
ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PATH}:${PNPM_HOME}"
ENV COREPACK_HOME=/opt/corepack
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app
# 只带构建 updater 所需的源码（spec 契约 + updater 包 + workspace 描述）。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/spec ./packages/spec
COPY apps/updater ./apps/updater
RUN pnpm install --frozen-lockfile --filter @stackpanel/updater... \
 && pnpm --filter @stackpanel/spec build \
 && pnpm --filter @stackpanel/updater build

# ---- runtime ------------------------------------------------------------
# 独立运行时镜像：无源码、无 pnpm、无构建器；只带 Node、docker/compose 客户端与
# pg 客户端，且只复制构建产物。
FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production
# 固定来源安装 Docker CLI 与 Compose v2 插件；版本由 apt/docker 仓锁定，不由包内内容决定。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-compose-plugin postgresql-client-16 tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# 只复制构建产物与入口；不带源码、pnpm 或构建工具。
COPY --from=build /app/apps/updater/dist ./apps/updater/dist
COPY --from=build /app/apps/updater/package.json ./apps/updater/package.json
COPY docker/entrypoint-updater.sh /usr/local/bin/entrypoint-updater
RUN chmod +x /usr/local/bin/entrypoint-updater \
 && mkdir -p /var/lib/stackpanel-updater \
 && chown -R node:node /app /var/lib/stackpanel-updater
ENV HOME=/home/node
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint-updater"]
