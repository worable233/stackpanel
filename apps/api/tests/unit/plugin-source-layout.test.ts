import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single-source rule for plugin packages.
 *
 * `packages/plugins/*` in this repository is the kernel's *shipped* set: these
 * packages are built into the image and seeded on first boot. Business plugins
 * that operators install live in the separate `StackPanel-plugins` repository.
 *
 * The rule was violated by a half-deleted directory: `packages/plugins/referral`
 * kept its `src/` after its `package.json` was removed, so it was not a
 * workspace member, not discovered as built-in, and not seeded — but it was
 * still tracked in git and got grepped by anyone looking for "the referral
 * plugin". That copy had no clawback logic, so reading it led straight to a
 * wrong conclusion about production behaviour.
 *
 * Two invariants therefore:
 *
 * 1. Every directory under `packages/plugins` is a complete package (it has a
 *    `package.json` with an explicit `stackpanel.builtin` boolean). A leftover
 *    directory is a bug, not "harmless extra source".
 * 2. The set of shipped plugin ids is explicit. Adding or removing one is a
 *    deliberate act that shows up as a diff here, rather than being an
 *    accident of whatever happens to be on disk.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const pluginsRoot = path.join(repoRoot, 'packages', 'plugins');

interface PackageJson {
  name?: string;
  stackpanel?: { builtin?: unknown };
}

function pluginDirs(): string[] {
  return readdirSync(pluginsRoot)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(path.join(pluginsRoot, name)).isDirectory())
    .sort();
}

function readPackage(dir: string): PackageJson | null {
  const file = path.join(pluginsRoot, dir, 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
}

describe('packages/plugins: shipped plugin sources', () => {
  it('every directory is a complete package with an explicit builtin flag', () => {
    const incomplete: string[] = [];
    for (const dir of pluginDirs()) {
      const pkg = readPackage(dir);
      if (!pkg) {
        incomplete.push(`${dir}: missing package.json`);
        continue;
      }
      if (typeof pkg.stackpanel?.builtin !== 'boolean') {
        // Omitted vs `false` is not a distinction the kernel can act on: seeding
        // and reserved-id protection both key off an explicit boolean.
        incomplete.push(`${dir}: stackpanel.builtin must be an explicit boolean`);
      }
    }
    expect(incomplete).toEqual([]);
  });

  it('ships exactly the expected set of built-in plugins', () => {
    const shipped = pluginDirs().filter((dir) => readPackage(dir)?.stackpanel?.builtin === true);
    expect(shipped).toEqual([
      'channel',
      'login',
      'market',
      'storage',
      'store',
      'store-product-card',
      'store-product-membership',
      'store-product-server',
      'store-wallet',
    ]);
  });

  it('does not keep a second copy of a business plugin', () => {
    // `referral` is the package that used to be duplicated here. Its authoritative
    // home is StackPanel-plugins; a source tree under this repository would be a
    // stale fork (the previous copy was missing the clawback implementation).
    expect(pluginDirs()).not.toContain('referral');
  });
});
