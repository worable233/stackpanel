import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { userListResponseSchema as responseSchema } from '../../src/lib/openapi.ts';
import type { UserAdminDeps } from '../../src/lib/user-admin.ts';
import { userListResponseSchema, adminUserMutationResponseSchema } from '@stackpanel/sdk';
vi.mock('../../src/plugins/prisma.ts', () => ({ getPrisma: vi.fn() }));
import { UserAdminService } from '../../src/lib/user-admin.ts';

const date = new Date('2026-10-16T00:00:00Z');
const rows = ['a', 'b'].map((id) => ({
  id,
  email: `${id}@example.com`,
  status: 'ACTIVE',
  createdAt: date,
  updatedAt: date,
  lastLoginAt: null,
  passwordHash: 'private',
  groups: [],
}));
function fixture() {
  const findMany = vi.fn().mockResolvedValue(rows);
  const raw = vi.fn().mockResolvedValue([{ id: 'b' }, { id: 'a' }]);
  const countServicesByUsers = vi.fn().mockResolvedValue({ a: 275, b: 0 });
  const deps = {
    prisma: {
      user: { findMany, count: vi.fn().mockResolvedValue(42) },
      walletAccount: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'b', balance: 500, currency: 'CNY' }]),
      },
      $queryRaw: raw,
    },
    wallet: {},
    auth: {},
    commerce: { countServicesByUsers },
  } as unknown as UserAdminDeps;
  return { deps, findMany, raw, countServicesByUsers, service: new UserAdminService(deps) };
}

describe('admin user list', () => {
  it('returns exact product counts and a zero balance for users without a wallet, without leaking credentials', async () => {
    const { service, countServicesByUsers } = fixture();
    const result = await service.listUsers({ page: 1, pageSize: 20 });
    expect(result.total).toBe(42);
    expect(result.users[0]).toMatchObject({
      balance: 0,
      balanceCurrency: 'CNY',
      serviceCount: 275,
    });
    expect(result.users[0]).not.toHaveProperty('passwordHash');
    expect(result.users[1]).toMatchObject({ balance: 500, serviceCount: 0 });
    expect(countServicesByUsers).toHaveBeenCalledWith(['a', 'b']);
    const json = JSON.parse(JSON.stringify(result));
    expect(userListResponseSchema.parse(json).users[0]?.serviceCount).toBe(275);
    // Detail / mutation endpoints do not include list-only aggregates.
    const {
      balance: _balance,
      balanceCurrency: _currency,
      serviceCount: _count,
      ...user
    } = json.users[0];
    expect(adminUserMutationResponseSchema.safeParse({ user }).success).toBe(true);
  });
  it('preserves list aggregates through the API response serializer', async () => {
    const { service } = fixture();
    const app = Fastify();
    app.get('/users', { schema: { response: { 200: responseSchema } } }, () =>
      service.listUsers({ page: 1, pageSize: 20 }),
    );
    try {
      const response = await app.inject({ method: 'GET', url: '/users' });
      expect(response.statusCode).toBe(200);
      expect(response.json().users[0]).toMatchObject({
        balance: 0,
        balanceCurrency: 'CNY',
        serviceCount: 275,
      });
      expect(response.json().users[0]).not.toHaveProperty('passwordHash');
    } finally {
      await app.close();
    }
  });
  it('sorts balances in the database before pagination and preserves the returned ID order', async () => {
    const { service, raw, findMany } = fixture();
    const result = await service.listUsers({
      page: 2,
      pageSize: 10,
      sort: 'balance_desc',
      q: "a'_%",
      status: 'ACTIVE',
      groupId: 'group_user',
    });
    expect(result.users.map((user) => user.id)).toEqual(['b', 'a']);
    const sql = raw.mock.calls[0]![0];
    expect(sql.sql).toContain('COALESCE(w.balance, 0) DESC');
    expect(sql.sql).toContain('LIMIT ? OFFSET ?');
    expect(sql.sql).not.toContain("a'_%");
    expect(sql.values.slice(-2)).toEqual([10, 10]);
    expect(sql.values).toContain('group_user');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['b', 'a'] } } }),
    );
  });
  it('keeps never-signed-in accounts last for both login-time directions and retains all filters', async () => {
    const { service, findMany } = fixture();
    for (const direction of ['asc', 'desc'] as const) {
      await service.listUsers({
        page: 2,
        pageSize: 10,
        sort: `lastLoginAt_${direction}`,
        status: 'DISABLED',
        groupId: 'group_user',
        q: 'B@Example',
      });
      expect(findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
          where: {
            email: { contains: 'b@example' },
            status: 'DISABLED',
            groups: { some: { groupId: 'group_user' } },
          },
          orderBy: [{ lastLoginAt: { sort: direction, nulls: 'last' } }, { id: 'asc' }],
        }),
      );
    }
  });
  it('does not confuse a disabled, older or failed plugin with a genuine zero product count', async () => {
    const { deps, countServicesByUsers } = fixture();
    for (const commerce of [null, {}, deps.commerce]) {
      countServicesByUsers.mockRejectedValue(new Error('plugin unavailable'));
      const service = new UserAdminService({ ...deps, commerce } as UserAdminDeps);
      const result = await service.listUsers({ page: 1, pageSize: 20 });
      expect(result.users[0]?.serviceCount).toBeNull();
      expect(result.users[1]?.balance).toBe(500);
    }
  });
});
