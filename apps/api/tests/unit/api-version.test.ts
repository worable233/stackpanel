import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  applyDeprecationHeaders,
  DEPRECATED_ROUTES,
  deprecationFor,
  registerApiVersioning,
  type DeprecatedRoute,
} from '../../src/lib/api-version.ts';

/**
 * G1: deprecation headers are applied from a single registry. The live registry
 * is empty by contract; these tests use a fixture registry to prove the matcher
 * and header rendering.
 */
const fixture: DeprecatedRoute[] = [
  {
    method: 'GET',
    path: '/admin/legacy/:id',
    since: '2026-10-01',
    sunsetAt: '2027-01-01T00:00:00.000Z',
    replacement: '/admin/modern/:id',
    note: 'test fixture',
  },
];

describe('deprecation matching', () => {
  it('matches by method + path template (params capture)', () => {
    expect(deprecationFor('GET', '/admin/legacy/42', fixture)?.path).toBe('/admin/legacy/:id');
    expect(deprecationFor('GET', '/admin/legacy/42?x=1', fixture)?.method).toBe('GET');
  });

  it('ignores other methods and paths', () => {
    expect(deprecationFor('POST', '/admin/legacy/42', fixture)).toBeUndefined();
    expect(deprecationFor('GET', '/admin/modern/42', fixture)).toBeUndefined();
    expect(deprecationFor('GET', '/admin/legacy/42/extra', fixture)).toBeUndefined();
  });

  it('ships an empty registry by contract', () => {
    expect(DEPRECATED_ROUTES).toEqual([]);
  });
});

describe('deprecation headers over HTTP', () => {
  it('emits Deprecation / Sunset / Link on matched routes', async () => {
    const app = Fastify();
    registerApiVersioning(app, fixture);
    app.get('/admin/legacy/:id', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/admin/legacy/7' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe(new Date('2027-01-01T00:00:00.000Z').toUTCString());
    expect(res.headers['link']).toBe('</admin/modern/:id>; rel="deprecation"');
    await app.close();
  });

  it('does not touch undeclared routes', async () => {
    const app = Fastify();
    registerApiVersioning(app, fixture);
    app.get('/admin/modern/:id', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/admin/modern/7' });
    expect(res.headers['deprecation']).toBeUndefined();
    await app.close();
  });

  it('is a no-op when the registry is empty', async () => {
    const app = Fastify();
    registerApiVersioning(app, []);
    app.get('/anything', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/anything' });
    expect(res.headers['deprecation']).toBeUndefined();
    await app.close();
  });

  it('renders only Deprecation when no sunset / replacement', () => {
    // Directly exercise the header helper to avoid a second server.
    const seen: Record<string, string> = {};
    const fakeReply = {
      header(name: string, value: string) {
        seen[name] = value;
        return this;
      },
    } as unknown as Parameters<typeof applyDeprecationHeaders>[0];
    applyDeprecationHeaders(fakeReply, { method: 'GET', path: '/x', since: '2026-10-01' });
    expect(seen).toEqual({ Deprecation: 'true' });
  });
});
