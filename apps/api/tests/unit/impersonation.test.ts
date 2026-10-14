import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { getSessionStore } from '../../src/auth/session-store.ts';
import { auditContext } from '../../src/plugins/audit.ts';
import type { AuthUser } from '../../src/plugins/auth.ts';

/** Minimal request double carrying only what `auditContext` reads. */
function requestWith(user: Partial<AuthUser> | undefined): FastifyRequest {
  return {
    ip: '203.0.113.7',
    headers: { 'user-agent': 'vitest' },
    ...(user ? { user: user as AuthUser } : {}),
  } as unknown as FastifyRequest;
}

describe('impersonation tracking (audit AZ-4)', () => {
  it('round-trips the impersonator id through the session store', async () => {
    const store = getSessionStore();
    const token = await store.create('user_target', { impersonatorId: 'admin_1' });
    const record = await store.get(token);
    expect(record).toMatchObject({ userId: 'user_target', impersonatorId: 'admin_1' });
    await store.revoke(token);
    expect(await store.get(token)).toBeNull();
  });

  it('omits the impersonator id for a normal session', async () => {
    const store = getSessionStore();
    const token = await store.create('user_normal');
    const record = await store.get(token);
    expect(record?.userId).toBe('user_normal');
    expect(record?.impersonatorId).toBeUndefined();
    await store.revoke(token);
  });

  it('attributes an impersonated request to the real administrator', () => {
    const context = auditContext(
      requestWith({ id: 'user_target', impersonatorId: 'admin_1', permissions: new Set() }),
    );
    expect(context.actorId).toBe('admin_1');
    expect(context.impersonatedUserId).toBe('user_target');
  });

  it('attributes a normal request to the user themselves', () => {
    const context = auditContext(requestWith({ id: 'user_normal', permissions: new Set() }));
    expect(context.actorId).toBe('user_normal');
    expect(context.impersonatedUserId).toBeUndefined();
  });

  it('records no actor for an anonymous request', () => {
    const context = auditContext(requestWith(undefined));
    expect(context.actorId).toBeUndefined();
    expect(context.impersonatedUserId).toBeUndefined();
  });
});
