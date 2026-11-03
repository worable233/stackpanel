# 首屏 JS 瘦身：把图表类组件从 UI 桶里拆出去

> 状态：设计（未实施）
> 日期：2026-11
> 前置调查：`docs/AUDIT-2026-11-03-PERF-UPSTREAM.md`（服务端部分已全部落地）

## 1. 问题：不是服务端慢

`/account` 被报"加载很慢"。实测：

```
HTML 生成            46 ms
页面 p50（含 HTML）   58 ms
```

服务端不是瓶颈。浏览器侧才是：

```
/login   31 个 <script>，gzip 后 1028 KB
  阻塞渲染（非 async）  110 KB
  async 不阻塞        3250 KB（未压缩）
```

按真实网络估算首屏：

| 网络 | 传输 | 建连 | 首屏 |
|---|---|---|---|
| 4G 良好（10 Mbps / RTT 50ms） | 803 ms | 150 ms | **0.95 s** |
| 4G 一般（5 Mbps / RTT 100ms） | 1606 ms | 300 ms | **1.9 s** |
| 3G（1.5 Mbps / RTT 200ms） | 5354 ms | 600 ms | **6.0 s** |

`async` 脚本不阻塞首屏渲染，但会持续抢带宽、并在主线程上解析 —— 用户感受
是"页面出来了，然后卡住"。

## 2. 根因：Turbopack 把重依赖合并进共享 chunk

`@stackpanel/ui` 是单一入口桶（101 个导出）。其中只有一个模块依赖 recharts：

```
packages/ui/src/metrics-explorer.tsx   →  import { Area, ... } from 'recharts'
packages/ui/src/index.ts:58            →  export { MetricsExplorer } from './metrics-explorer.js'
```

Turbopack 把 `metrics-explorer`、`usage-trend-chart` 与 `select`、`sheet`、
`tooltip` 等基础组件**合并进同一个 chunk**。于是任何页面只要用到基础组件，
就一起把 recharts（未压缩 559 KB）下载下来。

### 已试过但无效的手段

| 手段 | 结果 |
|---|---|
| 子路径导出 `@stackpanel/ui/inline-error` 等 | chunk 数量与体积**不变** |
| `experimental.optimizePackageImports: ['@stackpanel/ui']` | **无效**，该选项只对 `node_modules` 里的包生效，workspace 包不走这条路 |
| `publishHostClientAbi()` 改按需 `import()` | 让发布不再阻塞，但 chunk 仍被合并 |

这些都是**正确的局部改进**（已提交 `c088867`），但不解决 chunk 合并。

### 决定性实验

把 `MetricsExplorer` 从 `index.ts` 桶里临时移除后重建：

```
改前  31 chunks   3360 KB（未压缩）  recharts 存在
改后  31 chunks   2991 KB（未压缩）  recharts 不存在
```

**-369 KB，且 recharts 完全从首屏消失。** 这证明唯一有效的杠杆是
「让 `metrics-explorer` 不出现在 web 的模块图里」。

## 3. 约束（决定了方案空间）

1. **`MetricsExplorer` 必须能被 store 插件使用。** store 插件是**运行期装载**
   的，通过宿主 ABI 适配器取 UI 组件：
   ```ts
   import { MetricsExplorer } from '@stackpanel/ui';   // 被构建脚本改写成
   // → /api/frontend-abi/@stackpanel/ui?names=...,MetricsExplorer
   ```
2. **`@stackpanel/ui` 是宿主 ABI 槽之一**，由 `HOST_FRONTEND_ABI_SLOTS`
   （`packages/spec/src/frontend-abi.ts`）声明，并有守卫测试核对版本。
3. **adapter 路由的白名单已含 `recharts`**，但 `spec` 的白名单**没有**，
   `frontend-abi-bridge.tsx` **也从未发布它** —— 这是个半成品，说明有人想过
   这条路径但没走完。
4. 插件前端**没有任何一个**直接 `import 'recharts'`，它们只用
   `MetricsExplorer` 封装。

## 4. 方案

### 方案 A（推荐）：新增 `@stackpanel/ui/charts` ABI 槽

把图表类组件从主桶挪到一个**独立 ABI 槽**，插件按需从该槽取。

**改动点**

1. `packages/ui` 增加第二个入口 `src/charts.ts`：
   ```ts
   export { MetricsExplorer } from './metrics-explorer.js';
   export { UsageTrendChart } from './usage-trend-chart.js';
   export type { MetricPointLike, MetricSeriesLike, ... } from './metrics-explorer.js';
   ```
   并从 `src/index.ts` **移除**这些导出。

2. `packages/ui/package.json`：
   ```json
   "exports": {
     ".": { ... },
     "./charts": { "types": "./dist/charts.d.ts", "import": "./dist/charts.js" }
   }
   ```

3. `packages/spec/src/frontend-abi.ts`：`HOST_FRONTEND_ABI_SLOTS` 增加
   `'@stackpanel/ui/charts'`，并在 `HOST_FRONTEND_ABI` 里登记版本（与
   `@stackpanel/ui` 同版本号）。

4. `apps/web/src/components/frontend-abi-bridge.tsx`：**按需**发布该槽 ——
   与现有的 `@stackpanel/ui` 一样走 `await import()`，但只在插件真的请求
   charts 槽时才解析：
   ```ts
   // 惰性 getter，避免无条件 import
   let chartsPromise: Promise<unknown> | null = null;
   Object.defineProperty(abi, '@stackpanel/ui/charts', {
     get: () => (chartsPromise ??= import('@stackpanel/ui/charts')),
   });
   ```

5. `apps/web/src/app/api/frontend-abi/[...slot]/route.ts`：白名单加入
   `'@stackpanel/ui/charts'`（并**移除**未实现的 `'recharts'`，消除不一致）。

6. `scripts/build-frontend.mjs`：`HOST_ABI_ADAPTER_ALIASES` 增加
   `--alias:@stackpanel/ui/charts=/api/frontend-abi/@stackpanel/ui/charts`
   **且必须排在 `@stackpanel/ui` 之前**。

   这不是风格问题：该文件第 25 行已写明「esbuild `--alias` 是前缀匹配」，
   并因此把 `react/jsx-runtime` 排在 `react` 前面。若顺序反了，
   `@stackpanel/ui/charts` 会先命中 `@stackpanel/ui` 前缀，被改写成
   `/api/frontend-abi/@stackpanel/ui/charts` 之外的错误 URL，运行期 404。

7. store 插件：`import { MetricsExplorer } from '@stackpanel/ui/charts'`。

**为什么这是最优解**

- **首屏零成本**：web 自己的组件不再引用 charts 槽，recharts 不进 web 模块图。
  实测可省 369 KB（未压缩）/ 约 110 KB gzip。
- **契约一致**：沿用既有 ABI 机制，不引入新概念。adapter 白名单本来就留了
  recharts 的位置，这个方案把它做成正确形态。
- **插件无感**：插件仍然 `import` 一个包，只是路径从 `@stackpanel/ui` 变成
  `@stackpanel/ui/charts`。构建脚本的 adapter 改写逻辑无需改动。
- **可扩展**：`react-markdown`（`article-body`）、`lenis`（`smooth-document`）
  是同类"重依赖、低频"模块，将来可用同一模式拆出，不必再设计。

**风险与代价**

- 破坏性变更：插件若已 `import { MetricsExplorer } from '@stackpanel/ui'`
  会失败。当前仓库内只有 store 一个使用者，改起来可控；但要为**外部插件**
  提供过渡：`index.ts` 保留一个**带警告的 re-export**（`console.warn` 一次），
  或按 `frontendExternals` 版本号做一次 major bump。
- 需要同步：`spec` 守卫测试、adapter 白名单、bridge 发布、构建 alias、
  store 插件 —— 五处必须一起改，漏一处就是运行期报错（不是编译期）。

### 方案 B：把图表组件拆成独立包 `@stackpanel/ui-charts`

与 A 的差别只在包边界。

- 优点：依赖隔离最彻底（`recharts` 只被这个包依赖），主包可以彻底不装 recharts。
- 缺点：新增一个 workspace 包、一个 ABI 槽、一套发布流程；对插件作者是
  **另一个包名**而不是子路径，迁移成本更高。

**结论**：A 与 B 效果等价（都不让 recharts 进 web 模块图），A 的迁移面更小。
除非将来主包想彻底卸掉 `recharts` 依赖，否则选 A。

### 方案 C（不推荐）：`next.config` 的 `splitChunks` 手工分块

Turbopack 当前不支持 webpack 那套 `splitChunks` 配置；退一步用 webpack 构建
又违背仓库已迁移到 Turbopack 的决定。**不做。**

## 5. 验收标准

1. `/login` 与 `/` 的首屏 chunk 集合中**不含** recharts：
   ```bash
   python3 scripts/measure-request-fanout.py   # 已有；需扩展 chunk 体积统计
   ```
   新增脚本 `scripts/measure-first-load.py`：统计 HTML 引用的 chunk 数与 gzip
   后总字节，并检测指定库是否出现。
2. 首屏字节从 1028 KB 降到 ≤ 920 KB（gzip）。
3. store 插件的实时监控面板仍能正常渲染 `MetricsExplorer`（手动验证 + 现有
   插件前端测试）。
4. `packages/spec/tests/frontend-abi.test.ts` 覆盖新槽。
5. 外部插件的过渡路径有明确记录（`docs/` 里的迁移说明）。

## 6. 实施顺序（每步可独立验证）

1. `packages/ui` 加 `charts` 入口并移除主桶导出 → 跑 `pnpm build`，确认
   `dist/charts.js` 存在、`dist/index.js` 不再含 recharts。
2. web 侧：bridge 惰性 getter + adapter 白名单 + 移除 `recharts` 伪槽 →
   实测首屏体积下降。
3. spec：白名单与版本 + 守卫测试。
4. 构建脚本 alias（注意顺序）+ store 插件改导入 → 重建插件产物，
   验证 adapter URL 带 `?names=` 且能装载。
5. 更新迁移文档。

## 6b. 已实施（第二轮）：zod 也走了同一条路

recharts 落地后继续测量，发现**真正的 zod 也是搭车成本**，成因与图表完全同构：

```
frontend-abi-bridge.tsx  import * as sdk from '@stackpanel/sdk'   // 挂在根 layout
packages/sdk/dist/client.js  → zod
```

`@stackpanel/sdk` 的桶把 zod（911 KB 未压缩）一起带出，而这个 bridge 在**根
layout** 上，于是每个页面首屏都有 zod。两处改动：

1. bridge 里 sdk 与 ui 一起改 `await import()`（`Promise.all`）。
2. `formatMinorCurrency` / `minorUnitFor` / `toMinorUnits` / `minorUnitsToPlainString`
   这四个纯格式化函数加 `@stackpanel/sdk/currency` 子路径导出，
   `cart-checkout.tsx` 与 `i18n/core.ts` 改从子路径导入（后者被
   `i18n/provider` 使用，同样挂在根 layout 上）。

`currency.ts` 只依赖 `errors.js`，不含 zod，所以子路径入口是干净的。

### 累计效果

| 阶段 | 未压缩 | gzip |
|---|---|---|
| 起点 | 3360 KB | 1028 KB |
| 拆 recharts | 2987 KB | 916 KB |
| 拆 zod | **2787 KB** | **862 KB** |

`/login`、`/`、`/account` 三个页面的 chunk 里 zod 与 recharts 均为 0。
chunk 数 31 → 30。

### 一个差点误判的地方

排查时 `grep zod` 在一个 614 KB 的 chunk 里命中 14 次，看起来 zod 还在。
逐条看上下文才发现全是 **lucide 的星座图标名**（`zodiac-aquarius`、
`zodiac-aries`、…）。判断「某个库是否还在 bundle 里」必须匹配库的**特征
符号**（`ZodType` / `ZodObject` / `safeParse` / `_zod`），不能只 grep 名字。

## 7. 未纳入本方案的

- **`zod`（911 KB）**：**已拆**，见 §6b。仍有 6 个 admin/auth 页面从 sdk 桶
  做运行时导入（`settings-manager`、`reseller-manager`、`setup-form`、
  `register-form`、`reset-password-form`、`account-settings`），那些页面各自的
  首屏会带 zod。这是按页成本，不是全局首屏问题 —— 若要继续优化，可逐个改用
  sdk 子路径。
- **`lucide-react`（359 KB）**：它是宿主 ABI 槽（UI 包大量依赖），拆开会导致
  图标树两份。除非改用按需图标导入，否则不动。
- **`/admin/settings` 的 54 次内核 fan-out**：与本方案无关，属另一条优化线
  （需要合并端点），已在 `c088867` 的提交信息里记录。
