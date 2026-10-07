import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@stackpanel/db';
import type {
  AdminPaymentCancelResult,
  AdminPaymentConfirmResult,
  EventBus,
  ExternalPaymentCancelResult,
  ExternalPaymentCreateInput,
  ExternalPaymentCreated,
  ExternalPaymentRecord,
  ExternalTopUpCancelResult,
  ManualPaymentInstructions,
  PaymentMethod,
  PaymentMethodListing,
  PaymentOrderLink,
  PaymentProvider,
  PaymentSettleResult,
  PaymentSettlement,
  PaymentSettlementHandler,
  PaymentService as PaymentServiceContract,
  PluginLogger,
  ResolvedPaymentSettlement,
  SalesChannelView,
  WalletTopUpView,
} from '@stackpanel/sdk';
import { PaymentError, isPaymentError } from '@stackpanel/sdk';
import type { WalletService } from '../wallet/wallet-service.ts';

const MAX_MINOR_AMOUNT = 2_000_000_000;
const EXTERNAL_PAYMENT_STATUSES = ['PENDING', 'REVIEW'] as const;
const CANCEL_PAYMENT_STATUSES = ['PENDING', 'REVIEW', 'CANCELLING'] as const;
/** Fallback when an external gateway does not report its own payment expiry. */
const EXTERNAL_PAYMENT_TTL_MS = 30 * 60 * 1000;

type Tx = Prisma.TransactionClient | PrismaClient;

export interface PaymentServiceOptions {
  db: PrismaClient;
  events: EventBus;
  wallet: WalletService;
  getProviders: () => PaymentProvider[];
  getSettlementHandlers: () => PaymentSettlementHandler[];
  logger?: Pick<PluginLogger, 'info' | 'warn' | 'error'>;
}

interface PaymentRow {
  id: string;
  purpose: string;
  userId: string;
  orderId: string | null;
  methodId: string | null;
  gateway: string;
  providerId: string | null;
  paymentMethod: string | null;
  merchantOrderNo: string | null;
  amount: number;
  currency: string;
  orderCurrency: string | null;
  orderAmount: number | null;
  fxRate: number | null;
  status: string;
  externalId: string | null;
  paymentUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Kernel-owned payment orchestration. Owns the `payments` table, provider
 * resolution, settlement dispatch and the expiry sweep. Business plugins drive
 * payment records through {@link PaymentServiceContract}; gateways submit
 * verified settlements through {@link PaymentServiceContract.settle}.
 */
export class PaymentsService implements PaymentServiceContract {
  constructor(private readonly options: PaymentServiceOptions) {}

  // ---------------------------------------------------------------------------
  // Provider / URL helpers
  // ---------------------------------------------------------------------------

  private providers(): PaymentProvider[] {
    return this.options.getProviders();
  }

  private providerFor(providerId: string, method: string): PaymentProvider {
    const provider = this.providers().find((candidate) => candidate.id === providerId);
    if (!provider || !provider.getMethods().some((candidate) => candidate.id === method)) {
      throw new PaymentError(400, '所选支付方式不可用');
    }
    return provider;
  }

  private isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  private publicUrl(
    variable: 'STACKPANEL_PUBLIC_URL' | 'STACKPANEL_API_PUBLIC_URL',
    fallback: string,
  ): URL {
    let url: URL;
    try {
      url = new URL(process.env[variable] ?? fallback);
    } catch {
      throw new PaymentError(503, `${variable} is invalid`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (this.isProduction() && url.protocol !== 'https:')
    ) {
      throw new PaymentError(
        503,
        `${variable} must use ${this.isProduction() ? 'HTTPS' : 'HTTP or HTTPS'}`,
      );
    }
    return url;
  }

  private providerUrls(
    provider: PaymentProvider,
    returnPath: string,
  ): { notifyUrl: string; returnUrl: string } {
    if (!provider.callbackPath.startsWith('/') || provider.callbackPath.startsWith('//')) {
      throw new PaymentError(503, '支付渠道回调配置无效');
    }
    const web = this.publicUrl('STACKPANEL_PUBLIC_URL', 'http://127.0.0.1:3000');
    const api = this.publicUrl('STACKPANEL_API_PUBLIC_URL', 'http://127.0.0.1:3001');
    return {
      notifyUrl: new URL(provider.callbackPath, api).toString(),
      returnUrl: new URL(returnPath, web).toString(),
    };
  }

  private validPaymentUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PaymentError(502, '支付渠道返回了无效的支付链接');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (this.isProduction() && url.protocol !== 'https:')
    ) {
      throw new PaymentError(502, '支付渠道返回了不安全的支付链接');
    }
    return url.toString();
  }

  private isDefinitiveProviderFailure(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'definitive' in error &&
      (error as { definitive?: unknown }).definitive === true
    );
  }

  /**
   * The provider's own reason for refusing/failing, surfaced to the buyer
   * instead of a generic sentence. Provider plugins (e.g. `epay`) put the
   * gateway's business message on `error.message`; a network fault is already
   * normalised by the provider, so this only lifts curated text.
   */
  private providerReason(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim().length > 0) {
        return message.trim().slice(0, 500);
      }
    }
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // Public contract
  // ---------------------------------------------------------------------------

  listPaymentMethods(): PaymentMethodListing {
    return {
      wallet: { id: 'wallet', label: '余额支付' },
      providers: this.providers().map((provider) => ({
        id: provider.id,
        name: provider.name,
        methods: provider.getMethods(),
      })),
    };
  }

  async createRecord(input: ExternalPaymentCreateInput, tx?: Tx): Promise<ExternalPaymentRecord> {
    if (
      !Number.isSafeInteger(input.amount) ||
      input.amount <= 0 ||
      input.amount > MAX_MINOR_AMOUNT
    ) {
      throw new PaymentError(400, '金额无效');
    }
    const provider = this.providerFor(input.providerId, input.paymentMethod);
    const db = tx ?? this.options.db;
    const merchantOrderNo = `sp_${input.purpose === 'TOP_UP' ? 'top' : 'ord'}_${randomUUID().replaceAll('-', '')}`;
    const record = await db.payment.create({
      data: {
        purpose: input.purpose,
        userId: input.userId,
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...(input.methodId ? { methodId: input.methodId } : {}),
        gateway: provider.id,
        providerId: provider.id,
        paymentMethod: input.paymentMethod,
        merchantOrderNo,
        amount: input.amount,
        currency: input.currency,
        ...(input.orderCurrency ? { orderCurrency: input.orderCurrency } : {}),
        ...(input.orderAmount !== undefined ? { orderAmount: input.orderAmount } : {}),
        ...(input.fxRate != null ? { fxRate: input.fxRate } : {}),
        status: 'PENDING',
        expiresAt: new Date(Date.now() + EXTERNAL_PAYMENT_TTL_MS),
      },
    });
    return {
      id: record.id,
      merchantOrderNo: record.merchantOrderNo as string,
      amount: record.amount,
      currency: record.currency,
    };
  }

  async initiate(
    paymentId: string,
    options: { returnPath: string; subject: string; clientIp?: string },
  ): Promise<ExternalPaymentCreated> {
    const payment = await this.options.db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new PaymentError(404, '支付记录不存在');
    if (payment.status !== 'PENDING') throw new PaymentError(409, '支付已处理');
    const provider = this.providerFor(
      payment.providerId as string,
      payment.paymentMethod as string,
    );
    const urls = this.providerUrls(provider, options.returnPath);
    const method = payment.methodId
      ? await this.options.db.paymentMethod.findUnique({ where: { id: payment.methodId } })
      : null;
    const config = method?.config;
    try {
      const initiated = await provider.createPayment(
        {
          purpose: payment.purpose as 'ORDER' | 'TOP_UP',
          merchantOrderNo: payment.merchantOrderNo as string,
          amount: payment.amount,
          currency: payment.currency,
          method: payment.paymentMethod as string,
          subject: options.subject,
          ...urls,
          ...(options.clientIp ? { clientIp: options.clientIp } : {}),
        },
        config,
      );

      // Manual methods (bank transfer / QR code) do not call a live gateway:
      // they return buyer instructions and the payment stays PENDING until an
      // admin confirms receipt.
      if ('mode' in initiated && initiated.mode === 'manual') {
        const updated = await this.options.db.payment.update({
          where: { id: payment.id },
          data: { paymentUrl: null },
        });
        return this.toCreated(updated, initiated.instructions);
      }

      const paymentUrl = this.validPaymentUrl((initiated as { paymentUrl: string }).paymentUrl);
      const updated = await this.options.db.payment.update({
        where: { id: payment.id },
        data: {
          externalId: (initiated as { externalId: string }).externalId,
          paymentUrl,
          ...((initiated as { expiresAt?: Date }).expiresAt
            ? { expiresAt: (initiated as { expiresAt: Date }).expiresAt }
            : {}),
        },
      });
      return this.toCreated(updated);
    } catch (error) {
      if (this.isDefinitiveProviderFailure(error)) {
        await this.options.db.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        // Restore merchant side-effects (order cancel + stock) through the same
        // release dispatch used by the expiry sweep.
        await this.dispatchRelease(payment);
        throw new PaymentError(
          502,
          this.providerReason(error, '支付渠道拒绝了订单'),
          'definitive',
          'payment.rejected',
        );
      }
      await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'REVIEW' },
      });
      // Our own post-call validation (e.g. an unsafe payment URL) already
      // carries a specific code/message; keep it after flagging for review
      // instead of overwriting it with a generic provider-failure sentence.
      if (isPaymentError(error)) throw error;
      throw new PaymentError(
        502,
        this.providerReason(error, '支付状态无法确认；订单已挂起待对账'),
        'undetermined',
      );
    }
  }

  async create(input: ExternalPaymentCreateInput): Promise<ExternalPaymentCreated> {
    const record = await this.createRecord(input);
    return this.initiate(record.id, {
      returnPath: input.returnPath,
      subject: input.subject,
      ...(input.clientIp ? { clientIp: input.clientIp } : {}),
    });
  }

  async settle(input: PaymentSettlement): Promise<PaymentSettleResult> {
    if (
      !Number.isSafeInteger(input.amount) ||
      input.amount <= 0 ||
      input.amount > MAX_MINOR_AMOUNT
    ) {
      throw new PaymentError(400, '结算金额无效');
    }
    const payment = await this.options.db.payment.findUnique({
      where: { merchantOrderNo: input.merchantOrderNo },
    });
    if (!payment) throw new PaymentError(404, '支付记录不存在');
    if (
      payment.providerId !== input.providerId ||
      payment.amount !== input.amount ||
      payment.currency !== input.currency
    ) {
      throw new PaymentError(409, '结算信息不匹配');
    }

    if (payment.purpose === 'TOP_UP') {
      // Top-ups are kernel-owned end to end: settle and credit the wallet in
      // one transaction (idempotent via the TOP_UP:<paymentId> ledger ref).
      const applied = await this.options.db.$transaction(async (tx) => {
        const gate = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: [...EXTERNAL_PAYMENT_STATUSES] } },
          data: { status: 'PAID', externalId: input.externalId },
        });
        if (gate.count === 0) return false;
        await this.options.wallet.credit(
          payment.userId,
          payment.amount,
          payment.currency,
          {
            type: 'TOP_UP',
            referenceType: 'TOP_UP',
            referenceId: payment.id,
            note: `Top-up ${payment.merchantOrderNo}`,
          },
          tx,
        );
        return true;
      });
      return { applied, purpose: 'TOP_UP' };
    }

    // ORDER payments: the kernel claims the payment, then dispatches the
    // commerce-owned settlement handler synchronously before the callback reply.
    const gate = await this.options.db.payment.updateMany({
      where: { id: payment.id, status: { in: [...EXTERNAL_PAYMENT_STATUSES] } },
      data: { status: 'PAID', externalId: input.externalId },
    });
    if (gate.count === 0) return { applied: false, purpose: 'ORDER' };

    const settlement = this.resolveSettlement(payment);
    let dispatched = false;
    for (const handler of this.options.getSettlementHandlers()) {
      try {
        const result = await handler.settle(settlement);
        if (result.applied) {
          dispatched = true;
          break;
        }
      } catch (error) {
        this.options.logger?.error(
          `payments: settlement handler failed for ${payment.id}: ${String(error)}`,
        );
      }
    }
    if (!dispatched) {
      // No merchant handler applied: revert to REVIEW so the money is not lost.
      await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'PAID' },
        data: { status: 'REVIEW' },
      });
      return { applied: false, purpose: 'ORDER' };
    }
    this.options.events.publish('payment.settled', {
      orderId: payment.orderId,
      paymentId: payment.id,
    });
    return { applied: true, purpose: 'ORDER' };
  }

  async cancelExternalPayment(orderId: string): Promise<ExternalPaymentCancelResult> {
    const payment = await this.options.db.payment.findFirst({
      where: { orderId, status: { in: [...CANCEL_PAYMENT_STATUSES] } },
    });
    if (!payment?.providerId || !payment.paymentMethod || !payment.merchantOrderNo) {
      return { cancelled: false, reason: 'NOT_CANCELLABLE' };
    }
    const provider = this.providers().find((candidate) => candidate.id === payment.providerId);
    if (!provider?.closePayment) return { cancelled: false, reason: 'UNSUPPORTED' };

    // Phase 1: atomically take the payment out of executable statuses so a
    // concurrent settle/release can no longer claim it, then persist.
    const claimed = await this.options.db.payment.updateMany({
      where: { id: payment.id, status: { in: [...CANCEL_PAYMENT_STATUSES] } },
      data: { status: 'CANCELLING' },
    });
    if (claimed.count === 0) return { cancelled: false, reason: 'STILL_PROCESSING' };

    let closed: boolean;
    try {
      closed = await provider.closePayment({
        merchantOrderNo: payment.merchantOrderNo,
        externalId: payment.externalId,
      });
    } catch (error) {
      // A gateway/network error must not leave the payment stuck in CANCELLING
      // (the expiry sweep only reclaims PENDING/REVIEW). Revert to REVIEW so the
      // payment can be released by the sweep or reconciled by an admin later.
      this.options.logger?.warn(
        `payments: cancel external payment failed for ${payment.id}: ${String(error)}`,
      );
      await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'CANCELLING' },
        data: { status: 'REVIEW' },
      });
      return { cancelled: false, reason: 'STILL_PROCESSING' };
    }
    if (!closed) {
      await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'CANCELLING' },
        data: { status: 'REVIEW' },
      });
      return { cancelled: false, reason: 'STILL_PROCESSING' };
    }

    const cancelled = await this.options.db.payment.updateMany({
      where: { id: payment.id, status: 'CANCELLING' },
      data: { status: 'CANCELLED', externalId: payment.externalId },
    });
    if (cancelled.count === 0) return { cancelled: false, reason: 'STILL_PROCESSING' };
    return { cancelled: true };
  }

  async cancelTopUp(paymentId: string, userId: string): Promise<ExternalTopUpCancelResult> {
    const payment = await this.options.db.payment.findFirst({
      where: {
        id: paymentId,
        userId,
        purpose: 'TOP_UP',
        status: { in: [...EXTERNAL_PAYMENT_STATUSES] },
      },
    });
    if (!payment?.providerId || !payment.paymentMethod || !payment.merchantOrderNo) {
      return { cancelled: false, reason: 'NOT_CANCELLABLE' };
    }
    const provider = this.providers().find((candidate) => candidate.id === payment.providerId);
    if (!provider?.closePayment) return { cancelled: false, reason: 'UNSUPPORTED' };

    let closed: boolean;
    try {
      closed = await provider.closePayment({
        merchantOrderNo: payment.merchantOrderNo,
        externalId: payment.externalId,
      });
    } catch (error) {
      this.options.logger?.warn(
        `payments: cancel top-up failed for ${payment.id}: ${String(error)}`,
      );
      return { cancelled: false, reason: 'STILL_PROCESSING' };
    }
    if (!closed) return { cancelled: false, reason: 'STILL_PROCESSING' };

    const updated = await this.options.db.payment.updateMany({
      where: { id: payment.id, status: { in: [...EXTERNAL_PAYMENT_STATUSES] } },
      data: { status: 'CANCELLED' },
    });
    if (updated.count !== 1) return { cancelled: false, reason: 'STILL_PROCESSING' };
    return { cancelled: true };
  }

  async listTopUps(userId: string, limit = 30): Promise<WalletTopUpView[]> {
    const rows = await this.options.db.payment.findMany({
      where: { userId, purpose: 'TOP_UP' },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      currency: row.currency,
      providerId: row.providerId,
      paymentMethod: row.paymentMethod,
      paymentUrl: row.paymentUrl,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getProviderConfig(providerId: string): Promise<unknown | null> {
    const method = await this.options.db.paymentMethod.findFirst({
      where: { providerId, enabled: true },
    });
    return method?.config ?? null;
  }

  async listByOrderIds(orderIds: string[]): Promise<PaymentOrderLink[]> {
    if (orderIds.length === 0) return [];
    const rows = await this.options.db.payment.findMany({
      where: { orderId: { in: orderIds } },
    });
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      paymentUrl: row.paymentUrl,
      paymentMethod: row.paymentMethod,
      providerId: row.providerId,
      amount: row.amount,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async listChannelMethods(code: string): Promise<SalesChannelView | null> {
    const channel = await this.options.db.salesChannel.findUnique({
      where: { code },
      include: { methods: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!channel) return null;
    return {
      code: channel.code,
      name: channel.name,
      enabled: channel.enabled,
      methods: channel.methods.map((method) => ({
        id: method.id,
        providerId: method.providerId,
        name: method.name,
        scene: method.scene,
        enabled: method.enabled,
        sortOrder: method.sortOrder,
      })),
    };
  }

  async sweepExpired(): Promise<number> {
    const now = new Date();
    const manualIds = this.manualProviders().map((candidate) => candidate.id);
    const stalePayments = await this.options.db.payment.findMany({
      where: {
        status: { in: [...EXTERNAL_PAYMENT_STATUSES] },
        expiresAt: { not: null, lt: now },
        gateway: { not: 'wallet' },
        ...(manualIds.length ? { providerId: { notIn: manualIds } } : {}),
      },
      take: 200,
    });
    let released = 0;
    for (const payment of stalePayments) {
      try {
        if (payment.purpose === 'TOP_UP') {
          // No merchant side-effects: cancel directly (fixes expired top-ups
          // never being released).
          const gate = await this.options.db.payment.updateMany({
            where: { id: payment.id, status: { in: [...EXTERNAL_PAYMENT_STATUSES] } },
            data: { status: 'CANCELLED' },
          });
          if (gate.count > 0) released += 1;
          continue;
        }
        const claimed = await this.options.db.payment.updateMany({
          where: { id: payment.id, status: { in: [...EXTERNAL_PAYMENT_STATUSES] } },
          data: { status: 'CANCELLING' },
        });
        if (claimed.count === 0) continue;
        const applied = await this.dispatchRelease(payment);
        if (applied) {
          await this.options.db.payment.updateMany({
            where: { id: payment.id, status: 'CANCELLING' },
            data: { status: 'CANCELLED' },
          });
          released += 1;
        } else {
          await this.options.db.payment.updateMany({
            where: { id: payment.id, status: 'CANCELLING' },
            data: { status: 'PENDING' },
          });
        }
      } catch (error) {
        this.options.logger?.warn(
          `payments: expired payment sweep failed for ${payment.id}: ${String(error)}`,
        );
      }
    }
    if (released > 0) {
      this.options.logger?.info(`payments: released ${released} expired payment(s)`);
    }
    return released;
  }

  // ---------------------------------------------------------------------------
  // Manual payments (admin confirmation)
  // ---------------------------------------------------------------------------

  private manualProviders(): PaymentProvider[] {
    return this.providers().filter((candidate) => candidate.mode === 'manual');
  }

  private isManualPayment(payment: PaymentRow): boolean {
    if (!payment.providerId) return false;
    return this.manualProviders().some((candidate) => candidate.id === payment.providerId);
  }

  async confirmManual(paymentId: string): Promise<AdminPaymentConfirmResult> {
    const payment = await this.options.db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { confirmed: false, reason: 'NOT_FOUND' };
    if (!this.isManualPayment(payment)) return { confirmed: false, reason: 'NOT_MANUAL' };
    if (payment.status !== 'PENDING') return { confirmed: false, reason: 'NOT_PENDING' };

    if (payment.purpose === 'TOP_UP') {
      const applied = await this.options.db.$transaction(async (tx) => {
        const gate = await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'PAID' },
        });
        if (gate.count === 0) return false;
        await this.options.wallet.credit(
          payment.userId,
          payment.amount,
          payment.currency,
          {
            type: 'TOP_UP',
            referenceType: 'TOP_UP',
            referenceId: payment.id,
            note: `Manual top-up ${payment.merchantOrderNo}`,
          },
          tx,
        );
        return true;
      });
      if (!applied) return { confirmed: false, reason: 'NOT_PENDING' };
      this.options.events.publish('payment.settled', {
        orderId: payment.orderId,
        paymentId: payment.id,
      });
      return { confirmed: true };
    }

    const gate = await this.options.db.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'PAID' },
    });
    if (gate.count === 0) return { confirmed: false, reason: 'NOT_PENDING' };

    const settlement = this.resolveSettlement(payment);
    let dispatched = false;
    for (const handler of this.options.getSettlementHandlers()) {
      try {
        const result = await handler.settle(settlement);
        if (result.applied) {
          dispatched = true;
          break;
        }
      } catch (error) {
        this.options.logger?.error(
          `payments: confirm manual settlement handler failed for ${payment.id}: ${String(error)}`,
        );
      }
    }
    if (!dispatched) {
      await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'PAID' },
        data: { status: 'REVIEW' },
      });
      return { confirmed: false, reason: 'NOT_PENDING' };
    }
    this.options.events.publish('payment.settled', {
      orderId: payment.orderId,
      paymentId: payment.id,
    });
    return { confirmed: true };
  }

  async cancelManual(paymentId: string): Promise<AdminPaymentCancelResult> {
    const payment = await this.options.db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { cancelled: false, reason: 'NOT_FOUND' };
    if (!this.isManualPayment(payment)) return { cancelled: false, reason: 'NOT_MANUAL' };
    if (payment.status !== 'PENDING') return { cancelled: false, reason: 'NOT_PENDING' };

    if (payment.purpose === 'TOP_UP') {
      const gate = await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      return gate.count > 0 ? { cancelled: true } : { cancelled: false, reason: 'NOT_PENDING' };
    }

    const claimed = await this.options.db.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'CANCELLING' },
    });
    if (claimed.count === 0) return { cancelled: false, reason: 'NOT_PENDING' };
    const applied = await this.dispatchRelease(payment);
    if (applied) {
      await this.options.db.payment.updateMany({
        where: { id: payment.id, status: 'CANCELLING' },
        data: { status: 'CANCELLED' },
      });
      return { cancelled: true };
    }
    await this.options.db.payment.updateMany({
      where: { id: payment.id, status: 'CANCELLING' },
      data: { status: 'PENDING' },
    });
    return { cancelled: false, reason: 'NOT_PENDING' };
  }

  // ---------------------------------------------------------------------------
  // Expiry sweep
  // ---------------------------------------------------------------------------
  //
  // The sweep is no longer an in-process timer: S6 schedules `payments.sweep-expired`
  // as a BullMQ recurring job so it runs once across the cluster. The job handler
  // calls {@link sweepExpired} directly.

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private toCreated(
    payment: PaymentRow,
    manualInstructions?: ManualPaymentInstructions,
  ): ExternalPaymentCreated {
    return {
      id: payment.id,
      merchantOrderNo: payment.merchantOrderNo as string,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      paymentUrl: payment.paymentUrl as string,
      providerId: payment.providerId as string,
      paymentMethod: payment.paymentMethod as string,
      ...(manualInstructions ? { manualInstructions } : {}),
      ...(payment.expiresAt ? { expiresAt: payment.expiresAt.toISOString() } : {}),
      createdAt: payment.createdAt.toISOString(),
    };
  }

  private resolveSettlement(payment: PaymentRow): ResolvedPaymentSettlement {
    return {
      providerId: payment.providerId as string,
      merchantOrderNo: payment.merchantOrderNo as string,
      externalId: payment.externalId as string,
      amount: payment.amount,
      currency: payment.currency,
      paymentId: payment.id,
      purpose: payment.purpose as 'ORDER' | 'TOP_UP',
      userId: payment.userId,
      orderId: payment.orderId,
    };
  }

  /** Dispatch release to commerce-owned handlers (order cancel + stock restore). */
  private async dispatchRelease(payment: PaymentRow): Promise<boolean> {
    const settlement = this.resolveSettlement(payment);
    for (const handler of this.options.getSettlementHandlers()) {
      if (typeof handler.release === 'function') {
        try {
          const result = await handler.release(settlement);
          if (result.applied) return true;
        } catch (error) {
          this.options.logger?.warn(
            `payments: release handler failed for ${payment.id}: ${String(error)}`,
          );
        }
      }
    }
    return false;
  }
}

export type { PaymentMethod, PaymentSettlement };
