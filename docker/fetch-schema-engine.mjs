/**
 * 在**镜像构建期**把 Prisma schema engine 下载进镜像（ADR-0025 / 升级链路）。
 *
 * 为什么必须在构建期做：`prisma migrate deploy` 运行时需要
 * `schema-engine-<platform>`，而 `prisma generate` 只下载 query engine。
 * 缺了它，每次迁移都会在**升级时**从 `binaries.prisma.sh` 现场下载：
 *
 *   prisma:fetch-engine:download https://binaries.prisma.sh/all_commits/<hash>/...
 *
 * 这条下载**没有超时**。真机升级演练里网络受限，`migrating` 一步挂了 30 分钟：
 * updater 只能干等，实例停在维护态，日志里也没有任何原因说明。离线/内网部署
 * 则永远无法迁移。放到构建期下载，运行时才是确定性的。
 *
 * 产物落在 pnpm store 之外，并通过 `PRISMA_SCHEMA_ENGINE_BINARY` 显式钉住，
 * 避免 CLI 再去猜缓存路径。
 *
 * 用法：node docker/fetch-schema-engine.mjs [目标路径]
 */

import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const target = process.argv[2] ?? process.env['PRISMA_SCHEMA_ENGINE_BINARY'];
if (!target) {
  console.error('缺少目标路径：传入参数或设置 PRISMA_SCHEMA_ENGINE_BINARY');
  process.exit(1);
}

/**
 * 找到 `@prisma/fetch-engine` 的入口。
 *
 * pnpm 用**隔离式** node_modules：`prisma` 包只能解析到它自己在 `.pnpm/<hash>/`
 * 下的同伴依赖，从 workspace 根目录 require 会 MODULE_NOT_FOUND。而
 * `@prisma/engines` 把 `@prisma/fetch-engine` 声明为普通依赖，所以最稳的做法是
 * 先定位 `.pnpm` 下 `@prisma+engines` 的包目录，再以它为基准解析。
 */
function resolveFetchEngine() {
  const req = createRequire(import.meta.url);
  const tried = [];
  const tryResolve = (base) => {
    try {
      return req.resolve('@prisma/fetch-engine', { paths: [base] });
    } catch {
      tried.push(base);
      return null;
    }
  };

  // 1) 直接候选（本地开发 / 非 pnpm 布局）。
  for (const base of [
    '/app/packages/db/node_modules/prisma',
    '/app/node_modules/prisma',
    '/app/packages/db',
    '/app',
    process.cwd(),
  ]) {
    const hit = tryResolve(base);
    if (hit) return hit;
  }

  // 2) pnpm 布局：遍历 `.pnpm` 找 engines 包（root 与 workspace 包都要找）。
  const roots = ['/app/node_modules/.pnpm', path.join(process.cwd(), 'node_modules/.pnpm')];
  for (const pnpmDir of roots) {
    if (!existsSync(pnpmDir)) continue;
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('@prisma+engines@')) continue;
      const base = path.join(pnpmDir, entry, 'node_modules', '@prisma', 'engines');
      if (!existsSync(base)) continue;
      const hit = tryResolve(base);
      if (hit) return hit;
    }
  }

  throw new Error(
    `无法解析 @prisma/fetch-engine，已尝试：\n - ${tried.join('\n - ')}\n` +
      `以及 .pnpm 下的 @prisma+engines@* 目录`,
  );
}

const modulePath = resolveFetchEngine();
console.log(`[schema-engine] fetch-engine: ${modulePath}`);

const { download } = createRequire(import.meta.url)(modulePath);
mkdirSync(path.dirname(target), { recursive: true });

// `download()` 把产物写成 `<target>/schema-engine-<platform>`（target 是目录）。
// 我们把它收敛成单文件 `<target>`，这样 `PRISMA_SCHEMA_ENGINE_BINARY` 可以
// 直接指向确定路径，CLI 不需要再按平台猜文件名。
// `download()` 会把产物放进 **同名目录**（`<target>/schema-engine-<platform>`），
// 目录不存在时它内部的 copyfile 会以 ENOENT 失败——必须提前建好。
//
// 用独立的 staging 目录而不是 target 本身：否则重复执行时 `mkdirSync(target)`
// 会把上一次已收敛好的**文件**当成目录建回来，产物直接丢失（本脚本本地验证时踩到）。
const stagingDir = `${target}.download`;
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

// 必须显式给 `version`（= engines 的提交号）。缺省时 `download()` 用
// `channel: 'all_commits'` + `version: 'latest'`，会去拉
// `.../all_commits/latest/<platform>/schema-engine.gz.sha256` → 404。
// prisma CLI 自己是从 `@prisma/engines` 的 `enginesVersion` 取这个值的。
const { enginesVersion } = createRequire(import.meta.url)(
  createRequire(import.meta.url).resolve('@prisma/engines', { paths: [modulePath] }),
);
console.log(`[schema-engine] engines version: ${enginesVersion}`);
const result = await download({
  binaries: { 'schema-engine': stagingDir },
  version: enginesVersion,
});
console.log(`[schema-engine] 下载完成：${JSON.stringify(result)}`);

const produced = Object.values(result['schema-engine'] ?? {}).filter(
  (file) => typeof file === 'string' && existsSync(file),
);
if (produced.length === 0) {
  console.error('[schema-engine] 下载未产出任何文件，构建失败');
  process.exit(1);
}

// 单平台镜像：正常情况下恰好一个产物。多于一个说明构建环境有多 target，
// 取当前平台那个（`download()` 已按当前平台过滤，这里只做防御）。
const source = produced[0];
const size = statSync(source).size;
if (size < 1_000_000) {
  console.error(`[schema-engine] 产物过小（${size} 字节），疑似下载被截断：${source}`);
  process.exit(1);
}
// 收敛成单文件 `target`（先删旧的目录/文件再写），让
// PRISMA_SCHEMA_ENGINE_BINARY 能直接指向确定路径，CLI 不必再按平台猜文件名。
const staged = `${target}.staged`;
copyFileSync(source, staged);
rmSync(target, { recursive: true, force: true });
renameSync(staged, target);
rmSync(stagingDir, { recursive: true, force: true });
chmodSync(target, 0o755);
console.log(`[schema-engine] ok ${target} (${(size / 1_048_576).toFixed(1)} MB)`);
