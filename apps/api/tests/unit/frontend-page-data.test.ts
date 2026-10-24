import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { validateFrontendFiles } from '../../src/lib/frontend.ts';

/**
 * Declarative page-data requirements (`{ fetch }`) are executed by the host, not
 * by package code, so they are the one way an unadmitted third-party package can
 * still render a populated first screen.
 *
 * Two things must hold at install time:
 *
 * 1. The shape is validated where it is declared (exactly one of `finder` /
 *    `fetch`), so a half-declared requirement cannot silently render empty.
 * 2. A `fetch.path` stays an API path. It is concatenated onto the kernel base
 *    URL and issued with the caller's token, so traversal (`..`) or a backslash
 *    would let a manifest steer a privileged request somewhere else.
 */

function manifestMap(overrides: Record<string, unknown> = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([['frontend/dist/index.js', strToU8('export {};')]]);
  files.set(
    'frontend/manifest.json',
    strToU8(
      JSON.stringify({
        version: '1.0.0',
        revision: 'r1',
        entry: 'frontend/dist/index.js',
        files: ['frontend/dist/index.js'],
        ...overrides,
      }),
    ),
  );
  return files;
}

describe('validateFrontendFiles: declarative data requirements', () => {
  it('accepts a fetch requirement on an admin page', () => {
    const map = manifestMap({
      adminRoutes: [
        {
          path: '/tickets',
          component: 'admin/tickets',
          data: [
            { as: 'tickets', fetch: { path: '/ticket/admin/tickets?all=true', select: 'tickets' } },
          ],
        },
      ],
    });
    expect(() => validateFrontendFiles(map)).not.toThrow();
  });

  it('accepts a fetch requirement on an account page', () => {
    const map = manifestMap({
      accountRoutes: [
        {
          path: '/tickets/:id',
          component: 'account/ticket',
          data: [{ as: 'ticket', fetch: { path: '/tickets/:id' } }],
        },
      ],
    });
    expect(() => validateFrontendFiles(map)).not.toThrow();
  });

  it('still accepts a legacy finder requirement', () => {
    const map = manifestMap({
      finders: ['ticket.thing'],
      adminRoutes: [
        {
          path: '/x',
          component: 'admin/x',
          data: [{ as: 'thing', finder: 'ticket.thing' }],
        },
      ],
    });
    expect(() => validateFrontendFiles(map)).not.toThrow();
  });

  it('rejects a requirement that declares neither form', () => {
    const map = manifestMap({
      adminRoutes: [{ path: '/x', component: 'admin/x', data: [{ as: 'thing' }] }],
    });
    expect(() => validateFrontendFiles(map)).toThrow();
  });

  it('rejects a requirement that declares both forms', () => {
    const map = manifestMap({
      finders: ['ticket.thing'],
      adminRoutes: [
        {
          path: '/x',
          component: 'admin/x',
          data: [{ as: 'thing', finder: 'ticket.thing', fetch: { path: '/x' } }],
        },
      ],
    });
    expect(() => validateFrontendFiles(map)).toThrow();
  });

  it('rejects a relative fetch path', () => {
    const map = manifestMap({
      adminRoutes: [
        { path: '/x', component: 'admin/x', data: [{ as: 'thing', fetch: { path: 'x' } }] },
      ],
    });
    expect(() => validateFrontendFiles(map)).toThrow();
  });

  it('rejects a fetch path that tries to traverse out of the API', () => {
    const map = manifestMap({
      adminRoutes: [
        {
          path: '/x',
          component: 'admin/x',
          data: [{ as: 'thing', fetch: { path: '/tickets/../../admin/plugins' } }],
        },
      ],
    });
    expect(() => validateFrontendFiles(map)).toThrow(/非法的数据请求路径/);
  });
});
