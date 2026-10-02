import type { PaymentMethod, PaymentSettlement, PaymentSettlementHandler } from './plugin.js';
import type { ManualPaymentInstructions } from './plugin.js';

/**
 * Kernel-owned payment orchestration contract.
 *
 * The kernel owns the `payments` table, provider resolution, the settlement
 * entry point, and the expiry sweep. Commerce plugins (e.g. `store`) own order
 * and stock semantics and register a `payment.settlement` handler that the
 * kernel dispatches. Payment gateways (e.g. `epay`) depend only on the kernel —
 * they submit verified settlements through `ctx.payments.settle`.
 */

export type PaymentPurpose = 'ORDER' | 'TOP_UP';

/**
 * Stable, machine-readable codes for payment errors (ADR-0012). The kernel
 * throws `PaymentError(status, message)`; mapping the stable message (or the
 * `undetermined` kind) to a code here centralises the vocabulary.
 */
const PAYMENT_ERROR_CODES: Record<string, string> = {
  '所选支付方式不可用': 'payment.method_unavailable',
  '支付渠道回调配置无效': 'payment.callback_config_invalid',
  '支付渠道返回了无效的支付链接': 'payment.return_url_invalid',
  '支付渠道返回了不安全的支付链接': 'payment.return_url_insecure',
  '金额无效': 'payment.amount_invalid',
  '支付记录不存在': 'payment.not_found',
  '支付已处理': 'payment.already_settled',
  '支付渠道拒绝了订单': 'payment.rejected',
  '支付状态无法确认；订单已挂起待对账': 'payment.undetermined',
  '结算金额无效': 'payment.settlement_amount_invalid',
  '结算信息不匹配': 'payment.settlement_mismatch',
};

/**
 * Error thrown by the kernel payment service. Carries an HTTP status and a
 * display message so plugins can relay it without duplicating protocol rules.
 */
export class PaymentError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    /** 'definitive' = the provider refused; 'undetermined' = the session must be reconciled. */
    readonly kind?: 'definitive' | 'undetermined',
  ) {
    super(message);
    this.name = 'PaymentError';
    this.statusCode = status;
    this.code =
      kind === 'undetermined'
        ? 'payment.undetermined'
        : (PAYMENT_ERROR_CODES[message] ?? 'payment.error');
  }
  /** Alias so Fastify's error handler maps the error to an HTTP status. */
  readonly statusCode: number;
}

/** External payment statuses that are still in flight and may settle/release. */
export const EXTERNAL_PAYMENT_STATUSES = ['PENDING', 'REVIEW'] as const;

/** Input for creating an external payment record through the kernel. */
export interface ExternalPaymentCreateInput {
  purpose: PaymentPurpose;
  userId: string;
  /** Required when `purpose === 'ORDER'`; the order row is created by the caller. */
  orderId?: string;
  amount: number;
  /** Settlement currency (the amount the gateway actually charges). */
  currency: string;
  providerId: string;
  paymentMethod: string;
  /** Bound payment-method row id (resolved from the sales channel). */
  methodId?: string;
  /** Order's native currency (when different from the settlement currency). */
  orderCurrency?: string;
  /** Order's native amount (minor units). */
  orderAmount?: number;
  /** Frozen FX rate snapshot ×1e6 (null when no conversion). */
  fxRate?: number | null;
  subject: string;
  /** Web return path, e.g. `/account/orders` or `/account/balance`. */
  returnPath: string;
  clientIp?: string;
}

/** A payment record created inside the caller's transaction (if any). */
export interface ExternalPaymentRecord {
  id: string;
  merchantOrderNo: string;
  amount: number;
  currency: string;
}

/** Result of a successful external payment initiation. */
export interface ExternalPaymentCreated {
  id: string;
  merchantOrderNo: string;
  amount: number;
  currency: string;
  status: string;
  paymentUrl: string;
  providerId: string;
  paymentMethod: string;
  /** Present when the provider is a manual method (bank transfer / QR code). */
  manualInstructions?: ManualPaymentInstructions;
  expiresAt?: string;
  createdAt: string;
}

/** A top-up (purpose = TOP_UP) surfaced in the wallet UI. */
export interface WalletTopUpView {
  id: string;
  amount: number;
  currency: string;
  providerId: string | null;
  paymentMethod: string | null;
  paymentUrl: string | null;
  status: string;
  createdAt: string;
}

/** Minimal payment view linked to an order (store order list). */
export interface PaymentOrderLink {
  id: string;
  orderId: string | null;
  status: string;
  paymentUrl: string | null;
  paymentMethod: string | null;
  providerId: string | null;
  amount: number;
  currency: string;
  createdAt: string;
}

/** Payment methods surfaced at checkout. */
export interface PaymentMethodListing {
  wallet: { id: 'wallet'; label: string };
  providers: Array<{ id: string; name: string; methods: PaymentMethod[] }>;
}

/** 销售渠道下的一个可用支付方式（结账渠道选择器用）。 */
export interface ChannelMethod {
  id: string;
  providerId: string;
  name: string;
  scene: string;
  enabled: boolean;
  sortOrder: number;
}

/** 销售渠道及其可用支付方式。 */
export interface SalesChannelView {
  code: string;
  name: string;
  enabled: boolean;
  methods: ChannelMethod[];
}

/** Result of a settlement application. */
export interface PaymentSettleResult {
  applied: boolean;
  purpose: PaymentPurpose;
}

/** Outcome of an admin manual-payment confirmation. */
export type AdminPaymentConfirmResult =
  | { confirmed: true }
  | { confirmed: false; reason: 'NOT_FOUND' | 'NOT_MANUAL' | 'NOT_PENDING' };

/** Outcome of an admin manual-payment cancellation. */
export type AdminPaymentCancelResult =
  | { cancelled: true }
  | { cancelled: false; reason: 'NOT_FOUND' | 'NOT_MANUAL' | 'NOT_PENDING' };

/** Outcome of a user-initiated external payment cancellation. */
export type ExternalPaymentCancelResult =
  | { cancelled: true }
  | { cancelled: false; reason: 'NOT_CANCELLABLE' | 'UNSUPPORTED' | 'STILL_PROCESSING' };

/** Outcome of a user-initiated top-up cancellation. */
export type ExternalTopUpCancelResult =
  | { cancelled: true }
  | { cancelled: false; reason: 'NOT_CANCELLABLE' | 'UNSUPPORTED' | 'STILL_PROCESSING' };

/**
 * Kernel payment orchestration exposed to plugins via `ctx.payments`.
 */
export interface PaymentService {
  /** List wallet + active external providers for checkout UI. */
  listPaymentMethods(): PaymentMethodListing;
  /**
   * Create a PENDING external payment record. When `tx` is provided the record
   * is created inside the caller's transaction (order flows need payment +
   * order + stock to commit atomically). The provider is NOT called here.
   */
  createRecord(input: ExternalPaymentCreateInput, tx?: unknown): Promise<ExternalPaymentRecord>;
  /**
   * Call the provider for an existing PENDING payment and finalize the
   * payment URL/expiry. Definitive provider failures mark the payment
   * CANCELLED; undetermined failures mark it REVIEW. The caller owns merchant
   * side-effects (e.g. stock release) for ORDER purposes.
   */
  initiate(
    paymentId: string,
    options: { returnPath: string; subject: string; clientIp?: string },
  ): Promise<ExternalPaymentCreated>;
  /** createRecord + initiate in one call (used when no surrounding transaction). */
  create(input: ExternalPaymentCreateInput): Promise<ExternalPaymentCreated>;
  /** Idempotently apply a verified gateway settlement (callback entry point). */
  settle(input: PaymentSettlement): Promise<PaymentSettleResult>;
  /** Cancel an order's external payment (claims, closes the provider, dispatches release). */
  cancelExternalPayment(orderId: string): Promise<ExternalPaymentCancelResult>;
  /** Cancel a user's pending top-up (purpose = TOP_UP) by payment id. */
  cancelTopUp(paymentId: string, userId: string): Promise<ExternalTopUpCancelResult>;
  /** List a user's top-ups (purpose = TOP_UP), newest first. */
  listTopUps(userId: string, limit?: number): Promise<WalletTopUpView[]>;
  /**
   * Provider-scoped config of the first enabled payment method bound to
   * `providerId` (raw `payment_methods.config`), or null. Lets a gateway plugin
   * load its channel config without touching the kernel table directly.
   */
  getProviderConfig(providerId: string): Promise<unknown | null>;
  /** Batch-load the payment records bound to the given order ids. */
  listByOrderIds(orderIds: string[]): Promise<PaymentOrderLink[]>;
  /**
   * 按 code 取销售渠道及其可用支付方式（结账渠道选择器），不存在返回 null。
   * 让商城插件解析渠道而不直接读内核 `sales_channels` 表。
   */
  listChannelMethods(code: string): Promise<SalesChannelView | null>;
  /** Release expired unpaid external payments. Returns the count released. */
  sweepExpired(): Promise<number>;
  /** Admin-confirm a manual payment as received (PENDING → PAID, dispatches handlers). */
  confirmManual(paymentId: string): Promise<AdminPaymentConfirmResult>;
  /** Admin-cancel a manual payment. */
  cancelManual(paymentId: string): Promise<AdminPaymentCancelResult>;
}

/** Re-export the settlement handler type for plugin registration convenience. */
export type { PaymentSettlementHandler };