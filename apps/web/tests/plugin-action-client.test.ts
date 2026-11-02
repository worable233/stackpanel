import { describe, expect, it, vi, beforeEach } from 'vitest';

const success = vi.fn();
const error = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { success, error } }));

const { wrapPluginActions } = await import('@/lib/plugin-action-client');

const t = (key: string) => key;

beforeEach(() => {
  success.mockClear();
  error.mockClear();
});

describe('wrapPluginActions', () => {
  it('returns the receipt and toasts it once on success', async () => {
    const raw = { 'demo.save': async () => ({ ok: true, message: '已保存' }) };
    const wrapped = wrapPluginActions(raw, t);

    await expect(wrapped['demo.save']!(new FormData())).resolves.toEqual({
      ok: true,
      message: '已保存',
    });
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]?.[1]).toMatchObject({ description: '已保存' });
    expect(error).not.toHaveBeenCalled();
  });

  it('resolves domain failures so the page can render the precise reason', async () => {
    const reason = '前端文件过大：frontend/dist/admin.js 2.4 MiB > 2 MiB';
    const wrapped = wrapPluginActions(
      { 'demo.save': async () => ({ ok: false, error: reason }) },
      t,
    );

    // A rejection here is what made the market page report a *successful*
    // install as「安装失败，请重试」; domain failures must resolve.
    await expect(wrapped['demo.save']!(new FormData())).resolves.toEqual({
      ok: false,
      error: reason,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ description: reason });
    expect(success).not.toHaveBeenCalled();
  });

  it('treats a bare `undefined` result as success (older kernel)', async () => {
    const wrapped = wrapPluginActions({ 'demo.save': async () => undefined }, t);

    await expect(wrapped['demo.save']!(new FormData())).resolves.toEqual({ ok: true });
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('lets navigation rejections propagate untouched', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/admin/plugins;303;',
    });
    const wrapped = wrapPluginActions(
      {
        'demo.save': async () => {
          throw redirect;
        },
      },
      t,
    );

    await expect(wrapped['demo.save']!(new FormData())).rejects.toBe(redirect);
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('passes the diagnostic reason through instead of swallowing it', async () => {
    // P1：兜底文案（「支付状态无法确认」）必须能和网关原文一起给出来，否则用户
    // 分不清是自己没配好还是网关挂了。原文走 `detail`，主文案仍是本地化句子。
    const result = {
      ok: false as const,
      error: '支付状态无法确认，订单已挂起待对账',
      code: 'payment.undetermined',
      detail: '支付网关返回了 HTTP 502',
    };
    const wrapped = wrapPluginActions({ 'wallet.create-topup': async () => result }, t);

    await expect(wrapped['wallet.create-topup']!(new FormData())).resolves.toBe(result);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ description: expect.anything() });
  });
});
