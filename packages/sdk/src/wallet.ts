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
  /** Spendable balance. Already excludes amounts frozen by live holds. */
  balance: number;
  /** Amount currently frozen by live holds; for reconciliation and display. */
  held?: number;
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

/** A pre-authorization: credit frozen before use, settled or released afterwards. */
export interface WalletHold {
  id: string;
  userId: string;
  currency: string;
  /** Amount originally frozen (minor units). */
  amount: number;
  /** HELD | SETTLED | RELEASED | EXPIRED. */
  status: string;
  /** Actually charged amount; set once settled. */
  settledAmount: number | null;
  referenceType: string;
  referenceId: string;
  note: string | null;
  expiresAt: Date;
  settledAt: Date | null;
  createdAt: Date;
}

/** Options for {@link WalletService.hold}. */
export interface WalletHoldOptions {
  /**
   * How long the freeze stays valid before the kernel's sweep releases it.
   * Bounded by the kernel (must be a positive, sane duration); defaults to 15
   * minutes, which comfortably exceeds any single upstream LLM call.
   */
  ttlMs?: number;
  note?: string;
  /** Join the caller's transaction instead of opening one. */
  tx?: unknown;
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
   * Freeze `amount` from the user's balance before a metered operation starts.
   *
   * This closes the concurrent-billing window that a plain "check balance, then
   * debit after use" flow leaves open: parallel requests sharing one balance
   * snapshot all pass the check, and the losers of the race produce write-offs.
   * Because freezing moves the amount out of `balance`, later requests see the
   * reduced balance and are rejected up front instead.
   *
   * Idempotent per `ref`: calling twice with the same
   * `(referenceType, referenceId)` returns the existing hold and does not freeze
   * twice. Throws {@link WalletError} (409) when the available balance is
   * insufficient. Holds expire (see {@link WalletHoldOptions.ttlMs}) so a crashed
   * request can never freeze funds forever.
   */
  hold(
    userId: string,
    amount: number,
    currency: string,
    ref: WalletLedgerRef,
    options?: WalletHoldOptions,
  ): Promise<WalletHold>;
  /**
   * Settle a hold for the amount actually consumed, returning the difference to
   * the balance. Idempotent: settling an already-settled/released hold is a
   * no-op. `settledAmount` 0 releases the whole freeze. When `tx` is provided
   * the operation joins the caller's transaction.
   */
  settleHold(
    holdId: string,
    settledAmount: number,
    ref?: WalletLedgerRef,
    tx?: unknown,
  ): Promise<WalletHold | null>;
  /** Release a hold in full (the operation failed before consuming anything). */
  releaseHold(holdId: string, tx?: unknown): Promise<WalletHold | null>;
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
