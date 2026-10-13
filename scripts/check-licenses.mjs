#!/usr/bin/env node
// License gate for the whole workspace. Backs `pnpm license:check` and the CI
// step of the same name.
//
// Two passes, because neither tool covers the whole surface on its own:
//
//   1. `pnpm licenses list` walks the installed tree, optional dependencies
//      included. That is what makes platform-native packages such as the
//      LGPL sharp-libvips binary visible at all; `license-checker` never
//      descends into `optionalDependencies`.
//   2. A `pnpm-lock.yaml` scan covers the platform variants that are not
//      installed on the current machine, so the result does not depend on
//      whether the gate runs on Linux CI or a developer's Mac.
//
// A copyleft-family license is not a failure by itself, but it must be
// documented in DOCUMENTED_EXCEPTIONS below and described in
// THIRD-PARTY-NOTICES.md. Adding such a dependency therefore requires editing
// both, which is the point.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const COPYLEFT = [
  'GPL-1.0',
  'GPL-1.0-or-later',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-1.0',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'MPL-1.0',
  'MPL-1.1',
  'MPL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'CDDL-1.0',
  'CDDL-1.1',
];

// Every entry here must also appear in THIRD-PARTY-NOTICES.md.
const DOCUMENTED_EXCEPTIONS = [
  {
    license: 'LGPL-3.0-or-later',
    pattern: /^@img\/sharp-libvips-/,
    reason: 'sharp 的 libvips 原生库，运行时动态加载、可单独替换',
  },
  {
    license: 'LGPL-2.1-only',
    pattern: /^mariadb$/,
    reason: '官方 Prisma MySQL 适配器（当前依赖树中未安装）',
  },
  {
    license: 'MPL-2.0',
    pattern: /^(lightningcss(-[a-z0-9]+)*|axe-core)$/,
    reason: 'Tailwind 构建链与无障碍检查，未修改上游源码',
  },
  {
    license: 'EPL-2.0',
    pattern: /^elkjs$/,
    reason: 'Prisma CLI 的图形布局库，未修改上游源码',
  },
  {
    license: 'AGPL-3.0',
    pattern: /^pm2$/,
    reason: '以独立进程运行的进程管理器，未修改、未链接进应用代码',
  },
  {
    license: 'CC-BY-3.0',
    pattern: /^(spdx-exceptions|spdx-ranges)$/,
    reason: 'SPDX 许可证元数据，署名链见 THIRD-PARTY-NOTICES.md',
  },
  {
    license: 'CC-BY-4.0',
    pattern: /^caniuse-lite$/,
    reason: '浏览器特性数据，署名 caniuse.com',
  },
  {
    license: 'ODC-By-1.0',
    pattern: /^language-subtag-registry$/,
    reason: 'IANA 语言子标签数据，署名见 THIRD-PARTY-NOTICES.md',
  },
];

// Native packages resolved at install time: the installed tree holds only the
// variant for the current OS/arch, but every variant is pinned in the lockfile
// and ships in the container image. Keep this list in sync with
// THIRD-PARTY-NOTICES.md.
const PLATFORM_VARIANT_FAMILIES = [/^@img\/sharp-libvips-/];

function tokens(expression) {
  return String(expression)
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|and|or|WITH|with)\s+|\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

// `(MIT OR GPL-3.0)` is usable under MIT, so only flag an OR expression when
// every alternative is copyleft.
function copyleftTokens(expression) {
  const alternatives = String(expression).split(/\s+(?:OR|or)\s+/);
  const flagged = new Set();
  for (const alternative of alternatives) {
    const hits = tokens(alternative).filter((token) => COPYLEFT.includes(token));
    if (hits.length === 0) return [];
    for (const hit of hits) flagged.add(hit);
  }
  return [...flagged];
}

const documented = (name, license) =>
  DOCUMENTED_EXCEPTIONS.find((entry) => entry.license === license && entry.pattern.test(name));

const failures = [];
const report = [];

function register(name, version, license) {
  for (const token of copyleftTokens(license)) {
    const entry = documented(name, token);
    if (!entry) {
      failures.push(
        `${name}@${version} — ${token} 没有对应备案，请先确认合规并更新 THIRD-PARTY-NOTICES.md`,
      );
      continue;
    }
    report.push(`  ${name}@${version} — ${token} — ${entry.reason}`);
  }
}

// --- pass 1: the installed tree ------------------------------------------
let buckets;
try {
  buckets = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
} catch (error) {
  console.error('无法执行 `pnpm licenses list --json`，请先安装依赖。');
  console.error(error.message);
  process.exit(1);
}

let installed = 0;
for (const [license, packages] of Object.entries(buckets)) {
  for (const pkg of packages) {
    const versions = pkg.versions?.length ? pkg.versions : [''];
    for (const version of versions) {
      installed += 1;
      register(pkg.name, version, license);
    }
  }
}

// --- pass 2: platform variants pinned in the lockfile ---------------------
const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');
const pinned = new Map();
for (const line of lockfile.split('\n')) {
  const match = /^ {2}'?((?:@[^/'@\s]+\/)?[^'@\s:]+)@([0-9][^'\s:]*?)'?:\s*$/.exec(line);
  if (!match) continue;
  const [, name, version] = match;
  if (!PLATFORM_VARIANT_FAMILIES.some((pattern) => pattern.test(name))) continue;
  if (!pinned.has(name)) pinned.set(name, new Set());
  pinned.get(name).add(version);
}

let variants = 0;
for (const [name, versions] of [...pinned].sort()) {
  for (const version of [...versions].sort()) {
    variants += 1;
    if (!DOCUMENTED_EXCEPTIONS.some((entry) => entry.pattern.test(name))) {
      failures.push(`${name}@${version} — 平台原生包没有对应备案，请更新 THIRD-PARTY-NOTICES.md`);
    }
  }
}

console.log(`扫描 ${installed} 个已安装包，${pinned.size} 个平台原生包（${variants} 个版本）。`);
if (report.length > 0) {
  console.log('\n已备案的非宽松许可证：');
  console.log([...new Set(report)].sort().join('\n'));
}

if (failures.length > 0) {
  console.error('\n许可证检查未通过：');
  console.error(failures.map((line) => `  - ${line}`).join('\n'));
  process.exit(1);
}

console.log('\n许可证检查通过。');
