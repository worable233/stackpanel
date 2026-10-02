/**
 * Infrastructure configuration (Redis + object storage).
 *
 * Read from the environment by the kernel and passed to the shared factories in
 * this package, so `@stackpanel/db` stays free of `process.env` coupling and
 * remains unit-testable.
 *
 * Production rules (ADR-0017): Redis is mandatory (session/rate-limit/state/
 * events all must be shared across replicas) and storage must not be the local
 * disk driver (replicas do not share a volume). Both fail fast at startup with
 * a clear message instead of silently degrading.
 */

export type StorageDriverKind = 'local' | 's3';

export interface LocalStorageConfig {
  driver: 'local';
  /** Absolute directory that holds stored objects. */
  root: string;
  /** Public URL base the browser uses to fetch objects. */
  publicBaseUrl: string;
}

export interface S3StorageConfig {
  driver: 's3';
  /** Custom endpoint for S3-compatible services (MinIO/R2/OSS). Unset = AWS. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted gateways need path-style addressing. */
  forcePathStyle: boolean;
  /** Public URL base the browser uses to fetch objects. */
  publicBaseUrl: string;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

export interface InfraConfig {
  production: boolean;
  /** `undefined` means "not configured" (development falls back to in-memory). */
  redisUrl?: string;
  storage: StorageConfig;
}

export interface ReadInfraConfigInput {
  env: Record<string, string | undefined>;
  /** Absolute path used to anchor the default local storage directory. */
  dataDir: string;
}

const trim = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
  const t = trim(v);
  if (t === undefined) return fallback;
  return t === 'true' || t === '1';
};

/** Thrown when production is missing a required piece of infrastructure. */
export class InfraConfigError extends Error {}

function readStorage(env: Record<string, string | undefined>, dataDir: string): StorageConfig {
  const rawDriver = trim(env['STORAGE_DRIVER']) ?? 'local';
  if (rawDriver !== 'local' && rawDriver !== 's3') {
    throw new InfraConfigError(`STORAGE_DRIVER 只能是 "local" 或 "s3"，当前为 "${rawDriver}"。`);
  }

  const publicBaseUrl = trim(env['STORAGE_PUBLIC_BASE_URL']) ?? '';

  if (rawDriver === 'local') {
    const root = trim(env['STORAGE_LOCAL_ROOT']) ?? `${dataDir}/storage`;
    return { driver: 'local', root, publicBaseUrl: publicBaseUrl || '/storage' };
  }

  const bucket = trim(env['STORAGE_S3_BUCKET']);
  const accessKeyId = trim(env['STORAGE_S3_ACCESS_KEY_ID']);
  const secretAccessKey = trim(env['STORAGE_S3_SECRET_ACCESS_KEY']);
  const endpoint = trim(env['STORAGE_S3_ENDPOINT']);
  const region = trim(env['STORAGE_S3_REGION']) ?? 'us-east-1';

  const missing: string[] = [];
  if (!bucket) missing.push('STORAGE_S3_BUCKET');
  if (!accessKeyId) missing.push('STORAGE_S3_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('STORAGE_S3_SECRET_ACCESS_KEY');
  if (missing.length > 0) {
    throw new InfraConfigError(`对象存储（S3）配置不完整，缺少：${missing.join('、')}。`);
  }

  const derivedBase =
    publicBaseUrl ||
    (endpoint ? `${endpoint.replace(/\/$/, '')}/${bucket}` : `https://${bucket}.s3.amazonaws.com`);

  return {
    driver: 's3',
    ...(endpoint ? { endpoint } : {}),
    region,
    bucket: bucket as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    forcePathStyle: bool(env['STORAGE_S3_FORCE_PATH_STYLE'], true),
    publicBaseUrl: derivedBase,
  };
}

/**
 * Parse infrastructure config and enforce production requirements.
 * Throws {@link InfraConfigError} with a user-facing (Chinese) message.
 */
export function readInfraConfig(input: ReadInfraConfigInput): InfraConfig {
  const production = input.env['NODE_ENV'] === 'production';
  const redisUrl = trim(input.env['REDIS_URL']);
  const storage = readStorage(input.env, input.dataDir);

  const problems: string[] = [];
  if (production && !redisUrl) {
    problems.push('未配置 REDIS_URL：多副本的会话、限流、状态与事件必须共享 Redis。');
  }
  if (production && storage.driver === 'local') {
    problems.push(
      '生产环境不支持本地盘对象存储：请设置 STORAGE_DRIVER=s3 并配置 STORAGE_S3_*（多副本不共享卷）。',
    );
  }
  if (problems.length > 0) {
    throw new InfraConfigError(
      `基础设施配置不满足生产要求：\n${problems.map((p) => ` - ${p}`).join('\n')}`,
    );
  }

  return {
    production,
    ...(redisUrl ? { redisUrl } : {}),
    storage,
  };
}
