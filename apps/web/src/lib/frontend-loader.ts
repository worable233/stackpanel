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
  const stem = absorbedStem(specifier);
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

/** 合成一个 ESM shim（data: URL），逐名重导宿主命名空间。 */
function shimUrl(ns: Record<string, unknown>, key: string): string {
  const cached = cache.get(key);
  if (cached) return cached;
  const names = Object.keys(ns).filter((name) => name !== 'default');
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
  cache.set(key, url);
  return url;
}
