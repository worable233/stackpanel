import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * First-run setup wizard, open mode (no claim token). Each test file runs
 * against a freshly recreated database (see tests/setup.ts), so the instance
 * starts unclaimed. Exercises the state probe, the single-use claim under the
 * shared first-user advisory lock, and the permanent self-disable afterwards.
 */
describe.skipIf(!dbAvailable)('setup wizard (real DB)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the instance as unclaimed with no token required', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ required: true, tokenRequired: false, phase: 'needs_admin' });
  });

  it('rejects a weak password with the policy code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { email: 'admin@example.com', password: 'short' },
    });
    // A weak password is a client error with a localisable reason, not a generic
    // schema failure: the wizard renders `error.password.too_short`.
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code?: string }).code).toBe('password.too_short');
  });

  it('claims the instance exactly once under concurrent submissions', async () => {
    const suffix = Date.now();
    const attempts = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/setup',
        payload: { email: `setup_a_${suffix}@example.com`, password: 'SetupPass123' },
      }),
      app.inject({
        method: 'POST',
        url: '/setup',
        payload: { email: `setup_b_${suffix}@example.com`, password: 'SetupPass123' },
      }),
    ]);

    const codes = attempts.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);

    const winner = attempts.find((r) => r.statusCode === 201);
    const body = winner?.json() as { token: string; user: { email: string } };
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.user.email).toMatch(/^setup_[ab]_\d+@example\.com$/);

    // The winner is a real admin (group_admin membership), not a plain user.
    const admin = await getPrisma().user.findUnique({
      where: { email: body.user.email },
      select: { groups: { select: { groupId: true } } },
    });
    expect(admin?.groups.map((g) => g.groupId)).toContain('group_admin');

    // Exactly one admin exists — the loser created nothing.
    const adminCount = await getPrisma().userGroup.count({ where: { groupId: 'group_admin' } });
    expect(adminCount).toBe(1);
  });

  it('self-disables after the instance is claimed', async () => {
    const status = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(status.json()).toEqual({ required: false, tokenRequired: false, phase: 'complete' });

    const again = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { email: `setup_again_${Date.now()}@example.com`, password: 'SetupPass123' },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('setup.already_completed');
  });
});
