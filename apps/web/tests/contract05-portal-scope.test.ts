import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Contract 05 §3.5 / contract 01 §7 — Portal scope propagation.
 *
 * Base UI overlays render into `<body>` by default, which would escape the
 * package's `[data-sp-frontend]` style scope. Every host primitive that portals
 * must therefore route through the scope-aware container. This is a structural
 * guard: it fails if a primitive is added/changed to portal without the scope
 * container (the behaviour itself is exercised in the browser E2E pass).
 */

const UI_DIR = path.join(process.cwd(), 'src/components/ui');

const PORTAL_PRIMITIVES = [
  'dialog.tsx',
  'alert-dialog.tsx',
  'select.tsx',
  'dropdown-menu.tsx',
  'popover.tsx',
  'tooltip.tsx',
];

describe('portal scope propagation (contract 05 §3.5)', () => {
  it.each(PORTAL_PRIMITIVES)('%s portals through the scope-aware container', (file) => {
    const source = readFileSync(path.join(UI_DIR, file), 'utf8');
    expect(source).toContain('useFrontendPortalContainer');
    expect(source).toMatch(/container=\{useFrontendPortalContainer\(\)\}|container\s*[,}]/);
  });

  it('the scope root emits the same marker the stylesheet validator accepts', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/frontend-scope.tsx'),
      'utf8',
    );
    expect(source).toMatch(/data-sp-frontend=\{scope\}/);
    expect(source).toMatch(/setAttribute\('data-sp-frontend', scope\)/);
  });

  it('the user-page render root uses the scope provider, not a bare div', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/frontend-route.tsx'),
      'utf8',
    );
    expect(source).toContain('FrontendScopeRoot');
  });
});
