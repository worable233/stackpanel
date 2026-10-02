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
gen_secret() { openssl rand -base64 48 2>/dev/null | tr -d '=+/' | head -c 48 || true; }

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
    fail "无法生成随机密钥（需要 openssl）。请手动填写 .env 的 JWT_SECRET / SETTINGS_ENCRYPTION_KEY。"
  fi
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
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
sed -i.bak \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=${SETTINGS_KEY}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=\"${DATABASE_URL}\"|" \
  "$ROOT_DIR/apps/api/.env"
rm -f "$ROOT_DIR/apps/api/.env.bak"

# apps/web/.env（Web BFF 实际读取，JWT_SECRET 必须与 API 一致）
if [[ ! -f "$ROOT_DIR/apps/web/.env" ]]; then
  cp "$ROOT_DIR/apps/web/.env.example" "$ROOT_DIR/apps/web/.env" 2>/dev/null || touch "$ROOT_DIR/apps/web/.env"
fi
sed -i.bak \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  "$ROOT_DIR/apps/web/.env"
rm -f "$ROOT_DIR/apps/web/.env.bak"

# 可选：外部公网地址（影响 OIDC 回调与支付通知 URL）
if [[ -n "${STACKPANEL_PUBLIC_URL:-}" ]]; then
  for envfile in "$ROOT_DIR/.env" "$ROOT_DIR/apps/api/.env"; do
    sed -i.bak \
      -e "s|^STACKPANEL_PUBLIC_URL=.*|STACKPANEL_PUBLIC_URL=${STACKPANEL_PUBLIC_URL}|" \
      -e "s|^STACKPANEL_API_PUBLIC_URL=.*|STACKPANEL_API_PUBLIC_URL=${STACKPANEL_PUBLIC_URL}|" \
      "$envfile"
    rm -f "$envfile.bak"
  done
fi
info ".env 已生成（根 / apps/api / apps/web，共享 JWT_SECRET 与 SETTINGS_ENCRYPTION_KEY）"

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
echo "  首次登录: 使用 STACKPANEL_BOOTSTRAP_EMAIL/PASSWORD（见 .env，或查看启动日志中的随机密码）"
echo "  日志:     pm2 logs stackpanel-api"
