/**
 * Kernel-owned wallet service contract.
 *
 * The kernel owns the `wallet_accounts` and `wallet_ledger_entries` tables and
 * exposes atomic, idempotent money movement through `ctx.wallet`. Any plugin
 * (store order payment, store-wallet top-up, ticket refunds, rewards, …) can
 * debit/credit safely without touching the tables directly.
 *
 * Ledger entries are idempotent via the unique `(referenceType, referenceId)`
 * constraint: the same business reference can affect a wallet exactly once.
 */

import { KernelError, brandSdkErrorClass, isSdkErrorClass } from './errors.js';

/** Identifies the business reason for a ledger entry. */
export interface WalletLedgerRef {
  type: string;
  referenceType: string;
  referenceId: string;
  note?: string;
}

/**
 * Stable, machine-readable codes for wallet errors (ADR-0012). The kernel
 * throws `WalletError(status, message)` in a handful of places; mapping the
 * stable message to a code here centralises the vocabulary.
 */
const WALLET_ERROR_CODES: Record<string, string> = {
  金额无效: 'wallet.amount_invalid',
  钱包余额不足: 'wallet.insufficient_balance',
  钱包调整参数无效: 'wallet.adjustment_invalid',
  钱包余额不能为负: 'wallet.balance_negative',
};

/** Error thrown by the kernel wallet service. Carries an HTTP status + display message. */
export class WalletError extends KernelError {
  constructor(status: number, message: string) {
    super(WALLET_ERROR_CODES[message] ?? 'wallet.error', status, message);
    this.name = 'WalletError';
  }
}

brandSdkErrorClass(WalletError, 'WalletError');

/** True when `value` is a {@link WalletError}, even across duplicated SDK modules. */
export function isWalletError(value: unknown): value is WalletError {
  return isSdkErrorClass(value, 'WalletError');
}

export interface WalletAccount {
  userId: string;
  currency: string;
  balance: number;
}

export interface WalletLedgerEntry {
  id: string;
  amount: number;
  currency: string;
  type: string;
  referenceType: string;
  referenceId: string;
  note: string | null;
  createdAt: Date;
}

export interface WalletAdjustmentInput {
  userId: string;
  amount: number;
  currency: string;
  note: string;
  /** Id of the admin performing the adjustment (written to the audit trail). */
  actorId?: string;
}

export interface WalletService {
  /** Read a user's balance account (null when it has never been created). */
  getAccount(userId: string): Promise<WalletAccount | null>;
  /**
   * Atomically debit a user's balance. Throws when the balance is insufficient.
   * When `tx` is provided the operation joins the caller's transaction instead
   * of opening its own.
   */
  debit(
    userId: string,
    amount: number,
    currency: string,
    ref: WalletLedgerRef,
    tx?: unknown,
  ): Promise<WalletAccount>;
  /** Atomically credit a user's balance (idempotent per `ref`). */
  credit(
    userId: string,
    amount: number,
    currency: string,
    ref: WalletLedgerRef,
    tx?: unknown,
  ): Promise<WalletAccount>;
  /** Apply an administrator adjustment (positive or negative) with an audit entry. */
  adjust(input: WalletAdjustmentInput): Promise<void>;
  /** List recent wallet accounts for admin views. */
  listAccounts(limit?: number): Promise<Array<WalletAccount & { email: string }>>;
  /** List a user's recent ledger entries. */
  listLedger(userId: string, limit?: number): Promise<WalletLedgerEntry[]>;
}
