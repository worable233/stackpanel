// @i18n-exempt — server-side runtime diagnostics (developer log messages, not UI copy)
import 'server-only';

/**
 * Contract 02 §5 / 主计划 §5 阶段 4 — the host RSC ABI publisher (M1 server side).
 *
 * A frontend package loaded at runtime is plain Node ESM from `data/`. In the RSC
 * server graph, `@stackpanel/ui`'s `'use client'` components are **client-reference
 * proxies** that only the host bundled, and `next/*` resolves to the host's own
 * adapters. Importing those bare specifiers from an un-bundled runtime module would
 * resolve to raw `node_modules` files and crash in RSC (`useState` is null —
 * SPIKE-results §0).
 *
 * This module is imported (and thus executed) **inside the host's RSC graph**, so
 * each import below is the host's real instance. It republishes them on
 * `globalThis.__STACKPANEL_SERVER_ABI__`, which the synchronous Node resolve hook in
 * `scripts/frontend-loader.mjs` reads to redirect a runtime module's host-ABI
 * specifiers to these exact host namespaces.
 *
 * Importing this module has a side effect (publishing the ABI), so the runtime
 * loader imports it before the first runtime `import()`.
 */
import * as ui from '@stackpanel/ui';
import * as link from 'next/link';
import * as form from 'next/form';
import * as navigation from 'next/navigation';
import * as jsxRuntime from 'react/jsx-runtime';
import * as react from 'react';
// 宿主 RSC 图里的 `react` 是 **react-server 构建**：没有 `useState`/`useEffect`/
// `useLayoutEffect`/`createContext` 等客户端 hook（实测差异 18 个名字）。而插件的
// 服务端入口 `dist/index.js` 常把某个 `'use client'` 模块一并打进同一个文件——
// referral 的 `route-progress.tsx` 就是如此，它在文件顶层写
// `import { useCallback, useState } from 'react'`。
//
// Node 的 ESM 链接是静态的：缺一个具名导出就抛
// `SyntaxError: The requested module 'react' does not provide an export named
// 'useState'`，**整个包**装载失败 → `pkg.ui` 为空 → 账号页/后台页全部被伪装成
// 404（v0.1.1 线上 `/account/referral` 的「未找到这个账户页面」）。
//
// 修法不是把客户端 React 塞进 RSC 图（那会让 `createContext` 直接抛），而是把
// 这些**只可能出现在客户端模块里的**名字补成链接期桩：真实渲染这些组件本来就是
// 错的，但「能链接」与「能执行」是两件事——前者不该让整包死掉。
const CLIENT_ONLY_REACT_NAMES = [
  'Component',
  'PureComponent',
  'act',
  'addTransitionType',
  'createContext',
  'startTransition',
  'useActionState',
  'useContext',
  'useDeferredValue',
  'useEffect',
  'useEffectEvent',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
] as const;

/**
 * `@stackpanel/ui/charts` 在 RSC 图里的链接期桩。
 *
 * 为什么不能发布真实实现：recharts 在**模块作用域**调 `React.createContext`，
 * 而服务端 React 构建没有它 —— 一旦 import 真实 charts，整个 RSC 图 500。
 *
 * 为什么不能发布空对象：插件的 `dist/index.js` 写着
 * `import { MetricsExplorer } from "@stackpanel/ui/charts"`，ESM 链接是静态的，
 * 缺一个具名导出就抛 `does not provide an export named`，整包加载失败（这正是
 * 之前 llm-gateway 报 `UsageTrendChart` 那次事故的形态）。
 *
 * 所以：每个导出名给一个**被调用才抛**的桩。顶层 import 不抛，链接能过。
 */
function chartsServerAbi(): Record<string, unknown> {
  const notInRsc = (): never => {
    throw new Error(
      '[frontend-runtime] @stackpanel/ui/charts 只能在浏览器里渲染。' +
        '图表组件依赖 recharts，它在模块作用域调用 React.createContext，' +
        '服务端 RSC 图里不可用。请把使用它的组件放进客户端入口。',
    );
  };
  return { MetricsExplorer: notInRsc, UsageTrendChart: notInRsc };
}

/**
 * 把 react-server 构建里缺失的客户端名字补成链接期桩（存在的不动）。
 *
 * 桩**不在加载时抛**：`dist/index.js` 顶层只 import 名字、不调用，所以抛错会让
 * 本可以正常渲染的账号页一起挂掉。它在真正被调用时抛，把「组件在 RSC 图里被执行」
 * 这个真实的 bug 暴露在正确的位置，而不是伪装成「页面不存在」。
 */
export function reactServerAbi(reactNamespace: Record<string, unknown>): Record<string, unknown> {
  const abi: Record<string, unknown> = { ...reactNamespace };
  for (const name of CLIENT_ONLY_REACT_NAMES) {
    if (name in abi) continue;
    abi[name] = (): never => {
      throw new Error(
        `[frontend-runtime] React.${name} 是客户端 API，服务端 RSC 图里不可用。` +
          '这个组件应该在浏览器里渲染：发布期应把它作为单独的客户端入口（admin.tsx / route-progress.tsx）',
      );
    };
  }
  return abi;
}

/**
 * `react-dom` 在 RSC 图里没有可用的服务端构建，但插件包可能把它当成宿主 ABI 导入。
 * 与上面的 React 桩同理：只为链接而存在。
 */
function reactDomServerAbi(): Record<string, unknown> {
  const notInRsc = (): never => {
    throw new Error(
      "[frontend-runtime] 'react-dom' 只能在浏览器里使用；服务端渲染请用 react-dom/server。",
    );
  };
  return {
    default: notInRsc,
    createPortal: notInRsc,
    flushSync: notInRsc,
    version: '0.0.0-rsc-stub',
  };
}
import * as sdk from '@stackpanel/sdk';
import * as lucide from 'lucide-react';
import * as sonner from 'sonner';
// NOTE: do **not** import `recharts` here. This module is evaluated inside the
// RSC server graph, and Recharts calls `React.createContext` at module scope —
// the server React build has no `createContext`, so the import throws
// "createContext only works in Client Components" and every page 500s.
// If a plugin ever needs charts, publish them from a `'use client'` module the
// way `frontend-abi-bridge.tsx` publishes the rest of the client ABI.
import {
  AutoSubmitForm,
  CopyLinkButton,
  RouteProgress,
} from '@/components/frontend-absorbed-clients';
import { CartCheckout } from '@/components/cart-checkout';
import { navigationServerAbi } from './frontend-loader';

/**
 * Host-absorbed client capabilities, keyed by the **dist file stem** of the client
 * module a runtime package ships (contract 02 §5; SPIKE-results §0). A runtime
 * package cannot serialize its own `'use client'` module, so the loader hook maps
 * a relative import of `./<stem>.js` inside a package's `dist/` to the host-bundled
 * stand-in.
 *
 * Today only the default theme's `route-progress.js` (stem `route-progress`) needs
 * absorption; new capabilities are added here.
 */
const ABSORBED_CLIENT_CAPABILITIES: Record<string, unknown> = {
  // Keyed by dist file stem, shared by every package that ships a module with
  // that name. The shim re-exports every name here, so each package only picks
  // up the exports it actually imports.
  // - default theme's `route-progress.js` → RouteProgress
  // - referral plugin's `route-progress.js` → CopyLinkButton
  'route-progress': { RouteProgress, CopyLinkButton },
  'auto-submit': { AutoSubmitForm, CartCheckout },
};

export type HostServerAbi = Record<string, unknown>;

/**
 * Publish the host RSC ABI on `globalThis` and return it. Must run before any
 * runtime `import()` of a frontend package so the resolve hook can see it.
 *
 * Assigned on every call rather than once: the value is a cheap object over
 * module-level imports, and a stale snapshot is a trap — a long-running dev server
 * kept publishing the ABI captured at boot, so a fix to what a slot exports (see
 * `navigationServerAbi`) never took effect until the process restarted. The shim
 * reads the global lazily, so swapping the object is safe.
 */
export function publishHostServerAbi(): HostServerAbi {
  const g = globalThis as unknown as {
    __STACKPANEL_SERVER_ABI__?: HostServerAbi;
    __STACKPANEL_ABSORBED_CLIENT__?: Record<string, unknown>;
  };
  g.__STACKPANEL_SERVER_ABI__ = {
    react: reactServerAbi(react as unknown as Record<string, unknown>),
    'react/jsx-runtime': jsxRuntime,
    // 两条 react-dom 说明符都要在：插件包同时会写 `react-dom` 与 `react-dom/client`，
    // 漏一个就是整包链接失败。
    'react-dom': reactDomServerAbi(),
    'react-dom/client': reactDomServerAbi(),
    'next/link': link,
    'next/form': form,
    'next/navigation': navigationServerAbi(navigation as unknown as Record<string, unknown>),
    '@stackpanel/ui': ui,
    // 图表组件的独立槽。服务端**不发布真实实现**：recharts 在模块作用域调
    // `React.createContext`，在 RSC 图里会直接抛（见上方 NOTE）。
    //
    // 给一组链接期桩，与 `reactServerAbi` 同一个理由：插件 `dist/index.js`
    // 顶层只 import 名字、不调用，所以能链接就不该让整包死掉；真被调用时才
    // 抛，把「客户端组件在服务端执行」这个真实 bug 暴露在正确位置。
    '@stackpanel/ui/charts': chartsServerAbi(),
    '@stackpanel/sdk': sdk,
    'lucide-react': lucide,
    sonner,
  };
  // Client references are refreshed too, so development hot reload picks up new
  // absorbed capabilities.
  g.__STACKPANEL_ABSORBED_CLIENT__ = ABSORBED_CLIENT_CAPABILITIES;
  return g.__STACKPANEL_SERVER_ABI__;
}

/** Dist file stem → host-absorbed capability (for tests / the loader hook). */
export const ABSORBED_CLIENT_STEMS = Object.keys(ABSORBED_CLIENT_CAPABILITIES);
