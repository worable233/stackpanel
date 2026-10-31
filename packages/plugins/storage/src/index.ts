import type { HttpReply, HttpRequest, StorageProvider } from '@stackpanel/sdk';
import { EXTENSION_POINTS, PluginError, definePlugin } from '@stackpanel/sdk';
import { z } from 'zod';
import { loadConfig, saveConfig, SECRET_ACCESS_KEY_ID, SECRET_SECRET_ACCESS_KEY } from './config';
import { bindContext, context, resetContext } from './context';
import { configModel, type StoragePluginConfig } from './data';
import { StoragePluginError } from './errors';
import { createDynamicProvider, backendForConfig } from './providers';

/** Permissions this plugin declares. */
const PERMISSION = 'storage.admin';

const saveSchema = z.object({
  kind: z.enum(['env', 'local', 's3', 'http']),
  localRoot: z.string().max(1024).optional(),
  s3Endpoint: z.string().max(2048).optional(),
  s3Region: z.string().max(64).optional(),
  s3Bucket: z.string().max(255).optional(),
  s3ForcePathStyle: z.boolean().optional(),
  publicBaseUrl: z.string().max(2048).optional(),
  httpUploadUrl: z.string().max(2048).optional(),
  httpPublicBaseUrl: z.string().max(2048).optional(),
  httpMethod: z.enum(['PUT', 'POST']).optional(),
  httpFieldName: z.string().max(128).optional(),
  httpHeaders: z.string().max(4096).optional(),
  httpDeleteUrlTemplate: z.string().max(2048).optional(),
  /** Write-only: never returned by the read endpoints. */
  accessKeyId: z.string().max(255).optional(),
  secretAccessKey: z.string().max(255).optional(),
});

/** Map plugin-local errors to stable kernel-renderable codes (ADR-0012). */
function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof StoragePluginError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

/** Public view of the config: secrets are never included. */
function toView(config: StoragePluginConfig) {
  return {
    kind: config.kind,
    localRoot: config.localRoot,
    s3Endpoint: config.s3Endpoint,
    s3Region: config.s3Region,
    s3Bucket: config.s3Bucket,
    s3ForcePathStyle: config.s3ForcePathStyle,
    publicBaseUrl: config.publicBaseUrl,
    httpUploadUrl: config.httpUploadUrl,
    httpPublicBaseUrl: config.httpPublicBaseUrl,
    httpMethod: config.httpMethod,
    httpFieldName: config.httpFieldName,
    httpHeaders: config.httpHeaders,
    httpDeleteUrlTemplate: config.httpDeleteUrlTemplate,
    hasCredentials: config.hasCredentials,
    secretsAvailable: context().secrets.isAvailable(),
  };
}

const getAdminConfig = async (): Promise<unknown> => ({ config: toView(await loadConfig()) });

const putAdminConfig = async (req: HttpRequest): Promise<unknown> => {
  const parsed = saveSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new StoragePluginError(400, '无效的配置');
  const input = parsed.data;
  const current = await loadConfig();

  // Persist credentials through the encrypted secret store, never the model.
  let hasCredentials = current.hasCredentials;
  if (input.accessKeyId || input.secretAccessKey) {
    if (!context().secrets.isAvailable()) {
      throw new StoragePluginError(409, '密钥存储不可用：请先配置 SETTINGS_ENCRYPTION_KEY');
    }
    if (input.accessKeyId) await context().secrets.set(SECRET_ACCESS_KEY_ID, input.accessKeyId);
    if (input.secretAccessKey)
      await context().secrets.set(SECRET_SECRET_ACCESS_KEY, input.secretAccessKey);
    hasCredentials = true;
  }
  if (input.kind === 'env') {
    await context().secrets.remove(SECRET_ACCESS_KEY_ID);
    await context().secrets.remove(SECRET_SECRET_ACCESS_KEY);
    hasCredentials = false;
  }

  const next: StoragePluginConfig = {
    kind: input.kind,
    localRoot: input.localRoot ?? current.localRoot,
    s3Endpoint: input.s3Endpoint ?? current.s3Endpoint,
    s3Region: input.s3Region ?? current.s3Region,
    s3Bucket: input.s3Bucket ?? current.s3Bucket,
    s3ForcePathStyle: input.s3ForcePathStyle ?? current.s3ForcePathStyle,
    publicBaseUrl: input.publicBaseUrl ?? current.publicBaseUrl,
    httpUploadUrl: input.httpUploadUrl ?? current.httpUploadUrl,
    httpPublicBaseUrl: input.httpPublicBaseUrl ?? current.httpPublicBaseUrl,
    httpMethod: input.httpMethod ?? current.httpMethod,
    httpFieldName: input.httpFieldName ?? current.httpFieldName,
    httpHeaders: input.httpHeaders ?? current.httpHeaders,
    httpDeleteUrlTemplate: input.httpDeleteUrlTemplate ?? current.httpDeleteUrlTemplate,
    hasCredentials,
  };

  // Validate the candidate backend *before* persisting. `backendForConfig`
  // constructs the provider, so a rejected endpoint (e.g. cloud metadata, SSRF)
  // fails the save. Provisioning (bucket creation) is best-effort: an admin may
  // legitimately configure a backend that is not reachable yet, so a transient
  // connectivity error must not block saving — first write retries.
  let candidate;
  try {
    candidate = await backendForConfig(next);
  } catch (error) {
    throw new StoragePluginError(
      422,
      `存储后端不可用：${String((error as Error)?.message ?? error)}`,
    );
  }
  try {
    await candidate?.ensureReady?.();
  } catch (error) {
    context().logger.warn(`storage: 后端预初始化失败（首写时重试）：${String(error)}`);
  }

  return { config: toView(await saveConfig(next)) };
};

/** Connectivity probe for the admin UI (best effort, never throws). */
const testConnection = async (): Promise<unknown> => {
  const provider = createDynamicProvider();
  try {
    const ok = provider.ping ? await provider.ping() : true;
    return { ok };
  } catch (error) {
    // 反馈契约：provider 的原始异常不上屏（`SignatureDoesNotMatch`、上游 XML 等只进日志），
    // 前端按 `ok: false` 显示本地化的 `test.failed`。
    console.error('[storage] connection test failed', error);
    return { ok: false };
  }
};

export const storagePlugin = definePlugin({
  manifest: {
    id: 'storage',
    name: '存储插件',
    version: '0.1.0',
    description: '把对象存储交给本地盘、S3 兼容后端（MinIO/R2/OSS/AWS）或自定义 HTTP 图床。',
    permissions: [
      {
        key: PERMISSION,
        name: '存储管理',
        description: '配置对象存储后端与凭据。',
      },
    ],
    roleTemplates: [{ role: 'ADMIN', permissions: [PERMISSION] }],
  },
  customModels: [configModel],
  routes: [
    {
      method: 'GET',
      path: '/storage/admin/config',
      auth: 'admin',
      permission: PERMISSION,
      handler: handle(getAdminConfig),
    },
    {
      method: 'POST',
      path: '/storage/admin/config',
      auth: 'admin',
      permission: PERMISSION,
      handler: handle(putAdminConfig),
    },
    {
      method: 'POST',
      path: '/storage/admin/test',
      auth: 'admin',
      permission: PERMISSION,
      handler: handle(testConnection),
    },
  ],
  onActivate: (ctx) => {
    bindContext(ctx);
    // Register the dynamic provider on the kernel extension point. The kernel
    // re-resolves its storage driver on `plugin.activated`, so this takes effect
    // immediately without a restart.
    const provider = createDynamicProvider();
    ctx.effect((collect) => {
      collect(ctx.registerExtension<StorageProvider>(EXTENSION_POINTS.storageProvider, provider));
    });
    ctx.logger.info('storage: activated');
  },
  onDeactivate: (ctx) => {
    resetContext();
    ctx.logger.info('storage: deactivated');
  },
});

export default storagePlugin;
