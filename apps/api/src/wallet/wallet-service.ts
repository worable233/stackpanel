import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@stackpanel/db';
import type { WalletAccount, WalletLedgerEntry, WalletLedgerRef } from '@stackpanel/sdk';
import { WalletError } from '@stackpanel/sdk';
import { writeAudit } from '../plugins/audit.ts';

const MAX_MINOR_AMOUNT = 2_000_000_000;

type Tx = Prisma.TransactionClient | PrismaClient;

export interface WalletServiceOptions {
  db: PrismaClient;
}

/**
 * Kernel-owned wallet service. Owns `wallet_accounts` and
 * `wallet_ledger_entries`; exposes atomic, idempotent money movement. Ledger
 * entries are idempotent via the unique `(referenceType, referenceId)`
 * constraint, so the same business reference can affect a wallet exactly once.
 */
export class WalletService {
  constructor(private readonly options: WalletServiceOptions) {}

  private assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MINOR_AMOUNT) {
      throw new WalletError(400, '金额无效');
    }
  }

  private toAccount(
    account: { userId: string; currency: string; balance: number },
  ): WalletAccount {
    return { userId: account.userId, currency: account.currency, balance: account.balance };
  }

  async getAccount(userId: string, currency = 'CNY'): Promise<WalletAccount | null> {
    const account = await this.options.db.walletAccount.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    return account ? this.toAccount(account) : null;
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