/** Errors thrown by the storage plugin. */

/** Stable codes for storage-plugin errors (ADR-0012). */
const STORAGE_PLUGIN_ERROR_CODES: Record<string, string> = {
  '存储插件未就绪': 'storage.not_ready',
  '无效的参数': 'validation.invalid',
  '无效的配置': 'storage.config_invalid',
  '存储后端未配置': 'storage.not_configured',
  '密钥存储不可用：请先配置 SETTINGS_ENCRYPTION_KEY': 'storage.secrets_unavailable',
};

export class StoragePluginError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StoragePluginError';
    this.code = STORAGE_PLUGIN_ERROR_CODES[message] ?? 'storage.error';
  }
}
