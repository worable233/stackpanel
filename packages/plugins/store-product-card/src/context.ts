import type { ExtensionClient, ExtensionTransaction } from '@stackpanel/sdk';

/** Stable codes for card errors (ADR-0012). */
const CARD_ERROR_CODES: Record<string, string> = {
  参数无效: 'validation.invalid',
  没有可导入的卡密: 'store.card.empty_import',
  发卡插件未就绪: 'store.card.not_ready',
};

export class CardError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CardError';
    this.code = CARD_ERROR_CODES[message] ?? 'store.card.error';
  }
}

type TransactionRunner = <T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>;

let extensionClient: ExtensionClient | null = null;
let transactionRunner: TransactionRunner | null = null;

/** The plugin's own model client, bound at activation. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new CardError(503, '发卡插件未就绪');
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!transactionRunner) throw new CardError(503, '发卡插件未就绪');
  return transactionRunner(fn);
}

export function bindExtensions(client: ExtensionClient, runTransactionFn: TransactionRunner): void {
  extensionClient = client;
  transactionRunner = runTransactionFn;
}

export function clearExtensions(): void {
  extensionClient = null;
  transactionRunner = null;
}
