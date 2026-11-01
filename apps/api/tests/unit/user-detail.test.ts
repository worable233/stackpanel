import { describe, expect, it, vi } from 'vitest';
import type { UserAdminDeps } from '../../src/lib/user-admin.ts';
import { PluginError } from '@stackpanel/sdk';
vi.mock('../../src/plugins/prisma.ts', () => ({ getPrisma: vi.fn() }));
import { UserAdminService } from '../../src/lib/user-admin.ts';

function fixture(orders = 47) {
  const date = new Date('2026-10-01T00:00:00Z');
  const all = Array.from({ length: orders }, (_, i) => ({ id: `order-${i + 1}`, status: 'PAID', total: 100, currency: 'CNY', createdAt: date }));
  const listOrders = vi.fn(async (_id: string, page: number, size: number) => ({ items: all.slice((page - 1) * size, page * size), total: all.length }));
  const payments = [
    { id: 'pay-topup', purpose: 'TOP_UP', status: 'PAID', amount: 1000, currency: 'CNY', providerId: 'manual', paymentMethod: 'bank_transfer', orderId: null, paymentUrl: null, createdAt: date },
    { id: 'pay-order', purpose: 'ORDER', status: 'PAID', amount: 100, currency: 'CNY', providerId: 'epay', paymentMethod: 'alipay', orderId: 'order-1', paymentUrl: null, createdAt: date },
  ];
  const listPayments = vi.fn(async () => payments);
  const countPayments = vi.fn(async () => payments.length);
  const deps = {
    prisma: {
      user: { findUnique: vi.fn(async () => ({ id: 'user', email: 'user@example.com', groups: [], passwordHash: 'private' })) },
      payment: { findMany: listPayments, count: countPayments },
    },
    wallet: { getAccount: vi.fn(async () => null), listLedger: vi.fn(async () => []) },
    auth: {}, commerce: { listServices: vi.fn(async () => []), listOrders, listBoundServices: vi.fn(async () => []) },
  } as unknown as UserAdminDeps;
  return { deps, listOrders, listPayments, service: new UserAdminService(deps) };
}

describe('admin user detail', () => {
  it('keeps equal instance IDs from different upstream accounts distinct', async () => {
    const { deps } = fixture();
    deps.commerce!.listBoundServices = vi.fn().mockResolvedValue([{ id: 'local-a', userId: 'other', providerServiceId: '42', runtime: { upstreamId: 'a' } }]);
    const service = new UserAdminService({ ...deps, upstreamServiceSources: [{ id: 'zjmf', name: 'ZJMF', list: vi.fn().mockResolvedValue([{ id: '42', name: 'A', sourceRef: 'a' }, { id: '42', name: 'B', sourceRef: 'b' }]) }] });
    const result = await service.listUpstreamServices('user');
    expect(result.services[0]?.boundUserId).toBe('other');
    expect(result.services[1]?.boundUserId).toBeNull();
    expect(result.services[1]?.sourceRef).toBe('b');
  });
  it('returns every order through server-side pagination, including records older than twenty', async () => {
    const { service, listOrders } = fixture();
    const pages = await Promise.all([1, 2, 3].map((page) => service.getUserDetail('user', page, 20)));
    expect(listOrders).toHaveBeenCalledWith('user', 3, 20);
    expect(pages.flatMap((page) => page.orders).map((order) => order.id)).toEqual(Array.from({ length: 47 }, (_, i) => `order-${i + 1}`));
    expect(pages[2]?.ordersPagination).toEqual({ page: 3, pageSize: 20, total: 47 });
    expect(pages[0]?.user).not.toHaveProperty('passwordHash');
  });
  it('lists wallet top-ups and order payments alongside orders', async () => {
    const { service, listPayments } = fixture();
    const result = await service.getUserDetail('user');
    expect(listPayments).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user' }, take: 20 }));
    expect(result.payments.map((payment) => [payment.id, payment.purpose])).toEqual([
      ['pay-topup', 'TOP_UP'],
      ['pay-order', 'ORDER'],
    ]);
    expect(result.paymentsTotal).toBe(2);
  });
  it('returns an explicit empty page when commerce is disabled', async () => {
    const { deps } = fixture();
    const result = await new UserAdminService({ ...deps, commerce: null }).getUserDetail('user');
    expect(result.orders).toEqual([]);
    expect(result.ordersPagination.total).toBe(0);
  });
  it('preserves actionable upstream configuration errors crossing IPC', async () => {
    const { deps } = fixture();
    const failure = Object.assign(new Error('请先配置上游连接'), { code: 'zjmf.no_enabled_upstream', status: 409 });
    const service = new UserAdminService({ ...deps, upstreamServiceSources: [{ id: 'zjmf', name: '智简魔方', list: vi.fn().mockRejectedValue(failure) }] });
    await expect(service.listUpstreamServices('user')).rejects.toMatchObject({ code: failure.code, status: 409, detail: failure.message });
  });
  it('does not disguise an upstream network failure as an empty service list', async () => {
    const { deps } = fixture();
    const service = new UserAdminService({ ...deps, upstreamServiceSources: [{ id: 'zjmf', name: '智简魔方', list: vi.fn().mockRejectedValue(new Error('network')) }] });
    await expect(service.listUpstreamServices('user')).rejects.toMatchObject({ code: 'upstream.list_failed', status: 502 });
  });
  it('keeps the human-readable detail of SDK plugin errors', async () => {
    const { deps } = fixture();
    const failure = new PluginError('upstream.credentials', 503, '请检查上游凭据');
    const service = new UserAdminService({ ...deps, upstreamServiceSources: [{ id: 'source', name: '上游', list: vi.fn().mockRejectedValue(failure) }] });
    await expect(service.listUpstreamServices('user')).rejects.toMatchObject({ code: failure.code, status: 503, detail: '请检查上游凭据' });
  });
});
