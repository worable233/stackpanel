import 'server-only';

import { cache } from 'react';
import {
  DEFAULT_PLATFORM_INFO,
  type PlatformBrand,
  type PlatformInfo,
} from '@stackpanel/sdk';
import { getApiClient } from './api';

/**
 * 平台身份、品牌与激活主题的请求级缓存。
 *
 * 为什么需要：这三样是**每个页面渲染**都要读的公开数据，而同一请求里它们
 * 会被多处独立调用：
 *
 *   - 根 `layout.tsx` 的 `generateMetadata`（title/description/favicon）
 *   - `resolveSiteOrigin()` / `platformSeoDefaults()`（SEO canonical 与 hreflang）
 *   - `FrontendRoute`（主题/插件页面的导航与品牌）
 *   - `theme-stylesheet.tsx` / `frontend-stylesheets.tsx`（样式表）
 *   - 登录/注册/找回密码等页面各自再读一次
 *
 * 这些调用彼此没有依赖，却各自打一次内核。内核侧虽然给了
 * `Cache-Control: public, max-age=60`，但 web 是**服务端**在取数据，
 * 浏览器的缓存对它无效 —— 于是每次渲染都要多跑几次 HTTP + DB 查询。
 *
 * **为什么用 React `cache()` 而不是 `AsyncLocalStorage`**：实测发现
 * `enterWith` 建的作用域**不跨渲染阶段**——`generateMetadata` 与页面组件、
 * 根 layout 与嵌套 layout 之间都不共享，于是 `/account` 单次渲染仍然打 2 次
 * `/platform/info`。`cache()` 由 Next 绑定到同一次渲染，跨这些阶段共享。
 *
 * 跨请求不保留 —— 改平台名/换图标/切主题立即生效，不需要等 TTL。
 * 失败一律降级到默认值，绝不因为读不到平台信息而让页面 500。
 */

export const requestPlatformInfo = cache(async (): Promise<PlatformInfo> => {
  try {
    const { platform } = await getApiClient().getPlatformInfo();
    return platform;
  } catch {
    return DEFAULT_PLATFORM_INFO;
  }
});

export const requestPlatformBrand = cache(async (): Promise<PlatformBrand | null> => {
  try {
    const { brand } = await getApiClient().getPlatformBrand();
    return brand;
  } catch {
    return null;
  }
});

/**
 * 当前激活主题。
 *
 * 同一请求里有三处独立读取：`slots.ts`（解析候选）、`theme-stylesheet.tsx`
 * （宿主样式表）、`frontend-stylesheets.tsx`（主题自身的样式）。实测单次
 * `/login` 渲染会打 2 次 `/themes/active`（线上 n=1111、p50 136ms）。
 */
export const requestActiveTheme = cache(async (): Promise<{ theme: { id: string } | null }> => {
  try {
    const { theme } = await getApiClient().getActiveTheme();
    return { theme: theme ? { id: theme.id } : null };
  } catch {
    return { theme: null };
  }
});

/**
 * 主题前端描述（manifest / revision），按请求去重。
 *
 * 两处独立读取：`slots.ts`（解析候选）与 `frontend-stylesheets.tsx`（样式）。
 * 实测单次 `/login` 渲染会打 2 次 `/themes/<id>/frontend`。
 */
export const requestThemeFrontend = cache(
  async (themeId: string): Promise<Awaited<ReturnType<ReturnType<typeof getApiClient>["getThemeFrontend"]>> | null> => {
    try {
      return await getApiClient().getThemeFrontend(themeId);
    } catch {
      return null;
    }
  },
);
