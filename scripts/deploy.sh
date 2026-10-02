#!/usr/bin/env bash
#
# StackPanel 一键上云（Docker Compose + 可选 Caddy 自动 HTTPS）。
#
# 用法：
#   bash scripts/deploy.sh                          # 本机 Docker（http://localhost:3000）
#   bash scripts/deploy.sh --domain sp.example.com --email you@example.com
#   bash scripts/deploy.sh --cluster                # 集群档（外部 PG/Redis/对象存储）
#
# 选项：
#   --domain <d>   公网域名（启用 Caddy 自动 HTTPS；需 DNS 已指向本机）
#   --email <e>     Let's Encrypt 通知邮箱（与 --domain 搭配）
#   --no-https      即使给了域名也不启用 Caddy（纯 HTTP，仅测试用）
#   --cluster       使用 docker-compose.cluster.yml（忽略内置 PG/Redis/MinIO）
#   --image <ref>   使用已发布镜像（GHCR）而非本地构建；建议用 @sha256: 摘要引用
#
# 行为：
#   1. 检测 docker / docker compose
#   2. 生成 docker/.env（含随机密钥）——已存在则保留
#   3. 构建并启动 api + web + PostgreSQL + Redis + MinIO（默认档）
#      —— 若给 --image：拉取该镜像（不本地构建）后启动
#   4. 若给域名：额外启动 caddy（80/443 自动 HTTPS）
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOMAIN=""
EMAIL=""
NO_HTTPS=0
CLUSTER=0
IMAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --email)    EMAIL="${2:-}"; shift 2 ;;
    --no-https) NO_HTTPS=1; shift ;;
    --cluster)  CLUSTER=1; shift ;;
    --image)    IMAGE="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

info()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "未找到 docker。请先安装 Docker（https://docs.docker.com/get-docker/）"
docker compose version >/dev/null 2>&1 || fail "需要 docker compose v2（docker compose version）。"

# ---- 1. 生成 docker/.env ----------------------------------------------------
DOCKER_ENV="$ROOT_DIR/docker/.env"
if [[ -f "$DOCKER_ENV" ]]; then
  info "检测到 docker/.env，保留现有配置。"
else
  info "生成 docker/.env（含随机密钥）…"
  gen_secret() { openssl rand -base64 48 2>/dev/null | tr -d '=+/' | head -c 48 || true; }
  JWT_SECRET="$(gen_secret)"
  SETTINGS_KEY="$(gen_secret)"
  POSTGRES_PASSWORD="$(gen_secret)"
  MINIO_ROOT_PASSWORD="$(gen_secret)"
  [[ -n "$JWT_SECRET" && -n "$SETTINGS_KEY" && -n "$POSTGRES_PASSWORD" && -n "$MINIO_ROOT_PASSWORD" ]] \
    || fail "无法生成随机密钥（需要 openssl）。"
  cp "$ROOT_DIR/docker/.env.example" "$DOCKER_ENV"
  sed -i.bak \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
    -e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=${SETTINGS_KEY}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
    -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}|" \
    "$DOCKER_ENV"
  rm -f "$DOCKER_ENV.bak"
  info "docker/.env 已生成（含 PostgreSQL / MinIO 随机密钥）。"
fi

# ---- 2. 域名/HTTPS 配置 ------------------------------------------------------
USE_HTTPS=0
if [[ -n "$DOMAIN" && "$NO_HTTPS" == "0" ]]; then
  USE_HTTPS=1
  # 写入 STACKPANEL_DOMAIN / EMAIL 到 docker/.env（若不存在则追加）
  if ! grep -q '^STACKPANEL_DOMAIN=' "$DOCKER_ENV"; then
    echo "STACKPANEL_DOMAIN=${DOMAIN}" >> "$DOCKER_ENV"
  fi
  if [[ -n "$EMAIL" && ! "$(grep '^STACKPANEL_EMAIL=' "$DOCKER_ENV" 2>/dev/null || true)" ]]; then
    echo "STACKPANEL_EMAIL=${EMAIL}" >> "$DOCKER_ENV"
  fi
  # 公网 URL 指向 https 域名（用于 OIDC 回调 / 支付通知）
  if ! grep -q '^STACKPANEL_PUBLIC_URL=' "$DOCKER_ENV"; then
    echo "STACKPANEL_PUBLIC_URL=https://${DOMAIN}" >> "$DOCKER_ENV"
    echo "STACKPANEL_API_PUBLIC_URL=https://${DOMAIN}" >> "$DOCKER_ENV"
  fi
  info "启用 Caddy 自动 HTTPS：${DOMAIN}"
  info "反代真实客户端 IP：API_TRUST_PROXY 默认信任 compose 网段（见 docker-compose.yml），无需额外配置。"
elif [[ -n "$DOMAIN" && "$NO_HTTPS" == "1" ]]; then
  warn "--no-https 与 --domain 同时给出：仅启动 api+web（HTTP），不启动 Caddy。"
fi

# ---- 3. 构建并启动 ------------------------------------------------------------
COMPOSE_FILE="-f docker-compose.yml"
if [[ "$CLUSTER" == "1" ]]; then
  COMPOSE_FILE="-f docker-compose.cluster.yml"
  info "使用集群档（docker-compose.cluster.yml）：请确保 docker/.env 已配置外部 DATABASE_URL / REDIS_URL / STORAGE_S3_*。"
fi

if [[ -n "$IMAGE" ]]; then
  # 发布镜像模式：用 GHCR 镜像替代本地构建。compose 中 api/worker/web 共用同一镜像。
  export STACKPANEL_IMAGE="$IMAGE"
  # 记录到 docker/.env，方便后续 `docker compose ... up -d` 复用同一镜像。
  if ! grep -q '^STACKPANEL_IMAGE=' "$DOCKER_ENV"; then
    echo "STACKPANEL_IMAGE=${IMAGE}" >> "$DOCKER_ENV"
  else
    sed -i.bak -e "s|^STACKPANEL_IMAGE=.*|STACKPANEL_IMAGE=${IMAGE}|" "$DOCKER_ENV" && rm -f "$DOCKER_ENV.bak"
  fi
  info "使用已发布镜像：${IMAGE}"
  if [[ "${STACKPANEL_VERIFY_IMAGE:-0}" == "1" ]]; then
    info "校验镜像签名（cosign keyless）…"
    bash "$ROOT_DIR/scripts/verify-image.sh" "$IMAGE"
  else
    warn "未校验镜像签名（如需校验：STACKPANEL_VERIFY_IMAGE=1 bash scripts/deploy.sh --image <ref>）。"
  fi
  info "拉取镜像…"
  docker compose $COMPOSE_FILE --env-file "$DOCKER_ENV" pull
else
  info "构建镜像（首次较慢）…"
  docker compose $COMPOSE_FILE --env-file "$DOCKER_ENV" build
fi

info "启动服务…"
if [[ "$USE_HTTPS" == "1" ]]; then
  docker compose $COMPOSE_FILE --env-file "$DOCKER_ENV" --profile https up -d
else
  docker compose $COMPOSE_FILE --env-file "$DOCKER_ENV" up -d
fi

# ---- 4. 汇报 ------------------------------------------------------------------
info "启动完成。"
echo
echo "  api : http://localhost:3001/health"
echo "  web : http://localhost:3000"
if [[ "$USE_HTTPS" == "1" ]]; then
  echo "  https: https://${DOMAIN}"
fi
echo "  日志: docker compose $COMPOSE_FILE --env-file docker/.env logs -f --tail=200"
echo "  备份: 宿主机执行 bash scripts/backup.sh（PostgreSQL，见 ADR-0018）"
