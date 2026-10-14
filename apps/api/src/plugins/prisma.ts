import { createPrismaClient } from '@stackpanel/db';
import type { PrismaClient } from '@stackpanel/db';
import { resolveStackPanelDataDir, resolveStackPanelDatabaseUrl } from '@stackpanel/sdk/paths';
import { env } from '../config/env.ts';

let prisma: PrismaClient | null = null;

/**
 * Name this process in Postgres so `pg_stat_activity` can attribute pool usage
 * to the API vs the worker. Both entry points build the same `PluginContext`,
 * so the role has to come from the entry file the runtime was started with.
 */
function processRole(): string {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('worker.js') ? 'stackpanel-worker' : 'stackpanel-api';
}

/** Lazily-created singleton Prisma client (per process). */
export function getPrisma(): PrismaClient {
  if (!prisma) {
    // Anchor `file:`-relative DSNs to the canonical data directory so the
    // database location never depends on the process working directory.
    const connectionString = resolveStackPanelDatabaseUrl(
      env.DATABASE_URL,
      resolveStackPanelDataDir(),
    );
    prisma = createPrismaClient(connectionString, {
      max: env.DATABASE_POOL_MAX,
      connectionTimeoutMillis: env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      statementTimeoutMillis: env.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName: processRole(),
    });
  }
  return prisma;
}
