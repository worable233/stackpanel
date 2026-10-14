/** Stable, machine-readable codes for channel errors (ADR-0012 §2). */

const CHANNEL_ERROR_CODES: Record<string, string> = {
  '渠道插件未就绪': 'channel.not_ready',
  '渠道名称已存在': 'channel.name_taken',
  '渠道不存在': 'channel.not_found',
  '未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥': 'channel.secrets_unavailable',
  '渠道密钥标识冲突': 'channel.key_id_conflict',
};

export class ChannelError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
    this.code = CHANNEL_ERROR_CODES[message] ?? 'channel.error';
  }
}
