#!/usr/bin/env bash
#
# StackPanel 本地安装器：PM2 模式（本机 PostgreSQL + Redis + 对象存储）。
#
# 仅用于「不想用 Docker、本机已有 PostgreSQL/Redis」的场景。默认推荐走
# Docker 一键部署：`bash scripts/deploy.sh`（内置 PG/Redis/MinIO，零运维）。
#
# 用法：
#   bash scripts/install.sh                 # 交互式（读取/生成密钥）
#   bash scripts/install.sh --non-interactive
#   STACKPANEL_PUBLIC_URL=https://sp.example.com bash scripts/install.sh --non-interactive
#
# 行为：
#   1. 检测 Node/pnpm
#   2. 生成强随机密钥写入根/.env、apps/api/.env、apps/web/.env（共享 JWT_SECRET）
#   3. 安装依赖 + 构建
#   4. 应用数据库迁移（migrate deploy）
#   5. 用 PM2 启动 api + web
#
# 运行前请确保 .env 的 DATABASE_URL / REDIS_URL 指向可达的 PostgreSQL / Redis
# （ADR-0019 唯一存储引擎；ADR-0017 生产强制 Redis）。
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NON_INTERACTIVE=0
[[ "${1:-}" == "--non-interactive" ]] && NON_INTERACTIVE=1

info()  { printf '\033[1;36m[stackpanel]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[stackpanel]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m[stackpanel]\033[0m %s\n' "$*" >&2; exit 1; }

# set_env <file> <KEY> <VALUE>: replace an active `KEY=…` line, else append.
# `.env.example` ships these keys commented out, so appending is safe; an existing
# active line is replaced so re-runs take the new value (dotenv is first-wins).
set_env() {
  local file="$1" key="$2" val="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i.bak -e "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "$file.bak"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

# ---- 1. 环境检测 ------------------------------------------------------------
info "检测运行环境…"
command -v node >/dev/null 2>&1 || fail "未找到 node。请先安装 Node.js 22+（https://nodejs.org）"
command -v pnpm >/dev/null 2>&1 || fail "未找到 pnpm。请先安装：npm i -g pnpm"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if (( NODE_MAJOR < 22 )); then
  fail "需要 Node.js 22+，当前为 $(node -v)。请升级。"
fi
info "Node $(node -v) / pnpm $(pnpm -v) OK"

# ---- 2. 生成 .env（根 + apps/api + apps/web，共享同一密钥） -----------------
# Prefer openssl; fall back to /dev/urandom so the script also works on hosts
# without openssl (all supported platforms provide /dev/urandom).
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 2>/dev/null | tr -d '=+/' | head -c 48 || true
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48 || true
  fi
}

# 一次性初始化认领令牌（64 hex）：未初始化实例在 /setup 认领时需提供，
# 认领完成后即失效。写入 .env 并在末尾摘要中打印。
gen_setup_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64 || true
  fi
}

# 根 .env 供脚本/迁移/备份使用；apps/api/.env 与 apps/web/.env 供 PM2 进程读取。
# 三者必须共享同一 JWT_SECRET（Web BFF 用其校验 API 签发的 token）。
if [[ -f "$ROOT_DIR/.env" ]]; then
  info "检测到已有 .env，复用其密钥（如需重新生成请删除后重跑）。"
  JWT_SECRET="$(sed -n 's/^JWT_SECRET=//p' "$ROOT_DIR/.env" | tail -n1 | tr -d '"' | tr -d "'")"
  SETTINGS_KEY="$(sed -n 's/^SETTINGS_ENCRYPTION_KEY=//p' "$ROOT_DIR/.env" | tail -n1 | tr -d '"' | tr -d "'")"
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ROOT_DIR/.env" | tail -n1 | tr -d '"' | tr -d "'")"
else
  info "生成强随机密钥并写入 .env…"
  JWT_SECRET="$(gen_secret)"
  SETTINGS_KEY="$(gen_secret)"
  if [[ -z "$JWT_SECRET" || -z "$SETTINGS_KEY" ]]; then
    fail "无法生成随机密钥（需要 openssl 或 /dev/urandom）。请手动填写 .env 的 JWT_SECRET / SETTINGS_ENCRYPTION_KEY。"
  fi
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
fi

# 复用旧 .env 时，若密钥仍是模板占位符（change_me…）或过短，生产启动会被内核
# 直接拒绝（见 apps/api/src/config/env.ts）。这里就地换成强随机值，避免装到一半
# 才在启动阶段失败。
is_weak_secret() {
  [[ -z "$1" || "${#1}" -lt 32 || "$1" == change_me* || "$1" == change-me-* || "$1" == changeme || "$1" == dev_only_* ]]
}
if is_weak_secret "$JWT_SECRET"; then
  JWT_SECRET="$(gen_secret)"
  warn "JWT_SECRET 是占位符或过短，已重新生成强随机值。"
fi
if is_weak_secret "$SETTINGS_KEY"; then
  SETTINGS_KEY="$(gen_secret)"
  warn "SETTINGS_ENCRYPTION_KEY 是占位符或过短，已重新生成强随机值。"
fi

# 数据库连接串：外部显式设置 > 已有 .env > 模板默认（本机 PostgreSQL）。
DATABASE_URL="${DATABASE_URL:-${EXT_DATABASE_URL:-postgresql://stackpanel:stackpanel@127.0.0.1:5432/stackpanel}}"

sed -i.bak \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=${SETTINGS_KEY}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" \
  "$ROOT_DIR/.env"
rm -f "$ROOT_DIR/.env.bak"

# apps/api/.env（API 进程实际读取）
if [[ ! -f "$ROOT_DIR/apps/api/.env" ]]; then
  cp "$ROOT_DIR/apps/api/.env.example" "$ROOT_DIR/apps/api/.env"
fi

# 初始化认领令牌：已有则复用，否则生成。写入 API 进程读取的 .env。
SETUP_TOKEN="$(sed -n 's/^STACKPANEL_SETUP_TOKEN=//p' "$ROOT_DIR/apps/api/.env" | tail -n1 | tr -d '"' | tr -d "'")"
if [[ -z "$SETUP_TOKEN" ]]; then
  SETUP_TOKEN="$(gen_setup_token)"
fi

sed -i.bak \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=${SETTINGS_KEY}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=\"${DATABASE_URL}\"|" \
  "$ROOT_DIR/apps/api/.env"
rm -f "$ROOT_DIR/apps/api/.env.bak"
# `sed -i` only rewrites an existing line: an `.env` created before the wizard
# existed has no `STACKPANEL_SETUP_TOKEN=` line at all, which would silently run
# the wizard *open*. `set_env` appends when the key is absent.
set_env "$ROOT_DIR/apps/api/.env" STACKPANEL_SETUP_TOKEN "$SETUP_TOKEN"

# apps/web/.env（Web BFF 实际读取，JWT_SECRET 必须与 API 一致）
if [[ ! -f "$ROOT_DIR/apps/web/.env" ]]; then
  cp "$ROOT_DIR/apps/web/.env.example" "$ROOT_DIR/apps/web/.env" 2>/dev/null || touch "$ROOT_DIR/apps/web/.env"
fi
sed -i.bak \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  "$ROOT_DIR/apps/web/.env"
rm -f "$ROOT_DIR/apps/web/.env.bak"

# 外部公网地址（影响 OIDC 回调、支付通知与 SEO 绝对 URL）。
# `STACKPANEL_PUBLIC_URL` 是 Web 源；`STACKPANEL_API_PUBLIC_URL` 是 API 源
# （两者域不同时须分别给出，未给出则沿用已有 .env）。
PUBLIC_URL="${STACKPANEL_PUBLIC_URL:-$(sed -n 's/^STACKPANEL_PUBLIC_URL=//p' "$ROOT_DIR/apps/api/.env" | tail -n1 | tr -d '"' | tr -d "'")}"
API_PUBLIC_URL="${STACKPANEL_API_PUBLIC_URL:-$(sed -n 's/^STACKPANEL_API_PUBLIC_URL=//p' "$ROOT_DIR/apps/api/.env" | tail -n1 | tr -d '"' | tr -d "'")}"
API_PUBLIC_URL="${API_PUBLIC_URL:-$PUBLIC_URL}"
if [[ -n "$PUBLIC_URL" ]]; then
  for envfile in "$ROOT_DIR/.env" "$ROOT_DIR/apps/api/.env"; do
    sed -i.bak \
      -e "s|^STACKPANEL_PUBLIC_URL=.*|STACKPANEL_PUBLIC_URL=${PUBLIC_URL}|" \
      -e "s|^STACKPANEL_API_PUBLIC_URL=.*|STACKPANEL_API_PUBLIC_URL=${API_PUBLIC_URL}|" \
      "$envfile"
    rm -f "$envfile.bak"
  done
  # Web 侧 SEO（canonical / hreflang / sitemap / og:url）以 SITE_URL 为回退来源。
  # 不写它，公网部署的 SEO 绝对地址会退化成 http://localhost:3000。
  set_env "$ROOT_DIR/apps/web/.env" SITE_URL "$PUBLIC_URL"
  # 外部 API 客户端看到的地址（账户 API Key 页的可复制 curl 示例）。写成内部
  # 的 127.0.0.1:3001 会让用户复制到一条自己机器上打不通的命令。
  set_env "$ROOT_DIR/apps/web/.env" PUBLIC_API_BASE_URL "$API_PUBLIC_URL"
fi
info ".env 已生成（根 / apps/api / apps/web，共享 JWT_SECRET 与 SETTINGS_ENCRYPTION_KEY）"

# ---- 2b. 生产基础设施（ADR-0017）：PM2 以 NODE_ENV=production 运行，内核在启动
# 时强制要求 Redis 与 S3 兼容对象存储，缺失会 fail-fast（本地盘不被生产接受）。
# 这里在**构建之前**校验并把配置写进 API 进程读取的 .env，避免装完才在启动阶段
# 报错。以下变量可经环境变量覆盖，否则从已有 .env 读取：
#   REDIS_URL=redis://127.0.0.1:6379
#   STORAGE_DRIVER=s3  STORAGE_S3_ENDPOINT=… STORAGE_S3_BUCKET=…
#   STORAGE_S3_ACCESS_KEY_ID=… STORAGE_S3_SECRET_ACCESS_KEY=…
API_ENV="$ROOT_DIR/apps/api/.env"
read_env() { sed -n "s|^${1}=||p" "$API_ENV" 2>/dev/null | tail -n1 | tr -d '"' | tr -d "'"; }

REDIS_URL="${REDIS_URL:-$(read_env REDIS_URL)}"
S3_ENDPOINT="${STORAGE_S3_ENDPOINT:-$(read_env STORAGE_S3_ENDPOINT)}"
S3_BUCKET="${STORAGE_S3_BUCKET:-$(read_env STORAGE_S3_BUCKET)}"
S3_KEY="${STORAGE_S3_ACCESS_KEY_ID:-$(read_env STORAGE_S3_ACCESS_KEY_ID)}"
S3_SECRET="${STORAGE_S3_SECRET_ACCESS_KEY:-$(read_env STORAGE_S3_SECRET_ACCESS_KEY)}"
S3_REGION="${STORAGE_S3_REGION:-$(read_env STORAGE_S3_REGION)}"

if [[ -z "$REDIS_URL" ]]; then
  fail "缺少 REDIS_URL。PM2 以生产模式运行，内核强制要求 Redis（多副本会话/限流/状态/事件）。
  请指向一个可达的 Redis 后重跑，例如：
    REDIS_URL=redis://127.0.0.1:6379 bash scripts/install.sh --non-interactive"
fi

if [[ -z "$S3_ENDPOINT" || -z "$S3_BUCKET" || -z "$S3_KEY" || -z "$S3_SECRET" ]]; then
  fail "生产环境需要 S3 兼容对象存储（ADR-0017，本地盘不被接受）。
  请补齐后重跑，例如 MinIO：
    STORAGE_DRIVER=s3 \\
    STORAGE_S3_ENDPOINT=http://127.0.0.1:9000 \\
    STORAGE_S3_BUCKET=stackpanel \\
    STORAGE_S3_ACCESS_KEY_ID=<key> \\
    STORAGE_S3_SECRET_ACCESS_KEY=<secret> \\
    REDIS_URL=redis://127.0.0.1:6379 \\
    bash scripts/install.sh --non-interactive
  提示：不想自备 PG/Redis/S3 时，改用内置依赖的一键 Docker 部署：bash scripts/deploy.sh"
fi

# 写入根 .env 与 apps/api/.env（两者都补 Redis；对象存储只 API/worker 需要）。
for envfile in "$ROOT_DIR/.env" "$API_ENV"; do
  set_env "$envfile" REDIS_URL "$REDIS_URL"
done
set_env "$API_ENV" STORAGE_DRIVER "s3"
set_env "$API_ENV" STORAGE_S3_ENDPOINT "$S3_ENDPOINT"
set_env "$API_ENV" STORAGE_S3_BUCKET "$S3_BUCKET"
set_env "$API_ENV" STORAGE_S3_ACCESS_KEY_ID "$S3_KEY"
set_env "$API_ENV" STORAGE_S3_SECRET_ACCESS_KEY "$S3_SECRET"
set_env "$API_ENV" STORAGE_S3_REGION "${S3_REGION:-us-east-1}"
set_env "$API_ENV" STORAGE_S3_FORCE_PATH_STYLE "true"
info "生产基础设施已写入：REDIS_URL + STORAGE_DRIVER=s3"

if [[ "$NON_INTERACTIVE" != "1" ]]; then
  warn "请确认 .env / apps/api/.env 的 DATABASE_URL 与 REDIS_URL 指向可达的 PostgreSQL / Redis。"
  read -r -p "按回车继续，或 Ctrl-C 中止…" _ || true
fi

# ---- 3. 构建 ----------------------------------------------------------------
info "安装依赖并构建（首次较慢）…"
pnpm install
pnpm build

# ---- 4. 迁移 -----------------------------------------------------------------
info "应用数据库迁移（migrate deploy）…"
pnpm --filter @stackpanel/db migrate:deploy

# ---- 5. 启动 ----------------------------------------------------------------
info "用 PM2 启动 api(:3001) + web(:3000)…"
pnpm pm2:start 2>/dev/null || pnpm pm2:stop >/dev/null 2>&1 || true

echo
info "安装完成！"
echo "  后台地址: http://127.0.0.1:3000/admin"
echo "  首次初始化: 打开 http://127.0.0.1:3000 ，按引导在 /setup 创建第一个管理员"
echo "  初始化令牌: ${SETUP_TOKEN}"
echo "              （也保存在 apps/api/.env 的 STACKPANEL_SETUP_TOKEN；认领后即失效）"
echo "  日志:     pm2 logs stackpanel-api"
