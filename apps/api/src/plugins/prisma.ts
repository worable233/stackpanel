import { createPrismaClient } from '@stackpanel/db';
import type { PrismaClient } from '@stackpanel/db';
import { resolveStackPanelDataDir, resolveStackPanelDatabaseUrl } from '@stackpanel/sdk/paths';
import { env } from '../config/env.ts';

let prisma: PrismaClient | null = null;

/** Lazily-created singleton Prisma client (per process). */
export function getPrisma(): PrismaClient {
  if (!prisma) {
    // Anchor `file:`-relative DSNs to the canonical data directory so the
    // database location never depends on the process working directory.
    const connectionString = resolveStackPanelDatabaseUrl(
      env.DATABASE_URL,
      resolveStackPanelDataDir(),
    );
    prisma = createPrismaClient(connectionString);
  }
  return prisma;
}
