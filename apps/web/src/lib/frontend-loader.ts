import 'server-only';

/**
 * 运行时装载前端（PLAN-runtime-frontend-loading §5 阶段 4）——同步 resolve 钩子。
 *
 * 用 Node 22 的 `module.registerHooks`（**同步**、与 Next 服务端同线程）把运行期
 * 装载的前端包的宿主 ABI 说明符，重定向到宿主已 bundle 的真实模块：
 *
 * - 服务端（RSC）由 `frontend-host-abi.ts` 在 `import()` 之前把宿主 RSC 客户端引用
 *   代理发布到 `globalThis.__STACKPANEL_SERVER_ABI__`；
 * - 宿主收编的客户端能力（如默认主题的 `route-progress.js`）发布到
 *   `globalThis.__STACKPANEL_ABSORBED_CLIENT__`（同样由上面的模块发布）。
 *
 * 钩子在 `frontend-runtime.ts` 里**运行时注册**（不是进程启动钩子）：Node 允许在
 * 任意时刻调用 `registerHooks`，且对之后所有动态 `import()` 生效，因此无需改
 * `next start` 的启动方式（不需要 `NODE_OPTIONS`/自定义 server）。
 *
 * 为什么必须同步：异步 `module.register()` 在**独立线程**上运行钩子，`globalThis`
 * 不共享，桥接会失效（SPIKE-results §0）。
 */
import * as nodeModule from 'node:module';

/**
 * Node 22.20+ `module.registerHooks`. The installed `@types/node` predates it, so
 * the symbol is typed locally rather than widened globally.
 */
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => { url: string; format?: string },
) => { url: string; format?: string; shortCircuit?: boolean };
const registerHooks = (nodeModule as unknown as {
  registerHooks?: (hooks: { resolve: ResolveHook }) => void;
}).registerHooks as (hooks: { resolve: ResolveHook }) => void;

interface ServerAbiGlobal {
  __STACKPANEL_SERVER_ABI__?: Record<string, unknown>;
  __STACKPANEL_ABSORBED_CLIENT__?: Record<string, unknown>;
}

let registered = false;

/** 幂等注册钩子；第一次运行期装载前调用即可。 */
export function ensureFrontendLoaderHooks(): void {
  if (registered) return;
  registered = true;
  registerHooks({ resolve: resolveFrontendSpecifier });
}

/**
 * The resolve hook body, exported for tests. Reads the host ABI published on
 * `globalThis` and redirects host-ABI specifiers (and absorbed client modules) to
 * synthesized shims, delegating everything else to `nextResolve`.
 */
export function resolveFrontendSpecifier(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => { url: string; format?: string },
): { url: string; format?: string; shortCircuit?: boolean } {
  const g = globalThis as unknown as ServerAbiGlobal;
  const abi = g.__STACKPANEL_SERVER_ABI__;
  const absorbed = g.__STACKPANEL_ABSORBED_CLIENT__;
  // 宿主收编的客户端能力：包内相对导入 `./route-progress.js` → 宿主 bundle 的客户端引用。
  // 仅当**发起导入的包自己没有这个文件**时才重定向：absorbed 能力目前只为宿主主题
  // 准备，而插件（如 referral）可能自带同名模块（导出完全不同）。收编本意是替
  // 缺失的文件，不是抢占包内真实存在的文件——先解析包内路径，解析失败才落 shim。
  const stem = absorbedStem(specifier);
  // 收编能力优先于包内同名文件：包自带的那个文件是 `'use client'` 模块，在
  // RSC 服务端直接 import 会崩（`useState` 为 null，见 SPIKE-results §0）。
  // 宿主收编表需覆盖该 stem 下**所有**包用到的导出名。
  if (stem && absorbed && Object.prototype.hasOwnProperty.call(absorbed, stem)) {
    return {
      url: shimUrl(absorbed[stem] as Record<string, unknown>, `absorbed:${stem}`),
      shortCircuit: true,
      format: 'module',
    };
  }
  if (abi && Object.prototype.hasOwnProperty.call(abi, specifier)) {
    return {
      url: shimUrl(abi[specifier] as Record<string, unknown>, specifier),
      shortCircuit: true,
      format: 'module',
    };
  }
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    // 前端 dist 写的是无扩展的 `next/*` 子路径；Node 解析需要 `.js`。
    if (specifier.startsWith('next/') && !specifier.endsWith('.js')) {
      try {
        return nextResolve(`${specifier}.js`, context);
      } catch {
        /* fallthrough */
      }
    }
    throw error;
  }
}

/** `./x.js` / `../x.js` → `x`；其它返回 null。 */
export function absorbedStem(specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const match = /(?:^|\/)([A-Za-z0-9_-]+)\.js$/.exec(specifier);
  return match ? match[1] : null;
}

const cache = new Map<string, string>();

/**
 * `next/navigation` hooks that only exist in the **client** build.
 *
 * The host imports `next/navigation` inside its RSC graph, where the module is the
 * `react-server` build: `useRouter` (and friends) are not exported there. The shim
 * below re-exports exactly the names of that namespace, so a runtime-loaded package
 * writing `import { useRouter } from 'next/navigation'` failed to *link* —
 * "does not provide an export named 'useRouter'" — and the whole admin entry failed
 * to load, turning every plugin admin page into "not found" (altcha, smtp, notice).
 *
 * The browser path never had this problem: the frontend build rewrites the import to
 * `/api/frontend-abi/next/navigation?names=…`, which reads the **client** ABI, where
 * these hooks are real. So the server side only needs the names to exist for linking;
 * it must never execute them — a client hook in the RSC graph is a bug, and a silent
 * no-op would hide it. They throw instead.
 */
const CLIENT_ONLY_NAVIGATION_HOOKS = [
  'useRouter',
  'usePathname',
  'useSearchParams',
  'useParams',
  'useSelectedLayoutSegment',
  'useSelectedLayoutSegments',
] as const;

/**
 * Extend the host's `next/navigation` namespace with link-only stubs for the
 * client-only hooks, keeping every real export untouched.
 */
export function navigationServerAbi(navigation: Record<string, unknown>): Record<string, unknown> {
  const abi: Record<string, unknown> = { ...navigation };
  for (const hook of CLIENT_ONLY_NAVIGATION_HOOKS) {
    if (hook in abi) continue;
    abi[hook] = (): never => {
      throw new Error(
        `[frontend-runtime] ${hook}() from 'next/navigation' is client-only. A runtime-loaded package may import it, but it only runs in the browser (the frontend build rewrites the import to /api/frontend-abi/next/navigation). Reaching this on the server means the component was executed in the RSC graph.`,
      );
    };
  }
  return abi;
}

/**
 * Names a shim can re-export as a `const` binding: everything except `default`
 * (re-exported separately) and anything that is not a plain identifier.
 *
 * The identifier test is not cosmetic. Next's `react-server` build hands back the
 * CommonJS namespace, which carries a literal `"module.exports"` key; rendering it
 * as `export const module.exports = …` produced a shim with a syntax error, and the
 * failure surfaced as the misleading "module 'react' does not provide an export
 * named 'useState'" — every plugin admin page that imported a React hook from a
 * runtime-loaded package crashed with the red Next.js overlay. Such a key can never
 * be imported as a binding (`import { module.exports }` is invalid syntax), so
 * dropping it costs nothing.
 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 合成一个 ESM shim（data: URL），逐名重导宿主命名空间。 */
function shimUrl(ns: Record<string, unknown>, key: string): string {
  const names = Object.keys(ns).filter((name) => name !== 'default' && IDENTIFIER.test(name));
  const cacheKey = `${key}:${names.slice().sort().join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const global = key.startsWith('absorbed:')
    ? `globalThis.__STACKPANEL_ABSORBED_CLIENT__[${JSON.stringify(key.slice('absorbed:'.length))}]`
    : `globalThis.__STACKPANEL_SERVER_ABI__[${JSON.stringify(key)}]`;
  let src = `const ns = ${global};\n`;
  for (const name of names) {
    // 部分命名空间属性是 getter，稳妥地逐个取值。
    src += `export const ${name} = ns[${JSON.stringify(name)}];\n`;
  }
  src += 'export default ns.default;\n';
  const url = `data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`;
  cache.set(cacheKey, url);
  return url;
}
