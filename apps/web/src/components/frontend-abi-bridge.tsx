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
import * as ui from '@stackpanel/ui';
import * as sdk from '@stackpanel/sdk';
import * as lucide from 'lucide-react';

interface ClientAbiGlobal {
  __STACKPANEL_CLIENT_ABI__?: unknown;
}

/**
 * 发布（幂等）宿主客户端 ABI。返回发布对象（供 `useSyncExternalStore` 之外的
 * 一次性调用断言）。必须在任何运行期 `import()` 之前调用——`FrontendAbiBridge`
 * 挂在根布局，任何页面/组件渲染前即已执行。
 */
export function publishHostClientAbi(): void {
  const g = globalThis as unknown as ClientAbiGlobal;
  if (g.__STACKPANEL_CLIENT_ABI__) return;
  g.__STACKPANEL_CLIENT_ABI__ = {
    react: React,
    'react-dom': ReactDOM,
    'react/jsx-runtime': { jsx, jsxs, Fragment },
    'next/link': { default: Link },
    'next/form': form,
    'next/navigation': navigation,
    '@stackpanel/ui': ui,
    // Packages format money and resolve their own catalogs through the SDK
    // (`createPackageTranslator`), so runtime-loaded client modules need the
    // host's SDK namespace too.
    '@stackpanel/sdk': sdk,
    'lucide-react': lucide,
  };
}

/**
 * 根布局挂载的宿主 ABI 桥接：只做「发布」这一件事。浏览器里发布本身就是进口
 * `globalThis`，因此无需渲染任何 DOM（返回 `null`）。它存在的意义是**强制 Next
 * 把上述 ABI 模块打进客户端 bundle**，让宿主实例在适配器被 `import()` 时已就绪。
 */
export function FrontendAbiBridge(): null {
  publishHostClientAbi();
  return null;
}
