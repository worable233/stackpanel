import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * Guard: `sonner` must be a host ABI slot, not a package dependency that gets
 * bundled per plugin. Otherwise every plugin owns a separate toast store and
 * `<Toaster />` never sees its notifications.
 *
 * These assertions mirror the five wiring points listed in the feedback audit
 * (§6.2-1). If one is removed, plugin toasts silently stop working.
 */
describe('sonner host ABI wiring', () => {
  it('declares the slot and its version in @stackpanel/spec', () => {
    const spec = read('packages/spec/src/frontend-abi.ts');
    expect(spec).toContain("'sonner'");
    expect(spec).toMatch(/sonner:\s*'2\.0\.8'/);
  });

  it('externalizes and aliases sonner in the frontend build', () => {
    const build = read('scripts/build-frontend.mjs');
    expect(build).toContain("'--external:sonner'");
    expect(build).toContain("'--alias:sonner=/api/frontend-abi/sonner'");
  });

  it('publishes the host sonner namespace on both sides of the bridge', () => {
    const client = read('apps/web/src/components/frontend-abi-bridge.tsx');
    const server = read('apps/web/src/lib/frontend-host-abi.ts');
    expect(client).toMatch(/import \* as sonner from 'sonner'/);
    expect(client).toMatch(/\bsonner,/);
    expect(server).toMatch(/import \* as sonner from 'sonner'/);
    expect(server).toMatch(/\bsonner,/);
  });

  it('allows the slot through the ABI route whitelist', () => {
    const route = read('apps/web/src/app/api/frontend-abi/[...slot]/route.ts');
    expect(route).toContain("'sonner'");
  });
});
