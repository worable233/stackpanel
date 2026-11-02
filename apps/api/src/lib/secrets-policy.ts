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

/** `plugin.<id>.<key>` — the namespace `pluginSecrets()` enforces. */
const PLUGIN_SECRET_PREFIX = /^plugin\.([a-z0-9_-]{1,64})\.[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 一个 secret key 影响哪些**已加载**插件的运行期状态。
 *
 * 通用 `/admin/secrets/:key` 接口只写库，不知道谁在读它。插件的 `ctx.secrets`
 * 是「激活时读一次」的语义（`onActivate` 里 `await ctx.secrets.get(...)`），于是
 * 保存完这条 secret 后插件仍在用旧值——实测表现是配置页显示「已保存」，充值却
 * 一直报「易支付尚未配置」，因为 epay 的 `this.config` 仍是激活时的 `null`。
 *
 * 规则故意做得很窄：只认 `plugin.<id>.<key>` 命名空间，未知的 id 直接忽略。
 * 内核自己的 secret（`agent.llm.apiKey` 等）是**每次请求重读**的，不需要重启
 * 插件，也就不会被这条规则牵连成一次无谓的重载。
 */
export function pluginsAffectedBySecret(key: string): string[] {
  const match = PLUGIN_SECRET_PREFIX.exec(key);
  return match?.[1] ? [match[1]] : [];
}
