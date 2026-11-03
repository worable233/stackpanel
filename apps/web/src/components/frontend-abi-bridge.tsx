'use client';

/**
 * Contract 02 §5 / 主计划 §5 阶段 4 — 受控适配器的宿主侧（M2 浏览器）。
 *
 * 本模块由 Next/Turbopack bundle，因此下面每个 import 都是**宿主自己的**模块实例
 * （与渲染器同一份 React）。它把宿主 ABI 发布到 `globalThis.__STACKPANEL_CLIENT_ABI__`，
 * 由同源的 `/api/frontend-abi/*` 适配器逐名重导，供运行期装载的插件 admin 模块使用。
 *
 * 这**不是**全局 import map，也不是 Next 私有模块 id——正是计划的「发布期把固定宿主
 * 依赖转换为受控 adapter 导入」（SPIKE-results §0：naive bare specifier 在浏览器里
 * 解析失败，改写为受控 adapter 后稳定共享宿主 React）。
 */
import * as React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import Link from 'next/link';
import * as form from 'next/form';
import * as navigation from 'next/navigation';
import * as sdk from '@stackpanel/sdk';
import * as lucide from 'lucide-react';
import * as sonner from '@/components/ui/toast';

/**
 * `@stackpanel/ui` **不在这里静态导入**。
 *
 * 它是整个桶（101 个导出），其中 `MetricsExplorer` 依赖 recharts。静态
 * `import * as ui` 会把它拖进**每个页面**的首屏 chunk —— 实测首页未登录就
 * 同步加载 3.4MB（recharts 647KB + zod 911KB + lucide 359KB + …）。
 *
 * 改成按需 `import()`：只有真正要装载运行期插件模块时才解析这份命名空间。
 * 插件前端没有任何一个直接 `import 'recharts'`，它们用 UI 包里的
 * `MetricsExplorer` 封装，所以延迟加载不影响任何插件。
 */

interface ClientAbiGlobal {
  __STACKPANEL_CLIENT_ABI__?: unknown;
}

let publishing: Promise<void> | null = null;

/**
 * 发布（幂等）宿主客户端 ABI。
 *
 * 返回 Promise：`@stackpanel/ui` 是按需 `import()` 的，所以发布是异步的。
 * 调用方**必须** await 它之后再 `import()` 插件模块，否则适配器会读到未
 * 发布的 ABI。
 *
 * 幂等性靠两个检查：全局已发布则直接返回；并发的调用共享同一个 Promise
 * （`publishing`），避免重复解析 UI 桶。
 */
/**
 * 图表槽的惰性句柄。
 *
 * `@stackpanel/ui/charts` 依赖 recharts（未压缩 559 KB）。这里用 getter
 * **推迟到插件真的取用时才 import** —— 若在发布时无条件加载，recharts 会
 * 重新进入每个页面的模块图，拆分就白做了。
 *
 * getter 返回 Promise：适配器（`/api/frontend-abi/*`）取到的就是这个句柄，
 * 它 await 之后拿到真正的命名空间。
 */
let chartsPromise: Promise<unknown> | null = null;
function chartsSlot(): Promise<unknown> {
  chartsPromise ??= import('@stackpanel/ui/charts');
  return chartsPromise;
}

export function publishHostClientAbi(): Promise<void> {
  const g = globalThis as unknown as ClientAbiGlobal;
  if (g.__STACKPANEL_CLIENT_ABI__) return Promise.resolve();
  publishing ??= (async () => {
    // 动态 import 让 UI 桶落到**独立的懒加载 chunk**，不再阻塞首屏。
    const ui = await import('@stackpanel/ui');
    if (g.__STACKPANEL_CLIENT_ABI__) return;
    g.__STACKPANEL_CLIENT_ABI__ = {
      react: React,
      'react-dom': ReactDOM,
      'react/jsx-runtime': { jsx, jsxs, Fragment },
      'next/link': { default: Link },
      'next/form': form,
      'next/navigation': navigation,
      '@stackpanel/ui': ui,
      // 惰性：getter 只在插件取图表组件时才触发 import()。
      '@stackpanel/ui/charts': chartsSlot,
      // Packages format money and resolve their own catalogs through the SDK
      // (`createPackageTranslator`), so runtime-loaded client modules need the
      // host's SDK namespace too.
      '@stackpanel/sdk': sdk,
      'lucide-react': lucide,
      // Imported by runtime admin bundles. Publishing the host instance keeps
      // plugin `toast()` calls wired to the single host `<Toaster />`.
      sonner,
    };
  })();
  // 失败时释放，让下一次调用可以重试（一次网络抖动不该永久卡住插件装载）。
  publishing.catch(() => {
    publishing = null;
  });
  return publishing;
}

/**
 * 根布局挂载的宿主 ABI 桥接。
 *
 * 它**不再在首屏发布**：发布只在「运行期装载插件模块」之前才有意义，而那条
 * 路径（`use-runtime-module.ts` 的 `loadModule`）已经会在 `import()` 前 await
 * `publishHostClientAbi()`。所以这里不做任何事，只保留组件位置以免根布局改动。
 *
 * 渲染返回 `null`，不产生 DOM。
 */
export function FrontendAbiBridge(): null {
  return null;
}
