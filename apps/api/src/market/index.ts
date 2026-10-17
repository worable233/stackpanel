/**
 * 市场能力服务出口（PLAN-github-distribution-and-updates §9）。
 *
 * 内核只导出 {@link MarketService} 及其类型；HTTP 编排（`/admin/market/*`）已迁到
 * 内置插件 `packages/plugins/market`，通过 `ctx.getService('kernel.market')` 消费。
 */
export { MarketService } from './service.ts';
export type { MarketServiceDeps } from './service.ts';
