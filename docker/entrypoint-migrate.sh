#!/bin/sh
set -e

# One-shot schema migration (ADR-0025).
#
# Runs `prisma migrate deploy` exactly once per upgrade, before the new api /
# worker / web containers start. It is deliberately a separate service with
# `restart: "no"`: a failed migration must fail the upgrade, not crash-loop and
# leave half the stack running on an unknown schema.
#
# The API entrypoint no longer migrates on boot — N replicas racing the same
# `_prisma_migrations` table is not a migration strategy.

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

exec pnpm --filter @stackpanel/db migrate:deploy
