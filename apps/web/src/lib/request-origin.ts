/**
 * Same-origin guard for cookie-authenticated BFF mutations.
 *
 * 判定逻辑本身在 `@stackpanel/sdk`（`isSameOriginRequest`）—— 内核的
 * `/api/v1/system/proxy-check` 用的是**同一份**实现。两处各写一份会导致最坏的
 * 结果：诊断说「通过」，真实请求仍然 403，运维顺着错误结论去改反代越改越乱。
 *
 * 历史背景（保留，因为它是这个守卫存在的理由）：不能用 `request.nextUrl.origin`。
 * Next 会把它归一化成 dev server 配置的 host，只要访客从另一个名字进来
 * （`127.0.0.1` 与 `localhost`、LAN 地址、反代的公网域名）就会不一致，导致合法请求
 * 被 403（实测：从 `127.0.0.1:3000` 的标签页发 `POST /api/account/avatar`）。
 * 用请求自己的 `Host` 才是浏览器实际连的权威。
 */
import { isSameOriginRequest } from '@stackpanel/sdk';

export { isSameOriginRequest };

/** 只为保持既有调用点的类型可读性；行为完全由 spec 决定。 */
export type SameOriginRequest = {
  /** 只用到 `get`，所以普通 header bag 也满足。 */
  headers: { get(name: string): string | null };
};
