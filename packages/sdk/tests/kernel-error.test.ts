import { describe, expect, it } from 'vitest';
import {
  CommerceError,
  FxError,
  KernelError,
  PaymentError,
  PluginError,
  WalletError,
  isCommerceError,
  isFxError,
  isPaymentError,
  isPluginError,
  isWalletError,
} from '../src/index.js';

/**
 * Kernel-domain errors (payments/wallet/FX/commerce) must be renderable by the
 * kernel boundary through the existing `isPluginError` brand — not collapsed to
 * a generic 500 — and narrowable across duplicated SDK module instances, where
 * `instanceof` silently fails (see plugin-error.test.ts).
 */
describe('kernel domain errors', () => {
  it('extends the deterministic-error brand so the boundary renders them', () => {
    for (const error of [
      new PaymentError(502, '支付渠道拒绝了订单', 'definitive'),
      new WalletError(409, '钱包余额不足'),
      new FxError(409, '未配置 USD → CNY 的汇率', 'fx.rate_missing'),
      new CommerceError('product_not_found', '商品不存在'),
    ]) {
      expect(error).toBeInstanceOf(KernelError);
      expect(error).toBeInstanceOf(PluginError);
      expect(isPluginError(error)).toBe(true);
    }
  });

  it('derives a stable code and keeps the display message as detail/message', () => {
    const payment = new PaymentError(502, '支付记录不存在');
    expect(payment.code).toBe('payment.not_found');
    expect(payment.status).toBe(502);
    expect(payment.detail).toBe('支付记录不存在');
    expect(payment.message).toBe('支付记录不存在');

    const undetermined = new PaymentError(
      502,
      '支付状态无法确认；订单已挂起待对账',
      'undetermined',
    );
    expect(undetermined.code).toBe('payment.undetermined');
  });

  it('lets PaymentError carry a provider reason while pinning the stable code', () => {
    const error = new PaymentError(
      502,
      '当前商户未完成实名认证，无法收款',
      'definitive',
      'payment.rejected',
    );
    expect(error.code).toBe('payment.rejected');
    expect(error.detail).toBe('当前商户未完成实名认证，无法收款');
    expect(error.kind).toBe('definitive');
  });

  it('maps commerce failures to a status and code', () => {
    expect(new CommerceError('product_not_found', '商品不存在')).toMatchObject({
      code: 'commerce.product_not_found',
      status: 404,
    });
    expect(new CommerceError('product_unavailable', '商品已停售').status).toBe(409);
  });

  it('narrows each domain across a duplicated class identity', () => {
    // Simulate the plugin loader's cache-busted import: a distinct class object
    // carrying the same cross-module brand names.
    class ForeignPaymentError extends Error {
      readonly code = 'payment.rejected';
      readonly status = 502;
    }
    Object.defineProperty(ForeignPaymentError.prototype, '__stackpanelPluginError', {
      value: true,
    });
    Object.defineProperty(ForeignPaymentError.prototype, '__stackpanelSdkError', {
      value: 'PaymentError',
    });

    const foreign = new ForeignPaymentError();
    expect(foreign instanceof PaymentError).toBe(false); // the bug
    expect(isPaymentError(foreign)).toBe(true); // the guard
    expect(isWalletError(foreign)).toBe(false);
    expect(isFxError(foreign)).toBe(false);
    expect(isCommerceError(foreign)).toBe(false);
  });

  it('rejects impostors without a brand', () => {
    expect(isPaymentError({ code: 'payment.rejected', status: 502 })).toBe(false);
    expect(isFxError(null)).toBe(false);
    expect(isCommerceError(undefined)).toBe(false);
  });
});
