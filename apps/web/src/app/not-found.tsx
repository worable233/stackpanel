import { DefaultNotFound } from '@/components/frontend-route';

/**
 * 根级 404 边界（ADR-0011 §6）。覆盖用户站点源之外的路由（后台、账户、API 等
 * 未匹配路径），统一使用平台默认 404 面板，避免把主题页面误渲染到后台上下文。
 */
export default function RootNotFound() {
  return <DefaultNotFound />;
}
