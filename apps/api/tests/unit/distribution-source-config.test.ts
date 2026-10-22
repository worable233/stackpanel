/**
 * 分发源配置（PLAN-github-distribution §2/§10）。
 *
 * 这里用内存假 Prisma 覆盖「数据库优先、环境变量兜底」的语义：后台保存的配置要能
 * 覆盖默认远程源，非法值要整体忽略而不是让实例静默失效，token 只报告是否已保存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();

vi.mock('../../src/plugins/prisma.ts', () => ({
  getPrisma: () => ({
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        settings.set(where.key, 'value' in create ? create.value : update.value);
        return { key: where.key };
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        settings.delete(where.key);
        return { count: 1 };
      },
    },
    secret: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        secrets.has(where.key) ? { key: where.key, ciphertext: secrets.get(where.key) } : null,
      upsert: async ({
        where,
        create,
      }: {
        where: { key: string };
        create: { ciphertext: string };
      }) => {
        secrets.set(where.key, create.ciphertext);
        return { key: where.key };
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        secrets.delete(where.key);
        return { count: 1 };
      },
    },
  }),
}));

const { encryptSecret, decryptSecret } = await import('../../src/lib/crypto.ts');
const {
  env,
  DEFAULT_CATALOG_KEY_ID,
  DEFAULT_CATALOG_PUBLIC_KEY,
  DEFAULT_CATALOG_REPOSITORY,
} = await import('../../src/config/env.ts');
const {
  CATALOG_PUBLIC_KEY_SETTING_KEY,
  CATALOG_SOURCE_SETTING_KEY,
  CATALOG_TOKEN_SECRET_KEY,
  currentCatalogSourceConfig,
  loadCatalogSourceConfig,
  resetCatalogSourceConfigForTest,
  saveCatalogPublicKey,
  saveCatalogSourceConfig,
  saveCatalogToken,
  toCatalogSourceView,
} = await import('../../src/distribution/source-config.ts');

beforeEach(() => {
  settings.clear();
  secrets.clear();
  resetCatalogSourceConfigForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('catalog source config', () => {
  it('falls back to env with no stored row', async () => {
    const config = await loadCatalogSourceConfig();
    // 单元测试把目录源钉成 `off`（见 vitest.distribution.config.ts），因此这里
    // 看到的是显式关闭；「未设置时回退到默认源」由 normalizeCatalogRepository 覆盖。
    expect(config.repository).toBeNull();
    expect(config.channel).toBe('stable');
    expect(config.ref).toBe('main');
    expect(config.mirror).toBeNull();
    expect(toCatalogSourceView(config).source).toBe('env');
  });

  it('lets a stored row override env and normalizes URLs', async () => {
    await saveCatalogSourceConfig(
      {
        repository: 'https://github.com/acme/plugins.git',
        channel: 'beta',
        ref: 'dev',
        mirror: 'https://github.chenc.dev/',
      },
      'admin-1',
    );
    const config = currentCatalogSourceConfig();
    expect(config.repository).toBe('acme/plugins');
    expect(config.channel).toBe('beta');
    expect(config.ref).toBe('dev');
    expect(config.mirror).toBe('https://github.chenc.dev');
    expect(toCatalogSourceView(config).source).toBe('stored');
  });

  it('stores explicit offline as repository: null rather than falling back to env', async () => {
    await saveCatalogSourceConfig({ repository: null, mirror: null }, 'admin-1');
    expect(currentCatalogSourceConfig().repository).toBeNull();
    expect(toCatalogSourceView(currentCatalogSourceConfig()).repository).toBeNull();
  });

  it('ignores malformed stored fields and keeps the env fallback', async () => {
    settings.set(CATALOG_SOURCE_SETTING_KEY, {
      repository: 'not a repo',
      channel: 'nightly',
      ref: 'bad ref!',
      mirror: 'http://insecure.example',
    });
    const config = await loadCatalogSourceConfig();
    expect(config.repository).toBeNull();
    expect(config.channel).toBe('stable');
    expect(config.ref).toBe('main');
    expect(config.mirror).toBeNull();
  });

  it('rejects a non-HTTPS mirror on save', async () => {
    await expect(
      saveCatalogSourceConfig({ repository: 'acme/plugins', mirror: 'http://ghfast.top' }, null),
    ).rejects.toThrow(/HTTPS/);
    expect(settings.has(CATALOG_SOURCE_SETTING_KEY)).toBe(false);
  });

  it('binds the catalog public key separately from the env signing key', async () => {
    const pem = '-----BEGIN PUBLIC KEY-----\ncatalog\n-----END PUBLIC KEY-----';
    await saveCatalogPublicKey(pem, 'admin-1', 'catalog-2026');
    // keyId 必须和公钥一起存：验签是按 catalog.sig.keyId 在信任根里查 key 的。
    expect(settings.get(CATALOG_PUBLIC_KEY_SETTING_KEY)).toEqual({
      publicKey: pem,
      keyId: 'catalog-2026',
    });
    expect(currentCatalogSourceConfig().publicKey).toBe(pem);
    expect(currentCatalogSourceConfig().publicKeyId).toBe('catalog-2026');

    await saveCatalogPublicKey('   ', 'admin-1');
    expect(settings.has(CATALOG_PUBLIC_KEY_SETTING_KEY)).toBe(false);
    expect(currentCatalogSourceConfig().publicKey).toBeNull();
    expect(currentCatalogSourceConfig().publicKeyId).toBeNull();
  });

  it('stores the token encrypted and never echoes it back', async () => {
    await saveCatalogToken('github_pat_secret', 'admin-1');
    expect(secrets.get(CATALOG_TOKEN_SECRET_KEY)).toBeTruthy();
    expect(secrets.get(CATALOG_TOKEN_SECRET_KEY)).not.toBe('github_pat_secret');
    expect(decryptSecret(secrets.get(CATALOG_TOKEN_SECRET_KEY) ?? '')).toBe('github_pat_secret');

    const view = toCatalogSourceView(currentCatalogSourceConfig());
    expect(view.tokenConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('github_pat_secret');
    // 加密函数本身也保持可用（避免测试把假实现当成真的）。
    expect(encryptSecret('x')).not.toBe('x');
  });

  it('clears the token with an empty value', async () => {
    await saveCatalogToken('github_pat_secret', null);
    await saveCatalogToken('', null);
    expect(secrets.has(CATALOG_TOKEN_SECRET_KEY)).toBe(false);
    expect(toCatalogSourceView(currentCatalogSourceConfig()).tokenConfigured).toBe(false);
  });

  it('exposes the env defaults for the admin hint', async () => {
    const config = await loadCatalogSourceConfig();
    const view = toCatalogSourceView(config);
    // 视图要能告诉后台「环境变量里是什么」（测试里是显式关闭）。
    expect(view.envRepository).toBeNull();
    expect(view.envMirror).toBeNull();
    expect(view.secretsEnabled).toBe(true);
  });
});

/**
 * 默认远程源必须**自带**信任根：只内置仓库地址而不内置公钥，开箱就会「连得上、
 * 验签失败」。这一组用例钉死三件事——默认源用默认 key、第三方仓库不复用这把 key、
 * 显式离线时不注入。
 */
describe('built-in catalog trust root', () => {
  const originalRepository = env.DISTRIBUTION_CATALOG_REPOSITORY;

  beforeEach(() => {
    delete env.DISTRIBUTION_CATALOG_PUBLIC_KEY;
    env.DISTRIBUTION_CATALOG_REPOSITORY = DEFAULT_CATALOG_REPOSITORY;
  });

  afterEach(() => {
    env.DISTRIBUTION_CATALOG_REPOSITORY = originalRepository;
    delete env.DISTRIBUTION_CATALOG_PUBLIC_KEY;
    delete env.DISTRIBUTION_CATALOG_KEY_ID;
  });

  it('ships a catalog-purpose key for the default source so it verifies out of the box', async () => {
    const config = await loadCatalogSourceConfig();
    expect(config.repository).toBe(DEFAULT_CATALOG_REPOSITORY);
    expect(config.publicKey).toBe(DEFAULT_CATALOG_PUBLIC_KEY);
    // keyId 必须与 catalog.sig 一致，否则信任根命中不了签名者。
    expect(config.publicKeyId).toBe(DEFAULT_CATALOG_KEY_ID);
    expect(config.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('never reuses the built-in catalog key for a third-party repository', async () => {
    await saveCatalogSourceConfig({ repository: 'acme/plugins', mirror: null }, 'admin-1');
    const config = currentCatalogSourceConfig();
    expect(config.repository).toBe('acme/plugins');
    expect(config.publicKey).toBeNull();
    expect(config.publicKeyId).toBeNull();
  });

  it('does not inject the built-in key when the remote catalog is off', async () => {
    env.DISTRIBUTION_CATALOG_REPOSITORY = undefined;
    const config = await loadCatalogSourceConfig();
    expect(config.repository).toBeNull();
    expect(config.publicKey).toBeNull();
    expect(config.publicKeyId).toBeNull();
  });

  it('keeps an explicitly configured key over the built-in one', async () => {
    settings.delete(CATALOG_PUBLIC_KEY_SETTING_KEY);
    env.DISTRIBUTION_CATALOG_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\ncustom\n-----END PUBLIC KEY-----';
    env.DISTRIBUTION_CATALOG_KEY_ID = 'custom-key';
    const config = await loadCatalogSourceConfig();
    expect(config.publicKey).toContain('custom');
    expect(config.publicKeyId).toBe('custom-key');
  });

  it('drops the built-in key once the stored source points elsewhere', async () => {
    // 后台把源改成第三方仓库时，默认 key 必须一起失效——否则等于拿官方目录的
    // 公钥去验第三方目录，既验不过也让信任边界变得难以解释。
    await saveCatalogSourceConfig({ repository: 'acme/plugins', mirror: null }, 'admin-1');
    expect(currentCatalogSourceConfig().publicKey).toBeNull();
    await saveCatalogSourceConfig({ repository: DEFAULT_CATALOG_REPOSITORY, mirror: null }, 'admin-1');
    expect(currentCatalogSourceConfig().publicKey).toBe(DEFAULT_CATALOG_PUBLIC_KEY);
  });
});
