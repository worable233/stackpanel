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

# set_env <KEY> <VALUE>: write/replace a KEY=VALUE line in docker/.env.
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$DOCKER_ENV"; then
    sed -i.bak -e "s|^${key}=.*|${key}=${val}|" "$DOCKER_ENV" && rm -f "$DOCKER_ENV.bak"
  else
    echo "${key}=${val}" >> "$DOCKER_ENV"
  fi
}

command -v docker >/dev/null 2>&1 || fail "未找到 docker。请先安装 Docker（https://docs.docker.com/get-docker/）"
docker compose version >/dev/null 2>&1 || fail "需要 docker compose v2（docker compose version）。"

# ---- 1. 生成 docker/.env ----------------------------------------------------
DOCKER_ENV="$ROOT_DIR/docker/.env"
if [[ -f "$DOCKER_ENV" ]]; then
  info "检测到 docker/.env，保留现有配置。"
  # I-2 guard: the encrypted-settings store is silently disabled without this
  # key, which would strand payment keys / signing keys in plaintext. Refuse to
  # deploy an existing env that forgot it rather than degrade invisibly.
  if ! grep -qE '^SETTINGS_ENCRYPTION_KEY=.+' "$DOCKER_ENV"; then
    fail "docker/.env 存在但 SETTINGS_ENCRYPTION_KEY 为空。请设置 >=32 字符的随机值（openssl rand -base64 48 | tr -d '=+/' | head -c 48）后重试。"
  fi
else
  info "生成 docker/.env（含随机密钥）…"
  # Prefer openssl; fall back to /dev/urandom so the script also works on
  # hosts without openssl (all supported platforms provide /dev/urandom).
  gen_secret() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 48 2>/dev/null | tr -d '=+/' | head -c 48 || true
    else
      LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48 || true
    fi
  }
  JWT_SECRET="$(gen_secret)"
  SETTINGS_KEY="$(gen_secret)"
  POSTGRES_PASSWORD="$(gen_secret)"
  MINIO_ROOT_PASSWORD="$(gen_secret)"
  [[ -n "$JWT_SECRET" && -n "$SETTINGS_KEY" && -n "$POSTGRES_PASSWORD" && -n "$MINIO_ROOT_PASSWORD" ]] \
    || fail "无法生成随机密钥（需要 openssl 或 /dev/urandom）。"
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

# ---- 1b. 初始化认领令牌（一次性） --------------------------------------------
# 全新实例在浏览器 /setup 认领时需提供该令牌，认领完成后即失效。它是一次性
# 「认领凭证」，不是管理员密码——管理员密码由运维在向导里自己设置，绝不写入日志。
SETUP_TOKEN="$(sed -n 's/^STACKPANEL_SETUP_TOKEN=//p' "$DOCKER_ENV" | tail -n1 | tr -d '"' | tr -d "'")"
if [[ -z "$SETUP_TOKEN" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    SETUP_TOKEN="$(openssl rand -hex 32)"
  else
    SETUP_TOKEN="$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64 || true)"
  fi
  if grep -q '^STACKPANEL_SETUP_TOKEN=' "$DOCKER_ENV"; then
    sed -i.bak -e "s|^STACKPANEL_SETUP_TOKEN=.*|STACKPANEL_SETUP_TOKEN=${SETUP_TOKEN}|" "$DOCKER_ENV" && rm -f "$DOCKER_ENV.bak"
  else
    echo "STACKPANEL_SETUP_TOKEN=${SETUP_TOKEN}" >> "$DOCKER_ENV"
  fi
fi

# ---- 2. 域名/HTTPS 配置 ------------------------------------------------------
USE_HTTPS=0
if [[ -n "$DOMAIN" && "$NO_HTTPS" == "0" ]]; then
  USE_HTTPS=1
  # 写入 STACKPANEL_DOMAIN / EMAIL 到 docker/.env（空值也覆盖，否则 .env.example
  # 中的空占位行会让「不存在才追加」的守卫永远跳过写入）。
  set_env STACKPANEL_DOMAIN "$DOMAIN"
  if [[ -n "$EMAIL" ]]; then
    set_env STACKPANEL_EMAIL "$EMAIL"
  fi
  # 公网 URL 指向 https 域名（用于 OIDC 回调 / 支付通知）。始终覆盖：模板的
  # localhost 占位行存在会让「不存在才追加」的守卫跳过，导致 HTTPS 部署却仍
  # 对外通告 http://localhost（OIDC 回调 / 支付通知错误）。
  set_env STACKPANEL_PUBLIC_URL "https://${DOMAIN}"
  set_env STACKPANEL_API_PUBLIC_URL "https://${DOMAIN}"
  info "启用 Caddy 自动 HTTPS：${DOMAIN}"
  info "反代真实客户端 IP：API_TRUST_PROXY 默认信任 compose 网段（见 docker-compose.yml），无需额外配置。"
  if ! grep -qE '^STACKPANEL_TRUSTED_PROXIES=.+' "$DOCKER_ENV"; then
    info "若在 Caddy 前再加 CDN/负载均衡，请把其回源网段写入 STACKPANEL_TRUSTED_PROXIES；否则所有访客会共用 CDN 节点 IP，限流与审计失效。"
  fi
elif [[ -n "$DOMAIN" && "$NO_HTTPS" == "1" ]]; then
  warn "--no-https 与 --domain 同时给出：仅启动 api+web（HTTP），不启动 Caddy。"
  set_env STACKPANEL_PUBLIC_URL "http://${DOMAIN}"
  set_env STACKPANEL_API_PUBLIC_URL "http://${DOMAIN}"
  warn "HTTP 部署下，生产环境的会话 cookie 强制带 Secure，浏览器不会回传 → 登录不可用。此模式仅供本机调试。"
fi

# 说明：生产环境（NODE_ENV=production）内核与 Web 都会把会话 cookie 强制标
# Secure（安全审计 M-1），因此「公网 HTTP」没有可用配置——这不是缺省值问题，
# 而是有意的安全策略。此处只对无域名（本机/内网）部署给出明确提示。
if [[ "$USE_HTTPS" == "0" ]]; then
  warn "当前未启用 HTTPS：仅适合本机（http://localhost）或内网试用。"
  warn "  经 http://<服务器IP>:3000 访问时浏览器不会保存 Secure 会话 cookie，登录会失败。"
  warn "  公网部署请使用：bash scripts/deploy.sh --domain <域名> --email <邮箱>"
fi

# ---- 3. 构建并启动 ------------------------------------------------------------
COMPOSE_FILE="-f docker-compose.yml"
if [[ "$CLUSTER" == "1" ]]; then
  COMPOSE_FILE="-f docker-compose.cluster.yml"
  info "使用集群档（docker-compose.cluster.yml）：请确保 docker/.env 已配置外部 DATABASE_URL / REDIS_URL / STORAGE_S3_*。"
  # 集群档对镜像用 `:?` 强制（默认档有本地 tag 兜底），缺任一变量时 docker compose
  # 会在解析期直接报错——本地构建路径也会中招。这里补齐本地构建所需的默认 tag；
  # 用 --image 时上面的 set_env 已写入真实引用，不会被覆盖。
  [[ -n "$(sed -n 's/^STACKPANEL_IMAGE=//p' "$DOCKER_ENV" | tail -n1)" ]] || set_env STACKPANEL_IMAGE "stackpanel-api:latest"
  [[ -n "$(sed -n 's/^STACKPANEL_WEB_IMAGE=//p' "$DOCKER_ENV" | tail -n1)" ]] || set_env STACKPANEL_WEB_IMAGE "stackpanel-web:latest"
  grep -qE '^CADDY_IMAGE=.+' "$DOCKER_ENV" || set_env CADDY_IMAGE "caddy:2-alpine"
fi

if [[ -n "$IMAGE" ]]; then
  # 发布镜像模式：用 GHCR 镜像替代本地构建。compose 中 api/worker/web 共用同一镜像。
  export STACKPANEL_IMAGE="$IMAGE"
  set_env STACKPANEL_IMAGE "$IMAGE"
  # 集群档额外要求 STACKPANEL_WEB_IMAGE / CADDY_IMAGE（compose 用 `:?` 强制），
  # 默认档的 web 与 api 共用 STACKPANEL_IMAGE、caddy 用固定 tag；这里一并写入，
  # 否则 `deploy.sh --cluster --image <ref>` 会在 `compose up` 时报「缺少变量」。
  set_env STACKPANEL_WEB_IMAGE "$IMAGE"
  if [[ "$CLUSTER" == "1" ]] && ! grep -qE '^CADDY_IMAGE=.+' "$DOCKER_ENV"; then
    set_env CADDY_IMAGE "caddy:2-alpine"
  fi
  info "使用已发布镜像：${IMAGE}"
  # 默认验签（fail-closed）：-image 路径本可被默认跳过，使 cosign 投入形同虚设
  #（审计 E-3）。默认强制校验镜像签名；确需跳过时显式 STACKPANEL_VERIFY_IMAGE=0。
  if [[ "${STACKPANEL_VERIFY_IMAGE:-1}" != "0" ]]; then
    info "校验镜像签名（cosign keyless）…"
    bash "$ROOT_DIR/scripts/verify-image.sh" "$IMAGE"
  else
    warn "已按 STACKPANEL_VERIFY_IMAGE=0 跳过镜像签名校验——生产环境强烈建议保持默认校验。"
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
echo
if [[ "${STACKPANEL_SETUP_MODE:-auto}" != "disabled" && -n "$SETUP_TOKEN" ]]; then
  info "首次初始化：打开 Web 站点按引导在 /setup 创建第一个管理员。"
  echo "  初始化令牌: ${SETUP_TOKEN}"
  echo "              （也保存在 docker/.env 的 STACKPANEL_SETUP_TOKEN；认领后即失效）"
fi
echo "  日志: docker compose $COMPOSE_FILE --env-file docker/.env logs -f --tail=200"
echo "  备份: bash scripts/backup.sh（自动识别 compose 部署，含 PostgreSQL + 对象存储；恢复用 scripts/restore.sh）"
