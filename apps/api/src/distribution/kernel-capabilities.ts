/**
 * 内核能力面（PLAN-github-distribution-and-updates §4、§13-3）。
 *
 * 市场、上传与自动更新共用同一门禁 {@link checkPackageCompatibility}，它需要一个
 * 「当前内核能力」描述。本模块把这组值收敛到**单一来源**，避免各处硬编码版本：
 *
 * - `version` / `kernelApi` / `frontendAbi` 取自契约包 {@link @stackpanel/spec} 的
 *   版本常量（产品版本 / 后端契约版本 / 前端 ABI 版本，三者独立）。
 * - `packageFormat` 取自契约包格式版本常量。
 * - `frontendModes` 是内核**当前真正支持**的前端加载模式。M1（受控 SSR 模板）随
 *   `PLAN-runtime-frontend-loading` 的运行时接入落地；在正式接入前只声明 M2，
 *   声明 M1 的包会被门禁拒绝（宁缺毋滥，不安装跑不起来的包）。
 * - `schemaRange` / `platform` 目前**不参与** {@link checkPackageCompatibility} 的
 *   判定（该函数只比 version/kernelApi/frontendAbi/packageFormat/frontendModes），
 *   这里给出诚实占位，待内核 schema 窗口契约落地后统一。
 */

import {
  KERNEL_API_VERSION,
  KERNEL_FRONTEND_ABI,
  KERNEL_VERSION,
  PACKAGE_MANIFEST_FORMAT_VERSION,
  type FrontendMode,
  type KernelCapabilities,
} from '@stackpanel/spec';
import { env } from '../config/env.ts';

/** 内核当前支持的前端加载模式（见模块说明）。 */
export const SUPPORTED_FRONTEND_MODES: readonly FrontendMode[] = Object.freeze(['M2']);

/**
 * 部署目标平台（内核镜像选择用）。容器内运行应报告容器目标平台而非开发宿主：
 * `DISTRIBUTION_DEPLOY_PLATFORM` 显式覆盖，缺省 `linux/amd64`。
 */
export function deploymentPlatform(): string {
  return env.DISTRIBUTION_DEPLOY_PLATFORM;
}

/** 组装当前内核能力面，供 `checkPackageCompatibility` / `selectTargetVersion` 使用。 */
export function kernelCapabilities(): KernelCapabilities {
  return {
    version: KERNEL_VERSION,
    kernelApi: KERNEL_API_VERSION,
    frontendAbi: KERNEL_FRONTEND_ABI,
    packageFormat: PACKAGE_MANIFEST_FORMAT_VERSION,
    schemaRange: '*',
    frontendModes: [...SUPPORTED_FRONTEND_MODES],
    platform: deploymentPlatform(),
  };
}
