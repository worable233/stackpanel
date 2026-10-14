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
  it('declares cloud-server actions including reinstall/reset-password/vnc', async () => {
    const detail = await captureProductType().getDetail!(serviceContext());
    const ids = (detail.actions ?? []).map((action) => action.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'power_on',
        'power_off',
        'reboot',
        'reinstall',
        'reset_password',
        'vnc',
      ]),
    );
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

  it('vnc returns a console url and persists it for later display', async () => {
    const provider = captureProductType();
    const result = await provider.executeAction!('vnc', serviceContext());
    expect(result?.url).toBeTruthy();
    expect(result?.runtime).toMatchObject({ consoleUrl: result?.url });
    // 落库的控制台地址在详情中可见且可点击。
    const detail = await provider.getDetail!(
      serviceContext({ consoleUrl: (result?.runtime as { consoleUrl: string }).consoleUrl }),
    );
    expect(detail.fields.some((field) => field.label === '控制台地址')).toBe(true);
  });

  it('rejects unknown actions', async () => {
    await expect(
      captureProductType().executeAction!('bogus', serviceContext()),
    ).rejects.toMatchObject({ code: 'store.product.action_unsupported' });
  });
});
