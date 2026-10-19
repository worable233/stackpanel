/**
 * 入口判定回归测试。
 *
 * 缺陷背景：macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接，Node 把主模块解析为
 * realpath，而 `argv[1]` 保留调用路径；直接用 `import.meta.url === file://argv[1]`
 * 比较会失败，导致 `--drain` / `--rollback` **静默退出 0 却不执行任何动作**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from '../src/entrypoint.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stackpanel-entrypoint-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeFile(name: string, content = '// entry\n'): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, content);
  return file;
}

describe('isEntrypoint', () => {
  it('accepts the literal path', async () => {
    const file = await makeFile('main.mjs');
    expect(isEntrypoint(file, pathToFileURL(file).href)).toBe(true);
  });

  it('accepts a path that reaches the module through a symlink', async () => {
    const real = await makeFile('main.mjs');
    const link = path.join(root, 'link');
    await symlink(root, link, 'dir');
    // 调用方给出的路径经过软链；Node 内部拿到的是 realpath。
    const invoked = path.join(link, 'main.mjs');
    expect(invoked).not.toBe(real);
    expect(isEntrypoint(invoked, pathToFileURL(await realpath(real)).href)).toBe(true);
  });

  it('rejects a different file and missing argv[1]', async () => {
    const file = await makeFile('main.mjs');
    const other = await makeFile('other.mjs', '// other\n');
    expect(isEntrypoint(other, pathToFileURL(file).href)).toBe(false);
    expect(isEntrypoint(undefined, pathToFileURL(file).href)).toBe(false);
    expect(isEntrypoint('/does/not/exist.mjs', pathToFileURL(file).href)).toBe(false);
  });

  it('does not treat a directory or symlink loop as the entry', async () => {
    const file = await makeFile('main.mjs');
    const dir = path.join(root, 'dir');
    await mkdir(dir);
    const loop = path.join(root, 'loop');
    await symlink(loop, loop, 'dir');
    expect(isEntrypoint(dir, pathToFileURL(file).href)).toBe(false);
    expect(isEntrypoint(loop, pathToFileURL(file).href)).toBe(false);
  });
});
