/**
 * 进程入口（审计 R2、R10）。
 *
 * 这个文件只做一件事：**决定加载哪一个 app**，然后交给它启动。
 *
 * 为什么不能用「一个 app 加运行时分支」：ESM 的静态 import 在模块求值时就执行，
 * 而 `app.ts` 会连带加载 Prisma、插件宿主、主题发现、审计与限流。
 * 在尚未配置数据库的首次启动里，这些模块本身就依赖 env 中的 DATABASE_URL；
 * 即使运行时分支不调用它们，加载期也可能已经失败。
 *
 * 因此这里用**动态 import**：provision 模式只加载 `bootstrap/provision-app.ts`，
 * 其传递依赖里没有 Prisma、没有 Redis、没有插件宿主。
 *
 * 阶段判定使用**显式磁盘状态**，不是「数据库连不上」（审计 R3）：
 * 数据库故障绝不能让生产实例回落到可写配置的页面。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { BootstrapStateStore, defaultBootstrapStateDir, initialState } from './bootstrap/state.ts';
import { resolveTargetVersion as readReleaseVersion } from './bootstrap/release-version.ts';

/**
 * 隔离插件进程通过 RPC 抛出的异步错误不能带走整个 API。
 * 记录后继续服务，具体请求由插件边界返回错误。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection (kept alive):', reason);
});

/**
 * 解析状态根目录与自举状态目录。
 *
 * 必须与 runner / 安装器一致：
 * - `<STACKPANEL_STATE_DIR>` 是状态根（配置文件、bootstrap、update 都在它下面）；
 * - 自举状态在 `<STACKPANEL_STATE_DIR>/bootstrap`。
 *
 * 没有 `STACKPANEL_STATE_DIR` 时从数据目录反推（`<state>/data` → `<state>`），
 * 仅为开发便利；生产由 ecosystem 显式注入。
 */
function resolveStateRoots(): { root: string; bootstrapDir: string } {
  const explicit = process.env['STACKPANEL_STATE_DIR'];
  if (explicit && explicit.trim().length > 0) {
    const root = path.resolve(explicit);
    return { root, bootstrapDir: defaultBootstrapStateDir(root) };
  }
  const dataDir = process.env['STACKPANEL_DATA_DIR'];
  if (dataDir && dataDir.trim().length > 0) {
    const root = path.dirname(path.resolve(dataDir));
    return { root, bootstrapDir: defaultBootstrapStateDir(root) };
  }
  const root = path.resolve(process.cwd(), '.stackpanel');
  return { root, bootstrapDir: defaultBootstrapStateDir(root) };
}

/** 读取目标内核版本；来自产物内的 `RELEASE.json`。 */
function resolveTargetVersion(moduleUrl: string): string {
  return readReleaseVersion(moduleUrl);
}

/**
 * 判断是否进入 provision 模式。
 *
 * 规则（与审计 §3 的状态机一致）：
 * - env 投影 `STACKPANEL_BOOTSTRAP_STATE` 为 `provision` → 进入；
 * - 否则看磁盘状态：只有 `needs_infra` 才进入；
 * - **其它任何阶段（含状态文件损坏）都不进入**，按正常启动，让故障暴露。
 *
 * 特别注意：`queued` / `migrating` / `starting` 期间 DB 可能已经可用，
 * 此时必须由正常入口启动（runner 会设置投影），不能回到自举页。
 */
async function shouldProvision(stateDir: string): Promise<boolean> {
  const projected = process.env['STACKPANEL_BOOTSTRAP_STATE'];
  if (projected === 'provision') return true;
  if (projected === 'configured') return false;

  const store = new BootstrapStateStore({ dir: stateDir });
  try {
    const state = await store.read();
    return state?.phase === 'needs_infra';
  } catch {
    // 状态损坏：不要静默进入可写页面，交给正常启动报错。
    return false;
  }
}

/**
 * provision 启动路径。
 *
 * 只监听，不连数据库、不初始化 Redis、不注册插件。
 */
async function startProvision(
  roots: { root: string; bootstrapDir: string },
  targetVersion: string,
): Promise<void> {
  const { buildProvisionApp } = await import('./bootstrap/provision-app.ts');
  const store = new BootstrapStateStore({ dir: roots.bootstrapDir, targetVersion });

  // 状态文件缺失时先落一个 needs_infra，让发现接口有权威来源。
  if (!existsSync(path.join(roots.bootstrapDir, 'state.json'))) {
    await store.write(initialState(new Date()));
  }

  const app = buildProvisionApp({
    setupToken: process.env['STACKPANEL_SETUP_TOKEN'] ?? '',
    store,
    targetVersion,
    stateDir: roots.root,
    ...(process.env['STACKPANEL_UPDATE_INSTANCE_ID']
      ? { instanceId: process.env['STACKPANEL_UPDATE_INSTANCE_ID'] }
      : {}),
  });

  const host = process.env['API_HOST'] ?? '127.0.0.1';
  const port = Number(process.env['API_PORT'] ?? 3001);
  await app.listen({ host, port });
  app.log.warn(
    `[bootstrap] 实例处于首次配置模式（${host}:${port}）。` +
      '请打开 Web 站点的 /setup 填写基础设施；此模式不接受任何业务请求。',
  );
}

/** 正常启动路径（与既有行为一致）。 */
async function startNormal(): Promise<void> {
  // 动态 import：provision 模式下这些模块根本不会被求值。
  const { default: run } = await import('./normal-start.ts');
  await run();
}

async function main(): Promise<void> {
  const roots = resolveStateRoots();
  const targetVersion = resolveTargetVersion(import.meta.url);
  if (await shouldProvision(roots.bootstrapDir)) {
    await startProvision(roots, targetVersion);
    return;
  }
  await startNormal();
}

await main();
