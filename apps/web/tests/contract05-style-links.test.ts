import { describe, expect, it } from 'vitest';
import { buildFrontendStyleLinks } from '@/lib/frontend-style-links';

/**
 * Contract 05 §3.6/§3.8 — the single controlled `<link>` injection point.
 *
 * Regression: a `styles[]` entry is relative to the frontend package root
 * (`frontend/dist/x.css`), and the versioned route serves the revision dir
 * contents *without* the `frontend/` prefix. The computed URL must therefore be
 * `<base>/dist/x.css`, not `<base>/x.css` (a 404).
 */

describe('buildFrontendStyleLinks (contract 05 §3.6/§3.8)', () => {
  it('emits versioned same-origin URLs for a theme with styles[]', () => {
    const links = buildFrontendStyleLinks(
      {
        id: 'default',
        descriptor: {
          available: true,
          manifest: { styles: ['frontend/dist/theme.css'], entry: 'frontend/dist/index.js' },
          revision: 'abc123def456',
        },
      },
      [],
    );
    expect(links).toEqual([
      {
        key: 'theme-css:default',
        href: '/api/plugins/themes/default/theme.css',
        marker: 'themes:default',
      },
      {
        key: 'theme-style:default:frontend/dist/theme.css',
        href: '/api/plugins/themes/default/frontend/abc123def456/dist/theme.css',
        marker: 'themes:default',
        revision: 'abc123def456',
      },
    ]);
  });

  it('falls back to the flat base without a revision', () => {
    const links = buildFrontendStyleLinks(
      {
        id: 'default',
        descriptor: {
          available: true,
          manifest: { styles: ['frontend/dist/theme.css'] },
        },
      },
      [],
    );
    expect(links[1]?.href).toBe('/api/plugins/themes/default/frontend/dist/theme.css');
  });

  it('emits versioned URLs for plugin styles[]', () => {
    const links = buildFrontendStyleLinks(null, [
      {
        id: 'store',
        manifest: { styles: ['frontend/dist/store.css'] },
        revision: 'f00dbabe1234',
      },
    ]);
    expect(links).toEqual([
      {
        key: 'plugin-style:store:frontend/dist/store.css',
        href: '/api/plugins/plugins/store/frontend/f00dbabe1234/dist/store.css',
        marker: 'plugins:store',
        revision: 'f00dbabe1234',
      },
    ]);
  });

  it('skips plugins with no styles[]', () => {
    expect(buildFrontendStyleLinks(null, [{ id: 'no-style', manifest: { styles: [] } }])).toEqual(
      [],
    );
  });

  it('always emits theme.css even when the theme has no frontend styles[]', () => {
    const links = buildFrontendStyleLinks(
      { id: 'plain', descriptor: { available: false, manifest: null } },
      [],
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe('/api/plugins/themes/plain/theme.css');
  });
});
