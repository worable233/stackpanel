import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 一次性 flash 回执的往返测试。
 *
 * `action-flash` 依赖 `next/headers` 的 cookie store，这里用一个内存实现替换它，
 * 于是「写入 → 消费 → 再消费为空」这条链路可以脱离 Next 运行时验证。
 */

const jar = new Map<string, { value: string; maxAge?: number; httpOnly?: boolean; sameSite?: string }>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = jar.get(name);
      return hit ? { name, value: hit.value } : undefined;
    },
    set: (name: string, value: string, options?: { maxAge?: number; httpOnly?: boolean; sameSite?: string }) => {
      jar.set(name, { value, ...options });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

const { consumeActionFlash, writeActionFlash, ACTION_FLASH_TTL_SECONDS } = await import('@/lib/action-flash');

beforeEach(() => {
  jar.clear();
  process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-for-derivation';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SESSION_SECRET;
  delete process.env.JWT_SECRET;
});

describe('一次性 flash 回执', () => {
  it('round-trips the payload and deletes the cookie on read', async () => {
    const token = await writeActionFlash({
      kind: 'success',
      message: '已更新 3 个商品，跳过 1 个',
      code: 'partial',
    });
    expect(token).toBeTruthy();
    // URL 里只有 token，正文不在 URL 上。
    expect(token).not.toContain('已更新');
    expect(jar.size).toBe(1);
    const stored = [...jar.values()][0];
    expect(stored?.httpOnly).toBe(true);
    expect(stored?.sameSite).toBe('lax');
    // 正文在 cookie 里是密文：直接读 cookie 值看不到原文。
    expect(stored?.value).not.toContain('已更新');

    const payload = await consumeActionFlash(token as string);
    expect(payload).toMatchObject({ kind: 'success', message: '已更新 3 个商品，跳过 1 个', code: 'partial' });
    // 一次有效：读完即删，刷新/后退不会重复弹。
    expect(jar.size).toBe(0);
    expect(await consumeActionFlash(token as string)).toBeNull();
  });

  it('rejects a tampered cookie instead of trusting it', async () => {
    const token = await writeActionFlash({ kind: 'error', message: '原始文本' });
    const name = `sp_flash_${token}`;
    const stored = jar.get(name);
    expect(stored).toBeTruthy();
    // 改认证标签（GCM 的 tag）：比改密文更可靠——密文末位可能只是 base64
    // 填充位，翻转它解出来仍是同一串字节，测不出篡改。
    const parts = (stored?.value ?? '').split('.');
    const tag = parts[1] ?? '';
    parts[1] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    jar.set(name, { ...stored!, value: parts.join('.') });
    expect(await consumeActionFlash(token as string)).toBeNull();
  });

  it('drops an expired payload even if the cookie is still present', async () => {
    const token = await writeActionFlash({ kind: 'error', message: '过期文本' });
    // 把时间推到 TTL 之后：cookie 还在，但正文里的 exp 已失效。
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + (ACTION_FLASH_TTL_SECONDS + 5) * 1000);
    expect(await consumeActionFlash(token as string)).toBeNull();
    vi.restoreAllMocks();
  });

  it('degrades to no flash when no secret is configured', async () => {
    delete process.env.SESSION_SECRET;
    delete process.env.JWT_SECRET;
    // 宁可丢回执，也不能退化成明文 cookie。
    expect(await writeActionFlash({ kind: 'success', message: 'x' })).toBeNull();
    expect(jar.size).toBe(0);
  });

  it('truncates very long messages instead of storing unbounded text', async () => {
    const token = await writeActionFlash({ kind: 'error', message: 'x'.repeat(5_000) });
    const payload = await consumeActionFlash(token as string);
    expect(payload?.message.length).toBe(2_000);
  });
});
