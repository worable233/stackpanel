import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The generated `ecosystem.config.cjs` is the only place that decides which
 * processes run and what each of them can see (BOOTSTRAP-R2/R7). It cannot be
 * unit-tested through TypeScript, so these tests generate the real artifact from
 * the build script and import it.
 *
 * Pinned properties:
 * - worker exists only from `starting` onwards (no crash loops before migration);
 * - `starting` already runs the normal API (config was promoted);
 * - the web process never receives database/redis/storage secrets;
 * - `STACKPANEL_BOOTSTRAP_STATE` matches what the API uses to pick its entry.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../../../scripts/release/build-kernel-artifact.mjs');

function ecosystemFactory(): (input: { version: string }) => string {
  const source = readFileSync(scriptPath, 'utf8');
  const start = source.indexOf('function ecosystemConfig');
  const end = source.indexOf('function releaseJson', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${source.slice(start, end)}; return ecosystemConfig;`,
  )() as (input: { version: string }) => string;
}

type App = { name: string; env: Record<string, string> };

async function load(phase: string, env: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), `sp-eco-${phase}-`));
  await mkdir(path.join(dir, 'bootstrap'), { recursive: true });
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await mkdir(path.join(dir, 'logs'), { recursive: true });
  await writeFile(
    path.join(dir, 'bootstrap', 'state.json'),
    JSON.stringify({ version: 1, phase }),
    'utf8',
  );
  const entries: Record<string, string> = {
    STACKPANEL_DATA_DIR: path.join(dir, 'data'),
    STACKPANEL_STATE_DIR: dir,
    STACKPANEL_LOG_DIR: path.join(dir, 'logs'),
    JWT_SECRET: 'jwt-secret',
    SETTINGS_ENCRYPTION_KEY: 'encryption-key',
    STACKPANEL_SETUP_TOKEN: 'setup-token',
    DATABASE_URL: 'postgresql://u:p#frag@h:5432/db',
    ...env,
  };
  await writeFile(
    path.join(dir, 'stackpanel.env'),
    Object.entries(entries)
      .map(([key, value]) => `${key}="${value}"`)
      .join('\n') + '\n',
    'utf8',
  );

  const configPath = path.join(dir, 'ecosystem.config.cjs');
  await writeFile(configPath, ecosystemFactory()({ version: '0.0.0-test' }), 'utf8');

  process.env.STACKPANEL_STATE_DIR = dir;
  process.env.STACKPANEL_DATA_DIR = path.join(dir, 'data');
  try {
    const mod = (await import(`${configPath}?v=${Date.now()}`)) as {
      default?: { apps?: App[] };
      apps?: App[];
    };
    return mod.default?.apps ?? mod.apps ?? [];
  } finally {
    delete process.env.STACKPANEL_STATE_DIR;
    delete process.env.STACKPANEL_DATA_DIR;
  }
}

function app(list: App[], name: string): App | undefined {
  return list.find((entry) => entry.name === name);
}

describe('generated ecosystem', () => {
  it('runs only api + web before the config is promoted', async () => {
    for (const phase of ['needs_infra', 'validating', 'queued', 'migrating', 'migration_failed']) {
      const apps = await load(phase);
      expect(apps.map((entry) => entry.name), phase).toEqual([
        'stackpanel-api',
        'stackpanel-web',
      ]);
      expect(app(apps, 'stackpanel-api')?.env['STACKPANEL_BOOTSTRAP_STATE'], phase).toBe(
        'provision',
      );
    }
  });

  it('adds the worker as soon as the migration succeeded', async () => {
    for (const phase of ['starting', 'needs_admin', 'complete']) {
      const apps = await load(phase);
      expect(apps.map((entry) => entry.name), phase).toContain('stackpanel-worker');
      // `starting` is still "not ready", but the config is already promoted, so
      // the API must be the normal app rather than the provision app.
      expect(app(apps, 'stackpanel-api')?.env['STACKPANEL_BOOTSTRAP_STATE'], phase).toBe(
        'configured',
      );
    }
  });

  it('never gives credentials to the web process', async () => {
    for (const phase of ['needs_infra', 'needs_admin', 'complete']) {
      const web = app(await load(phase), 'stackpanel-web');
      expect(web, phase).toBeDefined();
      const env = web?.env ?? {};
      for (const key of [
        'DATABASE_URL',
        'REDIS_URL',
        'JWT_SECRET',
        'SETTINGS_ENCRYPTION_KEY',
        'STACKPANEL_SETUP_TOKEN',
        'STORAGE_S3_SECRET_ACCESS_KEY',
        'STORAGE_S3_ACCESS_KEY_ID',
      ]) {
        expect(env[key], `${phase} ${key}`).toBeUndefined();
      }
      // But it does need to know which UI to render and where the BFF lives.
      expect(env['STACKPANEL_BOOTSTRAP_STATE']).toBeDefined();
      expect(env['API_BASE_URL']).toBeDefined();
    }
  });

  it('gives the API the infrastructure keys verbatim', async () => {
    const api = app(await load('needs_infra'), 'stackpanel-api');
    // '#' inside a password must survive the generated parser untouched.
    expect(api?.env['DATABASE_URL']).toBe('postgresql://u:p#frag@h:5432/db');
    expect(api?.env['JWT_SECRET']).toBe('jwt-secret');
    expect(api?.env['STACKPANEL_SETUP_TOKEN']).toBe('setup-token');
  });

  it('binds the web port from the deployment env instead of hardcoding it', async () => {
    const web = app(await load('complete', { PORT: '8080', HOSTNAME_BIND: '127.0.0.1' }), 'stackpanel-web');
    expect(web?.env['PORT']).toBe('8080');
    // `HOSTNAME_BIND` is the deployment knob; `HOSTNAME` is what Next reads.
    expect(web?.env['HOSTNAME']).toBe('127.0.0.1');
  });

  it('treats a missing or corrupt state file as "already installed"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-eco-missing-'));
    await mkdir(path.join(dir, 'bootstrap'), { recursive: true });
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await mkdir(path.join(dir, 'logs'), { recursive: true });
    await writeFile(
      path.join(dir, 'stackpanel.env'),
      [
        `STACKPANEL_DATA_DIR="${path.join(dir, 'data')}"`,
        `STACKPANEL_STATE_DIR="${dir}"`,
        `STACKPANEL_LOG_DIR="${path.join(dir, 'logs')}"`,
        'JWT_SECRET="j"',
        '',
      ].join('\n'),
      'utf8',
    );
    const configPath = path.join(dir, 'ecosystem.config.cjs');
    await writeFile(configPath, ecosystemFactory()({ version: '0.0.0-test' }), 'utf8');

    process.env.STACKPANEL_STATE_DIR = dir;
    try {
      const mod = (await import(`${configPath}?v=${Date.now()}`)) as {
        default?: { apps?: App[] };
      };
      const apps = mod.default?.apps ?? [];
      // Fail open towards the *normal* app: a broken state file must never
      // resurrect the writable provision surface on a running instance.
      expect(app(apps, 'stackpanel-api')?.env['STACKPANEL_BOOTSTRAP_STATE']).toBe('configured');
      expect(apps.map((entry) => entry.name)).toContain('stackpanel-worker');
    } finally {
      delete process.env.STACKPANEL_STATE_DIR;
    }
  });
});
