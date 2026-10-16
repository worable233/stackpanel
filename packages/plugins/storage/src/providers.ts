import { join } from 'node:path';
import type { StorageBackendSpec, StorageProvider, StorageProviderObjectStat } from '@stackpanel/sdk';
import { context } from './context';
import { loadConfig, SECRET_ACCESS_KEY_ID, SECRET_SECRET_ACCESS_KEY } from './config';
import type { StoragePluginConfig } from './data';

/**
 * 存储 provider 实现。
 *
 * 注册到内核的是一层**动态** provider：每次调用读取当前配置，委托给按配置构造的
 * 后端。这样后台改配置即时生效，无需内核重新解析扩展点。
 *
 * 字节逻辑（预签名、路径穿越防护、分页列举）全部由内核能力 `ctx.storage` 提供，
 * 本插件只做**配置 → 后端规格**的翻译，不 import 任何内核包（ADR-0008 边界）。
 */

interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Default data directory (matches the kernel's `resolveStackPanelDataDir`). */
function defaultDataDir(): string {
  const explicit = process.env['STACKPANEL_DATA_DIR'];
  if (explicit && explicit.trim().length > 0) return explicit;
  return join(process.cwd(), 'data');
}

async function readCredentials(): Promise<S3Credentials | null> {
  try {
    const secrets = context().secrets;
    if (!secrets.isAvailable()) return null;
    const [accessKeyId, secretAccessKey] = await Promise.all([
      secrets.get(SECRET_ACCESS_KEY_ID),
      secrets.get(SECRET_SECRET_ACCESS_KEY),
    ]);
    if (!accessKeyId || !secretAccessKey) return null;
    return { accessKeyId, secretAccessKey };
  } catch {
    return null;
  }
}

/** Translate the stored config into a generic backend spec. */
function toSpec(
  config: StoragePluginConfig,
  credentials: S3Credentials | null,
): StorageBackendSpec | undefined {
  if (config.kind === 'local') {
    const root = config.localRoot || join(defaultDataDir(), 'storage');
    return { driver: 'local', root, ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}) };
  }
  if (config.kind === 's3') {
    if (!credentials || !config.s3Bucket) return undefined;
    return {
      driver: 's3',
      region: config.s3Region,
      bucket: config.s3Bucket,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      forcePathStyle: config.s3ForcePathStyle,
      ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
      ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    };
  }
  return undefined;
}

/**
 * The provider registered on the kernel extension point. `byteMode` is nominal:
 * the kernel infers the actual channel from what `beginPut` returns, so a runtime
 * switch between local and S3 works without re-resolving the extension point.
 */
export function createDynamicProvider(): StorageProvider {
  const backend = async (): Promise<StorageProvider | undefined> => {
    const config = await loadConfig();
    if (config.kind === 'env') return undefined;
    const credentials = config.kind === 's3' ? await readCredentials() : null;
    const spec = toSpec(config, credentials);
    if (!spec) return undefined;
    // Rebuild per call so admin changes take effect immediately. Cheap: the
    // kernel backend factory only constructs a client.
    return context().storage.backend(spec);
  };

  return {
    id: 'storage',
    name: '存储插件',
    byteMode: 'spool',

    async beginPut(input) {
      const active = await backend();
      // Configured as 'env' (or S3 without credentials yet): stand aside and
      // let the kernel use its env-configured driver.
      if (!active) return {};
      return active.beginPut(input);
    },

    async prepareGet(key, expiresInSeconds) {
      const active = await backend();
      if (!active) throw new Error('存储后端未配置');
      return active.prepareGet(key, expiresInSeconds);
    },

    async delete(key) {
      await (await backend())?.delete(key);
    },
    async exists(key) {
      return (await backend())?.exists(key) ?? false;
    },
    async stat(key): Promise<StorageProviderObjectStat | null> {
      return (await backend())?.stat(key) ?? null;
    },
    async list(prefix) {
      return (await backend())?.list(prefix) ?? [];
    },
    url(key) {
      // Synchronous contract: a dynamic backend cannot be read synchronously.
      // The kernel serves bytes through `/media/:id/content` regardless.
      return `/storage/${key}`;
    },
    async ensureReady() {
      const active = await backend();
      // Provision whatever backend is currently configured; `env` (or an
      // incomplete S3 config) stands aside with nothing to prepare.
      await active?.ensureReady?.();
    },
    async ping() {
      const active = await backend();
      return active?.ping ? active.ping() : true;
    },
  };
}
