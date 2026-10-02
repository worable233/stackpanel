/**
 * Encrypted-secret storage policy (CONTRACT-SEC / H3).
 *
 * 现状：`SETTINGS_ENCRYPTION_KEY` 是可选的，导致「装了平台但密钥存储不可用」的
 * 模糊状态——有的路由返回 501、有的返回 `{ enabled: false }`，调用方无法据此
 * 决定是否暴露「设置密钥」入口。这里定案并把判定收敛到唯一函数。
 *
 * 定案（与 ADR-0014/0019 一致，不改运行时语义）
 * ---------------------------------------------
 * - 未配置 `SETTINGS_ENCRYPTION_KEY`：密钥存储**保持禁用**（不自动生成、不落明文），
 *   所有读写密钥的接口统一返回 **501** 且带稳定 code（{@link SECRETS_DISABLED_CODE}）。
 * - 配置了密钥：启用 AES-256-GCM 加密存储（实现见 `lib/crypto.ts`）。
 * - 管理端可用只读接口 `GET /admin/secrets` 探测状态（返回 `enabled` 与 `reason`），
 *   但**写入类**接口在禁用时一律 501，避免「看似成功实则没存」。
 *
 * 生产建议：密钥属于敏感配置，不应自动生成（重启即丢）；由运维经环境变量注入，
 * 并纳入密钥轮换/备份流程。
 */

/** Stable problem code returned by secret endpoints when storage is disabled. */
export const SECRETS_DISABLED_CODE = 'secret.storage.disabled';

/** Operator-facing Chinese message for the disabled state. */
export const SECRETS_DISABLED_MESSAGE = '密钥存储未配置：请设置 SETTINGS_ENCRYPTION_KEY';

export interface SecretsPolicy {
  /** Whether encrypted secret storage is available. */
  enabled: boolean;
  /** Why it is disabled (absent when enabled), for logs and read-only probes. */
  reason?: string;
}

/**
 * Resolve the policy from the configured key. A whitespace-only key counts as
 * unset so a stray `SETTINGS_ENCRYPTION_KEY= ` never half-enables storage.
 */
export function secretsPolicy(key: string | undefined): SecretsPolicy {
  const configured = typeof key === 'string' && key.trim().length > 0;
  return configured ? { enabled: true } : { enabled: false, reason: SECRETS_DISABLED_MESSAGE };
}
