import { describe, expect, it } from 'vitest';
import { actionTargetsSchema } from '@/lib/frontend-plugin-action-targets';

/**
 * The kernel's `/plugins/:id/action-targets` returns the active plugin's full
 * route table, including GET finder routes consumed by the same-origin BFF
 * proxy. The executor must parse that payload regardless of method, otherwise
 * every plugin save action fails before the mutation match with「网络请求失败」.
 */
describe('actionTargetsSchema', () => {
  it('parses a route table that mixes GET and mutation methods', () => {
    const parsed = actionTargetsSchema.parse({
      routes: [
        { method: 'GET', path: '/llm-gateway/admin/prices' },
        { method: 'POST', path: '/llm-gateway/admin/prices', permission: 'llm-gateway.admin' },
        { method: 'PATCH', path: '/llm-gateway/admin/prices/:id' },
        { method: 'DELETE', path: '/llm-gateway/admin/prices/:id' },
        { method: 'HEAD', path: '/llm-gateway/v1/models' },
        { method: 'OPTIONS', path: '/llm-gateway/v1/models' },
        { method: 'PUT', path: '/llm-gateway/admin/settings' },
      ],
    });
    expect(parsed.routes).toHaveLength(7);
    expect(parsed.routes[1]).toEqual({
      method: 'POST',
      path: '/llm-gateway/admin/prices',
      permission: 'llm-gateway.admin',
    });
  });

  it('rejects an unknown method', () => {
    expect(() =>
      actionTargetsSchema.parse({ routes: [{ method: 'TRACE', path: '/x' }] }),
    ).toThrow();
  });
});
