import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { FrontendError, isAllowedFrontendFile, validateFrontendFiles, validateScopedStylesheet } from '../../src/lib/frontend.ts';
import { serveFrontendFile } from '../../src/lib/frontend-service.ts';
import { parseThemeZip, ThemeError } from '../../src/lib/themes.ts';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Contract 05 §3.2/§6: `styles[]` is the package's own pre-compiled CSS channel,
 * distinct from the theme token channel (`theme.css`). The whitelist admits
 * `frontend/dist/**` `.css`; `styles[]` entries must be `.css` and also listed
 * in `files`.
 */

function frontend(
  overrides: Record<string, unknown> = {},
): { files: Map<string, Uint8Array>; manifest: Record<string, unknown> } {
  const js = strToU8('export default {};');
  const css = strToU8('@layer sp-plugin { .x { color: red } }');
  return {
    files: new Map<string, Uint8Array>([
      ['frontend/dist/index.js', js],
      ['frontend/dist/index.css', css],
    ]),
    manifest: {
      version: '1.0.0',
      revision: 'r1',
      entry: 'frontend/dist/index.js',
      files: ['frontend/dist/index.js'],
      ...overrides,
    },
  };
}

function manifestMap(manifest: Record<string, unknown>, files: Map<string, Uint8Array>) {
  const map = new Map(files);
  map.set('frontend/manifest.json', strToU8(JSON.stringify(manifest)));
  return map;
}

describe('frontend file whitelist (contract 05 §3.2)', () => {
  it('admits .js/.map/.css under frontend/dist and the manifest', () => {
    expect(isAllowedFrontendFile('frontend/manifest.json')).toBe(true);
    expect(isAllowedFrontendFile('frontend/dist/index.js')).toBe(true);
    expect(isAllowedFrontendFile('frontend/dist/index.js.map')).toBe(true);
    expect(isAllowedFrontendFile('frontend/dist/index.css')).toBe(true);
  });

  it('rejects .css outside frontend/dist and other extensions', () => {
    expect(isAllowedFrontendFile('index.css')).toBe(false);
    expect(isAllowedFrontendFile('frontend/dist/index.ts')).toBe(false);
    expect(isAllowedFrontendFile('frontend/dist/../../evil.css')).toBe(false);
  });
});

describe('validateFrontendFiles styles[] (contract 05 §3.2)', () => {
  it('accepts a styles[] entry that is .css and listed in files', () => {
    const { files, manifest } = frontend({
      files: ['frontend/dist/index.js', 'frontend/dist/index.css'],
      styles: ['frontend/dist/index.css'],
    });
    expect(() => validateFrontendFiles(manifestMap(manifest, files))).not.toThrow();
  });

  it('accepts an absent styles[] (optional)', () => {
    const { files, manifest } = frontend();
    expect(() => validateFrontendFiles(manifestMap(manifest, files))).not.toThrow();
  });

  it('rejects a styles[] entry not listed in files', () => {
    const { files, manifest } = frontend({ styles: ['frontend/dist/index.css'] });
    expect(() => validateFrontendFiles(manifestMap(manifest, files))).toThrow(FrontendError);
  });

  it('rejects a non-.css styles[] entry', () => {
    const { files, manifest } = frontend({
      files: ['frontend/dist/index.js'],
      styles: ['frontend/dist/index.js'],
    });
    expect(() => validateFrontendFiles(manifestMap(manifest, files))).toThrow(/必须是 frontend\/dist\/ 下的 \.css/);
  });

  it('rejects a styles[] entry outside frontend/dist', () => {
    const { files, manifest } = frontend({
      files: ['frontend/dist/index.js', 'evil.css'],
      styles: ['evil.css'],
    });
    expect(() => validateFrontendFiles(manifestMap(manifest, files))).toThrow(FrontendError);
  });
});

describe('serveFrontendFile MIME (contract 05 §6 / frontend-service.ts)', () => {
  /**
   * The legacy flat route validates against `manifest.files[]` (contract 04
   * §2), so a package dir needs a manifest declaring the served asset.
   */
  function manifestJson(files: string[]): string {
    return JSON.stringify({
      version: '1.0.0',
      revision: 'a1b2c3d4e5f6',
      entry: 'frontend/dist/index.js',
      files,
    });
  }

  function fakeReply() {
    const state: { type?: string; sent?: unknown; code?: number; headers?: Record<string, string> } =
      {};
    const reply = {
      header(name: string, value: string) {
        state.headers = { ...state.headers, [name]: value };
        return this;
      },
      type(value: string) {
        state.type = value;
        return this;
      },
      code(value: number) {
        state.code = value;
        return this;
      },
      send(value: unknown) {
        state.sent = value;
        return this;
      },
    };
    return { reply, state };
  }

  it('serves .css as text/css; charset=utf-8', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-fe-'));
    try {
      await mkdir(path.join(dir, 'frontend', 'dist'), { recursive: true });
      await writeFile(path.join(dir, 'frontend', 'dist', 'theme.css'), '.x{color:red}');
      await writeFile(
        path.join(dir, 'frontend', 'manifest.json'),
        manifestJson(['frontend/dist/theme.css']),
      );
      const { reply, state } = fakeReply();
      await serveFrontendFile(reply as never, dir, 'dist/theme.css');
      expect(state.type).toBe('text/css; charset=utf-8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps .js as text/javascript', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-fe-'));
    try {
      await mkdir(path.join(dir, 'frontend', 'dist'), { recursive: true });
      await writeFile(path.join(dir, 'frontend', 'dist', 'index.js'), 'export default {};');
      await writeFile(
        path.join(dir, 'frontend', 'manifest.json'),
        manifestJson(['frontend/dist/index.js']),
      );
      const { reply, state } = fakeReply();
      await serveFrontendFile(reply as never, dir, 'dist/index.js');
      expect(state.type).toBe('text/javascript; charset=utf-8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('theme styles[] (contract 05 §6)', () => {  function themeZip(manifest: Record<string, unknown>, extra: Record<string, Uint8Array> = {}) {
    return Buffer.from(
      zipSync({
        'theme.json': strToU8(JSON.stringify(manifest)),
        'theme.css': strToU8(':root { --background: white; }'),
        ...extra,
      }),
    );
  }

  it('accepts a theme styles[] entry present in the package', () => {
    const frontendManifest = JSON.stringify({
      version: '1.0.0',
      revision: 'theme-fe-1',
      entry: 'frontend/dist/index.js',
      files: ['frontend/dist/index.js', 'frontend/dist/demo.css'],
      styles: ['frontend/dist/demo.css'],
    });
    const zip = themeZip(
      { id: 'demo', name: 'Demo', version: '1.0.0', styles: ['frontend/dist/demo.css'] },
      {
        'frontend/dist/demo.css': strToU8('@layer sp-plugin { .x { color: red } }'),
        'frontend/dist/index.js': strToU8('export default {};'),
        'frontend/manifest.json': strToU8(frontendManifest),
      },
    );
    expect(() => parseThemeZip(zip)).not.toThrow();
  });

  it('rejects a theme styles[] entry that is missing from the package', () => {
    const zip = themeZip({ id: 'demo', name: 'Demo', version: '1.0.0', styles: ['frontend/dist/nope.css'] });
    expect(() => parseThemeZip(zip)).toThrow(ThemeError);
  });

  it('rejects a non-.css or traversal theme styles[] entry', () => {
    const zip = themeZip({ id: 'demo', name: 'Demo', version: '1.0.0', styles: ['../evil.css'] });
    expect(() => parseThemeZip(zip)).toThrow(ThemeError);
  });
});

describe('validateScopedStylesheet (contract 05 §3.3/§3.4/§3.8)', () => {
  it('accepts a layered, scoped, same-origin stylesheet', () => {
    expect(() =>
      validateScopedStylesheet(
        '@layer sp-plugin { .card { color: red; background: url(./bg.png) } }',
      ),
    ).not.toThrow();
  });

  it('accepts data: URLs', () => {
    expect(() =>
      validateScopedStylesheet(
        `@layer sp-plugin { .x { background: url("data:image/png;base64,AAAA") } }`,
      ),
    ).not.toThrow();
  });

  it('rejects @import', () => {
    expect(() =>
      validateScopedStylesheet(`@import "evil.css"; @layer sp-plugin { .x {} }`),
    ).toThrow(/@import/);
  });

  it('rejects cross-origin url()', () => {
    expect(() =>
      validateScopedStylesheet(
        '@layer sp-plugin { .x { background: url(https://evil.example/x.png) } }',
      ),
    ).toThrow(/跨源/);
  });

  it('rejects bare global selectors', () => {
    expect(() => validateScopedStylesheet('@layer sp-plugin { body { margin: 0 } }')).toThrow(
      /裸全局选择器/,
    );
    expect(() => validateScopedStylesheet('@layer sp-plugin { :root { --x: 1 } }')).toThrow(
      /裸全局选择器/,
    );
  });

  it('rejects unlayered rules', () => {
    expect(() => validateScopedStylesheet('.x { color: red }')).toThrow(/未分层/);
  });

  it('accepts an empty stylesheet', () => {
    expect(() => validateScopedStylesheet('')).not.toThrow();
  });
});
