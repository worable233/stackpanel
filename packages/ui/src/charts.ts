/**
 * 图表类组件的独立入口（宿主 ABI 槽 `@stackpanel/ui/charts`）。
 *
 * ## 为什么单独一个入口
 *
 * 主桶 `@stackpanel/ui` 里只有 `metrics-explorer.tsx` 依赖 `recharts`。
 * Turbopack 会把同一批 client 组件合并进一个 chunk，于是**任何页面**只要
 * 用了 `Button`/`Select`/`Sheet` 这类基础组件，就会连带把 recharts
 * （未压缩 559 KB）下载下来。
 *
 * 实测：把这两个导出从主桶移走后，`/login` 首屏从 3360 KB 降到 2991 KB，
 * 且 recharts 完全从模块图里消失。详见
 * `docs/design/frontend-bundle-slimming.md`。
 *
 * ## 谁用这个入口
 *
 * 只有**运行期装载的插件前端**（当前是 store 的实时监控面板）。web 自己的
 * 组件一律不引用这里 —— 一旦引用，recharts 就回到首屏。
 *
 * 插件通过宿主 ABI 适配器取用：
 *
 *     import { MetricsExplorer } from '@stackpanel/ui/charts';
 *     // 构建时被改写成 /api/frontend-abi/@stackpanel/ui/charts?names=...
 */
export { MetricsExplorer } from './metrics-explorer.js';
export type {
  MetricPointLike,
  MetricSeriesLike,
  MetricsExplorerLabels,
} from './metrics-explorer.js';

export { UsageTrendChart } from './usage-trend-chart.js';
export type { UsageTrendDetail, UsageTrendPoint, UsageTrendFormat } from './usage-trend-chart.js';
