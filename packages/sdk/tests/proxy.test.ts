import { describe, expect, it } from 'vitest';
import { checkOrigin, firstHeaderValue, isSameOriginRequest } from '../src/proxy.js';

/**
 * 同源判定的**单一实现**测试。
 *
 * 这些用例存在的理由：这套判定同时决定「BFF 要不要接受写请求」和「诊断端点报不报
 * 通过」。任何一处漂移，最坏的组合是「诊断说没问题、真实请求 403」——比不诊断更糟。
 * 所以两个入口都必须由这里的行为定义：Web 侧与内核侧各有一份薄封装，
 * `apps/web/tests/request-origin.test.ts` 与
 * `apps/api/tests/unit/proxy-check.test.ts` 断言它们复用同一份实现。
 */

function headers(init: Record<string, string | undefined>) {
  return {
    get(name: string): string | null {
      const key = Object.keys(init).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key === undefined ? null : (init[key] ?? null);
    },
  };
}

const req = (init: Record<string, string | undefined>) => ({ headers: headers(init) });

describe('firstHeaderValue', () => {
  it('取逗号分隔头的第一个值', () => {
    expect(firstHeaderValue('a.example.com, b.example.com')).toBe('a.example.com');
  });

  it('空串与 null 归一为 undefined', () => {
    expect(firstHeaderValue('')).toBeUndefined();
    expect(firstHeaderValue(null)).toBeUndefined();
    expect(firstHeaderValue(undefined)).toBeUndefined();
  });
});

describe('isSameOriginRequest', () => {
  it('host 与协议都一致时通过', () => {
    expect(
      isSameOriginRequest(
        req({ origin: 'https://sp.example.com', host: 'sp.example.com', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe(true);
  });

  it('没有 Origin 的写请求一律拒绝（不是浏览器）', () => {
    expect(isSameOriginRequest(req({ host: 'sp.example.com' }))).toBe(false);
  });

  it('协议不一致时拒绝 —— 这就是「请求来源无效」那条事故', () => {
    // 反代用 $scheme 填 http，而浏览器 Origin 是 https。
    expect(
      isSameOriginRequest(
        req({ origin: 'https://sp.example.com', host: 'sp.example.com', 'x-forwarded-proto': 'http' }),
      ),
    ).toBe(false);
  });

  it('反代没报协议时不因协议拒绝（TLS 直接终止在应用上）', () => {
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }))).toBe(
      true,
    );
  });

  it('X-Forwarded-Host 优先于 Host', () => {
    expect(
      isSameOriginRequest(
        req({
          origin: 'https://public.example.com',
          host: 'web:3000',
          'x-forwarded-host': 'public.example.com',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(true);
  });

  it('Origin 无法解析时拒绝', () => {
    expect(isSameOriginRequest(req({ origin: 'not-a-url', host: 'sp.example.com' }))).toBe(false);
  });

  it('host 不同时拒绝（跨站）', () => {
    expect(
      isSameOriginRequest(req({ origin: 'https://evil.example.com', host: 'sp.example.com' })),
    ).toBe(false);
  });

  it('接受普通 header bag（不要求 Headers 实例）', () => {
    expect(
      isSameOriginRequest({
        headers: { origin: 'https://a.test', host: 'a.test', 'x-forwarded-proto': 'https' },
      }),
    ).toBe(true);
  });
});

describe('checkOrigin（诊断分解）', () => {
  it('结论与 isSameOriginRequest 恒一致', () => {
    const cases: Array<Record<string, string | undefined>> = [
      { origin: 'https://a.test', host: 'a.test', 'x-forwarded-proto': 'https' },
      { origin: 'https://a.test', host: 'a.test', 'x-forwarded-proto': 'http' },
      { origin: 'https://a.test', host: 'b.test' },
      { host: 'a.test' },
      { origin: 'bad', host: 'a.test' },
    ];
    for (const init of cases) {
      expect(checkOrigin(req(init)).passes, JSON.stringify(init)).toBe(
        isSameOriginRequest(req(init)),
      );
    }
  });

  it('协议不匹配时能指出是哪一项', () => {
    const breakdown = checkOrigin(
      req({ origin: 'https://sp.example.com', host: 'sp.example.com', 'x-forwarded-proto': 'http' }),
    );
    expect(breakdown.hostMatches).toBe(true);
    expect(breakdown.protoMatches).toBe(false);
    expect(breakdown.forwardedProto).toBe('http');
    expect(breakdown.originProto).toBe('https');
    expect(breakdown.passes).toBe(false);
  });

  it('host 不匹配时 protoMatches 报 true（另一项是好的）', () => {
    const breakdown = checkOrigin(req({ origin: 'https://a.test', host: 'b.test' }));
    expect(breakdown.hostMatches).toBe(false);
    expect(breakdown.protoMatches).toBe(true);
    expect(breakdown.passes).toBe(false);
  });

  it('缺 Origin 时 hasOrigin 为 false', () => {
    const breakdown = checkOrigin(req({ host: 'a.test' }));
    expect(breakdown.hasOrigin).toBe(false);
    expect(breakdown.origin).toBeNull();
    expect(breakdown.passes).toBe(false);
  });
});
