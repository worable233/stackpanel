import { beforeEach, describe, expect, it, vi } from 'vitest';
const secrets = { get: vi.fn(), set: vi.fn() };
vi.mock('./context', () => ({ context: () => ({ secrets, auth: {} }), logger: () => ({ warn: vi.fn() }) }));
vi.mock('./audit', () => ({ auditActor: () => ({}), recordStoreAudit: vi.fn() }));
import { storeSettings, saveStoreSettings, refundPolicy } from './settings';
import { DEFAULT_REFUND_POLICY } from './refund-policy';
describe('store provisioning policy', () => {
  beforeEach(() => { vi.clearAllMocks(); secrets.get.mockResolvedValue(null); });
  it('requires administrator approval by default when unconfigured', async () => {
    expect(await storeSettings()).toEqual({ provisioningMode: 'manual', refund: DEFAULT_REFUND_POLICY });
  });
  it('persists only valid settings', async () => {
    await saveStoreSettings({ body: { provisioningMode: 'manual' } } as never);
    expect(secrets.set).toHaveBeenCalledWith(
      'store-provisioning-policy',
      JSON.stringify({ provisioningMode: 'manual', refund: DEFAULT_REFUND_POLICY }),
    );
    await expect(saveStoreSettings({ body: { provisioningMode: 'invalid' } } as never)).rejects.toThrow();
    expect(secrets.set).toHaveBeenCalledTimes(1);
  });
  it('falls back to fail-closed defaults on malformed stored policy', async () => {
    // 后端一条坏记录不该让整个设置页打不开；回落的默认值本身是关闭态的
    // （manual + 退款关闭），所以「不抛错」不等于「fail open」。
    secrets.get.mockResolvedValue('{broken');
    expect(await storeSettings()).toEqual({ provisioningMode: 'manual', refund: DEFAULT_REFUND_POLICY });
  });
  it('upgrades legacy records without a refund block to the default policy', async () => {
    // 存量部署只有 provisioningMode：升级不能凭空打开一个花钱的退款入口。
    secrets.get.mockResolvedValue(JSON.stringify({ provisioningMode: 'automatic' }));
    const settings = await storeSettings();
    expect(settings.provisioningMode).toBe('automatic');
    expect(settings.refund).toEqual(DEFAULT_REFUND_POLICY);
    expect(settings.refund.enabled).toBe(false);
  });
  it('saves refund policy alone without clobbering provisioning mode', async () => {
    secrets.get.mockResolvedValue(JSON.stringify({ provisioningMode: 'automatic' }));
    await saveStoreSettings({ body: { refund: { enabled: true, windowDays: null } } } as never);
    const saved = JSON.parse(secrets.set.mock.calls[0]![1] as string);
    expect(saved.provisioningMode).toBe('automatic');
    expect(saved.refund.enabled).toBe(true);
    expect(saved.refund.windowDays).toBeNull();
    // 未提交的字段沿用现值
    expect(saved.refund.amountMode).toBe(DEFAULT_REFUND_POLICY.amountMode);
  });
  it('rejects out-of-range refund policy values', async () => {
    await expect(saveStoreSettings({ body: { refund: { feePercentBps: 20_000 } } } as never)).rejects.toThrow();
    await expect(saveStoreSettings({ body: { refund: { windowDays: -1 } } } as never)).rejects.toThrow();
    expect(secrets.set).not.toHaveBeenCalled();
  });
  it('exposes only the refund policy through refundPolicy()', async () => {
    secrets.get.mockResolvedValue(JSON.stringify({ provisioningMode: 'manual', refund: { ...DEFAULT_REFUND_POLICY, enabled: true, windowDays: 1 } }));
    expect(await refundPolicy()).toEqual({ ...DEFAULT_REFUND_POLICY, enabled: true, windowDays: 1 });
  });
});
