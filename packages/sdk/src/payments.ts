import type { PaymentMethod, PaymentSettlement, PaymentSettlementHandler } from './plugin.js';
import type { ManualPaymentInstructions } from './plugin.js';
import { KernelError, brandSdkErrorClass, isSdkErrorClass } from './errors.js';

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
  所选支付方式不可用: 'payment.method_unavailable',
  支付渠道回调配置无效: 'payment.callback_config_invalid',
  支付渠道返回了无效的支付链接: 'payment.return_url_invalid',
  支付渠道返回了不安全的支付链接: 'payment.return_url_insecure',
  金额无效: 'payment.amount_invalid',
  支付记录不存在: 'payment.not_found',
  支付已处理: 'payment.already_settled',
  支付渠道拒绝了订单: 'payment.rejected',
  '支付状态无法确认；订单已挂起待对账': 'payment.undetermined',
  结算金额无效: 'payment.settlement_amount_invalid',
  结算信息不匹配: 'payment.settlement_mismatch',
};

/**
 * Error thrown by the kernel payment service. Carries an HTTP status and a
 * display message so plugins can relay it without duplicating protocol rules.
 *
 * `code` defaults to a stable value derived from `kind`/`message`; pass an
 * explicit `code` to surface a provider's original reason as `message` while
 * keeping the machine contract stable (e.g. `payment.rejected`).
 */
export class PaymentError extends KernelError {
  /** 'definitive' = the provider refused; 'undetermined' = the session must be reconciled. */
  readonly kind: 'definitive' | 'undetermined' | undefined;

  constructor(
    status: number,
    message: string,
    kind?: 'definitive' | 'undetermined',
    code?: string,
  ) {
    const resolved =
      code ??
      (kind === 'undetermined'
        ? 'payment.undetermined'
        : (PAYMENT_ERROR_CODES[message] ?? 'payment.error'));
    super(resolved, status, message);
    this.name = 'PaymentError';
    this.kind = kind;
  }
}

brandSdkErrorClass(PaymentError, 'PaymentError');

/** True when `value` is a {@link PaymentError}, even across duplicated SDK modules. */
export function isPaymentError(value: unknown): value is PaymentError {
  return isSdkErrorClass(value, 'PaymentError');
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
  /** Bound `payment_methods` row, so callers can recover per-method config. */
  methodId?: string | null;
  amount: number;
  currency: string;
  createdAt: string;
}

/** Payment methods surfaced at checkout. */
export interface PaymentMethodListing {
  wallet: { id: 'wallet'; label: string };
  /**
   * `mode` lets a consumer tell the two provider families apart. A gateway
   * provider is configured by its own plugin settings and returns a
   * `paymentUrl`; a manual provider has no gateway at all, so its configured
   * `payment_methods` row *is* the payment step. Admin surfaces use this to
   * avoid demanding collection details from gateways.
   */
  providers: Array<{
    id: string;
    name: string;
    mode: 'gateway' | 'manual';
    methods: PaymentMethod[];
  }>;
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
  { confirmed: true } | { confirmed: false; reason: 'NOT_FOUND' | 'NOT_MANUAL' | 'NOT_PENDING' };

/** Outcome of an admin manual-payment cancellation. */
export type AdminPaymentCancelResult =
  { cancelled: true } | { cancelled: false; reason: 'NOT_FOUND' | 'NOT_MANUAL' | 'NOT_PENDING' };

/** Outcome of a user-initiated external payment cancellation. */
export type ExternalPaymentCancelResult =
  | { cancelled: true }
  | { cancelled: false; reason: 'NOT_CANCELLABLE' | 'UNSUPPORTED' | 'STILL_PROCESSING' };

/** Outcome of a user-initiated top-up cancellation. */
export type ExternalTopUpCancelResult =
  | { cancelled: true }
  | { cancelled: false; reason: 'NOT_CANCELLABLE' | 'UNSUPPORTED' | 'STILL_PROCESSING' };

/** How a provider collects money (mirrors the provider contract). */
export type AdminPaymentProviderMode = 'gateway' | 'manual';

/**
 * A payment record as an operator sees it.
 *
 * A manual provider (bank transfer / QR) never redirects the buyer anywhere, so
 * "confirm receipt" *is* the settlement step. That makes the record itself the
 * working surface: the row has to carry the buyer, the collection method and the
 * order link, otherwise an operator cannot tell one transfer from another.
 */
export interface AdminPaymentRecord {
  id: string;
  purpose: PaymentPurpose;
  status: string;
  /** Settlement amount (what the provider actually receives). */
  amount: number;
  currency: string;
  /** Order-currency amount when it differs from the settlement currency. */
  orderAmount: number | null;
  orderCurrency: string | null;
  providerId: string | null;
  providerMode: AdminPaymentProviderMode | null;
  /** Provider-specific collection code, e.g. `bank_transfer`. */
  paymentMethod: string | null;
  /** Display name of the configured `payment_methods` row, when bound. */
  methodName: string | null;
  orderId: string | null;
  buyerId: string;
  buyerEmail: string | null;
  externalId: string | null;
  paymentUrl: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Filters for the admin payment list. */
export interface AdminPaymentListQuery {
  status?: string;
  mode?: AdminPaymentProviderMode;
  page?: number;
  pageSize?: number;
}

export interface AdminPaymentListResponse {
  payments: AdminPaymentRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Kernel payment orchestration exposed to plugins via `ctx.payments`.
 */
export interface PaymentService {
  /**
   * List wallet + active external providers for checkout UI.
   *
   * Async because providers may live in an isolated plugin process: their
   * `getMethods()` only exists as an async proxy there, so a synchronous
   * listing would hand callers Promises instead of method arrays (which is
   * exactly how every gateway checkout broke: `methods` came back as `{}`,
   * and `providerFor` threw on `.some(...)`).
   */
  listPaymentMethods(): Promise<PaymentMethodListing>;
  /**
   * Provider id → collection mode.
   *
   * The mode is part of the provider contract, not of the stored record, so
   * admin tooling cannot label a row "needs manual confirmation" without asking
   * the registry. Exposing it here keeps provider ids out of calling code.
   */
  providerModes(): Record<string, AdminPaymentProviderMode>;
  /** Same shape, filtered to methods that are actually configured. */
  listAvailablePaymentMethods(): Promise<PaymentMethodListing>;
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
   * Buyer-facing instructions for a manual payment (bank account / QR image),
   * or null when the payment is not a manual one. Manual payments have no
   * `paymentUrl`, so this is the only way an order page can tell the buyer how
   * to pay.
   */
  manualInstructions(paymentId: string): Promise<ManualPaymentInstructions | null>;
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
