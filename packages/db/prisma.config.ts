import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';
import { resolveStackPanelDataDir, resolveStackPanelDatabaseUrl } from '@stackpanel/sdk/paths';

// Load the repo-root .env so `prisma migrate` works from this package.
dotenv.config({ path: '../../.env' });

// Anchor `file:`-relative DSNs to the canonical data directory so the Prisma
// CLI and the API resolve the same database regardless of working directory.
const databaseUrl = process.env.DATABASE_URL
  ? resolveStackPanelDatabaseUrl(process.env.DATABASE_URL, resolveStackPanelDataDir())
  : undefined;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    ...(databaseUrl ? { url: databaseUrl } : {}),
  },
});
