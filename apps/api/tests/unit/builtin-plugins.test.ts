import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PLUGIN_IDS,
  PluginError,
  validateManifest,
  type PluginManifestFile,
} from '../../src/lib/plugins.ts';

/**
 * ADR-0008 D9：内置插件清单不再由内核硬编码，而是从插件包元数据
 * （`package.json` 的 `stackpanel.builtin`）派生。本文钉死派生结果与声明一致，
 * 并守住「上传包不得自声明 builtin」的边界。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const pluginsDir = path.join(repoRoot, 'packages', 'plugins');

function declaredBuiltinIds(): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const pkg = JSON.parse(readFileSync(path.join(pluginsDir, name, 'package.json'), 'utf8')) as {
        stackpanel?: { builtin?: boolean };
      };
      return pkg.stackpanel?.builtin === true;
    })
    .sort();
}

function manifest(extra: Partial<PluginManifestFile> = {}): PluginManifestFile {
  return { id: 'demo', name: 'Demo', version: '1.0.0', ...extra };
}

describe('内置插件清单由包元数据派生（ADR-0008 D9）', () => {
  it('BUILTIN_PLUGIN_IDS 与 package.json 的 stackpanel.builtin 声明完全一致', () => {
    const declared = declaredBuiltinIds();
    expect(declared.length).toBeGreaterThan(0);
    expect([...BUILTIN_PLUGIN_IDS].sort()).toEqual(declared);
  });

  it('不把未声明的示例插件当成内置', () => {
    for (const example of ['cms', 'minimal', 'notice', 'template']) {
      expect(BUILTIN_PLUGIN_IDS).not.toContain(example);
    }
  });

  it('上传包（allowReserved=false）不得声明 builtin，返回 422', () => {
    try {
      validateManifest(manifest({ builtin: true }));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).status).toBe(422);
    }
  });

  it('内核写入的内置 manifest（allowReserved=true）可带 builtin', () => {
    expect(() => validateManifest(manifest({ builtin: true }), true)).not.toThrow();
  });
});
