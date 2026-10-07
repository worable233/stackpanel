/**
 * Rate-limit policy (CONTRACT-SEC / H2).
 *
 * 原来限流覆盖不全：只有 OAuth、插件上传等零星几处，其余写接口裸奔。这里把
 * 「需要限流的敏感面」收敛成一份**可审计的策略表**——路由从这里取参数，而不是
 * 各写各的魔数；新增敏感路由时在此登记，测试 `rate-limit-policy.test.ts` 会校验
 * 覆盖。跨副本计数由内核在注册时接 Redis（ADR-0017），本文件只管「限额多少」。
 *
 * 约定：
 * - 只对**触达凭证、写状态、消耗资源**的接口设限；只读公开接口不限，避免误伤。
 * - `max: 0` 表示显式关闭（保留给测试环境，生产不应出现）。
 * - 固定窗口按 `@fastify/rate-limit` 语义，`timeWindow` 支持 `'1 minute'` 等。
 */

/** One fixed-window rule; shape matches `@fastify/rate-limit`'s `config.rateLimit`. */
export interface RateLimitRule {
  max: number;
  timeWindow: string;
}

/**
 * Named presets. Keep them few and intention-revealing; routes must reference a
 * preset here rather than inline numbers.
 */
export const RATE_LIMIT = {
  /** Third-party OAuth dance (authorize/callback/providers). */
  oauth: { max: 10, timeWindow: '1 minute' },
  /** Issuing / rotating credentials (API tokens). */
  credentialWrite: { max: 30, timeWindow: '1 minute' },
  /** Admin mutating endpoints (secrets, signing, platform identity, executors). */
  adminWrite: { max: 60, timeWindow: '1 minute' },
  /** Authenticated user-originated writes that are cheap but abusable (frontend audit). */
  userWrite: { max: 120, timeWindow: '1 minute' },
  /** Resource uploads (plugins, themes, media) — heavier ceilings. */
  upload: { max: 20, timeWindow: '1 minute' },
  /**
   * Anonymous read endpoints that are heavy enough to be worth a DoS ceiling:
   * media bytes/derivatives, theme & plugin asset files, SEO feeds. The ceiling
   * is deliberately generous — a single page load fans out into many asset
   * requests — so it stops abuse without throttling real browsing
   * (SECURITY-AUDIT-2026-10-04 L-1).
   */
  publicRead: { max: 600, timeWindow: '1 minute' },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitPreset = keyof typeof RATE_LIMIT;

/**
 * Operator escape hatch to raise every ceiling proportionally (e.g. an internal
 * deployment behind another gateway). Values below 1 are clamped to 1 so the
 * policy can never be weakened — only relaxed, never disabled. Test runs set a
 * high factor so the shared-IP integration suite is not throttled.
 */
export function rateLimitMultiplier(): number {
  const raw = Number(process.env['API_RATE_LIMIT_MULTIPLIER'] ?? '1');
  return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 1;
}

/** Build the `@fastify/rate-limit` route config for a preset (factor applied). */
export function rateLimitConfig(preset: RateLimitPreset): {
  config: { rateLimit: RateLimitRule };
} {
  const rule = RATE_LIMIT[preset];
  const factor = rateLimitMultiplier();
  return {
    config: {
      rateLimit: { max: factor > 1 ? rule.max * factor : rule.max, timeWindow: rule.timeWindow },
    },
  };
}

/**
 * Sensitive route groups that MUST carry a limiter, by stable description. This
 * is the contract the coverage test enforces: each entry names the preset its
 * routes use.
 */
export const RATE_LIMIT_COVERAGE: ReadonlyArray<{
  surface: string;
  preset: RateLimitPreset;
}> = [
  { surface: 'OAuth 授权 / 回调 / 提供方列表', preset: 'oauth' },
  { surface: 'API Token 签发 / 轮换 / 撤销', preset: 'credentialWrite' },
  { surface: '管理端密钥 / 签名 / 平台身份写入', preset: 'adminWrite' },
  { surface: '插件 / 主题 / 媒体上传', preset: 'upload' },
  { surface: '匿名重读端点（媒体内容 / 主题与插件资源 / SEO 订阅）', preset: 'publicRead' },
];
