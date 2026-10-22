/**
 * 运行形态探测（PLAN-github-distribution-and-updates §9、§10）。
 *
 * 市场有两条来源：**随内核发布的本地包**（monorepo 的 `packages/plugins`、
 * `packages/themes`）与**已签名远程目录**。本地来源只在「源码/开发布局」下有意义：
 * 生产镜像虽然也 COPY 了仓库，但那是构建上下文，不是可安装来源——从镜像里的源码
 * 目录装插件等于绕过分发与验签，属于必须挡住的路径。
 *
 * 因此这里提供一个**保守**的容器判定：命中即视为「生产/容器形态」，本地来源禁用。
 * 宁可误判成容器（多走远程签名目录）也不能误判成开发机（放行本地来源）。
 */

import { existsSync } from 'node:fs';

/** 显式覆盖本地来源开关（`off` 强制禁用，`on` 仅在非容器下生效）。 */
function explicitOverride(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = (env['STACKPANEL_MARKET_LOCAL_SOURCES'] ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'false') return false;
  if (raw === 'on' || raw === 'true') return true;
  return undefined;
}

/**
 * 是否运行在容器/生产形态下。
 *
 * 判定依据（任一命中即为真）：
 * - `NODE_ENV=production`：发布镜像与 PM2 生产部署都会设；
 * - `/.dockerenv` 或 `/run/.containerenv` 存在（Docker / Podman）；
 * - `KUBERNETES_SERVICE_HOST` 存在（k8s Pod）。
 *
 * 之所以不只依赖 `NODE_ENV`：单容器里 `next start` + `node dist/server.js` 仍可能
 * 以 development 跑，但来源语义已经是「镜像内」，不该放行源码目录。
 */
export function isContainerRuntime(
  env: NodeJS.ProcessEnv = process.env,
  probe: (file: string) => boolean = existsSync,
): boolean {
  if (env['NODE_ENV'] === 'production') return true;
  if (env['KUBERNETES_SERVICE_HOST']) return true;
  if (probe('/.dockerenv')) return true;
  if (probe('/run/.containerenv')) return true;
  return false;
}

/**
 * 本地市场来源是否允许。
 *
 * 容器/生产形态下一律不允许（哪怕显式 `on` 也不放行——这是安全边界，不是偏好）；
 * 开发形态下默认允许，可用 `STACKPANEL_MARKET_LOCAL_SOURCES=off` 关掉。
 */
export function localMarketSourcesAllowed(
  env: NodeJS.ProcessEnv = process.env,
  probe: (file: string) => boolean = existsSync,
): boolean {
  const override = explicitOverride(env);
  if (isContainerRuntime(env, probe)) return false;
  return override ?? true;
}

/** 本地来源被禁用时给运维的可执行原因（用于日志与市场列表提示）。 */
export function localSourcesDisabledReason(): string {
  return (
    '本地市场来源在容器/生产形态下已禁用：请从已签名远程目录安装插件与主题；' +
    '如需在开发机上恢复，请设置 STACKPANEL_MARKET_LOCAL_SOURCES=on 并以非 production 运行。'
  );
}
