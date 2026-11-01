import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { consumeActionFlash } from '@/lib/action-flash';
import { isFlashToken } from '@/lib/action-feedback-codes';

export const dynamic = 'force-dynamic';

/**
 * 取出并**作废**一条一次性 flash 回执。
 *
 * 为什么用一次 fetch 而不是服务端渲染：回执可能出现在任何页面（插件页面、
 * 主题页面、公开页面），而 layout 拿不到 `searchParams`。客户端看到
 * `?flash=<token>` 就来这里取正文——正文在 httpOnly cookie 里，读完即删。
 *
 * 安全约束：
 * - token 形态先校验，杜绝把任意字符串当 cookie 名去读；
 * - cookie 是 `httpOnly` + `sameSite=lax`，跨站页面拿不到它；
 * - 只返回 `{kind, message, code, requestId}`，不含任何用户输入原文之外的东西，
 *   且这条正文本来就是服务端自己写进去的本地化文案。
 */
export async function GET(request: NextRequest) {
  // 只接受同源请求：这个接口会**消费**一次性回执，被跨站触发的意义是捣乱。
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'cross_origin' }, { status: 403 });
  }
  const token = request.nextUrl.searchParams.get('token');
  if (!isFlashToken(token)) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }
  const payload = await consumeActionFlash(token);
  if (!payload) {
    // 过期、已消费或密钥缺失：调用方按「没有回执」处理，不显示任何提示。
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } });
}
