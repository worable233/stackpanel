// @i18n-exempt — 服务端运行期诊断（开发者日志，不是界面文案）
import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 前端运行期诊断上下文（P1-B）。
 *
 * 之前所有 `[frontend-runtime]` 错误只有一句话，没有 pluginId / route /
 * component。线上 v0.1.3 的实例详情页 500（digest 1508909678）定位靠的是手工
 * grep 编译产物，反查 `MetricsExplorer` 来自 store 插件的 account/service-detail
 * 路由 —— 这在生产上是不可接受的成本。
 *
 * 机制：渲染一个前端包的页面时用 `runWithFrontendContext` 起一个
 * AsyncLocalStorage 域，域内任何地方（ABI 桩、loader 钩子）打日志都能带上
 * 插件与路由，不必层层传参。
 */
export interface FrontendDiagnosticContext {
  /** `plugins` / `themes` */
  kind: 'themes' | 'plugins';
  id: string;
  version?: string;
  /** 前端路由名，例如 `account/service-detail`。 */
  route?: string;
  /** 具体组件名，例如 `MetricsExplorer`。 */
  component?: string;
}

const storage = new AsyncLocalStorage<FrontendDiagnosticContext>();

/** 在当前 async 上下文里挂上前端诊断信息，并执行 `fn`。 */
export function runWithFrontendContext<T>(context: FrontendDiagnosticContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * 在当前 async 上下文里**挂上**诊断信息（`enterWith` 而非 `run`）。
 *
 * 为什么不是 `run`：RSC 的渲染发生在组件**返回之后**（页面组件只是
 * `createElement` 一个元素就返回了），`run(fn)` 的域在渲染真正开始时已经结束。
 * `enterWith` 把存储挂到当前 async 执行及其后续延续上，与 `frontend-snapshot.ts`
 * 用的是同一个机制（那里同样不能用 `run`，理由相同）。
 *
 * 已存在时**合并**而不是覆盖：loader 先挂 kind/id，页面组件随后补 route。
 */
export function enterFrontendContext(context: Partial<FrontendDiagnosticContext>): void {
  const existing = storage.getStore();
  storage.enterWith({ ...(existing ?? {}), ...context } as FrontendDiagnosticContext);
}

/** 当前上下文的只读快照（无则 undefined）。 */
export function currentFrontendContext(): FrontendDiagnosticContext | undefined {
  return storage.getStore();
}

/**
 * 把诊断上下文压成一行可 grep 的字段串。
 *
 * 缺字段就省略而不是打 `undefined`：日志里 `route=undefined` 会让人以为
 * 那个字段取到了空值，比没有更误导。
 */
export function formatFrontendContext(
  context: FrontendDiagnosticContext | undefined,
  overrides: Partial<FrontendDiagnosticContext> = {},
): string {
  const merged = { ...context, ...overrides };
  const parts: string[] = [];
  if (merged.kind && merged.id) parts.push(`${merged.kind}/${merged.id}`);
  if (merged.version) parts.push(`version=${merged.version}`);
  if (merged.route) parts.push(`route=${merged.route}`);
  if (merged.component) parts.push(`component=${merged.component}`);
  return parts.join(' ');
}

/** 已 warn 过的组件名（进程级）。同一处误用只报一次，不刷屏。 */
const warnedComponents = new Set<string>();

/** 测试用：清空去重表。 */
export function resetChartComponentWarnings(): void {
  warnedComponents.clear();
}

/**
 * 图表组件在服务端被渲染了：留一条可定位的 warn，然后让调用方返回 null。
 *
 * 去重按 `插件/路由/组件` 三元组：一个页面上重复渲染同一个图表组件只报一次，
 * 但两个不同插件的同一组件名会各报一条 —— 这正是需要区分的信息。
 */
export function reportChartComponentOnServer(component: string): void {
  const context = storage.getStore();
  const scope = formatFrontendContext(context, { component });
  if (warnedComponents.has(scope)) return;
  warnedComponents.add(scope);
  console.warn(
    `[frontend-runtime] 图表组件在服务端 RSC 图里被渲染，已降级为空块（页面其余部分正常）：${scope}`
      + ' —— 该组件依赖 recharts，只能在浏览器渲染。修法：把使用它的组件放进客户端入口。',
  );
}
