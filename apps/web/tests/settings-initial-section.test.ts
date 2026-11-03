import { beforeEach, describe, expect, it } from 'vitest';
import { initialSectionId } from '@/components/settings-sections';

/**
 * 「直接访问某个设置分区，会先显示第一个分区再跳过去」。
 *
 * 根因：`useState(sections[0].id)` 把初始值钉在第一个分区，URL hash 只在
 * `useEffect` 里读 —— 而 effect 在水合之后才跑。于是
 * `/admin/settings#payment` 会先画出「常规」再闪到「支付」。
 *
 * 修法：用惰性初始化，在**客户端首次渲染**时就把 hash 读出来。
 *
 * 注意 hash 不参与请求，服务端渲染时读不到 —— 这时必须退回第一个分区，否则
 * 会出现水合不一致。
 */

const sections = [{ id: 'general' }, { id: 'payment' }, { id: 'mail' }];

/** 模拟浏览器环境下的 `window.location.hash`。 */
function withHash(hash: string, run: () => void): void {
  const original = globalThis.window;
  // @ts-expect-error -- 只在这条测试里造一个最小的 window 形状
  globalThis.window = { location: { hash } };
  try {
    run();
  } finally {
    globalThis.window = original;
  }
}

describe('initialSectionId', () => {
  it('uses the hash on the first client render', () => {
    withHash('#payment', () => {
      // 这条断言就是「不闪」：首帧直接是 payment，而不是 general。
      expect(initialSectionId(sections)).toBe('payment');
    });
  });

  it('falls back to the first section without a hash', () => {
    withHash('', () => {
      expect(initialSectionId(sections)).toBe('general');
    });
  });

  it('falls back when the hash names a section that no longer exists', () => {
    // 旧链接 / 已删除的分区不能让页面白屏。
    withHash('#removed-section', () => {
      expect(initialSectionId(sections)).toBe('general');
    });
  });

  it('returns the server-side value when there is no window', () => {
    // 服务端读不到 hash：必须与「无 hash」一致，否则水合不匹配。
    expect(typeof globalThis.window).toBe('undefined');
    expect(initialSectionId(sections)).toBe('general');
  });

  it('handles an empty section list without throwing', () => {
    withHash('#payment', () => {
      expect(initialSectionId([])).toBe('');
    });
  });
});
