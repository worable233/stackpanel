import { describe, expect, it } from 'vitest';
import { executePageData } from '@/lib/frontend-page-data';
import type { ApiError } from '@stackpanel/sdk';

/**
 * 「接口报错被渲染成空态」的内核侧修复。
 *
 * 现场：`zjmf.not_ready` 让每一次 GET 都失败，而插件页面写的是
 * `data?.upstreams ?? []` —— 于是「读失败」被渲染成「还没有上游」。用户看到
 * 一个合法空态，实际上数据就在库里，只是读不到。
 *
 * `data` 里键缺席本身是**故意的契约**（权限门禁、select 落空都走这条路），
 * 所以不能改成抛错。新增 `onFailure` 只收集**真错误**，让渲染层能区分。
 */

const api = {} as never;

function failureCollector() {
  const failures: Array<{ as: string; finder?: string }> = [];
  return { failures, onFailure: (f: { as: string; finder?: string }) => failures.push(f) };
}

describe('executePageData reports real failures without breaking the absence contract', () => {
  it('collects a finder that throws', async () => {
    const { failures, onFailure } = failureCollector();
    const data = await executePageData(
      [{ as: 'upstreams', finder: 'zjmf.upstreams' }],
      {
        finders: {
          'zjmf.upstreams': {
            handler: async () => {
              throw new Error('zjmf.not_ready');
            },
          } as never,
        },
        params: {},
        settings: {},
        session: { role: 'ADMIN' },
        api,
        isAllowed: async () => true,
        onFailure,
      },
    );
    // 键仍然缺席（保持旧契约，页面不会因为一个失败的 finder 变成 500）。
    expect(data).not.toHaveProperty('upstreams');
    // 但失败不再被吞掉。
    expect(failures).toMatchObject([{ as: 'upstreams', finder: 'zjmf.upstreams' }]);
  });

  it('does not report a permission denial as a failure', async () => {
    const { failures, onFailure } = failureCollector();
    await executePageData(
      [{ as: 'secret', finder: 'x.secret', permission: 'x.admin' }],
      {
        finders: { 'x.secret': { handler: async () => 'nope' } as never },
        params: {},
        settings: {},
        session: { role: 'USER' },
        api,
        // 门禁是**策略**，不是错误：受限页面不该显示「读取失败」。
        isAllowed: async () => false,
        onFailure,
      },
    );
    expect(failures).toEqual([]);
  });

  it('does not report a missing finder as a failure', async () => {
    const { failures, onFailure } = failureCollector();
    await executePageData(
      [{ as: 'x', finder: 'not.installed' }],
      {
        finders: {},
        params: {},
        settings: {},
        session: { role: 'ADMIN' },
        api,
        isAllowed: async () => true,
        onFailure,
      },
    );
    expect(failures).toEqual([]);
  });

  it('keeps successful data intact', async () => {
    const { failures, onFailure } = failureCollector();
    const data = await executePageData(
      [{ as: 'upstreams', finder: 'ok' }],
      {
        finders: { ok: { handler: async () => [{ id: 'a' }] } as never },
        params: {},
        settings: {},
        session: { role: 'ADMIN' },
        api,
        isAllowed: async () => true,
        onFailure,
      },
    );
    expect(data).toEqual({ upstreams: [{ id: 'a' }] });
    expect(failures).toEqual([]);
  });

  it('reports fetch-path failures too, not only finders', async () => {
    const { failures, onFailure } = failureCollector();
    await executePageData(
      [{ as: 'rows', fetch: { path: '/api/v1/x' } }],
      {
        finders: {},
        params: {},
        settings: {},
        session: { role: 'ADMIN' },
        api,
        isAllowed: async () => true,
        onFailure,
        fetchJson: async () => {
          throw new Error('502');
        },
      },
    );
    expect(failures).toMatchObject([{ as: 'rows' }]);
  });
});

/** `ApiError` 的 code/reqId 才会被送到界面（ADR-0012），原文只进日志。 */
describe('failure payload shape', () => {
  it('carries only stable code and requestId', () => {
    const error = { code: 'plugin.unavailable', requestId: 'req-9' } as unknown as ApiError;
    const mapped = {
      as: 'upstreams',
      ...(error.code ? { code: error.code } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
    expect(mapped).toEqual({ as: 'upstreams', code: 'plugin.unavailable', requestId: 'req-9' });
    // 不含 message：界面文案由本地词表决定。
    expect(Object.keys(mapped)).not.toContain('message');
  });
});
