import { describe, expect, it } from 'vitest';
import {
  MANIFEST_SCHEMA_VERSION,
  MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION,
  PluginError,
  validateManifest,
  type PluginManifestFile,
} from '../../src/lib/plugins.ts';

/**
 * G3: distribution manifests carry a `schemaVersion`. Older packages (no field)
 * stay installable; packages from a newer kernel are refused with a clear code,
 * never silently mis-parsed.
 */
function manifest(extra: Partial<PluginManifestFile> = {}): PluginManifestFile {
  return { id: 'demo', name: 'Demo', version: '1.0.0', ...extra };
}

describe('manifest schemaVersion (G3)', () => {
  it('accepts a manifest with no schemaVersion (legacy v1)', () => {
    expect(MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(() => validateManifest(manifest())).not.toThrow();
  });

  it('accepts the current schema version', () => {
    expect(() =>
      validateManifest(manifest({ schemaVersion: MANIFEST_SCHEMA_VERSION })),
    ).not.toThrow();
  });

  it('rejects a malformed schema version with 422', () => {
    for (const bad of [0, -1, 1.5, '1']) {
      try {
        validateManifest(manifest({ schemaVersion: bad as unknown as number }));
        throw new Error('应当抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(PluginError);
        expect((err as PluginError).status).toBe(422);
      }
    }
  });

  it('rejects a manifest from a newer kernel with 409', () => {
    try {
      validateManifest(manifest({ schemaVersion: MANIFEST_SCHEMA_VERSION + 1 }));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).status).toBe(409);
      expect((err as PluginError).message).toContain('schemaVersion');
    }
  });
});
