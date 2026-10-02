#!/bin/sh
set -e

# PostgreSQL is the only supported engine (ADR-0019). Retry until it accepts
# connections, then apply migrations. Idempotent; safe on every container start.
attempt=0
until pnpm --filter @stackpanel/db migrate:deploy; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL 未就绪或迁移失败：已重试 ${attempt} 次，请检查 DATABASE_URL 与数据库容器。" >&2
    exit 1
  fi
  echo "等待 PostgreSQL 就绪… (${attempt}/30)" >&2
  sleep 2
done

exec node apps/api/dist/server.js
