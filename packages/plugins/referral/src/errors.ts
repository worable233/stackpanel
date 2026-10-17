/** Errors thrown by the referral plugin. */

/** Stable codes for referral-plugin errors (ADR-0012). */
const REFERRAL_PLUGIN_ERROR_CODES: Record<string, string> = {
  '推广插件未就绪': 'referral.not_ready',
  '无效的参数': 'validation.invalid',
  '推广功能未开启': 'referral.disabled',
  '推广码不存在或已停用': 'referral.code_unavailable',
  '推广码数量已达上限': 'referral.code_limit',
  '不能推广自己': 'referral.self_referral',
  '注册已归因给其他推广人': 'referral.already_attributed',
  '邀请数量已达上限': 'referral.invite_limit',
  '用户不存在': 'referral.user_not_found',
  '无效的配置': 'referral.config_invalid',
};

export class ReferralPluginError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReferralPluginError';
    this.code = REFERRAL_PLUGIN_ERROR_CODES[message] ?? 'referral.error';
  }
}
