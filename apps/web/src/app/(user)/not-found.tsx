import { FrontendFallback } from '@/components/frontend-route';

/**
 * 用户站点源的 404 边界（ADR-0011 §6）。当 `FrontendRoute` 未命中显式页面或只
 * 命中 `*` 兜底模板时调用 `notFound()`，由此边界接管：优先渲染当前主题声明的
 * `*` not-found 模板，未声明时回退为平台默认 404 面板。HTTP 状态码为真实 404。
 */
export default function UserNotFound() {
  return <FrontendFallback />;
}
