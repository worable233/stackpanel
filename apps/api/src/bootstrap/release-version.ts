/**
 * 读取内核产物的目标版本（来自产物根目录的 `RELEASE.json`）。
 *
 * 为什么单独成文件而不是留在 `server.ts` 里：`server.ts` 是带顶层副作用的
 * 进程入口（`await main()`），任何 import 都会真的去启动进程，因此无法直接做
 * 单元测试。这段路径推导又恰好是最容易写错的地方——产物布局是
 * `releases/<version>/apps/api/dist/server.js`，而 `RELEASE.json` 在
 * `releases/<version>/`，即 `dist` 的**上三层**。少一层就会得到 `unknown`，
 * 表现为自举时 runner 报「任务未记录目标版本，无法定位迁移产物」。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 从入口模块 URL 向上查找 `RELEASE.json`。
 *
 * 依次尝试 dist 的 1/2/3 层父目录，覆盖：
 * - 产物布局 `<version>/apps/api/dist/server.js` → 3 层；
 * - 源码构建 `apps/api/dist/server.js` → 2 层（仓库根有时也有 RELEASE.json）；
 * - 单层打包布局 `dist/server.js` → 1 层。
 *
 * 找不到或内容不可解析时返回 `'unknown'`；调用方必须显式拒绝该值，
 * 不能把它当成合法版本继续执行。
 */
export function resolveTargetVersion(moduleUrl: string | URL): string {
  const here = path.dirname(moduleUrl instanceof URL ? moduleUrl.pathname : fileUrlPath(moduleUrl));
  const candidates = [
    path.resolve(here, '..', 'RELEASE.json'),
    path.resolve(here, '..', '..', 'RELEASE.json'),
    path.resolve(here, '..', '..', '..', 'RELEASE.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    } catch {
      // 读取或解析失败时继续尝试下一个候选。
    }
  }
  return 'unknown';
}

function fileUrlPath(moduleUrl: string): string {
  try {
    return new URL(moduleUrl).pathname;
  } catch {
    return moduleUrl;
  }
}
