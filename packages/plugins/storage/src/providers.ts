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

/** Parse the newline-separated `Name: value` header block into a record. */
function parseHeaders(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (name) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  if (config.kind === 'http') {
    if (!config.httpUploadUrl || !config.httpPublicBaseUrl) return undefined;
    const headers = parseHeaders(config.httpHeaders);
    return {
      driver: 'http',
      uploadUrl: config.httpUploadUrl,
      publicBaseUrl: config.httpPublicBaseUrl,
      method: config.httpMethod,
      fieldName: config.httpFieldName || 'file',
      ...(headers ? { headers } : {}),
      ...(config.httpDeleteUrlTemplate ? { deleteUrlTemplate: config.httpDeleteUrlTemplate } : {}),
    };
  }
  return undefined;
}

/**
 * Build the kernel backend for an explicit config (not necessarily persisted).
 *
 * Used both by the registered provider (reads current config on every call) and
 * by the admin save route (to provision/validate the config the admin is about
 * to persist). Returns `undefined` for `env` or an incomplete S3 config, which
 * means "stand aside and let the kernel use its env driver".
 */
export async function backendForConfig(
  config: StoragePluginConfig,
): Promise<StorageProvider | undefined> {
  if (config.kind === 'env') return undefined;
  const credentials = config.kind === 's3' ? await readCredentials() : null;
  const spec = toSpec(config, credentials);
  if (!spec) return undefined;
  // Rebuild per call so admin changes take effect immediately. Cheap: the
  // kernel backend factory only constructs a client.
  return context().storage.backend(spec);
}

/**
 * The provider registered on the kernel extension point. `byteMode` is nominal:
 * the kernel infers the actual channel from what `beginPut` returns, so a runtime
 * switch between local and S3 works without re-resolving the extension point.
 *
 * A `proxy` write spans several calls (`beginPut` → `writeChunk`* → `commitPut`),
 * so the backend instance chosen by `beginPut` is kept keyed by object key until
 * the write commits or aborts — otherwise each call would rebuild a backend and
 * lose the partial upload.
 */
export function createDynamicProvider(): StorageProvider {
  const backend = (): Promise<StorageProvider | undefined> =>
    loadConfig().then((config) => backendForConfig(config));
  /** Backend instance currently handling a `proxy` write, keyed by object key. */
  const writing = new Map<string, StorageProvider>();

  return {
    id: 'storage',
    name: '存储插件',
    byteMode: 'spool',

    async beginPut(input) {
      const active = await backend();
      // Configured as 'env' (or S3 without credentials yet): stand aside and
      // let the kernel use its env-configured driver.
      if (!active) return {};
      const target = await active.beginPut(input);
      if (target.proxy) writing.set(input.key, active);
      return target;
    },

    async writeChunk(input) {
      const active = writing.get(input.key);
      if (!active) throw new Error('存储写入会话不存在');
      await active.writeChunk?.(input);
    },

    async commitPut({ key }) {
      const active = writing.get(key);
      writing.delete(key);
      await active?.commitPut?.({ key });
    },

    async abortPut({ key }) {
      const active = writing.get(key);
      writing.delete(key);
      await active?.abortPut?.({ key });
    },

    async prepareGet(key, expiresInSeconds) {
      const active = await backend();
      if (!active) throw new Error('存储后端未配置');
      return active.prepareGet(key, expiresInSeconds);
    },

    async readChunk(input) {
      const active = await backend();
      if (!active?.readChunk) throw new Error('存储后端未配置');
      return active.readChunk(input);
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
