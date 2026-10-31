#!/usr/bin/env node
/**
 * 发版预检：在打标签之前，把「版本号是否自洽」一次问清楚。
 *
 * 发版失败最费时的不是构建，而是打完标签、CI 跑到第 10 分钟才因为在某处漏改版本号
 * 而失败——此时标签已经推出去，只能删标签重来。这个脚本把那些检查提前到本地秒级完成：
 *
 *   1. 工作区干净（版本号改动必须先提交，标签必须指向一个真实提交）。
 *   2. `KERNEL_VERSION`、root / `apps/{api,web,updater}` / `packages/{db,ui,net-guard}`
 *      的 `package.json` version 与要发的版本完全一致。
 *   3. `KERNEL_VERSION` 只有一处定义（别处抄一份就会漂移）。
 *   4. `CHANGELOG.md` 有对应版本段落且非空（`[Unreleased]` 不算）。
 *   5. 标签在本地与远端都不存在（发版不可覆盖，重发必须先删标签）。
 *
 * 用法：
 *   node scripts/release/preflight.mjs --version 0.1.0 [--allow-dirty]
 *
 * 退出码：0 全通过；1 有阻塞项（逐条列出，不会只报第一个）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 与 `KERNEL_VERSION` 必须一致的包：产品版本的所有者。 */
const LOCKSTEP_PACKAGES = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/updater/package.json',
  'packages/db/package.json',
  'packages/ui/package.json',
  'packages/net-guard/package.json',
];

const problems = [];
const passes = [];

const pass = (message) => {
  passes.push(message);
  console.log(`  ✓ ${message}`);
};
const fail = (message) => {
  problems.push(message);
  console.error(`  ✗ ${message}`);
};

function parseArgs(argv) {
  const args = { version: '', allowDirty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') args.version = argv[++i] ?? '';
    else if (arg.startsWith('--version=')) args.version = arg.slice('--version='.length);
    else if (arg === '--allow-dirty') args.allowDirty = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/release/preflight.mjs --version <X.Y.Z> [--allow-dirty]');
      process.exit(0);
    } else {
      fail(`未知参数：${arg}`);
    }
  }
  return args;
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
}

/** 从契约包源码里读 `KERNEL_VERSION`（发布前不一定有 `dist/`）。 */
function readKernelVersion() {
  const source = readFileSync(path.join(REPO_ROOT, 'packages/spec/src/version.ts'), 'utf8');
  const match = /export const KERNEL_VERSION = '([^']+)'/.exec(source);
  return match?.[1] ?? '';
}

/** 列出除契约包外还自己声明了一份内核版本的文件。 */
function findDuplicatedKernelVersion() {
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['grep', '-n', '-E', "KERNEL_VERSION\\s*=\\s*'[0-9]+\\.[0-9]+\\.[0-9]+'", '--', '.'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch {
    // `git grep` 无匹配时退出码为 1，不是错误。
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.startsWith('packages/spec/src/version.ts:'))
    .filter((line) => !line.includes('/dist/'))
    .filter((line) => !line.includes('.test.'));
}

function checkChangelog(version) {
  const changelog = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const lines = changelog.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (index === -1) {
    fail(`CHANGELOG.md 缺少 \`## [${version}]\` 段落（把 [Unreleased] 的内容收口到本版）`);
    return;
  }
  const nextHeading = lines.findIndex(
    (line, i) => i > index && (line.startsWith('## [') || line.startsWith('---')),
  );
  const body = lines.slice(index + 1, nextHeading === -1 ? undefined : nextHeading).join('').trim();
  if (body.length === 0) {
    fail(`CHANGELOG.md 的 \`## [${version}]\` 段落是空的`);
    return;
  }
  pass(`CHANGELOG.md 有 \`## [${version}]\` 段落且非空`);
}

function checkTagFree(tag) {
  let local = '';
  try {
    local = git('tag', '--list', tag);
  } catch {
    local = '';
  }
  if (local) {
    fail(`本地已存在标签 ${tag}；重发请先 \`git tag -d ${tag}\``);
    return;
  }
  try {
    const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', tag], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // 远端不可达时别让预检卡住：标签冲突这件事 CI 还会再拦一次。
      timeout: 10_000,
    }).trim();
    if (remote) {
      fail(`远端已存在标签 ${tag}；发版不可覆盖，重发需先删除远端标签`);
      return;
    }
  } catch {
    // 没有远端（或离线）不算阻塞：CI 侧会再拦一次。
    console.log('  · 跳过远端标签检查（无 origin 或远端不可达）');
  }
  pass(`标签 ${tag} 在本地与远端都不存在`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  console.log(`发版预检：${version || '(未指定 --version)'}\n`);

  // 目标版本必须显式给出：从 package.json 反推会让"漏改一处"也通过预检。
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail('必须用 --version 指定语义化版本，例如 --version 0.1.0');
  } else {
    pass(`目标版本格式合法：${version}`);
  }

  if (!args.allowDirty) {
    const dirty = git('status', '--porcelain');
    if (dirty) {
      fail(`工作区不干净，先提交再发版：\n${dirty.split('\n').map((l) => `      ${l}`).join('\n')}`);
    } else {
      pass('工作区干净');
    }
  }

  const kernelVersion = readKernelVersion();
  if (!kernelVersion) {
    fail('读不到 packages/spec/src/version.ts 的 KERNEL_VERSION');
  } else if (version && kernelVersion !== version) {
    fail(`KERNEL_VERSION 是 ${kernelVersion}，与目标版本 ${version} 不一致`);
  } else {
    pass(`KERNEL_VERSION = ${kernelVersion}`);
  }

  for (const pkgPath of LOCKSTEP_PACKAGES) {
    const { version: pkgVersion } = readJson(pkgPath);
    if (pkgVersion !== kernelVersion) {
      fail(`${pkgPath} 的 version 是 ${pkgVersion}，应为 ${kernelVersion}`);
    }
  }
  if (problems.length === 0) pass(`${LOCKSTEP_PACKAGES.length} 个产品版本包与 KERNEL_VERSION 一致`);

  const duplicates = findDuplicatedKernelVersion();
  if (duplicates.length > 0) {
    fail(`KERNEL_VERSION 出现了第二份副本（会与本值漂移）：\n${duplicates.map((l) => `      ${l}`).join('\n')}`);
  } else {
    pass('KERNEL_VERSION 只有一处定义');
  }

  if (version) {
    checkChangelog(version);
    checkTagFree(`v${version}`);
  }

  console.log('');
  if (problems.length > 0) {
    console.error(`预检未通过：${problems.length} 个阻塞项`);
    process.exit(1);
  }
  console.log(`预检通过（${passes.length} 项）。下一步：`);
  console.log(`  git commit -m "chore(release): v${version}"`);
  console.log(`  git tag -a v${version} -m "v${version}"`);
  console.log('  git push origin main && git push origin v' + version);
  console.log('  发布由 .github/workflows/release.yml 在标签推送后自动完成（镜像 + 产物 + Release）');
}

main();
