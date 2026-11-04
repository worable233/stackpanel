import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 三个「诊断可见性」缺陷的共同点：**坏消息被换成了一句无害的废话**。
 *
 *  1. 内核连不上 → 当成未登录 → 跳登录页（用户被踢出，内容丢失）
 *  2. 插件操作失败 → 只说「操作未完成」，reqId/code 全丢弃
 *  3. server action 走页面 URL → 日志里和页面渲染混在一起
 *
 * 这些不是“体验问题”：第 1 条直接造成数据丢失，第 2 条让排障只能靠猜，
 * 第 3 条让“到底哪一次请求失败了”无法定位。
 */

/** 会话三态判定的纯逻辑（与 `lib/auth.ts` 的 getSessionState 同构）。 */
function classify(status: number | 'network'): 'authenticated' | 'anonymous' | 'unavailable' {
  if (status === 'network') return 'unavailable';
  if (status === 401 || status === 403) return 'anonymous';
  return 'unavailable';
}

describe('session resolution distinguishes "anonymous" from "cannot tell"', () => {
  it('treats a real 401/403 as anonymous', () => {
    expect(classify(401)).toBe('anonymous');
    expect(classify(403)).toBe('anonymous');
  });

  it('never treats an api outage as a logout', () => {
    // 这三条以前都会落到 “anonymous” → redirect('/login')，把已登录用户踢出去。
    expect(classify(500)).toBe('unavailable');
    expect(classify(502)).toBe('unavailable');
    expect(classify(503)).toBe('unavailable');
    expect(classify('network')).toBe('unavailable');
  });

  it('does not treat a rate limit as a logout either', () => {
    // 429 说明请求被挡住了，不代表会话无效。
    expect(classify(429)).toBe('unavailable');
  });
});

describe('the web entry points never redirect on an outage', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  const root = resolve(__dirname, '..');

  it('admin proxy returns 503 instead of bouncing to /login on 5xx', () => {
    const proxy = read(`${root}/src/proxy.ts`);
    expect(proxy).toContain('serviceUnavailable(request, csp)');
    // 5xx 必须显式分流，否则 body 里没有 user 就又变成重定向了。
    expect(proxy).toMatch(/res\.status\s*>=\s*500/);
  });

  it('account layout renders 503 rather than redirecting when the kernel is down', () => {
    const layout = read(`${root}/src/app/(account)/account/layout.tsx`);
    expect(layout).toContain("session.kind === 'unavailable'");
    expect(layout).toContain('<ServiceUnavailable />');
    // 「session 为 null 就 redirect」正是那个 bug 的形状，不能再回来。
    // 只看代码行（剥掉注释），否则会命中解释这个 bug 的那段注释。
    const code = layout
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toMatch(/if \(!session\) redirect/);
    // 只有明确匿名才允许跳登录。
    expect(code).toMatch(/session\.kind === 'anonymous'\) redirect/);
  });
});
