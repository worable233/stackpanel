import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@stackpanel/db';
import type { WalletAccount, WalletHold, WalletLedgerEntry, WalletLedgerRef } from '@stackpanel/sdk';
import { WalletError } from '@stackpanel/sdk';
import { writeAudit } from '../plugins/audit.ts';

const MAX_MINOR_AMOUNT = 2_000_000_000;

/**
 * Default pre-authorization lifetime. Comfortably longer than any single
 * upstream LLM call (which the gateway bounds at 60s), short enough that a
 * crashed request cannot freeze funds for a meaningful amount of time.
 */
const DEFAULT_HOLD_TTL_MS = 15 * 60_000;
/** Hard ceiling on a caller-supplied hold TTL; keeps the sweep workload bounded. */
const MAX_HOLD_TTL_MS = 60 * 60_000;

type Tx = Prisma.TransactionClient | PrismaClient;

type WalletHoldRow = {
  id: string;
  userId: string;
  currency: string;
  amount: number;
  status: string;
  settledAmount: number | null;
  referenceType: string;
  referenceId: string;
  note: string | null;
  expiresAt: Date;
  settledAt: Date | null;
  createdAt: Date;
};

export interface WalletServiceOptions {
  db: PrismaClient;
}

/** Prisma surfaces a unique-index conflict as P2002. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Kernel-owned wallet service. Owns `wallet_accounts` and
 * `wallet_ledger_entries`; exposes atomic, idempotent money movement. Ledger
 * entries are idempotent via the unique `(referenceType, referenceId)`
 * constraint, so the same business reference can affect a wallet exactly once.
 *
 * Pre-authorization (`hold`/`settleHold`/`releaseHold`, ADR-0022 P16) adds a
 * second idempotency key of the same shape on `wallet_holds`, so the whole
 * hold → settle flow is safe under retries and duplicate delivery.
 */
export class WalletService {
  constructor(private readonly options: WalletServiceOptions) {}

  private assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MINOR_AMOUNT) {
      throw new WalletError(400, '金额无效');
    }
  }

  private toAccount(
    account: { userId: string; currency: string; balance: number; held: number },
  ): WalletAccount {
    return {
      userId: account.userId,
      currency: account.currency,
      balance: account.balance,
      held: account.held,
    };
  }

  private toHold(row: WalletHoldRow): WalletHold {
    return {
      id: row.id,
      userId: row.userId,
      currency: row.currency,
      amount: row.amount,
      status: row.status,
      settledAmount: row.settledAmount,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      note: row.note,
      expiresAt: row.expiresAt,
      settledAt: row.settledAt,
      createdAt: row.createdAt,
    };
  }

  async getAccount(userId: string, currency = 'CNY'): Promise<WalletAccount | null> {
    const account = await this.options.db.walletAccount.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    return account ? this.toAccount(account) : null;
  }

  /**
   * Freeze `amount` from the balance (ADR-0022 P16).
   *
   * Freezing moves the amount out of `balance` and into `held`, so a concurrent
   * request sees the reduced balance and is rejected **before** it consumes an
   * upstream call — instead of both requests passing a stale balance check and
   * one of them producing a write-off.
   *
   * Idempotent per `ref`. A duplicate call (retry, at-least-once delivery)
   * returns the existing hold and never freezes twice.
   */
  async hold(
    userId: string,
    amount: number,
    currency: string,
    ref: WalletLedgerRef,
    options: { ttlMs?: number; note?: string; tx?: Tx } = {},
  ): Promise<WalletHold> {
    this.assertAmount(amount);
    const ttlMs = Math.min(Math.max(options.ttlMs ?? DEFAULT_HOLD_TTL_MS, 1_000), MAX_HOLD_TTL_MS);
    const expiresAt = new Date(Date.now() + ttlMs);
    const run = async (t: Prisma.TransactionClient): Promise<WalletHold> => {
      // Hot path (ADR-0022 P16): one conditional UPDATE decides both "is there
      // enough balance" and "freeze it". Reading the row first, or upserting the
      // account before writing, would add round-trips to every proxied request
      // for a case that only matters when the account does not exist yet.
      const frozen = await t.walletAccount.updateMany({
        where: { userId, currency, balance: { gte: amount } },
        data: { balance: { decrement: amount }, held: { increment: amount } },
      });
      if (frozen.count === 0) {
        // Distinguish "no account yet" from "too poor to freeze". Creating the
        // empty account preserves the old upsert semantics so a first-ever
        // caller gets a helpful failure rather than a missing-row one.
        const account = await t.walletAccount.findUnique({
          where: { userId_currency: { userId, currency } },
        });
        if (!account) {
          await t.walletAccount.create({ data: { userId, currency, balance: 0 } });
        }
        throw new WalletError(409, '钱包余额不足');
      }

      const created = await t.walletHold.create({
        data: {
          userId,
          currency,
          amount,
          status: 'HELD',
          referenceType: ref.referenceType,
          referenceId: ref.referenceId,
          ...(options.note ?? ref.note ? { note: options.note ?? ref.note } : {}),
          expiresAt,
        },
      });
      return this.toHold(created);
    };
    if (options.tx) return run(options.tx as Prisma.TransactionClient);
    try {
      return await this.options.db.$transaction(run);
    } catch (error) {
      // Lost a race on the `(referenceType, referenceId)` unique index: another
      // caller froze the same reference first, so return theirs.
      if (isUniqueViolation(error)) {
        const existing = await this.options.db.walletHold.findUnique({
          where: {
            referenceType_referenceId: {
              referenceType: ref.referenceType,
              referenceId: ref.referenceId,
            },
          },
        });
        if (existing) return this.toHold(existing);
      }
      throw error;
    }
  }

  /**
   * Settle a hold for the amount actually consumed and return the remainder to
   * the balance. Idempotent: an already-settled/released hold is returned as-is.
   *
   * The state transition itself (`HELD` → `SETTLED`, guarded by `status: 'HELD'`
   * in the WHERE clause) is what makes the refund and the ledger row happen
   * exactly once, so no additional dedupe key is needed.
   */
  async settleHold(
    holdId: string,
    settledAmount: number,
    ref?: WalletLedgerRef,
    tx?: Tx,
  ): Promise<WalletHold | null> {
    if (!Number.isSafeInteger(settledAmount) || settledAmount < 0) {
      throw new WalletError(400, '金额无效');
    }
    const run = async (t: Prisma.TransactionClient): Promise<WalletHold | null> => {
      const hold = await t.walletHold.findUnique({ where: { id: holdId } });
      if (!hold) return null;
      if (hold.status !== 'HELD') return this.toHold(hold);

      const settled = Math.min(settledAmount, hold.amount);
      const refund = hold.amount - settled;
      const claimed = await t.walletHold.updateMany({
        where: { id: holdId, status: 'HELD' },
        data: { status: 'SETTLED', settledAmount: settled, settledAt: new Date() },
      });
      if (claimed.count === 0) {
        // Another caller settled it between our read and our write.
        const current = await t.walletHold.findUnique({ where: { id: holdId } });
        return current ? this.toHold(current) : null;
      }
      await t.walletAccount.update({
        where: { userId_currency: { userId: hold.userId, currency: hold.currency } },
        data: {
          held: { decrement: hold.amount },
          ...(refund > 0 ? { balance: { increment: refund } } : {}),
        },
      });
      if (settled > 0) {
        await t.walletLedgerEntry.create({
          data: {
            userId: hold.userId,
            amount: -settled,
            currency: hold.currency,
            type: ref?.type ?? 'wallet_hold_settle',
            referenceType: ref?.referenceType ?? hold.referenceType,
            referenceId: ref?.referenceId ?? hold.referenceId,
            ...(ref?.note ?? hold.note ? { note: ref?.note ?? hold.note } : {}),
          },
        });
      }
      const updated = await t.walletHold.findUniqueOrThrow({ where: { id: holdId } });
      return this.toHold(updated);
    };
    return tx ? run(tx as Prisma.TransactionClient) : this.options.db.$transaction(run);
  }

  /** Release a hold in full: the operation failed before consuming anything. */
  async releaseHold(holdId: string, tx?: Tx): Promise<WalletHold | null> {
    return this.finishHold(holdId, 'RELEASED', tx);
  }

  /**
   * Return expired holds to the balance. Runs as a kernel sweep so that a
   * crashed request (process killed between hold and settle) cannot freeze a
   * user's funds forever. Batched; a remote hold is skipped if another replica
   * claimed it first.
   */
  async sweepExpiredHolds(limit = 200): Promise<number> {
    const expired = await this.options.db.walletHold.findMany({
      where: { status: 'HELD', expiresAt: { lt: new Date() } },
      select: { id: true },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
    let released = 0;
    for (const row of expired) {
      const result = await this.finishHold(row.id, 'EXPIRED');
      if (result && result.status === 'EXPIRED') released += 1;
    }
    return released;
  }

  private async finishHold(
    holdId: string,
    status: 'RELEASED' | 'EXPIRED',
    tx?: Tx,
  ): Promise<WalletHold | null> {
    const run = async (t: Prisma.TransactionClient): Promise<WalletHold | null> => {
      const hold = await t.walletHold.findUnique({ where: { id: holdId } });
      if (!hold) return null;
      if (hold.status !== 'HELD') return this.toHold(hold);
      const claimed = await t.walletHold.updateMany({
        where: { id: holdId, status: 'HELD' },
        data: { status, settledAmount: 0, settledAt: new Date() },
      });
      if (claimed.count === 0) {
        const current = await t.walletHold.findUnique({ where: { id: holdId } });
        return current ? this.toHold(current) : null;
      }
      await t.walletAccount.update({
        where: { userId_currency: { userId: hold.userId, currency: hold.currency } },
        data: { held: { decrement: hold.amount }, balance: { increment: hold.amount } },
      });
      const updated = await t.walletHold.findUniqueOrThrow({ where: { id: holdId } });
      return this.toHold(updated);
    };
    return tx ? run(tx as Prisma.TransactionClient) : this.options.db.$transaction(run);
  }

  /**
   * Atomically debit a user's balance. Throws {@link WalletError} (409) when the
   * balance is insufficient. Joins the caller's transaction when `tx` is provided.
   */
  async debit(
    userId: string,
    amount: number,
    currency: string,
    ref: WalletLedgerRef,
    tx?: Tx,
  ): Promise<WalletAccount> {
    this.assertAmount(amount);
    const run = async (t: Prisma.TransactionClient): Promise<WalletAccount> => {
      await t.walletAccount.upsert({
        where: { userId_currency: { userId, currency } },
        create: { userId, currency, balance: 0 },
        update: {},
      });
      const updated = await t.walletAccount.updateMany({
        where: { userId, currency, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (updated.count === 0) throw new WalletError(409, '钱包余额不足');
      await t.walletLedgerEntry.create({
        data: {
          userId,
          amount: -amount,
          currency,
          type: ref.type,
          referenceType: ref.referenceType,
          referenceId: ref.referenceId,
          ...(ref.note ? { note: ref.note } : {}),
        },
      });
      const account = await t.walletAccount.findUniqueOrThrow({
        where: { userId_currency: { userId, currency } },
      });
      return this.toAccount(account);
    };
    return tx ? run(tx) : this.options.db.$transaction(run);
  }

  /** Atomically credit a user's balance (idempotent per `ref`). */
  async credit(
    userId: string,
    amount: number,
    currency: string,
    ref: WalletLedgerRef,
    tx?: Tx,
  ): Promise<WalletAccount> {
    this.assertAmount(amount);
    const run = async (t: Prisma.TransactionClient): Promise<WalletAccount> => {
      const account = await t.walletAccount.upsert({
        where: { userId_currency: { userId, currency } },
        create: { userId, currency, balance: amount },
        update: { balance: { increment: amount } },
      });
      await t.walletLedgerEntry.create({
        data: {
          userId,
          amount,
          currency,
          type: ref.type,
          referenceType: ref.referenceType,
          referenceId: ref.referenceId,
          ...(ref.note ? { note: ref.note } : {}),
        },
      });
      return this.toAccount(account);
    };
    return tx ? run(tx) : this.options.db.$transaction(run);
  }

  /** Apply an administrator adjustment (positive or negative) with an audit entry. */
  async adjust(input: {
    userId: string;
    amount: number;
    currency: string;
    note: string;
    actorId?: string;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.amount) || input.amount === 0 || Math.abs(input.amount) > MAX_MINOR_AMOUNT) {
      throw new WalletError(400, '钱包调整参数无效');
    }
    const { userId, amount, currency, note } = input;
    await this.options.db.$transaction(async (t) => {
      await t.walletAccount.upsert({
        where: { userId_currency: { userId, currency } },
        create: { userId, currency, balance: 0 },
        update: {},
      });
      if (amount < 0) {
        const updated = await t.walletAccount.updateMany({
          where: { userId, currency, balance: { gte: -amount } },
          data: { balance: { decrement: -amount } },
        });
        if (updated.count === 0) throw new WalletError(409, '钱包余额不能为负');
      } else if (amount > 0) {
        await t.walletAccount.update({
          where: { userId_currency: { userId, currency } },
          data: { balance: { increment: amount } },
        });
      }
      await t.walletLedgerEntry.create({
        data: {
          userId,
          amount,
          currency,
          type: 'ADMIN_ADJUST',
          referenceType: 'ADMIN_ADJUST',
          referenceId: randomUUID(),
          note,
        },
      });
    });
    await writeAudit({
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: 'wallet.adjust',
      resource: 'wallet',
      resourceId: userId,
      meta: { amount, currency, note },
    });
  }

  /** List recent wallet accounts for admin views. */
  async listAccounts(limit = 50): Promise<Array<WalletAccount & { email: string }>> {
    const accounts = await this.options.db.walletAccount.findMany({
      take: limit,
      orderBy: { updatedAt: 'desc' },
    });
    const users = await this.options.db.user.findMany({
      where: { id: { in: accounts.map((account) => account.userId) } },
      select: { id: true, email: true },
    });
    const emailById = new Map(users.map((user) => [user.id, user.email]));
    return accounts.map((account) => ({
      ...this.toAccount(account),
      email: emailById.get(account.userId) ?? account.userId,
    }));
  }

  /** List a user's recent ledger entries. */
  async listLedger(userId: string, limit = 50): Promise<WalletLedgerEntry[]> {
    const entries = await this.options.db.walletLedgerEntry.findMany({
      where: { userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return entries.map((entry) => ({
      id: entry.id,
      amount: entry.amount,
      currency: entry.currency,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      note: entry.note,
      createdAt: entry.createdAt,
    }));
  }
}