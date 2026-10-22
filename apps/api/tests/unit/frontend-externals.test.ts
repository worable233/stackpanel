import { describe, expect, it } from 'vitest';
import { PluginError, validateManifest, type PluginManifestFile } from '../../src/lib/plugins.ts';

/**
 * Contract 02 §5: a package may declare `frontendExternals` (host ABI slot →
 * compatible semver range). The kernel validates it against its own host
 * versions at install time; market and local upload share this same
 * `validateManifest` path. An unsatisfied range is a compatibility conflict
 * (409); a malformed declaration is a protocol error (422).
 */
function manifest(extra: Partial<PluginManifestFile> = {}): PluginManifestFile {
  return { id: 'demo-fe', name: 'Demo FE', version: '1.0.0', ...extra };
}

describe('manifest frontendExternals (contract 02 §5)', () => {
  it('accepts an absent declaration (optional field)', () => {
    expect(() => validateManifest(manifest())).not.toThrow();
  });

  it('accepts ranges the host satisfies', () => {
    expect(() =>
      validateManifest(
        manifest({
          frontendExternals: {
            react: '^19.0.0',
            'react/jsx-runtime': '19.3.x',
            'next/link': '>=16 <17',
            '@stackpanel/ui': '>=0.2 <0.3',
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a host version outside the declared range with 409', () => {
    try {
      validateManifest(manifest({ frontendExternals: { react: '^18.0.0' } }));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).status).toBe(409);
    }
  });

  it('rejects an unknown ABI slot with 422', () => {
    try {
      validateManifest(manifest({ frontendExternals: { 'made-up-slot': '^1.0.0' } }));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).status).toBe(422);
    }
  });

  it('rejects a malformed range with 422', () => {
    try {
      validateManifest(manifest({ frontendExternals: { react: 'not-a-range' } }));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).status).toBe(422);
    }
  });

  it('rejects a non-object declaration with 422', () => {
    try {
      validateManifest(
        manifest({ frontendExternals: ['react'] as unknown as Record<string, string> }),
      );
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).status).toBe(422);
    }
  });
});
