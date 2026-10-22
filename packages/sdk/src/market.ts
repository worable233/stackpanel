/**
 * 市场能力服务契约（ADR-0020 D3 / PLAN-github-distribution-and-updates §9）。
 *
 * 市场**业务面**是内置插件 `market`；它通过 `ctx.requireService('kernel.market')`
 * 消费内核保留的分发安全原语。契约放在 SDK 而不是内核，正是为了让插件与内核共享
 * 同一份类型，而插件源码不必 import `apps/api`（ADR-0008 边界）。
 *
 * 服务**不**做权限判断、不写审计、不解析 HTTP——那些属于插件路由。
 */
import type { MarketPackage } from './types.js';

/** 一次安装/升级的结果。`source` 区分随内核发布的本地包与已签名远程目录。 */
export interface MarketInstallResult {
  id: string;
  version: string;
  upgraded: boolean;
  /** `local` = 随内核发布的包；`catalog` = 从已签名 GitHub 目录安装。 */
  source: 'local' | 'catalog';
  /** 远程目录安装时的发布者（审计留痕用；本地来源为空）。 */
  publisher?: string;
  /** 远程目录安装时实际用于验签的 keyId（审计留痕用；本地来源为空）。 */
  keyId?: string;
}

/**
 * 内核市场能力服务。实现方（内核）负责：
 * - 本地包发现 + 已签名远程目录条目（本地优先，同名远程不覆盖本地）；
 * - 统一安装事务：解析 → 验签 → 暂存 → 运行时激活 → 提交/回滚（§7.6）。
 *
 * 失败时抛出错误且**不触达活动目录**；调用方只需把错误转成明确的拒绝响应。
 */
export interface MarketService {
  /** 列出某类可安装条目（本地 + 远程目录）。 */
  list(kind: 'plugin' | 'theme'): Promise<MarketPackage[]>;
  /** 安装/升级一个条目；本地来源优先。 */
  install(kind: 'plugin' | 'theme', id: string): Promise<MarketInstallResult>;
  /** 管理员可配置的远程目录源（密钥只返回是否已配置）。 */
  getSourceConfig(): Promise<MarketSourceConfig>;
  updateSourceConfig(input: MarketSourceConfigInput): Promise<MarketSourceConfig>;
}

export interface MarketSourceConfig {
  repository: string;
  channel: 'stable' | 'beta';
  ref: string;
  tokenConfigured: boolean;
}

export interface MarketSourceConfigInput {
  repository: string;
  channel: 'stable' | 'beta';
  ref: string;
  /** 留空表示保留已有密钥；clearToken 删除已有密钥。 */
  token?: string;
  clearToken?: boolean;
}
