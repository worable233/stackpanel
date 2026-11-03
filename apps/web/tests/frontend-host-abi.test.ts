import { describe, expect, it } from 'vitest';
import { reactServerAbi } from '@/lib/frontend-host-abi';

/**
 * 宿主服务端 ABI 必须能让插件的**服务端入口**链接成功。
 *
 * 线上事故（v0.1.1）：`/account/referral` 一直是「未找到这个账户页面」。因果链是
 * 插件的 `frontend/dist/index.js` 里含有 `import { useCallback, useState } from
 * "react"`（它的 `route-progress.tsx` 是个 `'use client'` 模块，却被一起打进了
 * 服务端入口），而宿主 RSC 图里的 `react` 是 **react-server 构建**，没有
 * `useState`/`useEffect`/`createContext` 等客户端 API。Node 的 ESM 链接是静态的，
 * 缺一个具名导出就抛 `SyntaxError`，整个包装载失败，`pkg.ui` 为空，调用方于是
 * 把「加载崩了」报成「页面不存在」。
 *
 * 这些用例锁住两件事：
 * 1. 链接期不能缺名 —— 客户端 hook 全部要有（哪怕只是桩）；
 * 2. 桩只在**被调用**时抛 —— 顶层 import 不抛，否则会连带打死本可正常渲染的页面。
 */

/** react-server 构建里真实存在的名字（少了就说明构建形态变了）。 */
const SERVER_NAMES = ['createElement', 'Fragment', 'use', 'useId', 'useMemo', 'useCallback'];

/** react-server 构建里**没有**、但客户端模块会 import 的名字。 */
const CLIENT_ONLY = [
  'useState',
  'useEffect',
  'useLayoutEffect',
  'useRef',
  'useReducer',
  'useContext',
  'createContext',
  'useTransition',
  'startTransition',
  'Component',
  'PureComponent',
  'forwardRef',
];

function serverReact(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ns: Record<string, unknown> = {};
  for (const name of SERVER_NAMES) ns[name] = () => null;
  return { ...ns, ...extra };
}

describe('reactServerAbi', () => {
  it('keeps every real react-server export untouched', () => {
    const real = serverReact();
    const abi = reactServerAbi(real);
    for (const name of SERVER_NAMES) expect(abi[name]).toBe(real[name]);
  });

  it('adds a binding for every client-only name so a package can still link', () => {
    const abi = reactServerAbi(serverReact());
    for (const name of CLIENT_ONLY) {
      if (name === 'forwardRef') continue; // react-server 其实有 forwardRef
      expect(abi, `missing ${name}`).toHaveProperty(name);
      expect(typeof abi[name], `${name} must be callable`).toBe('function');
    }
  });

  it('never throws at link time — only when a stub is actually invoked', () => {
    const abi = reactServerAbi(serverReact());
    // 链接期：取名字不能抛。
    expect(() => Object.keys(abi).map((key) => abi[key])).not.toThrow();
    // 执行期：在 RSC 图里调用客户端 hook 是真 bug，必须在调用点暴露。
    expect(() => (abi['useState'] as () => unknown)()).toThrow(/客户端 API/);
  });

  it('does not clobber a name the server build already provides', () => {
    const real = serverReact({ useState: 'REAL_USE_STATE' });
    expect(reactServerAbi(real)['useState']).toBe('REAL_USE_STATE');
  });

  it('leaves a genuine react-server build usable for rendering', () => {
    // 桩不能污染真实渲染路径：createElement 必须还是宿主自己的。
    const real = serverReact({ createElement: 'HOST_CREATE_ELEMENT' });
    const abi = reactServerAbi(real);
    expect(abi['createElement']).toBe('HOST_CREATE_ELEMENT');
    expect(abi['useState']).not.toBe('HOST_CREATE_ELEMENT');
  });
});

describe('charts server slot', () => {
  it('publishes link-time stubs for every charts export', async () => {
    // 事故形态：插件 dist 里写着
    //   import { MetricsExplorer } from "@stackpanel/ui/charts"
    // 服务端 ABI 若没有这个槽，resolve hook 会落到真实包 → recharts 在模块
    // 作用域调 React.createContext → RSC 图直接抛，整页 500。
    //
    // 反之，若发布**空对象**，ESM 静态链接缺具名导出 → 抛
    // "does not provide an export named"，整包加载失败。
    //
    // 所以必须是「名字齐全、被调用才抛」的桩。
    const { publishHostServerAbi } = await import('@/lib/frontend-host-abi');
    const abi = publishHostServerAbi();
    const charts = abi['@stackpanel/ui/charts'] as Record<string, unknown>;

    expect(charts).toBeTruthy();
    expect(typeof charts.MetricsExplorer).toBe('function');
    expect(typeof charts.UsageTrendChart).toBe('function');
  });

  it('never throws at link time — only when a charts stub is invoked', async () => {
    const { publishHostServerAbi } = await import('@/lib/frontend-host-abi');
    const charts = publishHostServerAbi()['@stackpanel/ui/charts'] as Record<string, unknown>;

    // 取名字不抛（顶层 import 只做这件事）。
    expect(() => charts.MetricsExplorer).not.toThrow();

    // 真被当成组件调用才抛 —— 把「客户端组件在服务端执行」暴露在正确位置。
    expect(() => (charts.MetricsExplorer as () => never)()).toThrow(/charts/);
  });
});
