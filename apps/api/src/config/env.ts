import { z } from 'zod';
import 'dotenv/config';

const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.length === 0 ? undefined : v;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  STACKPANEL_DATA_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
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
  API_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Reverse-proxy trust for client IP resolution (`req.ip`). `true` trusts the
  // immediate peer; a comma-separated list trusts only those proxy addresses/
  // CIDRs. Unset (default) trusts nothing, so `req.ip` is the socket address.
  API_TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().optional()),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_COOKIE_NAME: z.string().default('sp_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  STACKPANEL_BOOTSTRAP_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  STACKPANEL_BOOTSTRAP_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  SETTINGS_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  STACKPANEL_API_TOKEN_PREFIX: z.preprocess(emptyToUndefined, z.string().min(2).max(16).optional()),
  // Open platform (/api/v1) per-token limits. RPM default is a generous ceiling
  // for a fresh surface; concurrency 0 keeps it off until an operator opts in.
  OPEN_API_TOKEN_RPM: z.coerce.number().int().min(0).default(240),
  OPEN_API_TOKEN_CONCURRENCY: z.coerce.number().int().min(0).default(0),
  STACKPANEL_SIGNING_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
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
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
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
}
