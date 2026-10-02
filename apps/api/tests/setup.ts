// Hermetic test environment: provide env vars before modules import config/env.ts.
// Keeps the suite independent of any local .env file (CI-safe).
// PostgreSQL is required; the test database is dropped and recreated per run.
process.env.JWT_SECRET ??= 'test_jwt_secret_at_least_32_chars_0123456789';
process.env.SETTINGS_ENCRYPTION_KEY ??= 'test_settings_key_at_least_32_chars_0123456789';
process.env.API_HOST ??= '127.0.0.1';
process.env.API_PORT ??= '3001';
process.env.API_LOG_LEVEL ??= 'silent';
// Integration tests log in repeatedly from the same loopback IP; the login
// plugin's default 5/min would trip them. Tests disable the limiter.
process.env.LOGIN_RATE_LIMIT_MAX ??= '0';
process.env.REGISTER_RATE_LIMIT_MAX ??= '0';
// CONTRACT-SEC / H2 adds rate limits to credential / admin-write routes. The
// integration suite drives all of them from one loopback IP, so raise every
// fixed-window ceiling high enough that legit traffic is never throttled; the
// dedicated limiter test registers its own tightly-bound probe route instead.
process.env.API_RATE_LIMIT_MULTIPLIER ??= '1000';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');
const appsApiDir = path.resolve(rootDir, 'apps/api');

/**
 * Test database connection string. Override with `TEST_DATABASE_URL`; otherwise
 * defaults to a `stackpanel_test` database on the local PostgreSQL.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://stackpanel:stackpanel@127.0.0.1:5432/stackpanel_test';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.STACKPANEL_DATA_DIR ??= path.join(appsApiDir, 'data');

// When a Redis URL is supplied (cluster-oriented runs), connect it up-front so
// the app uses the shared Redis session + rate-limit stores instead of the
// in-process fallbacks. Without it, tests stay hermetic and use memory.
if (process.env.REDIS_URL) {
  const { initRedis } = await import('../src/infra.ts');
  try {
    await initRedis();
  } catch {
    // Leave Redis uninitialised; getRedis() will fall back to memory.
  }
}

/** Build a URL for the maintenance database (`postgres`) so we can drop/create. */
function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

// ---- Recreate the test database, then apply migrations --------------------
// Uses a raw `pg` connection (dynamic import so config/env.ts is not pulled in
// before DATABASE_URL is set). Runs once per test process.
if (!(globalThis as { __spTestMigrated?: boolean }).__spTestMigrated) {
  (globalThis as { __spTestMigrated?: boolean }).__spTestMigrated = true;

  const { Client } = await import('pg');
  const dbName = databaseName(TEST_DATABASE_URL);
  const admin = new Client({ connectionString: maintenanceUrl(TEST_DATABASE_URL) });
  await admin.connect();
  try {
    // Terminate lingering connections so DROP DATABASE does not hang.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  execSync('pnpm --filter @stackpanel/db migrate:deploy', {
    cwd: rootDir,
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}

// ---- Non-builtin test plugins ---------------------------------------------
// The API seeds built-in plugins at boot (login, store, store-product-card,
// store-product-server, store-wallet). No extra plugin bundles are pre-installed
// here: suites that need a plugin install it into their own temp data dir (see
// integration/plugins.test.ts and integration/plugin-dispatch.test.ts).
