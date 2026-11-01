#!/bin/sh
set -e

# Background worker (S6 / ADR-0013): consumes the BullMQ queue and runs kernel
# sweeps + plugin jobs. It owns no HTTP port and does not run migrations — the
# api entrypoint already applies them. It does need the same plugin data
# (`STACKPANEL_DATA_DIR`) and Redis/DB as the API.
# 源码映射：`dist/` 里带 13 MB 的 `.map`（见 Dockerfile 的 STACKPANEL_SOURCE_MAPS）。
# 不启用的话生产堆栈只有 `bowser-KGNXATBQ.js:1:2`，那些 map 是纯体积。
# 放在这里而不是 `ENV NODE_OPTIONS`：compose 会显式设 NODE_OPTIONS（内存上限），
# 覆盖 Dockerfile 的 ENV；而且这也不希望传染给 `pg_dump` 之类子进程。
if [ -f /app/apps/api/dist/server.js.map ] || [ -f /app/apps/api/dist/worker.js.map ]; then
  NODE_OPTIONS="${NODE_OPTIONS:-} --enable-source-maps"
  export NODE_OPTIONS
fi

exec node apps/api/dist/worker.js
