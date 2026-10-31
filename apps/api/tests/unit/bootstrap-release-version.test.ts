import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveTargetVersion } from '../../src/bootstrap/release-version.ts';

/**
 * 产物布局回归：`RELEASE.json` 在 `releases/<version>/`，入口在
 * `releases/<version>/apps/api/dist/server.js`——距 RELEASE.json 三层。
 *
 * 少认一层会让 targetVersion 恒为 `unknown`，自举时 runner 直接失败并报
 * 「任务未记录目标版本，无法定位迁移产物」，而安装器看起来完全成功。
 */
describe('resolveTargetVersion', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRelease(version: string, entryRel: string): string {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-release-'));
    created.push(root);
    writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ version }), 'utf8');
    const entryDir = path.join(root, path.dirname(entryRel));
    mkdirSync(entryDir, { recursive: true });
    const entry = path.join(root, entryRel);
    writeFileSync(entry, '// entry\n', 'utf8');
    return entry;
  }

  it('产物布局（apps/api/dist/server.js）读到版本', () => {
    const entry = makeRelease('0.2.0', 'apps/api/dist/server.js');
    expect(resolveTargetVersion(entry)).toBe('0.2.0');
  });

  it('接受 file:// URL 形式的入口', () => {
    const entry = makeRelease('1.4.2', 'apps/api/dist/server.js');
    expect(resolveTargetVersion(new URL(`file://${entry}`))).toBe('1.4.2');
  });

  it('单层布局（dist/server.js）也读到版本', () => {
    const entry = makeRelease('9.9.9', 'dist/server.js');
    expect(resolveTargetVersion(entry)).toBe('9.9.9');
  });

  it('找不到 RELEASE.json 时返回 unknown，而不是猜一个版本', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-release-none-'));
    created.push(root);
    const entryDir = path.join(root, 'apps/api/dist');
    mkdirSync(entryDir, { recursive: true });
    const entry = path.join(entryDir, 'server.js');
    writeFileSync(entry, '// entry\n', 'utf8');
    expect(resolveTargetVersion(entry)).toBe('unknown');
  });

  it('RELEASE.json 缺少 version 时返回 unknown', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-release-bad-'));
    created.push(root);
    writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ role: 'kernel' }), 'utf8');
    const entryDir = path.join(root, 'apps/api/dist');
    mkdirSync(entryDir, { recursive: true });
    const entry = path.join(entryDir, 'server.js');
    writeFileSync(entry, '// entry\n', 'utf8');
    expect(resolveTargetVersion(entry)).toBe('unknown');
  });
});
