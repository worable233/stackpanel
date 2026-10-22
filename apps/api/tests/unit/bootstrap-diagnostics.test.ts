import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProvisionApp } from '../../src/bootstrap/provision-app.ts';
import {
  MAX_DIAGNOSTIC_LENGTH,
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../../src/bootstrap/redact.ts';
import { BootstrapStateStore } from '../../src/bootstrap/state.ts';
import { bootstrapChannelPaths, finishBootstrapTask, publishBootstrapTask } from '../../src/bootstrap/task.ts';

/**
 * BOOTSTRAP-R8: the *public* status carries only a phase and a stable failure
 * class; anything detailed requires the claim token and is redacted.
 */

const TOKEN = 'diag-token-0123456789abcdef';
const INSTANCE = 'stackpanel';

async function fixture(phase = 'queued', withResult = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-diagnostics-'));
  const store = new BootstrapStateStore({
    dir: path.join(dir, 'bootstrap'),
    targetVersion: '0.3.0',
  });
  await store.write({
    version: 1,
    phase: phase as never,
    configGeneration: 2,
    targetVersion: '0.3.0',
    failure: 'migration_permission_denied',
    diagnosticsRequired: true,
    migrationSucceeded: false,
    runtimeReady: false,
    adminClaimed: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:01:00.000Z',
  });
  const channel = bootstrapChannelPaths(dir, INSTANCE);
  await publishBootstrapTask(channel, {
    id: 'op-1',
    configGeneration: 2,
    targetVersion: '0.3.0',
  });
  if (withResult !== false) {
    await finishBootstrapTask(channel, 'op-1', {
      ok: false,
      phase: 'migration_failed',
      detail:
        'connect failed: postgresql://stackpanel:hunter2@db.internal:5432/panel ' +
        'password=hunter2 token=abcdef0123456789abcdef',
    });
  }

  const app = buildProvisionApp({
    setupToken: TOKEN,
    store,
    targetVersion: '0.3.0',
    stateDir: dir,
    instanceId: INSTANCE,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { dir, store, app };
}

describe('GET /setup/diagnostics', () => {
  it('requires the claim token', async () => {
    const { app } = await fixture();
    const res = await app.inject({ method: 'GET', url: '/setup/diagnostics' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('bootstrap.token_invalid');

    const wrong = await app.inject({
      method: 'GET',
      url: '/setup/diagnostics',
      headers: { 'x-setup-token': 'nope-nope-nope-nope' },
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });

  it('never accepts the token from the query string', async () => {
    const { app } = await fixture();
    const res = await app.inject({
      method: 'GET',
      url: `/setup/diagnostics?token=${TOKEN}`,
    });
    // Query strings end up in access logs; the token must not be accepted there.
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns phase + the three independent results, never raw credentials', async () => {
    const { app } = await fixture();
    const res = await app.inject({
      method: 'GET',
      url: '/setup/diagnostics',
      headers: { 'x-setup-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const body = res.json();
    expect(body).toMatchObject({
      phase: 'queued',
      configGeneration: 2,
      failure: 'migration_permission_denied',
      diagnosticsRequired: true,
      migrationSucceeded: false,
      runtimeReady: false,
      adminClaimed: false,
    });
    expect(body.lastResult).toMatchObject({ id: 'op-1', ok: false, phase: 'migration_failed' });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abcdef0123456789abcdef');
    expect(serialized).toContain('<redacted>');
    await app.close();
  });

  it('stays readable when no runner result exists yet', async () => {
    const { app } = await fixture('validating', false);
    const res = await app.inject({
      method: 'GET',
      url: '/setup/diagnostics',
      headers: { 'x-setup-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastResult).toBeNull();
    await app.close();
  });

  it('is rate limited like the submit path', async () => {
    const { app } = await fixture();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/setup/diagnostics',
        headers: { 'x-setup-token': TOKEN },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((code) => code === 200)).toHaveLength(5);
    expect(statuses.at(-1)).toBe(429);
    await app.close();
  });
});

describe('GET /setup/status stays generic', () => {
  it('does not include the runner detail or credentials', async () => {
    const { app } = await fixture();
    const res = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(res.statusCode).toBe(200);
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('connect failed');
    expect(res.json().failure).toBeUndefined();
    await app.close();
  });
});

describe('redactDiagnosticText', () => {
  it('redacts userinfo in URLs, including non-postgres schemes', () => {
    expect(redactDiagnosticText('postgresql://u:p@h:5432/db')).toBe(
      'postgresql://<redacted>@h:5432/db',
    );
    expect(redactDiagnosticText('redis://:secret@cache:6379/0')).toBe(
      'redis://<redacted>@cache:6379/0',
    );
    // No credentials: untouched.
    expect(redactDiagnosticText('postgresql://h:5432/db')).toBe('postgresql://h:5432/db');
  });

  it('redacts bare user:pass@host pairs', () => {
    expect(redactDiagnosticText('login u:p@host failed')).toContain('<redacted>@host');
  });

  it('redacts key/value secrets regardless of quoting', () => {
    const out = redactDiagnosticText(
      'password="a b c" token=t0k3n secret_access_key: AKIA1234 api_key=\'x\'',
    );
    expect(out).not.toContain('a b c');
    expect(out).not.toContain('t0k3n');
    expect(out).not.toContain('AKIA1234');
    expect(out.match(/<redacted>/g)?.length).toBe(4);
  });

  it('redacts long hex/base64-ish runs but keeps a prefix for log correlation', () => {
    const out = redactDiagnosticText('signature deadbeefdeadbeefdeadbeefdeadbeefdeadbeef end');
    expect(out).toContain('dead…');
    expect(out).not.toContain('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('is idempotent', () => {
    const once = redactDiagnosticText('postgresql://u:p@h/db password=x');
    expect(redactDiagnosticText(once)).toBe(once);
  });

  it('truncates pathological input', () => {
    // Plain prose, so the long-secret rule does not shorten it first.
    const out = redactDiagnosticText('error '.repeat(MAX_DIAGNOSTIC_LENGTH));
    expect(out.length).toBeLessThan(MAX_DIAGNOSTIC_LENGTH + 200);
    expect(out).toContain('已截断');
  });

  it('walks nested values without changing their shape', () => {
    const redacted = redactDiagnosticValue({
      ok: false,
      items: ['postgresql://u:p@h/db'],
      nested: { url: 'redis://:x@h' },
    });
    expect(redacted).toEqual({
      ok: false,
      items: ['postgresql://<redacted>@h/db'],
      nested: { url: 'redis://<redacted>@h' },
    });
  });
});
