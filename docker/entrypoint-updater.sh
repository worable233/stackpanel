#!/bin/sh
# updater 独立镜像入口（PLAN-github-distribution-and-updates §5.1）。
#
# 唯一持有 Docker socket 的进程；只操作绑定的 Compose project。启动前校验绑定配置，
# 缺配置即拒绝启动（不误操作宿主）。
set -e

if [ -z "${UPDATER_STATE_DIR}" ]; then
  echo "[updater] 缺少 UPDATER_STATE_DIR：拒绝启动" >&2
  exit 1
fi
if [ -z "${UPDATER_COMPOSE_PROJECT}" ]; then
  echo "[updater] 缺少 UPDATER_COMPOSE_PROJECT：拒绝启动" >&2
  exit 1
fi

mkdir -p "${UPDATER_STATE_DIR}"

# 预构建镜像：直接运行已编译产物，不做任何构建。
exec node /app/apps/updater/dist/main.js
