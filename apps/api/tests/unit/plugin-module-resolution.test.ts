import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 插件装在数据目录（`/var/lib/stackpanel/data/plugins/<id>`），但它们的裸导入
 * （`@stackpanel/sdk`、`zod`）只存在于版本目录的 `node_modules`
 * （`/opt/stackpanel/releases/<v>/node_modules`）。Node 的解析只会从插件目录
 * **向上**找 `node_modules`，因此数据目录与安装根不在同一棵树时，每个内置插件
 * 都会变成 `Skipping invalid plugin: Cannot find package 'zod'`——进程正常、
 * 首页 404、市场为空，安装与自举却都报成功。
 *
 * `ensurePluginModuleResolution` 在数据目录放一个指向版本目录的符号链接，
 * 升级切换 `current` 后自动跟随新版本。这里钉死它的判定顺序与幂等性。
 */
import { ensurePluginModuleResolution } from '../../src/lib/plugins.ts';

describe('ensurePluginModuleResolution', () => {
  const created: string[] = [];
  const savedDataDir = process.env['STACKPANEL_DATA_DIR'];

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = savedDataDir;
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tree(): { root: string; releaseDir: string; dataDir: string; cwd: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-modres-'));
    created.push(root);
    // 产物布局：releases/<version>/{apps/api,node_modules}
    const releaseDir = path.join(root, 'releases', '0.2.0');
    const cwd = path.join(releaseDir, 'apps', 'api');
    const dataDir = path.join(root, 'state', 'data');
    mkdirSync(path.join(releaseDir, 'node_modules'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(releaseDir, 'node_modules', '.keep'), '');
    return { root, releaseDir, dataDir, cwd };
  }

  it('在数据目录建立指向当前版本 node_modules 的符号链接', async () => {
    const { releaseDir, dataDir, cwd } = tree();
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      await ensurePluginModuleResolution();
    } finally {
      process.chdir(previous);
    }
    const link = path.join(dataDir, 'node_modules');
    // macOS 的 tmpdir 是 /var → /private/var 符号链接，比较前统一取真实路径。
    expect(realpathSync(readlinkSync(link))).toBe(
      realpathSync(path.join(releaseDir, 'node_modules')),
    );
  });

  it('已存在 node_modules 时不覆盖（开发布局与重复启动都走这条）', async () => {
    const { dataDir } = tree();
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    const existing = path.join(dataDir, 'node_modules');
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, 'sentinel'), '');
    const logs: string[] = [];
    await ensurePluginModuleResolution((message) => logs.push(message));
    // 保持既有内容：开发布局下数据目录自带真实 node_modules，不该被符号链接替换。
    expect(existsSync(path.join(existing, 'sentinel'))).toBe(true);
    expect(lstatSync(existing).isSymbolicLink()).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('找不到版本目录时不创建悬空链接，只记一条日志', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-modres-none-'));
    created.push(root);
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    const logs: string[] = [];
    const previous = process.cwd();
    process.chdir(root);
    try {
      await ensurePluginModuleResolution((message) => logs.push(message));
    } finally {
      process.chdir(previous);
    }
    expect(() => readlinkSync(path.join(dataDir, 'node_modules'))).toThrow();
  });
});
