import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isVersionRange,
  maxSatisfying,
  parseSemver,
  satisfiesRange,
} from '../src/distribution/semver.js';
import {
  PACKAGE_MANIFEST_FORMAT_VERSION,
  isValidKernelManifest,
  isValidPackageManifest,
  validateKernelManifest,
  validatePackageManifest,
  type KernelManifest,
  type PackageManifest,
} from '../src/distribution/manifest.js';
import {
  catalogCandidates,
  catalogKernelRefs,
  catalogReleaseTag,
  channelSequence,
  isCatalogExpired,
  isNewerSequence,
  parseCatalogReleaseTag,
  validateCatalogSnapshot,
  type CatalogSnapshot,
} from '../src/distribution/catalog.js';
import {
  buildRevisionManifest,
  computeRevision,
  isRevision,
  normalizeRevisionPath,
} from '../src/distribution/revision.js';
import {
  assertTransition,
  canTransition,
  isTerminalPhase,
  UPDATE_PROTOCOL_VERSION,
} from '../src/distribution/update-protocol.js';
import { updateChannelDir, updateTaskFileName } from '../src/distribution/update-channel.js';
import {
  activeKeys,
  applyKeyRotation,
  applyRootRecovery,
  catalogKeyAllowed,
  packageKeyAllowed,
  type Keyring,
} from '../src/distribution/trust.js';
import {
  addedPermissions,
  checkPackageCompatibility,
  resolveDeployment,
  resolveKernelUpgrade,
  selectTargetVersion,
  type KernelCapabilities,
} from '../src/distribution/compatibility.js';
import {
  collectGcCandidates,
  INSTALL_TRANSACTION_STEPS,
  type GcReferences,
} from '../src/distribution/install.js';

const sha = (char: string) => char.repeat(64);

function pluginManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    formatVersion: PACKAGE_MANIFEST_FORMAT_VERSION,
    kind: 'plugin',
    id: 'llm-gateway',
    version: '1.2.3',
    channel: 'stable',
    source: {
      repository: 'worable233/stackpanel-plugins',
      tag: 'plugin-llm-gateway-v1.2.3',
      asset: 'llm-gateway-1.2.3.zip',
    },
    artifact: { sha256: sha('a'), size: 123456 },
    compatibility: {
      kernel: '>=0.2.0 <0.3.0',
      kernelApi: '^0.4.0',
      frontendAbi: '^1.0.0',
      packageFormat: 1,
    },
    requires: [],
    conflicts: [],
    permissions: [],
    frontendModes: ['M2'],
    migration: { mode: 'none', rollback: 'code-compatible' },
    automatic: { eligible: true },
    ...overrides,
  };
}

describe('distribution semver', () => {
  it('parses full semver and ignores build metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v1.2.3+build.7')?.patch).toBe(3);
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('not-a-version')).toBeNull();
  });

  it('compares versions including prerelease ordering', () => {
    const a = parseSemver('1.2.3');
    const b = parseSemver('1.2.4');
    const pre = parseSemver('1.2.3-beta.1');
    expect(a && b && compareSemver(a, b)).toBeLessThan(0);
    expect(pre && a && compareSemver(pre, a)).toBeLessThan(0);
  });

  it('evaluates caret, tilde, comparator and wildcard ranges', () => {
    expect(satisfiesRange('0.4.1', '^0.4.0')).toBe(true);
    expect(satisfiesRange('0.5.0', '^0.4.0')).toBe(false);
    expect(satisfiesRange('0.2.5', '~0.2.0')).toBe(true);
    expect(satisfiesRange('0.3.0', '~0.2.0')).toBe(false);
    expect(satisfiesRange('0.2.5', '>=0.2.0 <0.3.0')).toBe(true);
    expect(satisfiesRange('1.2.3', '*')).toBe(true);
    expect(satisfiesRange('1.2.3', '1.2.x')).toBe(true);
    expect(satisfiesRange('1.3.0', '1.2.x')).toBe(false);
  });

  it('does not let a prerelease satisfy a plain range unless the core matches', () => {
    expect(satisfiesRange('1.2.3-beta', '>=1.2.0')).toBe(false);
    expect(satisfiesRange('1.2.3-beta', '>=1.2.3-beta')).toBe(true);
  });

  it('validates range syntax and picks the max satisfying version', () => {
    expect(isVersionRange('>=1.0.0 <2.0.0')).toBe(true);
    expect(isVersionRange('nonsense')).toBe(false);
    expect(maxSatisfying(['1.0.0', '1.5.0', '2.0.0', 'bad'], '^1.0.0')).toBe('1.5.0');
  });
});

describe('package manifest contract', () => {
  it('accepts a well-formed manifest', () => {
    expect(validatePackageManifest(pluginManifest())).toEqual([]);
    expect(isValidPackageManifest(pluginManifest())).toBe(true);
  });

  it('rejects a non-sha256 artifact digest', () => {
    const issues = validatePackageManifest(
      pluginManifest({ artifact: { sha256: 'short', size: 1 } }),
    );
    expect(issues.map((i) => i.path)).toContain('artifact.sha256');
  });

  it('rejects a non-semver version and bad kind', () => {
    const bad = { ...pluginManifest(), version: 'v1', kind: 'widget' };
    const paths = validatePackageManifest(bad).map((i) => i.path);
    expect(paths).toContain('version');
    expect(paths).toContain('kind');
  });

  it('rejects an asset name with path separators', () => {
    const manifest = pluginManifest();
    const issues = validatePackageManifest({
      ...manifest,
      source: { ...manifest.source, asset: '../evil.zip' },
    });
    expect(issues.map((i) => i.path)).toContain('source.asset');
  });

  it('rejects duplicate permissions and unknown frontend modes', () => {
    const issues = validatePackageManifest(
      pluginManifest({ permissions: ['a', 'a'], frontendModes: ['M2', 'M3' as never] }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('permissions[1]');
    expect(paths).toContain('frontendModes[1]');
  });

  it('validates a kernel manifest with image digests', () => {
    const kernel: KernelManifest = {
      formatVersion: PACKAGE_MANIFEST_FORMAT_VERSION,
      kind: 'kernel',
      version: '0.2.0',
      channel: 'stable',
      kernelApi: '0.4.0',
      frontendAbi: '1.0.0',
      updateProtocol: UPDATE_PROTOCOL_VERSION,
      upgradeFrom: '>=0.1.0',
      migrationPath: 'direct',
      schemaRange: '>=20261001000000',
      images: [
        { platform: 'linux/amd64', digest: `ghcr.io/worable233/stackpanel@sha256:${sha('b')}` },
        { platform: 'linux/arm64', digest: `ghcr.io/worable233/stackpanel@sha256:${sha('c')}` },
      ],
      corePackages: [],
      supportedPlatforms: ['linux/amd64', 'linux/arm64'],
      smokeProbeVersion: 1,
      databaseMigration: '20261003000000_notification_live',
    };
    expect(validateKernelManifest(kernel)).toEqual([]);
    expect(isValidKernelManifest(kernel)).toBe(true);
    const broken = { ...kernel, images: [{ platform: 'plan9', digest: 'latest' }] };
    const paths = validateKernelManifest(broken).map((i) => i.path);
    expect(paths).toContain('images[0].platform');
    expect(paths).toContain('images[0].digest');
  });
});

describe('catalog contract', () => {
  function catalog(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
    return {
      formatVersion: 1,
      sequence: 7,
      generatedAt: '2026-10-16T00:00:00.000Z',
      expiresAt: '2026-10-20T00:00:00.000Z',
      channels: [{ channel: 'stable', sequence: 7 }],
      publishers: [
        {
          publisher: 'stackpanel',
          keyIds: ['catalog-2026'],
          repositories: ['worable233/stackpanel-market'],
        },
      ],
      entries: [pluginManifest()],
      ...overrides,
    };
  }

  it('validates a self-consistent snapshot', () => {
    expect(validateCatalogSnapshot(catalog())).toEqual([]);
  });

  it('rejects an expiry earlier than generation', () => {
    const issues = validateCatalogSnapshot(
      catalog({ generatedAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-10-16T00:00:00.000Z' }),
    );
    expect(issues.map((i) => i.path)).toContain('expiresAt');
  });

  it('rejects duplicate channels and invalid entries', () => {
    const issues = validateCatalogSnapshot(
      catalog({
        channels: [
          { channel: 'stable', sequence: 7 },
          { channel: 'stable', sequence: 8 },
        ],
        entries: [{ ...pluginManifest(), version: 'bad' }],
      }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('channels[1].channel');
    expect(paths).toContain('entries[0].version');
  });

  it('detects expiry and sequence replay', () => {
    expect(isCatalogExpired(catalog(), new Date('2026-10-21T00:00:00.000Z'))).toBe(true);
    expect(isCatalogExpired(catalog(), new Date('2026-10-17T00:00:00.000Z'))).toBe(false);
    expect(isNewerSequence(8, 7)).toBe(true);
    expect(isNewerSequence(7, 7)).toBe(false);
    expect(isNewerSequence(6, 7)).toBe(false);
  });

  it('round-trips catalog tags and resolves channels', () => {
    expect(catalogReleaseTag(7)).toBe('catalog-v1/7');
    expect(parseCatalogReleaseTag('catalog-v1/7')).toBe(7);
    expect(parseCatalogReleaseTag('catalog-v2/7')).toBeNull();
    expect(parseCatalogReleaseTag('random')).toBeNull();
    expect(channelSequence(catalog(), 'stable')).toBe(7);
    expect(channelSequence(catalog(), 'beta')).toBeNull();
  });

  it('excludes revoked entries from candidates', () => {
    const revoked: PackageManifest = { ...pluginManifest({}), version: '1.0.0' };
    const snapshot = catalog({
      entries: [pluginManifest(), { ...revoked, revoked: true }],
    });
    const candidates = catalogCandidates(snapshot, 'plugin', 'llm-gateway');
    expect(candidates.map((c) => c.version)).toEqual(['1.2.3']);
  });
});

describe('revision contract', () => {
  it('normalizes paths and rejects traversal', () => {
    expect(normalizeRevisionPath('./a/b.js')).toBe('a/b.js');
    expect(() => normalizeRevisionPath('/abs')).toThrow();
    expect(() => normalizeRevisionPath('a/../b')).toThrow();
  });

  it('is order-independent and excludes derived files', () => {
    const a = buildRevisionManifest(
      [
        { path: 'b.js', data: new Uint8Array([2]) },
        { path: 'a.js', data: new Uint8Array([1]) },
        { path: 'signature.json', data: new Uint8Array([9]) },
      ],
      ['signature.json'],
    );
    const b = buildRevisionManifest([
      { path: 'a.js', data: new Uint8Array([1]) },
      { path: 'b.js', data: new Uint8Array([2]) },
    ]);
    expect(a.files.map((f) => f.path)).toEqual(['a.js', 'b.js']);
    expect(computeRevision(a)).toBe(computeRevision(b));
    expect(isRevision(computeRevision(a))).toBe(true);
  });

  it('changes when any protected byte changes', () => {
    const first = buildRevisionManifest([{ path: 'a.js', data: new Uint8Array([1]) }]);
    const second = buildRevisionManifest([{ path: 'a.js', data: new Uint8Array([2]) }]);
    expect(computeRevision(first)).not.toBe(computeRevision(second));
  });
});

describe('update protocol state machine', () => {
  it('allows the success path and forbids skipping', () => {
    expect(canTransition('queued', 'resolving')).toBe(true);
    expect(canTransition('queued', 'migrating')).toBe(false);
    expect(canTransition('verifying', 'committed')).toBe(true);
    expect(canTransition('committed', 'cleanup')).toBe(true);
    expect(canTransition('cleanup', 'committed')).toBe(false);
    expect(() => assertTransition('queued', 'migrating')).toThrow();
  });

  it('routes failures into recovery and blocks as terminal', () => {
    expect(canTransition('migrating', 'recovering')).toBe(true);
    expect(canTransition('recovering', 'recovered')).toBe(true);
    expect(canTransition('recovering', 'recovery_failed')).toBe(true);
    expect(canTransition('resolving', 'blocked')).toBe(true);
    expect(isTerminalPhase('blocked')).toBe(true);
    expect(isTerminalPhase('recovered')).toBe(true);
    expect(isTerminalPhase('migrating')).toBe(false);
  });
});

describe('trust chain', () => {
  const keyring: Keyring = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'catalog-2026',
        purpose: 'catalog',
        publicKeyPem: 'PEM',
        allowedRepositories: ['worable233/stackpanel-market'],
      },
      {
        keyId: 'pkg-stackpanel',
        purpose: 'package',
        publicKeyPem: 'PEM',
        publisher: 'stackpanel',
        allowedRepositories: ['worable233/stackpanel-plugins'],
      },
      {
        keyId: 'expired',
        purpose: 'catalog',
        publicKeyPem: 'PEM',
        notAfter: '2020-01-01T00:00:00.000Z',
      },
    ],
  };

  it('filters active keys by purpose and window', () => {
    const keys = activeKeys(keyring, 'catalog').map((k) => k.keyId);
    expect(keys).toContain('catalog-2026');
    expect(keys).not.toContain('expired');
  });

  it('only allows the catalog key bound to the selected repository', () => {
    expect(catalogKeyAllowed(keyring, 'catalog-2026', 'worable233/stackpanel-market')).toBe(true);
    expect(catalogKeyAllowed(keyring, 'catalog-2026', 'evil/market')).toBe(false);
    expect(catalogKeyAllowed(keyring, 'pkg-stackpanel', 'worable233/stackpanel-market')).toBe(
      false,
    );
  });

  it('binds package signatures to publisher and repository', () => {
    expect(
      packageKeyAllowed(keyring, 'pkg-stackpanel', 'stackpanel', 'worable233/stackpanel-plugins'),
    ).toBe(true);
    expect(
      packageKeyAllowed(keyring, 'pkg-stackpanel', 'impostor', 'worable233/stackpanel-plugins'),
    ).toBe(false);
  });

  it('requires an existing, valid authorizer for key rotation', () => {
    const rotated = applyKeyRotation(keyring, {
      authorizedBy: 'catalog-2026',
      newKey: { keyId: 'catalog-2027', purpose: 'catalog', publicKeyPem: 'PEM2' },
    });
    expect(rotated.keys.map((k) => k.keyId)).toContain('catalog-2027');
    expect(() =>
      applyKeyRotation(keyring, {
        authorizedBy: 'unknown',
        newKey: { keyId: 'x', purpose: 'catalog', publicKeyPem: 'PEM' },
      }),
    ).toThrow();
  });

  it('requires an explicit assertion for root recovery', () => {
    expect(() =>
      applyRootRecovery(keyring, {
        recoveryAssertion: '',
        newRootKey: { keyId: 'root2', purpose: 'catalog', publicKeyPem: 'PEM' },
      }),
    ).toThrow();
    const recovered = applyRootRecovery(keyring, {
      recoveryAssertion: 'offline-signed-2026-10-16',
      newRootKey: { keyId: 'root2', purpose: 'catalog', publicKeyPem: 'PEM' },
    });
    expect(recovered.keys.map((k) => k.keyId)).toContain('root2');
  });
});

describe('compatibility gate and deployment plan', () => {
  const kernel: KernelCapabilities = {
    version: '0.2.0',
    kernelApi: '0.4.0',
    frontendAbi: '1.0.0',
    packageFormat: 1,
    schemaRange: '>=20261001000000',
    frontendModes: ['M1', 'M2'],
    platform: 'linux/amd64',
  };

  it('blocks incompatible kernel/abi/package format', () => {
    const manifest = pluginManifest({
      compatibility: {
        kernel: '>=9.0.0',
        kernelApi: '^99.0.0',
        frontendAbi: '^99.0.0',
        packageFormat: 99,
      },
    });
    const codes = checkPackageCompatibility(manifest, kernel).map((b) => b.code);
    expect(codes).toContain('incompatible_kernel');
    expect(codes).toContain('incompatible_abi');
  });

  it('computes newly added permissions by diff, not trust in automatic flag', () => {
    expect(addedPermissions(['a', 'b'], ['b', 'c'])).toEqual(['c']);
    expect(addedPermissions(['a'], ['a'])).toEqual([]);
  });

  it('selects the highest compatible stable version and honours a pin', () => {
    const source = {
      kind: 'plugin' as const,
      id: 'llm-gateway',
      manifests: [
        pluginManifest({ version: '1.0.0' }),
        pluginManifest({ version: '1.4.0' }),
        pluginManifest({
          version: '2.0.0',
          compatibility: {
            kernel: '>=2.0.0',
            kernelApi: '^0.4.0',
            frontendAbi: '^1.0.0',
            packageFormat: 1,
          },
        }),
        pluginManifest({ version: '1.5.0', channel: 'beta' }),
      ],
    };
    const picked = selectTargetVersion(source, undefined, kernel, { channel: 'stable' });
    expect('manifest' in picked && picked.manifest.version).toBe('1.4.0');

    const pinned = selectTargetVersion(
      source,
      {
        kind: 'plugin',
        id: 'llm-gateway',
        version: '1.0.0',
        enabled: true,
        grantedPermissions: [],
        pinnedVersion: '1.0.0',
      },
      kernel,
      { channel: 'stable' },
    );
    expect('manifest' in pinned && pinned.manifest.version).toBe('1.0.0');
  });

  it('resolves a compatible plan without disabling anything', () => {
    const result = resolveDeployment({
      kernel,
      installed: [
        { kind: 'plugin', id: 'store', version: '1.0.0', enabled: true, grantedPermissions: [] },
      ],
      candidates: [
        {
          kind: 'plugin',
          id: 'store',
          manifests: [pluginManifest({ id: 'store', version: '1.1.0' })],
        },
        {
          kind: 'plugin',
          id: 'llm-gateway',
          manifests: [
            pluginManifest({ requires: [{ kind: 'plugin', id: 'store', range: '^1.0.0' }] }),
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.map((p) => p.id).sort()).toEqual(['llm-gateway', 'store']);
    }
  });

  it('blocks on a dependency conflict with a specific reason', () => {
    const result = resolveDeployment({
      kernel,
      installed: [],
      candidates: [
        {
          kind: 'plugin',
          id: 'llm-gateway',
          manifests: [
            pluginManifest({ requires: [{ kind: 'plugin', id: 'store', range: '^1.0.0' }] }),
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocks.some((b) => b.code === 'dependency_conflict')).toBe(true);
    }
  });

  it('forbids downgrades by default', () => {
    const result = resolveDeployment({
      kernel,
      installed: [
        { kind: 'plugin', id: 'store', version: '2.0.0', enabled: true, grantedPermissions: [] },
      ],
      candidates: [
        {
          kind: 'plugin',
          id: 'store',
          manifests: [pluginManifest({ id: 'store', version: '1.0.0' })],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocks.some((b) => b.code === 'downgrade')).toBe(true);
  });

  it('marks permission increases so they are not auto-applied', () => {
    const result = resolveDeployment({
      kernel,
      installed: [
        { kind: 'plugin', id: 'store', version: '1.0.0', enabled: true, grantedPermissions: ['a'] },
      ],
      candidates: [
        {
          kind: 'plugin',
          id: 'store',
          manifests: [pluginManifest({ id: 'store', version: '1.1.0', permissions: ['a', 'b'] })],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan[0]?.addsPermissions).toBe(true);
  });
});

describe('kernel self-upgrade resolution (§13-4)', () => {
  function kernelManifest(
    version: string,
    overrides: Partial<KernelManifest> = {},
  ): KernelManifest {
    return {
      formatVersion: PACKAGE_MANIFEST_FORMAT_VERSION,
      kind: 'kernel',
      version,
      channel: 'stable',
      kernelApi: '0.4.0',
      frontendAbi: '1.0.0',
      updateProtocol: UPDATE_PROTOCOL_VERSION,
      upgradeFrom: '>=0.1.0',
      migrationPath: 'direct',
      schemaRange: '>=20261001000000',
      images: [
        { platform: 'linux/amd64', digest: `ghcr.io/worable233/stackpanel@sha256:${sha('b')}` },
        { platform: 'linux/arm64', digest: `ghcr.io/worable233/stackpanel@sha256:${sha('c')}` },
      ],
      corePackages: [],
      supportedPlatforms: ['linux/amd64', 'linux/arm64'],
      smokeProbeVersion: 1,
      databaseMigration: '20261003000000_x',
      ...overrides,
    };
  }

  it('picks the highest newer stable kernel on the target platform', () => {
    const plan = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      platform: 'linux/arm64',
      channel: 'stable',
      candidates: [kernelManifest('0.3.0'), kernelManifest('0.4.0'), kernelManifest('0.1.0')],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.target.version).toBe('0.4.0');
      expect(plan.digest).toContain(sha('c')); // arm64 image
    }
  });

  it('blocks when the target platform image is missing', () => {
    const plan = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      platform: 'linux/riscv64',
      channel: 'stable',
      candidates: [kernelManifest('0.3.0')],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.blocks[0]?.code).toBe('incompatible_kernel');
  });

  it('refuses a downgrade unless explicitly allowed', () => {
    const blocked = resolveKernelUpgrade({
      currentVersion: '0.4.0',
      channel: 'stable',
      targetVersion: '0.3.0',
      candidates: [kernelManifest('0.3.0')],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.blocks[0]?.code).toBe('downgrade');

    const forced = resolveKernelUpgrade({
      currentVersion: '0.4.0',
      channel: 'stable',
      targetVersion: '0.3.0',
      allowDowngrade: true,
      candidates: [kernelManifest('0.3.0')],
    });
    expect(forced.ok).toBe(true);
  });

  it('requires a verifiable migration path for multi-step upgrades', () => {
    const ok = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      channel: 'stable',
      candidates: [
        kernelManifest('0.4.0', { migrationPath: ['0.3.0', '0.4.0'] }),
        kernelManifest('0.3.0'),
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.path.map((m) => m.version)).toEqual(['0.3.0', '0.4.0']);

    const missing = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      channel: 'stable',
      candidates: [kernelManifest('0.4.0', { migrationPath: ['0.3.0', '0.4.0'] })],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.blocks[0]?.code).toBe('irreversible_migration');
  });

  it('blocks a target kernel that needs a newer update protocol', () => {
    const plan = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      channel: 'stable',
      candidates: [kernelManifest('0.3.0', { updateProtocol: 2 })],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.blocks[0]?.detail).toContain('升级协议');
  });

  it('honours each candidate\u2019s own upgradeFrom when auto-selecting', () => {
    const plan = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      channel: 'stable',
      candidates: [
        // Highest version but only accepts >=0.3.0 as source -> must be skipped.
        kernelManifest('0.5.0', { upgradeFrom: '>=0.3.0' }),
        kernelManifest('0.3.0'),
      ],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.target.version).toBe('0.3.0');

    const none = resolveKernelUpgrade({
      currentVersion: '0.2.0',
      channel: 'stable',
      candidates: [kernelManifest('0.5.0', { upgradeFrom: '>=0.3.0' })],
    });
    expect(none.ok).toBe(false);
  });

  it('exposes catalog kernel refs and validates them', () => {
    const snapshot: CatalogSnapshot = {
      formatVersion: 1,
      sequence: 5,
      generatedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-15T00:00:00.000Z',
      channels: [{ channel: 'stable', sequence: 5 }],
      publishers: [],
      entries: [],
      kernels: [
        {
          version: '0.2.0',
          channel: 'stable',
          source: {
            repository: 'worable233/stackpanel',
            tag: 'v0.2.0',
            asset: 'kernel-manifest.json',
          },
          digest: sha('d'),
          keyId: 'kernel-2026',
        },
        {
          version: '0.3.0',
          channel: 'beta',
          source: {
            repository: 'worable233/stackpanel',
            tag: 'v0.3.0',
            asset: 'kernel-manifest.json',
          },
          digest: sha('e'),
          keyId: 'kernel-2026',
        },
      ],
    };
    expect(validateCatalogSnapshot(snapshot)).toEqual([]);
    expect(catalogKernelRefs(snapshot).map((k) => k.version)).toEqual(['0.3.0', '0.2.0']);
    expect(catalogKernelRefs(snapshot, 'stable').map((k) => k.version)).toEqual(['0.2.0']);

    const bad = {
      ...snapshot,
      kernels: [{ ...snapshot.kernels?.[0], digest: 'nope', channel: 'nightly' }],
    };
    const paths = validateCatalogSnapshot(bad).map((i) => i.path);
    expect(paths).toContain('kernels[0].digest');
    expect(paths).toContain('kernels[0].channel');
  });
});

describe('install transaction and GC', () => {
  it('exposes the ordered transaction steps', () => {
    expect(INSTALL_TRANSACTION_STEPS[0]).toBe('resolve');
    expect(INSTALL_TRANSACTION_STEPS.at(-1)).toBe('gc');
  });

  it('never collects active, rollback or in-flight revisions', () => {
    const references: GcReferences = {
      activeRevisions: ['active'],
      rollbackRevisions: ['rollback'],
      inFlightRevisions: ['inflight'],
      lastUsedAt: {
        active: '2020-01-01T00:00:00.000Z',
        rollback: '2020-01-01T00:00:00.000Z',
        inflight: '2020-01-01T00:00:00.000Z',
        stale: '2020-01-01T00:00:00.000Z',
        fresh: '2026-10-15T00:00:00.000Z',
      },
    };
    const collected = collectGcCandidates(
      ['active', 'rollback', 'inflight', 'stale', 'fresh'],
      references,
      { keepPreviousVersions: 1, retentionDays: 7 },
      new Date('2026-10-16T00:00:00.000Z'),
    );
    expect(collected).toEqual(['stale']);
  });
});

describe('update task channel layout (§5.1)', () => {
  it('builds instance-scoped paths from a single source', () => {
    expect(updateChannelDir('/var/lib/updater/channel', 'inbox', 'sp')).toBe(
      '/var/lib/updater/channel/inbox/sp',
    );
    expect(updateChannelDir('/root/', 'results', 'sp')).toBe('/root/results/sp');
  });

  it('rejects path-traversal in the idempotency key and instance id', () => {
    expect(() => updateTaskFileName('../evil')).toThrow();
    expect(() => updateTaskFileName('a/b')).toThrow();
    expect(() => updateChannelDir('/root', 'inbox', '../x')).toThrow();
  });
});
