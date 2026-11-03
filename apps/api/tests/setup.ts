// Hermetic test environment: provide env vars before modules import config/env.ts.
// Keeps the suite independent of any local .env file (CI-safe).
// PostgreSQL is required; the test database is dropped and recreated per run.
process.env.JWT_SECRET ??= 'test_jwt_secret_at_least_32_chars_0123456789';
process.env.SETTINGS_ENCRYPTION_KEY ??= 'test_settings_key_at_least_32_chars_0123456789';
process.env.API_HOST ??= '127.0.0.1';
process.env.API_PORT ??= '3001';
process.env.API_LOG_LEVEL ??= 'silent';
process.env.AGENT_PUBLIC_ORIGIN ??= 'https://api.stackpanel.test';
process.env.AGENT_WEB_ORIGIN ??= 'https://web.stackpanel.test';
// Auth integration tests exercise both verified and unverified registration.
// Keep the process-wide parsed config aligned with the verification suite.
process.env.AUTH_EMAIL_VERIFICATION ??= 'required';
process.env.AUTH_CAPTCHA_MODE ??= 'off';
process.env.AUTH_CODE_SEND_PER_HOUR ??= '0';
process.env.AUTH_CODE_SEND_PER_HOUR_PER_IP ??= '0';
// Off by default so unrelated suites can re-request a code; the cooldown has its
// own suite (`register-code-cooldown.test.ts`) that turns it on.
process.env.AUTH_CODE_SEND_COOLDOWN_SECONDS ??= '0';
// Integration tests log in repeatedly from the same loopback IP; the login
// plugin's default 5/min would trip them. Tests disable the limiter.
process.env.LOGIN_RATE_LIMIT_MAX ??= '0';
process.env.REGISTER_RATE_LIMIT_MAX ??= '0';
// The kernel ships a default remote catalog source; tests must stay hermetic and
// never dial GitHub. `off` keeps the market on local sources only.
process.env.DISTRIBUTION_CATALOG_REPOSITORY ??= 'off';
// CONTRACT-SEC / H2 adds rate limits to credential / admin-write routes. The
// integration suite drives all of them from one loopback IP, so raise every
// fixed-window ceiling high enough that legit traffic is never throttled; the
// dedicated limiter test registers its own tightly-bound probe route instead.
process.env.API_RATE_LIMIT_MULTIPLIER ??= '1000';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll } from 'vitest';

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
// Connect Redis inside a hook, not at module evaluation time.
//
// `tests/setup.ts` runs *before* each test file's own top-level code. Importing
// `infra.ts` here would pull in `config/env.ts`, which parses and freezes the
// environment at import time — so a test file that sets `process.env.X` at the
// top (the documented pattern for the setup-wizard suites) would silently have
// no effect, but only when `REDIS_URL` is set. That is exactly the discrepancy
// between a local run (no Redis) and CI (Redis service attached).
if (process.env.REDIS_URL) {
  beforeAll(async () => {
    const { initRedis } = await import('../src/infra.ts');
    try {
      await initRedis();
    } catch {
      // Leave Redis uninitialised; getRedis() will fall back to memory.
    }
  });
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
// before DATABASE_URL is set).
//
// **Cross-process**, not just cross-file. The `globalThis` guard below only
// covers one process, and vitest's default `isolate: true` runs **every test
// file in a fresh worker process** — so each of ~190 files re-ran this block,
// DROPping the database the previous file was still using. Symptoms were
// `The table public.users does not exist` / `Database "stackpanel_test" does not
// exist` on unrelated suites, and they got *worse* with `--no-file-parallelism`
// (that flag serialises files, it does not stop isolation). Two changes:
//
//   1. An exclusive advisory lock (`pg_advisory_lock`) held across
//      DROP+CREATE+migrate, so concurrent processes queue instead of racing.
//   2. A readiness marker in the database itself (`_sp_test_ready`): once one
//      process has migrated, later processes skip the destructive step entirely.
//      That makes the whole run O(1) recreations instead of O(files), and the
//      migration is no longer the 5-minute bottleneck of a serial run.
if (!(globalThis as { __spTestMigrated?: boolean }).__spTestMigrated) {
  (globalThis as { __spTestMigrated?: boolean }).__spTestMigrated = true;

  const { Client } = await import('pg');
  const dbName = databaseName(TEST_DATABASE_URL);
  const admin = new Client({ connectionString: maintenanceUrl(TEST_DATABASE_URL) });
  await admin.connect();
  try {
    // Arbitrary but stable: any constant works as long as every process uses it.
    const LOCK_KEY = 4_120_198_501;
    // Wait indefinitely: the holder is another test worker doing DROP+migrate,
    // which is bounded work. Timing out here would turn a slow machine into a
    // spurious failure.
    await admin.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    // Already prepared by an earlier worker in this run? Two separate facts:
    //   1. does the database exist (`pg_database` is cluster-wide, so the admin
    //      connection can answer this);
    //   2. does it carry the readiness marker — this MUST be asked **inside**
    //      the test database. `to_regclass` resolves against the current
    //      database, and the admin connection is attached to `postgres`; asking
    //      there always answers `null`, so every worker concluded "not ready"
    //      and dropped the database out from under the others. That is what made
    //      a full `pnpm test` fail 100% of files while a single file passed.
    //
    // **The default is "already ready".** Recreating is destructive and only
    // safe when we can positively prove the schema is missing; a probe that
    // merely *failed* (connection reset because another worker terminated our
    // backend, transient socket error) must never be read as "wipe it".
    const exists = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1 AND datallowconn`,
      [dbName],
    );
    let needsRebuild = exists.rowCount !== 1;
    let markerExists = false;
    if (!needsRebuild) {
      const probe = new Client({ connectionString: TEST_DATABASE_URL });
      try {
        await probe.connect();
        const marker = await probe.query(
          `SELECT to_regclass('public._sp_test_ready') IS NOT NULL AS present`,
        );
        markerExists = marker.rows[0]?.present === true;
      } catch {
        // 探测失败 ≠ 需要重建。库就在那儿（上面刚确认过），只是这一下连不上；
        // 重建会把其它 worker 正在用的库删掉，代价远高于偶尔跑一次迁移。
        markerExists = true;
      } finally {
        await probe.end().catch(() => {});
      }
    }

    if (needsRebuild) {
      // Terminate lingering connections so DROP DATABASE does not hang.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.query(`CREATE DATABASE "${dbName}"`);
      markerExists = false;
    }

    // **Migrations run on every pass, marker or not.**
    //
    // The marker exists to skip the *destructive* DROP+CREATE, and it is correct
    // for that. But it was also skipping `migrate deploy`, which meant a newly
    // added migration file was never applied to the test database: the marker
    // table survived from an earlier run, so every subsequent run reported
    // "already ready" and the schema silently stayed one revision behind. The
    // symptom is a `PrismaClientValidationError: Unknown argument …` on a column
    // that plainly exists in `schema.prisma` — and a *single-file* run passes,
    // because it hits the same stale marker. `migrate deploy` is idempotent and
    // reads `_prisma_migrations`; when nothing is pending it costs one round-trip.
    execSync('pnpm --filter @stackpanel/db migrate:deploy', {
      cwd: rootDir,
      stdio: 'ignore',
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    });

    if (!markerExists) {
      const marker = new Client({ connectionString: TEST_DATABASE_URL });
      await marker.connect();
      try {
        await marker.query('CREATE TABLE IF NOT EXISTS _sp_test_ready (at timestamptz NOT NULL)');
        await marker.query('INSERT INTO _sp_test_ready (at) VALUES (now())');
      } finally {
        await marker.end();
      }
    }
  } finally {
    // Session-level locks are released by disconnect, but be explicit: this
    // client is reused for the marker check above.
    await admin.query('SELECT pg_advisory_unlock($1)', [4_120_198_501]).catch(() => {});
    await admin.end();
  }
}

// ---- Non-builtin test plugins ---------------------------------------------
// The API seeds built-in plugins at boot (login, store, store-product-card,
// store-product-server, store-wallet). No extra plugin bundles are pre-installed
// here: suites that need a plugin install it into their own temp data dir (see
// integration/plugins.test.ts and integration/plugin-dispatch.test.ts).

// ---- Cross-file module cache reset ----------------------------------------
// Two module-level caches hold distribution state for the whole process:
// `distribution/runtime.ts` (the refresh singleton) and
// `distribution/source-config.ts` (the resolved source config). A suite that
// pins a coordinator via `setCatalogRefreshForTest()` or saves a
// `distribution.catalogSource` row leaves both behind, so the *next* file can
// see a configured catalog even though its own env says `off` — the exact cause
// of the flaky 「目录未配置」 assertion in integration/market.test.ts.
//
// Resetting after each **file** (afterAll, not afterEach) keeps a file's own
// `beforeAll` pin intact while making files independent.
afterAll(async () => {
  const [{ resetCatalogRefreshForTest }, { resetCatalogSourceConfigForTest }] = await Promise.all([
    import('../src/distribution/runtime.ts'),
    import('../src/distribution/source-config.ts'),
  ]);
  resetCatalogRefreshForTest();
  resetCatalogSourceConfigForTest();
});
