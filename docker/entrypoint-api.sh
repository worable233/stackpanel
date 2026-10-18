#!/bin/sh
set -e

# API tier.
#
# Since ADR-0025 this process no longer applies migrations. Kernel upgrades run
# the dedicated `migrate` artifact exactly once, inside the upgrade window,
# before the new version is started (`docker compose run --rm migrate` or the
# systemd runner). Applying them here meant every replica raced the same
# `_prisma_migrations` table on boot, and a failed migration surfaced as a
# crash-loop instead of a failed upgrade that could be rolled back.
#
# The entrypoint still waits for PostgreSQL: the API cannot serve `/ready`
# without it, and a bounded wait produces a clear error instead of a fast
# restart loop.
attempt=0
until node -e '
const net = require("node:net");
const url = new URL(process.env.DATABASE_URL);
const port = Number(url.port || 5432);
const socket = net.connect({ host: url.hostname, port });
socket.setTimeout(2000);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("timeout", () => { socket.destroy(); process.exit(1); });
socket.on("error", () => process.exit(1));
'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL 未就绪：已重试 ${attempt} 次，请检查 DATABASE_URL 与数据库容器。" >&2
    exit 1
  fi
  echo "等待 PostgreSQL 就绪… (${attempt}/30)" >&2
  sleep 2
done

exec node apps/api/dist/server.js
