import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureRuntimeAdminBundle,
  hostAbiSlotFor,
  importedNames,
  isRuntimeAdminBundleValid,
  resetRuntimeAdminBundleCache,
  rewriteHostAbiImports,
} from '../../src/lib/frontend-runtime-bundle.ts';
import { annotateAdapterImportsSource } from '../../../../scripts/lib/annotate-adapter-imports.mjs';

/**
 * 插件 admin 产物的浏览器可装载变体（契约 02 §5）。
 *
 * 背景缺陷：`/plugins/frontends` 无条件拼接 `…/dist/admin.runtime.js`，但早于运行期
 * 装载的安装包只有 `dist/admin.js`，于是浏览器报
 * `Failed to fetch dynamically imported module: .../admin.runtime.js`。
 *
 * 修复策略：内核读取时**就地派生** runtime 变体（`admin.js` 的确定性函数），并把
 * 它登记进 manifest 白名单。派生不可行时 fail-closed，保持原状。
 *
 * 第二个缺陷在发布期脚本：`?names=` 曾写成**本地别名**（`useState4`）而非**原始导入
 * 名**（`useState`），产物虽存在却会在浏览器里 `does not provide an export named`。
 */

function tempRoot(): string {
  return path.join(os.tmpdir(), 'sp-runtime-bundle-test');
}

let dir: string;

beforeEach(async () => {
  resetRuntimeAdminBundleCache();
  dir = await mkdtemp(tempRoot() + '-');
});

afterEach(async () => {
  resetRuntimeAdminBundleCache();
  await rm(dir, { recursive: true, force: true });
});

async function writePackage(
  files: Record<string, string | string[]>,
  manifestExtra: Record<string, unknown> = {},
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, Array.isArray(content) ? content.join('\n') : content, 'utf8');
  }
  if (!('frontend/manifest.json' in files)) {
    await mkdir(path.join(dir, 'frontend'), { recursive: true });
    await writeFile(
      path.join(dir, 'frontend/manifest.json'),
      `${JSON.stringify(
        {
          version: '1.0.0',
          revision: '',
          entry: 'frontend/dist/index.js',
          adminEntry: 'frontend/dist/admin.js',
          files: ['frontend/dist/index.js', 'frontend/dist/admin.js'],
          ...manifestExtra,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

async function readManifest(): Promise<{ files: string[] } & Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, 'frontend/manifest.json'), 'utf8')) as {
    files: string[];
  } & Record<string, unknown>;
}

const ADMIN_SOURCE = [
  'import { jsx } from "react/jsx-runtime";',
  'import { useState as useState4, useEffect } from "react";',
  'import { useMemo as useMemo2 } from "react";',
  'import { Button } from "@stackpanel/ui";',
  'export function Admin() {',
  '  const [n] = useState4(0);',
  '  useEffect(() => {}, []);',
  '  useMemo2(() => n, []);',
  '  return jsx(Button, { children: n });',
  '}',
].join('\n');

describe('hostAbiSlotFor', () => {
  it('matches exact slots and the longest subpath prefix', () => {
    expect(hostAbiSlotFor('react')).toBe('react');
    expect(hostAbiSlotFor('react/jsx-runtime')).toBe('react/jsx-runtime');
    expect(hostAbiSlotFor('react-dom/client')).toBe('react-dom');
    expect(hostAbiSlotFor('lucide-react')).toBe('lucide-react');
  });

  it('returns null for non-host packages', () => {
    expect(hostAbiSlotFor('sonner')).toBeNull();
    expect(hostAbiSlotFor('zod')).toBeNull();
  });
});

describe('importedNames', () => {
  it('keeps original names and drops local aliases', () => {
    expect([...importedNames('import { useState as s4, useEffect }')]).toEqual([
      'useState',
      'useEffect',
    ]);
  });

  it('handles a span-multiple-lines clause and `default`', () => {
    const clause = 'import Default, {\n  a as a1,\n  b,\n}';
    expect([...importedNames(clause)]).toEqual(['a', 'b']);
  });
});

describe('rewriteHostAbiImports', () => {
  it('rewrites bare host specifiers to the adapter with original names', () => {
    const out = rewriteHostAbiImports(ADMIN_SOURCE);
    expect(out).not.toBeNull();
    expect(out).toContain('from "/api/frontend-abi/react?names=useEffect,useMemo,useState"');
    expect(out).toContain('from "/api/frontend-abi/react/jsx-runtime?names=jsx"');
    expect(out).toContain('from "/api/frontend-abi/@stackpanel/ui?names=Button"');
    // 别名本身保留（本地代码仍引用它们），只是不再进 `?names=`。
    expect(out).toContain('useState as useState4');
    expect(out).not.toContain('useState4,useEffect');
  });

  it('is a fixed point: running it on its own output changes nothing', () => {
    const once = rewriteHostAbiImports(ADMIN_SOURCE);
    expect(once).not.toBeNull();
    expect(rewriteHostAbiImports(once as string)).toBe(once);
  });

  it('leaves relative and URL specifiers alone', () => {
    const src = [
      'import "./sibling.js";',
      'import x from "https://cdn.example/x.js";',
      'import { y } from "@stackpanel/ui";',
    ].join('\n');
    const out = rewriteHostAbiImports(src);
    expect(out).toContain('"./sibling.js"');
    expect(out).toContain('"https://cdn.example/x.js"');
  });

  it('fails closed when a bare specifier is not a host ABI slot', () => {
    const src = 'import { toast } from "sonner";\nimport { Button } from "@stackpanel/ui";';
    expect(rewriteHostAbiImports(src)).toBeNull();
  });

  it('fails closed on an unmappable dynamic import', () => {
    expect(rewriteHostAbiImports('const m = await import("recharts");')).toBeNull();
    expect(rewriteHostAbiImports('const m = await import("react");')).not.toBeNull();
  });
});

describe('isRuntimeAdminBundleValid', () => {
  it('accepts the derived bundle', () => {
    expect(isRuntimeAdminBundleValid(rewriteHostAbiImports(ADMIN_SOURCE) as string)).toBe(true);
  });

  it('rejects a bundle with locally-aliased ?names= (old build script bug)', () => {
    // 旧 `annotateAdapterImports` 的产物：`?names=` 写成本地别名。
    const broken = [
      'import { useState as useState4, useEffect as useEffect2 } from "/api/frontend-abi/react?names=useState4,useEffect2";',
    ].join('\n');
    expect(isRuntimeAdminBundleValid(broken)).toBe(false);
  });

  it('accepts a superset of names (published bundles may over-declare)', () => {
    const extra = [
      'import { useState as s4 } from "/api/frontend-abi/react?names=useCallback,useState";',
    ].join('\n');
    expect(isRuntimeAdminBundleValid(extra)).toBe(true);
  });

  it('rejects leftover bare specifiers', () => {
    expect(isRuntimeAdminBundleValid('import { toast } from "sonner";')).toBe(false);
  });

  it('rejects adapter imports pointing at an unknown slot', () => {
    expect(
      isRuntimeAdminBundleValid('import { x } from "/api/frontend-abi/recharts?names=x";'),
    ).toBe(false);
  });
});

describe('ensureRuntimeAdminBundle', () => {
  it('derives the runtime bundle and registers it in manifest.files', async () => {
    await writePackage({ 'frontend/dist/admin.js': ADMIN_SOURCE });

    expect(await ensureRuntimeAdminBundle(dir)).toBe(true);

    const runtime = await readFile(path.join(dir, 'frontend/dist/admin.runtime.js'), 'utf8');
    expect(runtime).toBe(rewriteHostAbiImports(ADMIN_SOURCE));
    expect(isRuntimeAdminBundleValid(runtime)).toBe(true);
    expect((await readManifest()).files).toContain('frontend/dist/admin.runtime.js');
  });

  it('is idempotent (second call is a cache hit, no rewrite)', async () => {
    await writePackage({ 'frontend/dist/admin.js': ADMIN_SOURCE });
    await ensureRuntimeAdminBundle(dir);
    const first = await readFile(path.join(dir, 'frontend/dist/admin.runtime.js'), 'utf8');

    expect(await ensureRuntimeAdminBundle(dir)).toBe(false);
    expect(await readFile(path.join(dir, 'frontend/dist/admin.runtime.js'), 'utf8')).toBe(first);
    expect((await readManifest()).files.filter((f) => f.endsWith('admin.runtime.js'))).toHaveLength(
      1,
    );
  });

  it('rebuilds a bundle whose ?names= carry local aliases', async () => {
    await writePackage({
      'frontend/dist/admin.js': ADMIN_SOURCE,
      'frontend/dist/admin.runtime.js':
        'import { useState as s4 } from "/api/frontend-abi/react?names=s4";\n',
    });

    expect(await ensureRuntimeAdminBundle(dir)).toBe(true);
    const runtime = await readFile(path.join(dir, 'frontend/dist/admin.runtime.js'), 'utf8');
    expect(isRuntimeAdminBundleValid(runtime)).toBe(true);
    expect(runtime).toContain('?names=useEffect,useMemo,useState');
  });

  it('fails closed when the source has a non-host bare specifier', async () => {
    await writePackage({
      'frontend/dist/admin.js': 'import { toast } from "sonner";\n',
    });

    expect(await ensureRuntimeAdminBundle(dir)).toBe(false);
    await expect(
      readFile(path.join(dir, 'frontend/dist/admin.runtime.js'), 'utf8'),
    ).rejects.toThrow();
    expect((await readManifest()).files).not.toContain('frontend/dist/admin.runtime.js');
  });

  it('does nothing when the package has no admin.js', async () => {
    await writePackage({ 'frontend/dist/index.js': 'export const x = 1;\n' });
    expect(await ensureRuntimeAdminBundle(dir)).toBe(false);
    expect((await readManifest()).files).not.toContain('frontend/dist/admin.runtime.js');
  });

  it('does nothing when the manifest is missing or unreadable', async () => {
    await mkdir(path.join(dir, 'frontend/dist'), { recursive: true });
    await writeFile(path.join(dir, 'frontend/dist/admin.js'), ADMIN_SOURCE, 'utf8');
    expect(await ensureRuntimeAdminBundle(dir)).toBe(false);
  });

  it('keeps a valid published bundle byte-for-byte', async () => {
    const published = rewriteHostAbiImports(ADMIN_SOURCE) as string;
    await writePackage({
      'frontend/dist/admin.js': ADMIN_SOURCE,
      'frontend/dist/admin.runtime.js': published,
      'frontend/manifest.json': `${JSON.stringify(
        {
          version: '1.0.0',
          revision: '',
          entry: 'frontend/dist/index.js',
          adminEntry: 'frontend/dist/admin.js',
          files: [
            'frontend/dist/index.js',
            'frontend/dist/admin.js',
            'frontend/dist/admin.runtime.js',
          ],
        },
        null,
        2,
      )}\n`,
    });

    expect(await ensureRuntimeAdminBundle(dir)).toBe(false);
    expect(await readFile(path.join(dir, 'frontend/dist/admin.runtime.js'), 'utf8')).toBe(
      published,
    );
  });

  it('retries after a failed write instead of caching the failure', async () => {
    await writePackage({ 'frontend/dist/admin.js': ADMIN_SOURCE });
    const distDir = path.join(dir, 'frontend/dist');
    await chmod(distDir, 0o555);
    try {
      // 只读挂载/权限不足：写入失败但不应抛到调用方（`/plugins/frontends` 仍要能
      // 返回其余插件），也不能把这次失败记成“已检查过”。
      await expect(ensureRuntimeAdminBundle(dir)).resolves.toBe(false);
      await expect(readFile(path.join(distDir, 'admin.runtime.js'), 'utf8')).rejects.toThrow();
    } finally {
      await chmod(distDir, 0o755);
    }

    expect(await ensureRuntimeAdminBundle(dir)).toBe(true);
    expect(
      isRuntimeAdminBundleValid(await readFile(path.join(distDir, 'admin.runtime.js'), 'utf8')),
    ).toBe(true);
  });

  it('never leaves a staging file behind on success', async () => {
    await writePackage({ 'frontend/dist/admin.js': ADMIN_SOURCE });
    await ensureRuntimeAdminBundle(dir);
    const leftover = (await readdir(path.join(dir, 'frontend/dist'))).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftover).toEqual([]);
  });
});

describe('annotateAdapterImportsSource (publish-time)', () => {
  it('annotates with original names instead of local aliases', () => {
    const src =
      'import { useState as useState4, useEffect as useEffect2 } from "/api/frontend-abi/react";\n';
    const out = annotateAdapterImportsSource(src);
    expect(out).toContain('"/api/frontend-abi/react?names=useEffect,useState"');
    expect(out).not.toMatch(/names=[^"]*useState4/);
    // 内核校验器确认产物可装载——这正是旧脚本做不到的不变量。
    expect(isRuntimeAdminBundleValid(out)).toBe(true);
  });

  it('handles default imports and span-multiple-lines clauses', () => {
    const src = [
      'import Default, {',
      '  a as a1,',
      '  b,',
      '} from "/api/frontend-abi/@stackpanel/ui";',
    ].join('\n');
    expect(annotateAdapterImportsSource(src)).toContain(
      '"/api/frontend-abi/@stackpanel/ui?names=a,b"',
    );
  });

  it('unions names when the same slot is imported twice', () => {
    const src = [
      'import { useState } from "/api/frontend-abi/react";',
      'import { useMemo as m } from "/api/frontend-abi/react";',
    ].join('\n');
    const out = annotateAdapterImportsSource(src);
    expect(out.match(/\?names=useMemo,useState/g)).toHaveLength(2);
  });

  it('is idempotent', () => {
    const src = 'import { useState as s4 } from "/api/frontend-abi/react?names=s4";\n';
    const once = annotateAdapterImportsSource(src);
    expect(annotateAdapterImportsSource(once)).toBe(once);
  });
});
