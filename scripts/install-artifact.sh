#!/usr/bin/env bash
#
# 首次安装 / 手工切换到「产物载体」部署（ADR-0025，非 Docker）。
#
# 与 scripts/install.sh（源码构建 + PM2）并列：本脚本只接受**已构建的自包含产物**，
# 目标机不需要源码、pnpm 或构建器。
#
# 用法：
#   sudo bash scripts/install-artifact.sh \
#     --kernel stackpanel-0.3.0-kernel-linux-x64.tar.zst \
#     --migrate stackpanel-0.3.0-migrate-linux-x64.tar.zst \
#     --runner stackpanel-upgrade.mjs \
#     [--dir /opt/stackpanel] [--state-dir /var/lib/stackpanel] \
#     [--instance stackpanel] [--user stackpanel] \
#     [--skip-migrate] [--skip-systemd]
#
# 非默认 --instance 时，systemd path 单元的 PathExistsGlob 仍指向 stackpanel，
# 需改用 stackpanel-upgrade@.service 并自行编写对应 path 单元。
#
# 行为：
#   1. 校验布局与 Node 主版本，创建 /opt/stackpanel/{releases,bin} 与 /var/lib/stackpanel/{data,logs,backups,update}
#   2. 解包内核产物到 releases/<version>，原子切换 current
#   3. 安装 runner 到 /opt/stackpanel/bin（不随版本替换）
#   4. 可选：用迁移包执行一次 migrate deploy
#   5. 安装 systemd path/oneshot 单元并启用（无常驻进程）
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/opt/stackpanel"
STATE_DIR="/var/lib/stackpanel"
INSTANCE_ID="stackpanel"
SERVICE_USER="stackpanel"
KERNEL_PACK=""
MIGRATE_PACK=""
RUNNER_PACK=""
SKIP_MIGRATE=0
SKIP_SYSTEMD=0

info() { printf '\033[1;36m[stackpanel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[stackpanel]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[stackpanel]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kernel) KERNEL_PACK="${2:-}"; shift 2 ;;
    --migrate) MIGRATE_PACK="${2:-}"; shift 2 ;;
    --runner) RUNNER_PACK="${2:-}"; shift 2 ;;
    --dir) INSTALL_ROOT="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --instance) INSTANCE_ID="${2:-}"; shift 2 ;;
    --user) SERVICE_USER="${2:-}"; shift 2 ;;
    --skip-migrate) SKIP_MIGRATE=1; shift ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

[[ -n "${KERNEL_PACK}" ]] || fail "缺少 --kernel <tar.zst>"
[[ -f "${KERNEL_PACK}" ]] || fail "内核产物不存在：${KERNEL_PACK}"
[[ -n "${RUNNER_PACK}" ]] || fail "缺少 --runner <stackpanel-upgrade.mjs>"

command -v node >/dev/null 2>&1 || fail "未找到 node（需要 Node 22+）"
command -v tar >/dev/null 2>&1 || fail "未找到 tar"
command -v zstd >/dev/null 2>&1 || fail "未找到 zstd（解包 .tar.zst 需要）"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[[ "${NODE_MAJOR}" -ge 22 ]] || fail "需要 Node.js 22+，当前为 $(node -v)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# ---- 1. 目录与权限 -----------------------------------------------------------
install -d -m 0755 "${INSTALL_ROOT}" "${INSTALL_ROOT}/releases" "${INSTALL_ROOT}/bin" "${INSTALL_ROOT}/.staging"
install -d -m 0750 "${STATE_DIR}" "${STATE_DIR}/data" "${STATE_DIR}/logs" "${STATE_DIR}/backups" \
  "${STATE_DIR}/update" "${STATE_DIR}/update/inbox/${INSTANCE_ID}" \
  "${STATE_DIR}/update/claimed/${INSTANCE_ID}" "${STATE_DIR}/update/results/${INSTANCE_ID}" \
  "${STATE_DIR}/update/downloads" "${STATE_DIR}/update/work"

# 解包到与 releases/ 同文件系统的暂存目录：rename 才是原子的，跨文件系统 mv 不是。
STAGING="${INSTALL_ROOT}/.staging/unpack-$$"
rm -rf "${STAGING}"
mkdir -p "${STAGING}"
info "解包内核产物（${KERNEL_PACK}）…"
tar --zstd -xf "${KERNEL_PACK}" -C "${STAGING}" --no-same-owner --no-same-permissions
[[ -f "${STAGING}/RELEASE.json" ]] || fail "产物缺少 RELEASE.json"
VERSION="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.version)' "${STAGING}/RELEASE.json")"
PKG_NODE_MAJOR="$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.nodeMajor))' "${STAGING}/RELEASE.json")"
[[ "${PKG_NODE_MAJOR}" == "${NODE_MAJOR}" ]] || fail "产物要求 Node ${PKG_NODE_MAJOR}，当前为 ${NODE_MAJOR}"
info "内核版本 ${VERSION}（Node ${NODE_MAJOR}）"

# ---- 2. 落版本目录并原子切换 current -----------------------------------------
RELEASE_DIR="${INSTALL_ROOT}/releases/${VERSION}"
rm -rf "${RELEASE_DIR}"
mv "${STAGING}" "${RELEASE_DIR}"
chmod 0755 "${RELEASE_DIR}"

info "原子切换 current -> releases/${VERSION}"
# `ln -sfn` 是「先删后建」，中断会留下无 current 的状态（ADR-0025 决策 3）。
ln -s "${RELEASE_DIR}" "${INSTALL_ROOT}/.current.tmp.$$"
node -e "require('node:fs').renameSync(process.argv[1], process.argv[2])" \
  "${INSTALL_ROOT}/.current.tmp.$$" "${INSTALL_ROOT}/current"

if id "${SERVICE_USER}" >/dev/null 2>&1; then
  # 用户的主组不一定与用户名同名（macOS / 自定义 group）；只指定用户，让系统取主组。
  chown -R "${SERVICE_USER}" "${INSTALL_ROOT}" "${STATE_DIR}"
else
  warn "用户 ${SERVICE_USER} 不存在：请先创建并授予 ${INSTALL_ROOT} / ${STATE_DIR} 权限"
fi

# ---- 3. runner（版本目录之外） ------------------------------------------------
info "安装 runner 到 ${INSTALL_ROOT}/bin…"
install -m 0755 "${RUNNER_PACK}" "${INSTALL_ROOT}/bin/stackpanel-upgrade.mjs"
cat > "${INSTALL_ROOT}/bin/stackpanel-upgrade" <<'EOF'
#!/bin/sh
# StackPanel 产物载体升级执行者（不随内核版本替换）。
exec ${STACKPANEL_NODE:-node} "$(dirname "$0")/stackpanel-upgrade.mjs" "$@"
EOF
chmod 0755 "${INSTALL_ROOT}/bin/stackpanel-upgrade"

# ---- 4. 首次迁移（显式，不再由 API 启动时自动执行） --------------------------
if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  [[ -n "${MIGRATE_PACK}" ]] || fail "首次安装需要 --migrate <tar.zst>（或用 --skip-migrate）"
  [[ -f "${MIGRATE_PACK}" ]] || fail "迁移产物不存在：${MIGRATE_PACK}"
  info "解包并执行迁移…"
  mkdir -p "${TMP}/migrate"
  tar --zstd -xf "${MIGRATE_PACK}" -C "${TMP}/migrate" --no-same-owner --no-same-permissions
  ( cd "${TMP}/migrate" && node migrate.mjs )
fi

# ---- 5. systemd 单元（path + oneshot，无常驻进程） ---------------------------
if [[ "$SKIP_SYSTEMD" -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
  info "安装 systemd 单元…"
  # systemd 单元随内核产物一起发布：目标机可能没有源码树，因此优先用
  # `releases/<version>/deploy`，只有本地联调才回退到脚本所在仓库。
  UNIT_SRC="${RELEASE_DIR}/deploy/systemd"
  [[ -d "${UNIT_SRC}" ]] || UNIT_SRC="${ROOT_DIR}/deploy/systemd"
  [[ -d "${UNIT_SRC}" ]] || fail "找不到 systemd 单元（产物内与仓库里都没有 deploy/systemd）"
  install -d -m 0755 /etc/stackpanel
  [[ -f /etc/stackpanel/upgrade.env ]] || install -m 0640 \
    "${UNIT_SRC}/upgrade.env.example" /etc/stackpanel/upgrade.env
  install -m 0644 "${UNIT_SRC}/stackpanel-upgrade.service" /etc/systemd/system/
  install -m 0644 "${UNIT_SRC}/stackpanel-upgrade.path" /etc/systemd/system/
  install -m 0644 "${UNIT_SRC}/stackpanel-upgrade@.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now stackpanel-upgrade.path
  info "已启用 stackpanel-upgrade.path（监听 ${STATE_DIR}/update/inbox/${INSTANCE_ID}）"
else
  warn "跳过 systemd 安装；请手工安装 deploy/systemd/*.service 与 *.path"
fi

info "完成。数据目录 ${STATE_DIR}/data，日志 ${STATE_DIR}/logs，版本 ${RELEASE_DIR}"
info "启动业务进程：按 ${RELEASE_DIR}/ecosystem.config.cjs 执行 pm2 start（与 runner 同用户、同 PM2_HOME）"
