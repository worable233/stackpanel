import type {
  ExternalPaymentInitiationResult,
  ExternalPaymentRequest,
  ManualPaymentInstructions,
  PaymentMethod,
  PaymentProvider,
} from '@stackpanel/sdk';

/** Manual payment methods offered by the kernel (bank transfer / QR code). */
export const MANUAL_METHODS: PaymentMethod[] = [
  { id: 'bank_transfer', label: '银行转账' },
  { id: 'qrcode', label: '收款码支付' },
];

/**
 * Kernel-embedded manual payment provider. `createPayment` does not call a
 * live gateway: it returns buyer instructions and the payment stays PENDING
 * until an admin confirms receipt via `ctx.payments.confirmManual`. Expiry
 * sweep skips manual payments (transfers can take days).
 *
 * Per-method config (bank account fields / QR image URL) comes from the bound
 * `payment_method` row and is passed by the kernel as `config`.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly id = 'manual';
  readonly name = '手动收款';
  readonly mode = 'manual' as const;
  readonly callbackPath = '/callbacks/manual';

  getMethods(): PaymentMethod[] {
    return MANUAL_METHODS;
  }

  async createPayment(
    request: ExternalPaymentRequest,
    config?: unknown,
  ): Promise<ExternalPaymentInitiationResult> {
    const detail = (config ?? {}) as Record<string, unknown>;
    const instructions: ManualPaymentInstructions = {
      kind: request.method,
      message:
        request.method === 'bank_transfer'
          ? '请使用以下银行账户转账，并在备注中填写订单号。到账后管理员将确认订单。'
          : '请扫描收款码完成支付。到账后管理员将确认订单。',
      detail,
    };
    return { mode: 'manual', instructions };
  }

  async closePayment(): Promise<boolean> {
    // Manual payments are never auto-closed at the gateway; admin cancels them.
    return false;
  }
}
