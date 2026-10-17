import { describe, expect, it } from 'vitest';
import type { PluginContext, ProductTypeProvider, ProviderServiceContext } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import storeProductServerPlugin from './index.js';

/** 捕获插件激活时注册的云服务器商品类型提供方。 */
function captureProductType(): ProductTypeProvider {
  let captured: ProductTypeProvider | null = null;
  const ctx = {
    registerExtension: (pointId: string, implementation: unknown) => {
      if (pointId === EXTENSION_POINTS.productType) {
        captured = implementation as ProductTypeProvider;
      }
      return () => {};
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as PluginContext;
  storeProductServerPlugin.onActivate?.(ctx);
  if (!captured) throw new Error('productType not registered');
  return captured;
}

function serviceContext(runtime: unknown = null): ProviderServiceContext {
  return {
    service: {
      id: 'svc-1',
      providerId: null,
      providerServiceId: null,
      runtime,
      credentialsRef: null,
      userId: 'u',
      orderId: 'o',
      productId: 'p',
      productName: '云服务器',
      status: 'ACTIVE',
    },
    secrets: {
      isAvailable: () => true,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
  };
}

describe('store-product-server 原生运维动作', () => {
  it('declares cloud-server actions including reinstall/reset-password', async () => {
    const detail = await captureProductType().getDetail!(serviceContext());
    const ids = (detail.actions ?? []).map((action) => action.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'power_on',
        'power_off',
        'reboot',
        'reinstall',
        'reset_password',
      ]),
    );
    // 本地托管实例没有真实 VNC：不得把占位控制台当作可用动作对外声明。
    expect(ids).not.toContain('vnc');
    const reinstall = detail.actions?.find((action) => action.id === 'reinstall');
    expect(reinstall?.params?.[0]).toMatchObject({ name: 'os', type: 'select', required: true });
  });

  it('power actions update the runtime power state', async () => {
    const provider = captureProductType();
    const off = await provider.executeAction!('power_off', serviceContext());
    expect(off).toMatchObject({ runtime: { powerState: 'stopped' } });

    const detail = await provider.getDetail!(serviceContext({ powerState: 'stopped' }));
    expect(detail.status).toBe('SUSPENDED');
  });

  it('reinstall records the chosen OS and requires the param', async () => {
    const provider = captureProductType();
    await expect(provider.executeAction!('reinstall', serviceContext())).rejects.toMatchObject({
      code: 'store.product.action_param_invalid',
    });
    const result = await provider.executeAction!('reinstall', serviceContext(), {
      os: 'ubuntu-22.04',
    });
    expect(result).toMatchObject({ runtime: { os: 'ubuntu-22.04' } });
    expect(result?.fields?.[0]).toMatchObject({ label: '操作系统', value: 'ubuntu-22.04' });
  });

  it('reset_password requires a strong-enough password and returns it as a secret field', async () => {
    const provider = captureProductType();
    await expect(
      provider.executeAction!('reset_password', serviceContext(), { password: 'short' }),
    ).rejects.toMatchObject({ code: 'store.product.action_param_invalid' });
    const result = await provider.executeAction!('reset_password', serviceContext(), {
      password: 'S3cretPass!',
    });
    expect(result?.fields?.[0]).toMatchObject({
      label: '新密码',
      value: 'S3cretPass!',
      secret: true,
    });
  });

  it('refuses VNC instead of returning a placeholder console url', async () => {
    // 审计 #1：以前返回 `about:blank#vnc-console` 并被持久化到 runtime，
    // 让「本地模拟」看起来像真实运维闭环。现在必须显式拒绝。
    await expect(
      captureProductType().executeAction!('vnc', serviceContext()),
    ).rejects.toMatchObject({ code: 'store.product.action_unsupported' });
  });

  it('rejects unknown actions', async () => {
    await expect(
      captureProductType().executeAction!('bogus', serviceContext()),
    ).rejects.toMatchObject({ code: 'store.product.action_unsupported' });
  });
});
