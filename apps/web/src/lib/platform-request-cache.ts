import 'server-only';

import {
  DEFAULT_PLATFORM_INFO,
  type PlatformBrand,
  type PlatformInfo,
} from '@stackpanel/sdk';
import { getApiClient } from './api';
import { pinInSnapshot } from './frontend-snapshot';

/**
 * 平台身份与品牌的请求级缓存。
 *
 * 为什么需要：`/platform/info` 和 `/platform/brand` 是**每个页面渲染**都要读的
 * 公开数据，而同一请求里它们会被多处独立调用：
 *
 *   - 根 `layout.tsx`（metadata 的 title/description/favicon）
 *   - `resolveSiteOrigin()` / `platformSeoDefaults()`（SEO canonical 与 hreflang）
 *   - `FrontendRoute`（主题/插件页面的导航与品牌）
 *   - 登录/注册/找回密码等页面各自再读一次
 *
 * 这些调用彼此没有依赖，却各自打一次内核。内核侧虽然给了
 * `Cache-Control: public, max-age=60`，但 web 是**服务端**在取数据，
 * 浏览器的缓存对它无效 —— 于是每次渲染都要多跑 1~2 次 HTTP + 一次 DB 查询。
 *
 * 用 `pinInSnapshot` 缓存 Promise 本身（而不是 React `cache()`）：后者不合并
 * 并发调用，`Promise.all` 里同时发起的两次仍然会各打一次内核。
 *
 * 跨请求不保留 —— 改平台名/换图标立即生效，不需要等 TTL。
 * 失败一律降级到默认值，绝不因为读不到平台信息而让页面 500。
 */

export function requestPlatformInfo(): Promise<PlatformInfo> {
  return pinInSnapshot('platformInfo', async () => {
    try {
      const { platform } = await getApiClient().getPlatformInfo();
      return platform;
    } catch {
      return DEFAULT_PLATFORM_INFO;
    }
  });
}

export function requestPlatformBrand(): Promise<PlatformBrand | null> {
  return pinInSnapshot('platformBrand', async () => {
    try {
      const { brand } = await getApiClient().getPlatformBrand();
      return brand;
    } catch {
      return null;
    }
  });
}
