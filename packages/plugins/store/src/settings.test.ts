import { beforeEach, describe, expect, it, vi } from 'vitest';
const secrets = { get: vi.fn(), set: vi.fn() };
vi.mock('./context', () => ({ context: () => ({ secrets, auth: {} }), logger: () => ({ warn: vi.fn() }) }));
import { storeSettings, saveStoreSettings } from './settings';
describe('store provisioning policy', () => {
  beforeEach(() => { vi.clearAllMocks(); secrets.get.mockResolvedValue(null); });
  it('requires administrator approval by default when unconfigured', async () => {
    expect(await storeSettings()).toEqual({ provisioningMode: 'manual' });
  });
  it('persists only valid settings', async () => {
    await saveStoreSettings({ body: { provisioningMode: 'manual' } } as never);
    expect(secrets.set).toHaveBeenCalledWith('store-provisioning-policy', JSON.stringify({ provisioningMode: 'manual' }));
    await expect(saveStoreSettings({ body: { provisioningMode: 'invalid' } } as never)).rejects.toThrow();
    expect(secrets.set).toHaveBeenCalledTimes(1);
  });
  it('fails closed on malformed stored policy', async () => {
    secrets.get.mockResolvedValue('{broken');
    await expect(storeSettings()).rejects.toThrow();
  });
});
