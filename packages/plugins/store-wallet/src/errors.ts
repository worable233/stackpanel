/** Errors thrown by the store-wallet plugin. */

/** Stable codes for wallet-plugin errors (ADR-0012). */
const WALLET_PLUGIN_ERROR_CODES: Record<string, string> = {
  '无效的充值参数': 'wallet.topup.params_invalid',
  '无效的参数': 'validation.invalid',
  '无效的调整参数': 'wallet.adjustment.params_invalid',
  用户不存在: 'wallet.user_not_found',
  钱包插件未就绪: 'wallet.not_ready',
};

export class WalletPluginError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WalletPluginError';
    this.code = WALLET_PLUGIN_ERROR_CODES[message] ?? 'wallet.error';
  }
}