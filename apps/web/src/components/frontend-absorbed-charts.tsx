'use client';

/**
 * 图表组件的宿主客户端收编（P0-A）。
 *
 * 插件的服务端入口（`index.tsx`）写着 `import { MetricsExplorer } from './charts.js'`，
 * 而它自带的 `charts.tsx` 是 `'use client'` 模块 —— 运行期装载的包发布的是普通
 * Node ESM，自带 `'use client'` 在 RSC 下不生效。所以由宿主收编这个相对导入
 * （见 `frontend-host-abi.ts` 的 `ABSORBED_CLIENT_CAPABILITIES`）。
 *
 * ## 为什么用 `next/dynamic` 而不是直接 re-export
 *
 * 直接 `export { MetricsExplorer } from '@stackpanel/ui/charts'` 会让本模块**静态**
 * 依赖 recharts。实测代价：`/login` 首屏 gzip 从 703 KB 涨到 814 KB（+111 KB），
 * 因为本文件被根布局引用，recharts 落进 45 个页面的共享 chunk ——
 * 三轮首屏瘦身（1028 → 703 KB）全部作废。
 *
 * `next/dynamic` 把实现放进**独立 chunk**：首屏不加载，只有真的渲染图表时才取。
 * 这样既是真组件（能水合、图表真的显示），又不付首屏代价。
 *
 * `ssr: false` 是刻意的：recharts 在模块作用域调 `React.createContext`，服务端
 * 评估它会直接崩。服务端渲染阶段该区域为空，浏览器里再填充 —— 正是图表应有的
 * 行为（服务端没有可交互的图表）。
 */
import dynamic from 'next/dynamic';

export const MetricsExplorer = dynamic(
  () => import('@stackpanel/ui/charts').then((mod) => mod.MetricsExplorer),
  { ssr: false },
);

export const UsageTrendChart = dynamic(
  () => import('@stackpanel/ui/charts').then((mod) => mod.UsageTrendChart),
  { ssr: false },
);
