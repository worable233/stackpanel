import { describe, expect, it } from 'vitest';
import { readProxyCheck, readProxyHealth } from '../../src/lib/proxy-check.ts';
import { isSameOriginRequest } from '@stackpanel/sdk';

/**
 * 反代自检的判定逻辑。
 *
 * 这一组用例的重点不是「能不能返回 JSON」，而是**结论必须与真实行为一致**：
 * 诊断说 `originGuardWouldPass=true`，Web BFF 的 `isSameOriginRequest` 就必须
 * 真的放行。两者一旦漂移，最坏的结果是「诊断说通过、真实请求仍 403」——那比没有
 * 诊断更糟，运维会顺着错误结论去改反代。
 */

/** 造一个够用的 Fastify 请求替身：只用到 headers / ip / socket / url / method。 */
function fakeRequest(init: {
  headers?: Record<string, string>;
  peer?: string;
  ip?: string;
  url?: string;
  method?: string;
}) {
  const peer = init.peer ?? '172.18.0.5';
  return {
    headers: init.headers ?? {},
    ip: init.ip ?? peer,
    socket: { remoteAddress: peer },
    url: init.url ?? '/api/v1/system/proxy-check',
    method: init.method ?? 'GET',
  } as unknown as Parameters<typeof readProxyCheck>[0]['request'];
}

function report(init: Parameters<typeof fakeRequest>[0], overrides: Partial<{
  trustProxy: string;
  publicUrl: string | null;
  probeOrigin: string;
}> = {}) {
  return readProxyCheck({
    request: fakeRequest(init),
    trustProxy: overrides.trustProxy ?? 'loopback,linklocal,uniquelocal',
    publicUrl: overrides.publicUrl ?? 'https://sp.example.com',
    probeOrigin: overrides.probeOrigin ?? 'https://sp.example.com',
  });
}

describe('readProxyCheck', () => {
  it('协议与真实 IP 都对时全绿', () => {
    const result = report({
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'sp.example.com',
        'x-forwarded-for': '203.0.113.9',
      },
      ip: '203.0.113.9',
    });
    expect(result.items.find((item) => item.id === 'proto')?.ok).toBe(true);
    expect(result.items.find((item) => item.id === 'realIp')?.ok).toBe(true);
    expect(result.originGuardWouldPass).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('反代用 $scheme 报 http、对外是 https 时判失败并给出 map 修复文案', () => {
    const result = report({
      headers: {
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'sp.example.com',
        'x-forwarded-for': '203.0.113.9',
      },
      ip: '203.0.113.9',
    });
    const proto = result.items.find((item) => item.id === 'proto');
    expect(proto?.ok).toBe(false);
    expect(proto?.fix).toContain('$scheme');
    expect(proto?.fix).toContain('map $http_x_forwarded_proto');
    // 同源判定也必须判失败 —— 这就是「请求来源无效」那条事故
    expect(result.originGuardWouldPass).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('X-Forwarded-Proto'))).toBe(true);
  });

  it('诊断结论与 Web BFF 的判定恒一致（同一份实现）', () => {
    const combos = [
      { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'sp.example.com' },
      { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'sp.example.com' },
      { 'x-forwarded-proto': 'https', host: 'sp.example.com' },
      { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'other.example.com' },
    ];
    for (const headers of combos) {
      const result = report({ headers });
      // 用同样的头构造一次真实判定的输入（probeOrigin 对齐诊断所用的 origin）
      const direct = isSameOriginRequest({
        headers: {
          origin: 'https://sp.example.com',
          host: headers['x-forwarded-host'] ?? headers['host'] ?? 'sp.example.com',
          'x-forwarded-host': headers['x-forwarded-host'],
          'x-forwarded-proto': headers['x-forwarded-proto'],
        } as Record<string, string | undefined>,
      });
      expect(result.originGuardWouldPass, JSON.stringify(headers)).toBe(direct);
    }
  });

  it('报了 X-Forwarded-For 却未被采信时判失败（全员共用一个 IP）', () => {
    const result = report({
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'sp.example.com',
        'x-forwarded-for': '203.0.113.9',
      },
      peer: '172.18.0.5',
      ip: '172.18.0.5', // 没有采信
    });
    const realIp = result.items.find((item) => item.id === 'realIp');
    expect(realIp?.ok).toBe(false);
    expect(realIp?.fix).toContain('API_TRUST_PROXY');
    expect(realIp?.fix).toContain('set_real_ip_from');
    expect(result.clientIp).toBe('172.18.0.5');
  });

  it('直连部署（没有 XFF，ip 与对端相同）不算错误', () => {
    const result = report({ headers: { 'x-forwarded-proto': 'https' } });
    expect(result.items.find((item) => item.id === 'realIp')?.ok).toBe(true);
  });

  it('没有报协议时不因协议判失败（同机反代/直连）', () => {
    const result = report({ headers: {} });
    expect(result.items.find((item) => item.id === 'proto')?.ok).toBe(true);
  });

  it('X-Forwarded-For 链被截断，不会把整条链塞进响应', () => {
    const result = report({
      headers: {
        'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'sp.example.com',
      },
      ip: '1.1.1.1',
    });
    expect(result.forwardedFor).toBe('1.1.1.1, 2.2.2.2, 3.3.3.3, …(+2)');
  });

  it('Host 头丢失时给出 Host 修复文案', () => {
    const result = report(
      { headers: { 'x-forwarded-proto': 'https' } },
      { probeOrigin: 'https://sp.example.com' },
    );
    const guard = result.items.find((item) => item.id === 'originGuard');
    expect(guard?.ok).toBe(false);
    expect(guard?.fix).toContain('proxy_set_header Host $host');
  });

  it('每一项都带 doc 锚点，warnings 里能直接读到修复动作', () => {
    const result = report({ headers: { 'x-forwarded-proto': 'http' } });
    for (const item of result.items.filter((entry) => !entry.ok)) {
      expect(item.doc, `${item.id} 缺文档锚点`).toContain('DEPLOY-REVERSE-PROXY.md#');
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('readProxyHealth（/ready 精简版）', () => {
  it('采信了反代地址时 trusted=true', () => {
    const health = readProxyHealth(
      fakeRequest({
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
        ip: '203.0.113.9',
      }),
    );
    expect(health.trusted).toBe(true);
    expect(health.clientIp).toBe('203.0.113.9');
    expect(health.proto).toBe('https');
  });

  it('没采信时 trusted=false 且如实报对端', () => {
    const health = readProxyHealth(fakeRequest({ peer: '172.18.0.5', ip: '172.18.0.5' }));
    expect(health.trusted).toBe(false);
    expect(health.peer).toBe('172.18.0.5');
    expect(health.proto).toBeNull();
  });
});
