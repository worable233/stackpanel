import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_IMAGE_ACCEPT, BRAND_IMAGE_EXTENSIONS } from '@stackpanel/sdk';
import { defaultAssetsDir } from '../../src/lib/platform-brand.ts';

/**
 * 内置品牌图标的**查找路径**，以及前后端规则不能漂移。
 *
 * 这条断言对应一次线上 404：容器工作目录是 `/app`，而图标在
 * `/app/apps/api/assets/brand/`。原来的候选列表只有 `assets/brand` 与
 * `../assets/brand`，两者都不命中，`seedDefaultBrand()` 又用
 * `.catch(() => null)` 把失败吞了 —— 于是 `brand/favicon` 从第一次启动就不存在，
 * 首页输出 `<link rel="icon" href="/api/plugins/platform/brand/favicon">`，
 * 浏览器拿到 404，显示「损坏的图标」。日志全绿，配置页「保存成功」。
 *
 * 直接调用真实实现（它接受 `cwd` 参数），不复刻逻辑。
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_DIR = path.resolve(__dirname, '../..');

describe('default brand assets', () => {
  it('finds apps/api/assets/brand from the repo root (container layout)', () => {
    // 容器里 cwd=/app，图标在 /app/apps/api/assets/brand。
    expect(defaultAssetsDir(REPO_ROOT)).toBe(path.join(REPO_ROOT, 'apps', 'api', 'assets', 'brand'));
  });

  it('still finds assets/brand when run from apps/api (dev layout)', () => {
    expect(defaultAssetsDir(API_DIR)).toBe(path.join(API_DIR, 'assets', 'brand'));
  });

  it('has both built-in files on disk', () => {
    const dir = defaultAssetsDir(REPO_ROOT);
    expect(existsSync(path.join(dir, 'logo.png'))).toBe(true);
    expect(existsSync(path.join(dir, 'favicon.png'))).toBe(true);
  });

  it('falls back to a path rather than throwing when nothing exists', () => {
    const empty = path.join(REPO_ROOT, '.does-not-exist');
    expect(defaultAssetsDir(empty)).toBe(path.join(empty, 'assets', 'brand'));
  });

  it('finds a default icon whatever its extension is, not just .png', async () => {
    // 运维常用「挂载/覆盖默认图」的方式换图标（重建容器不丢）。原来这里硬编码
    // `${kind}.png`：默认图如果是 .ico/.svg，回退静默返回 null，接口继续 404，
    // 而文件确实放进去了。favicon 最常见的格式恰好就是 ico。
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'brand-'))
      .catch(() => path.join(tmpdir(), 'brand-x'));
    // 真实函数读 defaultAssetsDir(cwd) → `apps/api/assets/brand`，所以把
    // cwd 指向一个只有 apps/api/assets/brand 的临时目录。
    const assets = path.join(dir, 'apps', 'api', 'assets', 'brand');
    await (await import('node:fs/promises')).mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, 'favicon.ico'), Buffer.from('00000100', 'hex'));

    const { readDefaultBrandFileForTest } = await import('../../src/lib/platform-brand.ts');
    const data = await readDefaultBrandFileForTest('favicon', dir);
    expect(data).not.toBeNull();
    expect(data?.length).toBe(4);

    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
});

describe('client and kernel brand rules cannot drift', () => {
  it('accept list contains every allowed extension', () => {
    for (const ext of BRAND_IMAGE_EXTENSIONS) {
      expect(BRAND_IMAGE_ACCEPT).toContain(ext);
    }
  });

  it('accept list carries no extension the kernel would reject', () => {
    // 反向断言：`accept` 里出现的扩展名必须都在白名单里，否则用户又会挑中一个
    // 注定被 415 的文件。
    const fromAccept = BRAND_IMAGE_ACCEPT.split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('.'))
      .map((part) => part.toLowerCase());
    expect(fromAccept.length).toBeGreaterThan(0);
    for (const ext of fromAccept) {
      expect(BRAND_IMAGE_EXTENSIONS as readonly string[]).toContain(ext);
    }
  });

  it('includes .ico on both sides (the original failure)', () => {
    expect(BRAND_IMAGE_EXTENSIONS as readonly string[]).toContain('.ico');
    expect(BRAND_IMAGE_ACCEPT).toContain('.ico');
    expect(BRAND_IMAGE_ACCEPT).toContain('image/x-icon');
  });
});

/**
 * `STACKPANEL_BRAND_DIR` —— 自定义默认图标的受支持入口。
 *
 * 曾经的「长期方案」是手工把宿主目录挂到 `apps/api/assets/brand`：那是**遮蔽**
 * 镜像里的文件，宿主目录为空时 logo 和 favicon 一起 404。独立变量 + 独立挂载点
 * 不会，因为没配置时根本不覆盖任何东西。
 */
describe('STACKPANEL_BRAND_DIR', () => {
  it('wins over the bundled assets and reads an ico favicon', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'brand-env-'));
    await writeFile(path.join(dir, 'favicon.ico'), Buffer.from('00000100', 'hex'));
    process.env['STACKPANEL_BRAND_DIR'] = dir;
    try {
      expect(defaultAssetsDir('/app')).toBe(dir);
      const { readDefaultBrandFileForTest } = await import('../../src/lib/platform-brand.ts');
      expect((await readDefaultBrandFileForTest('favicon'))?.length).toBe(4);
    } finally {
      delete process.env['STACKPANEL_BRAND_DIR'];
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not silently fall back to the bundled icons when misconfigured', () => {
    process.env['STACKPANEL_BRAND_DIR'] = '/nonexistent/brand';
    try {
      // 显式配错就该立刻暴露（种子会打日志、接口 404），而不是悄悄用镜像内置图
      // 让人以为改动已经生效——那正是这个变量存在的目的。
      expect(defaultAssetsDir('/app')).toBe('/nonexistent/brand');
    } finally {
      delete process.env['STACKPANEL_BRAND_DIR'];
    }
  });

  it('is ignored when blank (compose passes an empty string)', () => {
    process.env['STACKPANEL_BRAND_DIR'] = '   ';
    try {
      expect(defaultAssetsDir(REPO_ROOT)).toBe(
        path.join(REPO_ROOT, 'apps', 'api', 'assets', 'brand'),
      );
    } finally {
      delete process.env['STACKPANEL_BRAND_DIR'];
    }
  });
});
