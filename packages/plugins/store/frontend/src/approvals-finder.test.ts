import { describe, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('./auto-submit.js', () => ({ AutoSubmitForm: () => null, CartCheckout: () => null }));
import frontend from './index';

/**
 * 开通审核页的数据契约。
 *
 * finder 用 zod 校验上游响应，**未知键会被静默剔除**：后端新增了
 * `retryExhausted`，如果这里不同步，页面永远拿不到「自动重试用尽」标记，
 * 付了钱没拿到机器的单就会安静地躺在「待核对」队列里（真实案例：
 * 上游购物车锁竞争把 3 次自动重试烧光）。
 */
describe('store approvals finder contract', () => {
  const task = {
    id: 'task-1',
    orderId: 'order-1',
    productName: '香港EPYC-4H8G', // i18n-exempt — test fixture
    quantity: 1,
    status: 'REQUIRES_RECONCILIATION',
    userId: 'user-1',
    reason: '自动重试已用尽，需人工核对上游：确认无实例请在订单页退款', // i18n-exempt — test fixture
    attempts: 3,
    maxAttempts: 3,
    retryExhausted: true,
    upstreamServiceId: null,
    invoiceId: null,
    paymentState: null,
    canResumePayment: false,
  };

  it('keeps the exhaustion flag instead of stripping it', async () => {
    const get = vi.fn().mockResolvedValue({ tasks: [task], total: 1, page: 1, pageSize: 50 });
    const handler = frontend.finders!['store.approvals']!.handler;
    const result = (await handler({}, {
      api: { get, post: vi.fn() },
    } as unknown as Parameters<typeof handler>[1])) as { tasks: Array<Record<string, unknown>> };
    expect(result.tasks[0]).toMatchObject({
      retryExhausted: true,
      maxAttempts: 3,
      attempts: 3,
    });
    expect(String(result.tasks[0]!['reason'])).toContain('自动重试已用尽'); // i18n-exempt — test fixture
    expect(String(get.mock.calls[0]?.[0])).toContain('/store/admin/delivery-tasks?status=attention');
  });
});
