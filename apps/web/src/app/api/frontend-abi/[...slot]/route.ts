import { NextResponse } from 'next/server';

/**
 * Contract 02 §5 / 主计划 §5 阶段 4 — 受控适配器（M2 浏览器）。
 *
 * 运行期装载的插件 admin 模块在发布期被改写为从这个 URL 导入宿主 ABI：
 *
 *   import { useState } from '/api/frontend-abi/react?names=useState';
 *
 * 本路由生成一段浏览器 JS：从 `globalThis.__STACKPANEL_CLIENT_ABI__`（由根布局的
 * `FrontendAbiBridge` 发布）按 `?names=` 列出的名逐个重导宿主命名空间。`default`
 * 单独处理为默认导出。
 *
 * 为什么由**调用方**给出名字，而不是服务端枚举命名空间：本路由在**服务端**运行，
 * `react` 在此解析为 `react-server` 构建（其命名导出与浏览器 React 不同，没有
 * `useState` 等）；且浏览器 React 命名空间不可安全枚举。因此发布期从插件 bundle
 * 的**实际导入语句**提取所需名字（见 `scripts/build-frontend.mjs`
 * `annotateAdapterImports`），这里按名精确生成——多一个不导、少一个不导。
 *
 * 为什么不是 import map：SPIKE-results §0 实测浏览器无 import map 时无法解析裸
 * 说明符，且 `'strict-dynamic'` 下动态 module script 需同源；本路由同源、受控。
 */

/** 允许被适配的宿主 ABI 槽（单一来源：`@stackpanel/spec` 的 `HOST_FRONTEND_ABI_SLOTS`）。 */
const HOST_ABI_SLOTS = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'next/link',
  'next/form',
  'next/navigation',
  '@stackpanel/ui',
  '@stackpanel/sdk',
  'lucide-react',
  'sonner',
  'recharts',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function adapterSource(slot: string, names: string[]): string {
  const lines = [
    '// StackPanel host ABI adapter (contract 02 §5). Generated; do not edit.',
    'const A = globalThis.__STACKPANEL_CLIENT_ABI__;',
    `if (!A || !A[${JSON.stringify(slot)}]) throw new Error('StackPanel host ABI not published for ${slot}');`,
    `const ns = A[${JSON.stringify(slot)}];`,
  ];
  for (const name of names) {
    if (name === 'default') continue;
    if (!IDENTIFIER.test(name)) continue;
    lines.push(`export const ${name} = ns[${JSON.stringify(name)}];`);
  }
  lines.push('export default ns.default ?? ns;');
  return `${lines.join('\n')}\n`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slot?: string[] }> },
): Promise<NextResponse> {
  const { slot: segments = [] } = await context.params;
  const slot = segments.join('/');
  if (!HOST_ABI_SLOTS.has(slot)) {
    return new NextResponse('Unknown host ABI slot', { status: 404 });
  }
  const names = (new URL(request.url).searchParams.get('names') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return new NextResponse(adapterSource(slot, names), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600, immutable',
    },
  });
}
