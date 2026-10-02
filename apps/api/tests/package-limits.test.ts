import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { isForbiddenSourceFile, parsePluginZip, PluginError } from '../src/lib/plugins.ts';
import { parseThemeZip, ThemeError } from '../src/lib/themes.ts';

function archive(entries: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(entries));
}

describe('package archive limits', () => {
  it('rejects plugin archives with too many entries before extraction', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < 129; index += 1) {
      entries[`assets/${index}.txt`] = strToU8('x');
    }
    expect(() => parsePluginZip(archive(entries))).toThrow(PluginError);
    expect(() => parsePluginZip(archive(entries))).toThrow('文件数量超出限制');
  });

  it('rejects an oversized theme entry before extraction', () => {
    const entries = {
      'theme.json': strToU8(JSON.stringify({ id: 'large', name: 'Large', version: '1.0.0' })),
      'theme.css': strToU8(':root { --background: white; }'),
      'assets/large.bin': new Uint8Array(1024 * 1024 + 1),
    };
    expect(() => parseThemeZip(archive(entries))).toThrow(ThemeError);
    expect(() => parseThemeZip(archive(entries))).toThrow('文件过大');
  });
});

describe('distributed package source-file guard', () => {
  it('flags declaration files and their source maps as forbidden source', () => {
    expect(isForbiddenSourceFile('dist/index.d.ts')).toBe(true);
    expect(isForbiddenSourceFile('dist/index.d.ts.map')).toBe(true);
    expect(isForbiddenSourceFile('dist/index.js')).toBe(false);
    expect(isForbiddenSourceFile('dist/index.js.map')).toBe(false);
  });

  it('rejects a plugin ZIP that still ships a .d.ts', () => {
    const entries = {
      'manifest.json': strToU8(
        JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', entry: 'dist/index.js' }),
      ),
      'dist/index.js': strToU8(
        'export default { manifest: { id: "demo", name: "Demo", version: "1.0.0" } }',
      ),
      'dist/index.d.ts': strToU8('export {}'),
    };
    expect(() => parsePluginZip(archive(entries))).toThrow(PluginError);
    expect(() => parsePluginZip(archive(entries))).toThrow('不允许包含源码文件');
  });
});
