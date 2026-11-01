/**
 * 宿主反馈通道保留的 query 参数名。
 *
 * `error` / `success` 由 `ActionFeedbackToaster` 消费（只认 code），`flash` 是
 * 一次性回执的 token，`action` 只是标题选择器。它们属于**宿主**，不属于插件
 * 页面：把 `?error=<任意文本>` 原样交给插件，插件就能把它渲染成自己的界面文案，
 * 等于把反射点从宿主挪到插件里。
 *
 * 插件若确实需要读某个参数，用别的名字（如 `range` / `panel` / `orderId`）。
 */
export const HOST_FEEDBACK_PARAMS = ['action', 'error', 'success', 'flash'] as const;

/** 去掉宿主反馈参数，保留其它一切 query（含同名以外的所有键）。 */
export function stripFeedbackParams(
  query: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if ((HOST_FEEDBACK_PARAMS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}
