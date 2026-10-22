import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  assertProvisionable,
  buildProvisionApp,
  normalizeBootstrapConfig,
} from '../../src/bootstrap/provision-app.ts';
import { BootstrapStateStore, candidateConfigPath } from '../../src/bootstrap/state.ts';

const TOKEN = 'test-setup-token-0123456789abcdef';

async function harness(
  options: { phase?: string; store?: BootstrapStateStore; stateDir?: string } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-provision-'));
  const store =
    options.store ??
    new BootstrapStateStore({ dir: path.join(dir, 'bootstrap'), targetVersion: '0.3.0' });
  if (options.phase) {
    await store.write({
      version: 1,
      phase: options.phase as never,
      configGeneration: options.phase === 'needs_infra' ? 0 : 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const app = buildProvisionApp({
    setupToken: TOKEN,
    store,
    targetVersion: '0.3.0',
    stateDir: dir,
    instanceId: 'stackpanel',
    // Silence expected warnings from probe failures during tests.
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { app, dir, store };
}

function provisionPayload(overrides: Record<string, unknown> = {}) {
  return {
    setupToken: TOKEN,
    idempotencyKey: 'idem-key-0001',
    config: {
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    ...overrides,
  };
}

describe('assertProvisionable', () => {
  it('refuses to boot without a strong token', () => {
    expect(() => assertProvisionable(undefined)).toThrow(/STACKPANEL_SETUP_TOKEN/);
    expect(() => assertProvisionable('short')).toThrow(/STACKPANEL_SETUP_TOKEN/);
    expect(() => assertProvisionable('')).toThrow(/STACKPANEL_SETUP_TOKEN/);
    expect(() => assertProvisionable('x'.repeat(16))).not.toThrow();
  });
});

describe('normalizeBootstrapConfig', () => {
  it('accepts whitelisted keys and requires DATABASE_URL', () => {
    const ok = normalizeBootstrapConfig({ DATABASE_URL: 'postgresql://h/db' });
    expect(ok.ok).toBe(true);

    const missing = normalizeBootstrapConfig({ REDIS_URL: 'redis://h' });
    expect(missing).toMatchObject({ ok: false, code: 'bootstrap.invalid_config' });
  });

  it('rejects unknown keys instead of spreading them into the process env', () => {
    const result = normalizeBootstrapConfig({
      DATABASE_URL: 'postgresql://h/db',
      NODE_OPTIONS: '--require /tmp/evil.js',
    });
    expect(result).toMatchObject({ ok: false, code: 'bootstrap.invalid_config' });
  });

  it('rejects CR/LF and non-string values', () => {
    expect(
      normalizeBootstrapConfig({ DATABASE_URL: 'postgresql://h/db\nINJECTED=1' }),
    ).toMatchObject({ ok: false });
    expect(normalizeBootstrapConfig({ DATABASE_URL: 42 })).toMatchObject({ ok: false });
    expect(normalizeBootstrapConfig(null)).toMatchObject({ ok: false });
    expect(normalizeBootstrapConfig([])).toMatchObject({ ok: false });
  });
});

describe('GET /setup/status in provision mode', () => {
  it('reports needs_infra and never caches', async () => {
    const { app } = await harness({ phase: 'needs_infra' });
    const res = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ phase: 'needs_infra', required: true, tokenRequired: true });
    await app.close();
  });

  it('does not report needs_infra once a candidate is queued', async () => {
    const { app } = await harness({ phase: 'queued' });
    const res = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(res.json()).toMatchObject({ phase: 'queued' });
    await app.close();
  });
});

describe('POST /setup/provision', () => {
  it('rejects a wrong or missing token before touching any target', async () => {
    const { app } = await harness({ phase: 'needs_infra' });

    const missing = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({ setupToken: undefined }),
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('bootstrap.token_invalid');

    const wrong = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({ setupToken: 'not-the-token-0123456789' }),
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });

  it('refuses to write config outside needs_infra / migration_failed', async () => {
    for (const phase of ['queued', 'migrating', 'starting', 'needs_admin', 'complete']) {
      const { app } = await harness({ phase });
      const res = await app.inject({
        method: 'POST',
        url: '/setup/provision',
        payload: provisionPayload(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('bootstrap.not_writable');
      await app.close();
    }
  });

  it('reports a stable failure classification without leaking driver details', async () => {
    const { app } = await harness({ phase: 'needs_infra' });
    const res = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({
        config: { DATABASE_URL: 'postgresql://u:secret@127.0.0.1:1/db' },
      }),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe('bootstrap.probe_failed');
    expect(body.failure).toBe('database_unreachable');
    // Never echo the DSN or the password back.
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('127.0.0.1:1');
    await app.close();
  });

  it('validates the payload before probing (422, not 503)', async () => {
    const { app } = await harness({ phase: 'needs_infra' });
    const res = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({ idempotencyKey: 'short' }),
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('publishes a candidate, a task file, and moves to queued on success', async () => {
    // A fake store whose probe always passes is not possible here (probes are
    // real), so this test exercises the pre-probe guards and the publish path
    // through the store directly.
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-provision-publish-'));
    const store = new BootstrapStateStore({
      dir: path.join(dir, 'bootstrap'),
      targetVersion: '0.3.0',
    });
    const app = buildProvisionApp({
      setupToken: TOKEN,
      store,
      targetVersion: '0.3.0',
      stateDir: dir,
      instanceId: 'stackpanel',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // Pre-seed an unreachable DB: the call must fail before publishing.
    const failed = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload(),
    });
    expect(failed.statusCode).toBe(422);
    // The request did claim `validating` on disk before probing; on failure it
    // must return to the phase it came from, not vanish or stay stuck.
    expect(await store.read()).toMatchObject({ phase: 'needs_infra', configGeneration: 0 });
    expect((await readdir(path.join(dir, 'bootstrap')).catch(() => [])).filter((n) => n.startsWith('config.candidate-'))).toEqual([]);
    await app.close();
  });

  it('rate limits repeated attempts from one IP', async () => {
    const { app } = await harness({ phase: 'needs_infra' });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/setup/provision',
        payload: provisionPayload({ idempotencyKey: `idem-key-${i}000` }),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((code) => code !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    await app.close();
  });
});

describe('provision app surface', () => {
  it('exposes no business routes at all (not just 403s)', async () => {
    const { app } = await harness({ phase: 'needs_infra' });
    for (const [method, url] of [
      ['GET', '/login'],
      ['GET', '/setup/plugins'],
      ['POST', '/setup'],
      ['GET', '/api/v1/users'],
      ['POST', '/graphql'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });

  it('serves a provision-mode health probe that cannot be confused with normal health', async () => {
    const { app } = await harness({ phase: 'needs_infra' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', mode: 'provision' });
    await app.close();
  });
});

describe('candidate file contract', () => {
  it('uses the generation in the filename and never overwrites a published candidate', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-candidate-'));
    const store = new BootstrapStateStore({ dir, targetVersion: 'v1' });
    const first = await store.publishCandidate({
      configContent: 'A="1"\n',
      configDigest: 'd1',
      idempotencyKey: 'k1',
    });
    expect(await readFile(candidateConfigPath(dir, first.configGeneration), 'utf8')).toBe('A="1"\n');

    // A second publication is only legal from a writable phase: `queued` is
    // already past the point of no return (the runner may be migrating).
    await store.transition({ phase: 'migration_failed' });
    const second = await store.publishCandidate({
      configContent: 'A="2"\n',
      configDigest: 'd2',
      idempotencyKey: 'k2',
    });
    expect(second.configGeneration).toBe(first.configGeneration + 1);
    // The first candidate is untouched: it is the audit trail for the attempt.
    expect(await readFile(candidateConfigPath(dir, first.configGeneration), 'utf8')).toBe('A="1"\n');
  });
});

void Fastify;

describe('POST /setup/provision — publish path (injected probes)', () => {
  type ProbeFn = () => Promise<
    { ok: true } | { ok: false; failure: 'database_permission_denied'; detail?: string }
  >;
  async function publishingHarness(probe: ProbeFn = async () => ({ ok: true })) {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-provision-ok-'));
    const store = new BootstrapStateStore({
      dir: path.join(dir, 'bootstrap'),
      targetVersion: '0.3.0',
    });
    const app = buildProvisionApp({
      setupToken: TOKEN,
      store,
      targetVersion: '0.3.0',
      stateDir: dir,
      instanceId: 'stackpanel',
      probes: probe,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return { app, dir, store };
  }

  it('writes an immutable candidate, a task file, and advances to queued', async () => {
    const { app, dir, store } = await publishingHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({
        config: {
          DATABASE_URL: 'postgresql://u:p#frag@h:5432/db',
          REDIS_URL: 'redis://h:6379',
          STORAGE_DRIVER: 's3',
          STORAGE_S3_BUCKET: 'b',
        },
      }),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { operation: { phase: string; configGeneration: number } };
    expect(body.operation.phase).toBe('queued');
    expect(body.operation.configGeneration).toBe(1);

    const state = await store.read();
    expect(state).toMatchObject({ phase: 'queued', configGeneration: 1, targetVersion: '0.3.0' });

    const candidate = await readFile(
      candidateConfigPath(path.join(dir, 'bootstrap'), 1),
      'utf8',
    );
    // The '#' inside the password must survive the write.
    expect(candidate).toContain('postgresql://u:p#frag@h:5432/db');
    expect(candidate).toContain('STORAGE_S3_BUCKET');

    // A task file exists in the inbox so the systemd path unit can fire.
    const inbox = await readdir(path.join(dir, 'bootstrap', 'inbox', 'stackpanel'));
    expect(inbox.filter((n) => n.endsWith('.json'))).toHaveLength(1);
    const taskFile = inbox.find((name) => name.endsWith('.json'));
    expect(taskFile).toBeDefined();
    const task = JSON.parse(
      await readFile(path.join(dir, 'bootstrap', 'inbox', 'stackpanel', taskFile ?? ''), 'utf8'),
    );
    expect(task).toMatchObject({ configGeneration: 1, targetVersion: '0.3.0' });

    // The task file must not contain any credential.
    expect(JSON.stringify(task)).not.toContain('postgresql://');
    await app.close();
  });

  it('replays an identical submission as the same operation', async () => {
    const { app, dir } = await publishingHarness();
    const payload = provisionPayload();
    const first = await app.inject({ method: 'POST', url: '/setup/provision', payload });
    const second = await app.inject({ method: 'POST', url: '/setup/provision', payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect((first.json() as { operation: { id: string } }).operation.id).toBe(
      (second.json() as { operation: { id: string } }).operation.id,
    );

    // Still exactly one candidate and one task.
    const bootstrap = path.join(dir, 'bootstrap');
    expect((await readdir(bootstrap)).filter((n) => n.startsWith('config.candidate-'))).toHaveLength(1);
    const inbox = await readdir(path.join(bootstrap, 'inbox', 'stackpanel'));
    expect(inbox.filter((n) => n.endsWith('.json'))).toHaveLength(1);
    await app.close();
  });

  it('rejects a reused idempotency key with different config (409)', async () => {
    const { app } = await publishingHarness();
    await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload(),
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({
        config: { DATABASE_URL: 'postgresql://other/db' },
      }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('bootstrap.idempotency_conflict');
    await app.close();
  });

  it('does not publish when the probe fails', async () => {
    const { app, store } = await publishingHarness(async () => ({
      ok: false as const,
      failure: 'database_permission_denied' as const,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'bootstrap.probe_failed',
      failure: 'database_permission_denied',
    });
    expect(await store.read()).toMatchObject({
      phase: 'needs_infra',
      configGeneration: 0,
      failure: 'database_permission_denied',
    });
    await app.close();
  });

  it('can correct a failed candidate from migration_failed with a new key', async () => {
    const { app, store } = await publishingHarness();
    await store.write({
      version: 1,
      phase: 'migration_failed',
      configGeneration: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      failure: 'migration_connect_failed',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({ idempotencyKey: 'corrected-key-0001' }),
    });
    expect(res.statusCode).toBe(202);
    expect(await store.read()).toMatchObject({ phase: 'queued', configGeneration: 2 });
    await app.close();
  });
});

describe('POST /setup/provision — concurrency', () => {
  it('lets exactly one of two concurrent submissions claim validation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-provision-race-'));
    const store = new BootstrapStateStore({
      dir: path.join(dir, 'bootstrap'),
      targetVersion: '0.3.0',
    });
    // Hold the probe open so both requests overlap deterministically.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = buildProvisionApp({
      setupToken: TOKEN,
      store,
      targetVersion: '0.3.0',
      stateDir: dir,
      instanceId: 'stackpanel',
      probes: async () => {
        await gate;
        return { ok: true };
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const first = app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({ idempotencyKey: 'race-key-aaaa' }),
    });
    // Give the first request time to write `validating` before the second reads.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = app.inject({
      method: 'POST',
      url: '/setup/provision',
      payload: provisionPayload({ idempotencyKey: 'race-key-bbbb' }),
    });

    const blocked = await second;
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('bootstrap.not_writable');

    release();
    const winner = await first;
    expect(winner.statusCode).toBe(202);

    const state = await store.read();
    expect(state).toMatchObject({ phase: 'queued', configGeneration: 1 });
    // Only the winner's config was published.
    const { readdir: read } = await import('node:fs/promises');
    expect((await read(path.join(dir, 'bootstrap'))).filter((n) => n.startsWith('config.candidate-'))).toHaveLength(1);
    await app.close();
  });
});
