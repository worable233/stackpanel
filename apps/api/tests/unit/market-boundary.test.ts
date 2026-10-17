import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 市场归属守护（ADR-0020 D3 / PLAN-github-distribution-and-updates §9）。
 *
 * 定案：**市场业务面属于内置插件 `market`，内核只保留分发安全原语**
 * （`MarketService`：验签目录、统一安装事务、运行时激活），经
 * `ctx.requireService('kernel.market')` 暴露。
 *
 * 本测试用「棘轮」方式钉死该边界，防止市场路由/页面悄悄回流内核：
 *   1. 内核不得注册 `/admin/market` 路由，也不得再导出 `adminMarketRoutes`；
 *   2. 市场页面组件不得再出现在 `apps/web`；
 *   3. `market` 插件必须存在且为 builtin，声明 `kernel.market` 注入与 `market.admin` 权限；
 *   4. 插件不得 import 内核（复用 ADR-0008 的边界要求，这里针对市场源码再钉一次）。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const apiSrc = path.join(repoRoot, 'apps', 'api', 'src');
const webSrc = path.join(repoRoot, 'apps', 'web', 'src');
const marketPlugin = path.join(repoRoot, 'packages', 'plugins', 'market');

function files(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...files(full, pattern));
    } else if (pattern.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('市场归属（ADR-0020 D3）', () => {
  it('内核不再注册 /admin/market 路由', () => {
    const offenders: string[] = [];
    for (const file of files(path.join(apiSrc, 'routes'), /\.ts$/)) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/['"`]\/admin\/market/.test(code) || /\badminMarketRoutes\b/.test(code)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders, `市场路由必须由插件提供：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('市场后台页面不再随内核 apps/web 发布', () => {
    const offenders = files(webSrc, /\.(tsx?|mjs)$/).filter(
      (file) =>
        /(^|\/)market-(section|actions)\.tsx?$/.test(file) ||
        /admin\/market\/page\.tsx$/.test(file),
    );
    expect(
      offenders.map((file) => path.relative(repoRoot, file)),
      '市场页面必须随 market 插件发布',
    ).toEqual([]);
  });

  it('market 内置插件存在、声明注入与权限', () => {
    const pkg = JSON.parse(readFileSync(path.join(marketPlugin, 'package.json'), 'utf8')) as {
      stackpanel?: { builtin?: boolean };
    };
    expect(pkg.stackpanel?.builtin).toBe(true);

    const manifest = JSON.parse(
      readFileSync(path.join(marketPlugin, 'frontend', 'manifest.json'), 'utf8'),
    ) as {
      adminRoutes: Array<{ permission?: string; nav?: { labelKey?: string } }>;
      actions: Array<{ path: string; permission?: string }>;
      finders: string[];
    };
    const route = manifest.adminRoutes[0];
    expect(route?.permission).toBe('market.admin');
    // ADR-0016: nav copy lives in the package catalog, not as inline Chinese.
    // The key must resolve in every shipped locale (see `i18n:packages`).
    const labelKey = route?.nav?.labelKey;
    expect(labelKey).toBeTruthy();
    const catalogs = JSON.parse(
      readFileSync(path.join(marketPlugin, 'frontend', 'messages', 'zh-CN.json'), 'utf8'),
    ) as Record<string, string>;
    expect(catalogs[labelKey ?? '']).toBeTruthy();
    expect(manifest.finders).toContain('market.adminPlugins');
    expect(manifest.finders).toContain('market.adminThemes');
    // 动作路径必须落在插件自己的命名空间，而不是内核路径。
    for (const action of manifest.actions) {
      expect(action.path.startsWith('/market/')).toBe(true);
      expect(action.permission).toBe('market.admin');
    }

    const source = readFileSync(path.join(marketPlugin, 'src', 'index.ts'), 'utf8');
    expect(source).toContain("inject: ['kernel.market']");
    expect(source).toContain("'kernel.market'");
  });

  it('market 插件不得 import 内核（ADR-0008）', () => {
    const offenders: string[] = [];
    for (const file of files(path.join(marketPlugin, 'src'), /\.ts$/)) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/from\s+['"][^'"]*apps\/api|from\s+['"]@stackpanel\/api['"]/.test(code)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders, `市场插件不得 import 内核：\n${offenders.join('\n')}`).toEqual([]);
  });
});
