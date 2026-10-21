import { z } from 'zod';
import 'dotenv/config';

const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.length === 0 ? undefined : v;

/**
 * 默认远程目录仓（PLAN-github-distribution-and-updates §2、§10）。
 *
 * 内核**自带**这个源：开箱即可浏览/安装官方签名插件与主题，而不是要求运维先找到
 * 仓库地址再手写环境变量。想完全离线（或使用私有目录）时显式关闭即可。
 */
export const DEFAULT_CATALOG_REPOSITORY = 'worable233/stackpanel-plugins';

/** 显式关闭远程目录的取值（大小写不敏感）。 */
const CATALOG_OFF = /^(off|none|false|-)$/i;

/**
 * 归一化目录仓写法，同时决定「是否启用远程目录」。
 *
 * - 未设置 / 空字符串 → {@link DEFAULT_CATALOG_REPOSITORY}（Compose 的
 *   `${VAR:-}` 会传空串，不能因此把默认源悄悄关掉）。
 * - `off` / `none` / `false` / `-` → `undefined`，即完全离线、零出网。
 * - `owner/repo` 或 `https://github.com/owner/repo(.git)` → 规范化为 `owner/repo`。
 *
 * 非法写法直接报错，避免把「拼错的仓库」当成「离线」而静默降级。
 */
export function normalizeCatalogRepository(value: unknown): string | undefined {
  if (value === undefined) return DEFAULT_CATALOG_REPOSITORY;
  if (typeof value !== 'string') {
    throw new Error('DISTRIBUTION_CATALOG_REPOSITORY 必须是字符串');
  }
  const raw = value.trim();
  if (raw.length === 0) return DEFAULT_CATALOG_REPOSITORY;
  if (CATALOG_OFF.test(raw)) return undefined;
  const url = raw.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i,
  );
  const slug = url ? `${url[1]}/${url[2]}` : raw.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(
      `DISTRIBUTION_CATALOG_REPOSITORY 非法：${value}（应为 owner/repo 或 GitHub URL，或 off 表示离线）`,
    );
  }
  return slug;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Connection-pool budget for this process (ADR-0022 D3/P3). `pg`'s silent
  // default of 10 with no acquisition timeout meant a saturated pool hung
  // forever; these make the budget explicit and failure fast. `DATABASE_POOL_MAX`
  // is per replica, so replicas × max must stay under Postgres max_connections.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  // Server-side per-statement ceiling. 0 disables it (not recommended).
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  STACKPANEL_DATA_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  // Stable replica identity used as the key for per-replica durable consumption
  // cursors (`replica:<id>`). A replica must keep the same id across restarts to
  // resume its cursor instead of replaying from "now"; a cluster deployment
  // must give every replica a stable, unique value (k8s: StatefulSet pod name).
  // Unset falls back to `os.hostname()`.
  STACKPANEL_INSTANCE_ID: z.preprocess(emptyToUndefined, z.string().min(1).max(128).optional()),
  // How far back a replica with no cursor replays on first boot. Default 0 means
  // "only events from now on": replaying all history on every fresh pod would
  // storm consumers. Set a window (ms) to backfill a bounded recent history.
  STACKPANEL_OUTBOX_REPLAY_WINDOW_MS: z.coerce.number().int().min(0).default(0),
  AGENT_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  AGENT_WEB_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  API_CORS_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()).transform((value) =>
    value
      ? value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0)
      : [],
  ),
  // Session-cookie `Secure` flag. Defaults to on in production so a missing
  // variable can never ship cookies over plaintext (security audit
  // M-1). `resolveCookieSecure` adds a second, independent guard at set time.
  API_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default(process.env.NODE_ENV === 'production' ? 'true' : 'false')
    .transform((v) => v === 'true'),
  // Reverse-proxy trust for client IP resolution (`req.ip`). `true` trusts the
  // immediate peer; a comma-separated list trusts only those proxy addresses/
  // CIDRs. Unset (default) trusts nothing, so `req.ip` is the socket address.
  API_TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().optional()),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_COOKIE_NAME: z.string().default('sp_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  // Registration email verification + human verification policy (audit §5).
  // `off` keeps the historical behaviour (register immediately, no code). When
  // `required`, a verified email code is mandatory before an ACTIVE account is
  // created and a missing delivery channel is a hard error, never a silent skip.
  AUTH_EMAIL_VERIFICATION: z.enum(['off', 'required']).default('off'),
  // Captcha policy: `off` never asks; `optional` verifies a token when the
  // client sends one but admits requests without it; `required` rejects any
  // request lacking a valid token (and rejects when no provider is configured).
  AUTH_CAPTCHA_MODE: z.enum(['off', 'optional', 'required']).default('off'),
  // Verification-code lifetime and throttling.
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUTH_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_CODE_SEND_PER_HOUR: z.coerce.number().int().min(0).default(5),
  AUTH_CODE_SEND_PER_HOUR_PER_IP: z.coerce.number().int().min(0).default(20),
  // First-run setup wizard (ADR: setup page). `auto` (default) lets the operator
  // claim the instance from the browser at `/setup`; `disabled` turns the wizard
  // off entirely, so a fresh instance can only be initialized out-of-band.
  STACKPANEL_SETUP_MODE: z.enum(['auto', 'disabled']).default('auto'),
  // Optional one-time claim token. When set, `POST /setup` (and the first-admin
  // election on `/register` / OAuth) requires it, closing the public "squat the
  // fresh instance" race. When unset the wizard is open — acceptable only when
  // the instance is on a trusted network until it is claimed.
  STACKPANEL_SETUP_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  SETTINGS_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  STACKPANEL_API_TOKEN_PREFIX: z.preprocess(emptyToUndefined, z.string().min(2).max(16).optional()),
  // Open platform (/api/v1) per-token limits. RPM default is a generous ceiling
  // for a fresh surface; concurrency 0 keeps it off until an operator opts in.
  OPEN_API_TOKEN_RPM: z.coerce.number().int().min(0).default(240),
  OPEN_API_TOKEN_CONCURRENCY: z.coerce.number().int().min(0).default(0),
  STACKPANEL_SIGNING_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  // GitHub 分发（PLAN-github-distribution-and-updates §2、§10）。目录仓地址与渠道
  // 决定后台刷新从哪取签名目录；只读 token 可选（私有目录/提高配额），浏览器与插件
  // 不可见。**内核自带默认远程目录**（{@link DEFAULT_CATALOG_REPOSITORY}），
  // 留空即用默认源；设 `off`/`none`/`false` 才完全离线、零出网。
  DISTRIBUTION_CATALOG_REPOSITORY: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      try {
        return normalizeCatalogRepository(value);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    }),
  DISTRIBUTION_CATALOG_CHANNEL: z.enum(['stable', 'beta']).default('stable'),
  DISTRIBUTION_CATALOG_REF: z.string().default('main'),
  DISTRIBUTION_CATALOG_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  // 目录签名公钥（PEM）。默认远程源一旦启用，实例必须能验证它的目录签名；数据
  // 目录 keyring 是部署后写入的，这里给运维一个「只填公钥」的入口。它只用于
  // `catalog` 用途并绑定到当前目录仓，不会与包签名共用一把 key。
  DISTRIBUTION_CATALOG_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  // 部署目标平台（内核镜像/产物选择用；如 linux/amd64、linux/arm64）。容器内运行，
  // 故与开发宿主 `process.platform` 解耦；缺省 linux/amd64。
  DISTRIBUTION_DEPLOY_PLATFORM: z.string().default('linux/amd64'),
  // 内核升级载体（ADR-0025）。`oci` 用镜像 digest，`artifact` 用自包含产物包。
  // 缺省 `oci`：既有镜像部署不会因为升级内核而被静默切到产物载体。
  DISTRIBUTION_UPDATE_CARRIER: z.enum(['oci', 'artifact']).default('oci'),
  // 升级任务通道（§5.1）。API 把声明式任务投递到实例私有卷；updater 认领并回写结果。
  // 生产里指向 updater 状态卷的 `channel` 子目录；本机/PM2 可共用数据目录。
  DISTRIBUTION_UPDATE_CHANNEL_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  // 绑定实例 ID（与 updater `UPDATER_INSTANCE_ID` 一致）。
  DISTRIBUTION_UPDATE_INSTANCE_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  // updater 状态投影文件（只读；更新中心展示当前代次/进行中任务）。
  DISTRIBUTION_UPDATER_STATUS_FILE: z.preprocess(emptyToUndefined, z.string().optional()),
  // Infrastructure. Redis is mandatory in production (ADR-0017); storage
  // defaults to the local disk in development and S3 in production.
  REDIS_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(['local', 's3']).optional()),
  STORAGE_PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_LOCAL_ROOT: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_S3_REGION: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_S3_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_S3_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_S3_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  STORAGE_S3_FORCE_PATH_STYLE: z.preprocess(emptyToUndefined, z.string().optional()),
  // Media upload ceiling in bytes (ADR-0014 §3). Default 25 MiB; enforced by the
  // media routes' per-content-type body parser before any byte is persisted.
  MEDIA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  // Async image-variant pipeline (ADR-0014 §4 Stage B). On by default: variants
  // are encoded by the worker instead of on the upload thread. `false` restores
  // the synchronous Stage A path (rollback switch); it is also inert before the
  // job backend is attached.
  MEDIA_VARIANTS_ASYNC: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PACKAGE_SIGNATURE_REQUIRED: z
    .enum(['true', 'false'])
    .default(process.env.NODE_ENV === 'production' ? 'true' : 'false')
    .transform((value) => value === 'true'),
  // Observability (ADR-0015). Metrics are on by default but only reachable over
  // loopback unless METRICS_TOKEN is set; tracing is off unless an OTLP endpoint
  // (standard OTEL_* vars) or OTEL_TRACES_ENABLED=true is provided.
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OTEL_TRACES_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  // Audit retention (ADR-0015 §5). Days to keep audit rows; 0 disables pruning.
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(180),
});

export type Env = z.infer<typeof envSchema>;

/** Known dev-only placeholders that must never run in production. */
const DEV_PLACEHOLDERS = new Set([
  'change_me_at_least_32_characters_long',
  'change-me-at-least-32-characters-long',
  'changeme',
]);

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables');
}

export const env: Env = parsed.data;

if (process.env.NODE_ENV === 'production') {
  const problems: string[] = [];
  const isDevValue = (v: string): boolean => DEV_PLACEHOLDERS.has(v) || v.startsWith('dev_only_');
  if (isDevValue(env.JWT_SECRET)) {
    problems.push('JWT_SECRET 仍为开发占位符，请设置强随机值');
  }
  if (env.SETTINGS_ENCRYPTION_KEY && isDevValue(env.SETTINGS_ENCRYPTION_KEY)) {
    problems.push('SETTINGS_ENCRYPTION_KEY 仍为开发占位符，请设置强随机值');
  }
  if (problems.length > 0) {
    console.error(`生产环境密钥未正确配置：\n${problems.map((p) => ` - ${p}`).join('\n')}`);
    throw new Error('Invalid production environment variables');
  }
  if (env.PACKAGE_SIGNATURE_REQUIRED && !env.STACKPANEL_SIGNING_PUBLIC_KEY) {
    console.warn(
      '[env] PACKAGE_SIGNATURE_REQUIRED=true 但未配置签名公钥：' +
        '上传插件/主题将被拒绝，可在后台「签名策略」中上传公钥后恢复。',
    );
  }
  if (!env.SETTINGS_ENCRYPTION_KEY) {
    // I-2: the key is optional, but silently disabling the encrypted-secret
    // store in production is a footgun — surface it loudly at boot.
    console.warn(
      '[env] 未配置 SETTINGS_ENCRYPTION_KEY：密钥存储（AES-256-GCM）将保持禁用，' +
        '支付密钥、签名私钥等敏感配置无法保存。生产环境请设置强随机值（≥32 字符）。',
    );
  }
}
