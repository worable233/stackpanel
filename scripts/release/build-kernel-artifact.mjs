#!/usr/bin/env node
/**
 * 构建内核自包含产物包（ADR-0025）。
 *
 * 产出**两个** tar.zst：
 *
 * - `<version>-kernel-<platform>.tar.zst`：运行包。解包即得到一个可直接
 *   `node apps/web/server.js` + `node apps/api/dist/server.js` 的目录树，
 *   不需要 `pnpm install`，也不携带 Prisma CLI。
 * - `<version>-migrate-<platform>.tar.zst`：迁移包。只在升级窗口内下载，含
 *   Prisma CLI、schema engine 与 `prisma/migrations`。
 *
 * 运行包目录布局（也是解包后的 `releases/<version>/`）：
 *
 *   RELEASE.json
 *   ecosystem.config.cjs
 *   apps/api/dist/**
 *   apps/web/{server.js,.next/**,public/**}
 *   node_modules/**              # 仅不可打包依赖闭包
 *
 * 前置条件：先构建 `@stackpanel/api` 与 `@stackpanel/web`（web 需
 * `output: 'standalone'`）。
 *
 * 用法：
 *   node scripts/release/build-kernel-artifact.mjs \
 *     --version 0.3.0 \
 *     --platform linux-x64 \
 *     --out dist-artifacts \
 *     [--kernel-api 0.4.0] [--frontend-abi 1.0.0] \
 *     [--database-migration 20261017090000_currency_governance] \
 *     [--skip-migrate]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTERNAL_PACKAGES, collectClosure, materializeClosure } from './collect-runtime-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 产物平台（tar 命名用）→ 契约平台（manifest 用）与 Node 的 os/arch。 */
const PLATFORMS = {
  'linux-x64': { contract: 'linux/amd64', os: 'linux', arch: 'x64' },
  'linux-arm64': { contract: 'linux/arm64', os: 'linux', arch: 'arm64' },
  'darwin-arm64': { contract: 'darwin/arm64', os: 'darwin', arch: 'arm64' },
  'darwin-x64': { contract: 'darwin/amd64', os: 'darwin', arch: 'x64' },
};

const DEFAULT_NODE_MAJOR = 22;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  });
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/** 最新的迁移目录名，用于 `databaseMigration` 字段。 */
function latestMigrationName() {
  const dir = path.join(REPO_ROOT, 'packages/db/prisma/migrations');
  if (!existsSync(dir)) return 'unknown';
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return names.at(-1) ?? 'unknown';
}

/**
 * 产物内 `ecosystem.config.cjs`。
 *
 * 与仓库根的同名文件不同：这里的路径全部相对于**产物根**，且数据目录与日志
 * 目录只从环境变量取绝对路径。版本目录会被整体替换，任何写入版本目录的运行期
 * 状态都会在升级时丢失，因此这里绝不回退到 `__dirname`。
 */
function ecosystemConfig({ version }) {
  return `/**
 * PM2 进程定义（由 scripts/release/build-kernel-artifact.mjs 生成）。
 * 内核版本：${version}
 *
 * 本文件位于版本目录内。数据与日志**必须**在版本目录之外，否则升级切换
 * 版本时会连同运行期状态一起丢弃。
 */
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = process.env.STACKPANEL_DATA_DIR;
const LOG_DIR = process.env.STACKPANEL_LOG_DIR || path.join(DATA_DIR || ROOT, '..', 'logs');
const NODE_ENV = 'production';

if (!DATA_DIR) {
  throw new Error('STACKPANEL_DATA_DIR 未设置：数据目录必须在版本目录之外');
}

module.exports = {
  apps: [
    {
      name: 'stackpanel-api',
      cwd: path.join(ROOT, 'apps/api'),
      script: path.join(ROOT, 'apps/api/dist/server.js'),
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV, STACKPANEL_DATA_DIR: DATA_DIR },
      out_file: path.join(LOG_DIR, 'api-out.log'),
      error_file: path.join(LOG_DIR, 'api-error.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'stackpanel-worker',
      cwd: path.join(ROOT, 'apps/api'),
      script: path.join(ROOT, 'apps/api/dist/worker.js'),
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV, STACKPANEL_DATA_DIR: DATA_DIR },
      out_file: path.join(LOG_DIR, 'worker-out.log'),
      error_file: path.join(LOG_DIR, 'worker-error.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'stackpanel-web',
      cwd: path.join(ROOT, 'apps/web'),
      script: path.join(ROOT, 'apps/web/server.js'),
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV,
        STACKPANEL_DATA_DIR: DATA_DIR,
        // 端口可被部署环境覆盖；不要在产物里写死，否则反向代理换端口就得改包。
        PORT: process.env.PORT || '3000',
        HOSTNAME: process.env.HOSTNAME_BIND || '0.0.0.0',
      },
      out_file: path.join(LOG_DIR, 'web-out.log'),
      error_file: path.join(LOG_DIR, 'web-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
`;
}

/** `RELEASE.json`：产物自描述，供 runner 校验与回滚判定。 */
function releaseJson(input) {
  return {
    formatVersion: 1,
    kind: 'kernel-artifact',
    role: input.role,
    version: input.version,
    platform: input.platform,
    nodeMajor: input.nodeMajor,
    kernelApi: input.kernelApi,
    frontendAbi: input.frontendAbi,
    updateProtocol: input.updateProtocol,
    databaseMigration: input.databaseMigration,
    builtAt: input.builtAt,
    gitCommit: input.gitCommit,
    entrypoints:
      input.role === 'kernel'
        ? {
            api: 'apps/api/dist/server.js',
            worker: 'apps/api/dist/worker.js',
            web: 'apps/web/server.js',
          }
        : { migrate: 'migrate.mjs' },
    ...(input.role === 'kernel' ? {} : { migrations: 'prisma/migrations' }),
  };
}

/** 用契约包校验 `RELEASE.json`，避免产物自描述与内核清单漂移。 */
async function validateReleaseJson(spec, release) {
  if (release.kind !== 'kernel-artifact') throw new Error('RELEASE.json kind 非法');
  if (release.role !== 'kernel' && release.role !== 'migrate') {
    throw new Error('RELEASE.json role 必须是 kernel 或 migrate');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/.test(release.version)) {
    throw new Error(`RELEASE.json version 非法：${release.version}`);
  }
  const issues = spec.validateKernelManifest({
    formatVersion: spec.PACKAGE_MANIFEST_FORMAT_VERSION,
    kind: 'kernel',
    version: release.version,
    channel: 'stable',
    kernelApi: release.kernelApi,
    frontendAbi: release.frontendAbi,
    updateProtocol: release.updateProtocol,
    upgradeFrom: '*',
    migrationPath: 'direct',
    schemaRange: '*',
    images: [],
    artifacts: [
      {
        role: release.role,
        platform: release.platform,
        url: 'https://example.invalid/placeholder.tar.zst',
        sha256: '0'.repeat(64),
        size: 1,
        nodeMajor: release.nodeMajor,
      },
    ],
    corePackages: [],
    supportedPlatforms: [release.platform],
    smokeProbeVersion: 1,
    databaseMigration: release.databaseMigration,
  });
  // 单角色清单会触发"每个平台必须同时有 kernel 与 migrate"以外的字段错误；
  // 这里只关心平台/角色/版本字段本身是否合法。
  const relevant = issues.filter(
    (issue) => !issue.message.includes('缺少') && !issue.path.startsWith('images'),
  );
  if (relevant.length > 0) {
    throw new Error(
      `RELEASE.json 与契约不符：${relevant.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
  }
}

/**
 * Copy `source` into `target` without overwriting anything that already exists.
 *
 * Next's standalone output already carries its own `node_modules` (next, react,
 * sharp). The runtime closure is merged on top of it, and the pre-existing
 * copies win — they are the ones Next's traced server bundle was built against.
 */
function mergeTree(source, target) {
  const copied = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (!existsSync(to)) {
      cpSync(from, to, { recursive: true, dereference: true, force: true });
      copied.push(to);
      continue;
    }
    if (entry.isDirectory() && statSync(to).isDirectory()) {
      copied.push(...mergeTree(from, to));
    }
  }
  return copied;
}

/** 把闭包树合并进 staging，已有条目（Next 自带）优先。 */
function mergeClosure(closure, staging) {
  const scratch = path.join(staging, '.rtdeps');
  rmSync(scratch, { recursive: true, force: true });
  const conflicts = materializeClosure(closure, scratch);
  if (conflicts.length > 0) {
    throw new Error(`依赖闭包布局冲突：\n  - ${conflicts.join('\n  - ')}`);
  }
  const copied = mergeTree(path.join(scratch, 'node_modules'), path.join(staging, 'node_modules'));
  rmSync(scratch, { recursive: true, force: true });
  return { copied: copied.length, packages: closure.packages.size };
}

/**
 * Fail the build if any symlink in the artifact is absolute or escapes the
 * artifact root. A tarball is unpacked into a different directory on the target
 * machine, so a link that only works on the build host is a packaging bug that
 * would otherwise surface as `ERR_MODULE_NOT_FOUND` at first start.
 */
function assertRelocatable(root, label) {
  const problems = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (path.isAbsolute(target)) {
          problems.push(`${path.relative(root, full)} -> ${target}（绝对路径）`);
          continue;
        }
        const resolved = path.resolve(path.dirname(full), target);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          problems.push(`${path.relative(root, full)} -> ${target}（逃出产物根）`);
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  if (problems.length > 0) {
    throw new Error(`${label} 含不可迁移的符号链接：\n  - ${problems.join('\n  - ')}`);
  }
}

/** 用 zstd 压缩一个目录，返回产物路径。 */
function packTarZst(sourceDir, outFile, { deterministic }) {
  ensureDir(path.dirname(outFile));
  rmSync(outFile, { force: true });
  const entries = readdirSync(sourceDir);
  const isGnuTar = run('tar', ['--version'], { quiet: true }).includes('GNU tar');
  const args = ['-c'];
  if (isGnuTar && deterministic) {
    args.push(
      '--sort=name',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mtime=@0',
      '--use-compress-program=zstd -19 -T0',
    );
  } else {
    args.push('--zstd');
  }
  args.push('-f', outFile, ...entries);
  run('tar', args, { cwd: sourceDir });
  return outFile;
}

function sha256File(file) {
  const hash = createHash('sha256');
  const data = readFileSync(file);
  hash.update(data);
  return hash.digest('hex');
}

async function buildKernel(spec, args, platformInfo) {
  const version = args.version;
  const installRoot = path.join(REPO_ROOT, 'apps/web/.next/standalone');
  if (!existsSync(path.join(installRoot, 'apps/web/server.js'))) {
    throw new Error(
      '找不到 apps/web/.next/standalone：请先以 output=standalone 构建 @stackpanel/web',
    );
  }
  if (!existsSync(path.join(REPO_ROOT, 'apps/api/dist/server.js'))) {
    throw new Error('找不到 apps/api/dist/server.js：请先构建 @stackpanel/api');
  }

  // staging 目录就是解包后的版本目录。
  const staging = path.join(args.out, `.staging-${version}-${args.platform}`);
  removeDir(staging);
  ensureDir(staging);

  // 1) 拷贝 Next standalone 树（含 next/react 与 web 自身的最小 node_modules）。
  //
  // `verbatimSymlinks: true` 是必须的。默认值为 false，Node 会把相对符号链接
  // 改写成**绝对路径**；产物一旦被解包到另一个目录（`releases/<version>/`），
  // 这些链接仍指向构建机，运行时直接 ERR_MODULE_NOT_FOUND。
  cpSync(installRoot, staging, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  // 2) Next 不会把 `.next/static` 与 `public/` 放进 standalone，必须显式补。
  const webDir = path.join(staging, 'apps/web');
  cpSync(path.join(REPO_ROOT, 'apps/web/.next/static'), path.join(webDir, '.next/static'), {
    recursive: true,
  });
  const publicDir = path.join(REPO_ROOT, 'apps/web/public');
  if (existsSync(publicDir)) {
    cpSync(publicDir, path.join(webDir, 'public'), { recursive: true });
  }

  // 3) API 产物。
  cpSync(path.join(REPO_ROOT, 'apps/api/dist'), path.join(staging, 'apps/api/dist'), {
    recursive: true,
  });

  // 4) 不可打包依赖闭包，合并进 standalone 的 node_modules。
  const missing = [];
  const closure = collectClosure(
    // Single source of truth, shared with apps/api/tsup.config.ts.
    [...EXTERNAL_PACKAGES, '@prisma/adapter-pg'],
    [path.join(REPO_ROOT, 'apps/api'), path.join(REPO_ROOT, 'packages/db'), REPO_ROOT],
    (name, from) => {
      if (name.startsWith('@types/') || /^@img\/sharp-/.test(name)) return;
      missing.push(`${name} (${from})`);
    },
    args.platform,
  );
  if (missing.length > 0) {
    throw new Error(`无法解析运行期依赖：\n  - ${missing.join('\n  - ')}`);
  }
  const dependencyStats = mergeClosure(closure, staging);

  // 5) 自描述与进程定义。
  const builtAt = new Date().toISOString();
  let gitCommit = 'unknown';
  try {
    gitCommit = run('git', ['rev-parse', '--short=12', 'HEAD'], { quiet: true }).trim();
  } catch {
    /* 非 git 环境（例如从 tarball 构建）不阻塞打包。 */
  }

  const release = releaseJson({
    role: 'kernel',
    version,
    platform: platformInfo.contract,
    nodeMajor: Number(args['node-major'] ?? DEFAULT_NODE_MAJOR),
    kernelApi: args['kernel-api'] ?? '0.4.0',
    frontendAbi: args['frontend-abi'] ?? '1.0.0',
    updateProtocol: Number(args['update-protocol'] ?? 1),
    databaseMigration: args['database-migration'] ?? latestMigrationName(),
    builtAt,
    gitCommit,
  });
  await validateReleaseJson(spec, release);
  writeFileSync(path.join(staging, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(path.join(staging, 'ecosystem.config.cjs'), ecosystemConfig({ version }));

  // 安装根为 `/opt/stackpanel`：`current` 指向 releases/<version>，产物内进程定义
  // 用到的相对路径都基于此。runner 与 systemd 单元的安装说明随包提供。
  cpSync(path.join(REPO_ROOT, 'deploy'), path.join(staging, 'deploy'), { recursive: true });

  assertRelocatable(staging, 'kernel 产物');

  const outFile = path.join(args.out, `stackpanel-${version}-kernel-${args.platform}.tar.zst`);
  packTarZst(staging, outFile, { deterministic: args.deterministic !== false });
  const size = dirSizeBytes(staging);

  return {
    role: 'kernel',
    platform: platformInfo.contract,
    file: outFile,
    sha256: sha256File(outFile),
    size: statSync(outFile).size,
    uncompressedSize: size,
    dependencies: dependencyStats,
  };
}

async function buildMigrate(spec, args, platformInfo) {
  const version = args.version;
  const staging = path.join(args.out, `.staging-migrate-${version}-${args.platform}`);
  removeDir(staging);
  ensureDir(staging);

  // 1) Prisma schema 与迁移历史。
  cpSync(path.join(REPO_ROOT, 'packages/db/prisma'), path.join(staging, 'prisma'), {
    recursive: true,
  });

  // 2) Prisma CLI 与它的依赖闭包。
  const missing = [];
  const closure = collectClosure(
    ['prisma'],
    [path.join(REPO_ROOT, 'packages/db'), REPO_ROOT],
    (name, from) => {
      if (name.startsWith('@types/') || /^@img\/sharp-/.test(name)) return;
      missing.push(`${name} (${from})`);
    },
    args.platform,
  );
  if (missing.length > 0) {
    throw new Error(`无法解析迁移包依赖：\n  - ${missing.join('\n  - ')}`);
  }
  const layoutConflicts = materializeClosure(closure, staging);
  if (layoutConflicts.length > 0) {
    throw new Error(`迁移包依赖布局冲突：\n  - ${layoutConflicts.join('\n  - ')}`);
  }

  // 3) 最小 prisma 配置：不回引 workspace 包，直接从环境变量取 DSN。
  writeFileSync(
    path.join(staging, 'prisma.config.mjs'),
    `import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
`,
  );

  // 4) 迁移入口。runner 只调用它，不感知 Prisma 的调用细节。
  writeFileSync(
    path.join(staging, 'migrate.mjs'),
    `#!/usr/bin/env node
/**
 * 执行 Prisma 迁移（由 scripts/release/build-kernel-artifact.mjs 生成）。
 * 失败时以非零退出码结束，由 runner 决定回滚。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(
  process.execPath,
  [cli, 'migrate', 'deploy', '--config', path.join(here, 'prisma.config.mjs')],
  { cwd: here, stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
`,
  );

  const builtAt = new Date().toISOString();
  let gitCommit = 'unknown';
  try {
    gitCommit = run('git', ['rev-parse', '--short=12', 'HEAD'], { quiet: true }).trim();
  } catch {
    /* ignore */
  }

  const release = releaseJson({
    role: 'migrate',
    version,
    platform: platformInfo.contract,
    nodeMajor: Number(args['node-major'] ?? DEFAULT_NODE_MAJOR),
    kernelApi: args['kernel-api'] ?? '0.4.0',
    frontendAbi: args['frontend-abi'] ?? '1.0.0',
    updateProtocol: Number(args['update-protocol'] ?? 1),
    databaseMigration: args['database-migration'] ?? latestMigrationName(),
    builtAt,
    gitCommit,
  });
  await validateReleaseJson(spec, release);
  writeFileSync(path.join(staging, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);

  assertRelocatable(staging, 'migrate 产物');

  const outFile = path.join(args.out, `stackpanel-${version}-migrate-${args.platform}.tar.zst`);
  packTarZst(staging, outFile, { deterministic: args.deterministic !== false });

  return {
    role: 'migrate',
    platform: platformInfo.contract,
    file: outFile,
    sha256: sha256File(outFile),
    size: statSync(outFile).size,
    uncompressedSize: dirSizeBytes(staging),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.platform) {
    console.error(
      'Usage: node scripts/release/build-kernel-artifact.mjs --version <X.Y.Z> --platform <linux-x64|linux-arm64> [--out <dir>] [--skip-migrate]',
    );
    process.exit(1);
  }
  const platformInfo = PLATFORMS[args.platform];
  if (!platformInfo) {
    console.error(`不支持的平台：${args.platform}（可选：${Object.keys(PLATFORMS).join(', ')}）`);
    process.exit(1);
  }
  args.out = path.resolve(args.out ?? path.join(REPO_ROOT, 'dist-artifacts'));
  ensureDir(args.out);

  const spec = await import(new URL('../../packages/spec/dist/index.js', import.meta.url).href);

  const results = [await buildKernel(spec, args, platformInfo)];
  if (!args['skip-migrate']) {
    results.push(await buildMigrate(spec, args, platformInfo));
  }

  // staging 目录不留在产物目录里，避免被误发布。
  for (const name of readdirSync(args.out)) {
    if (name.startsWith('.staging-')) removeDir(path.join(args.out, name));
  }

  const summary = {
    version: args.version,
    platform: platformInfo.contract,
    nodeMajor: Number(args['node-major'] ?? DEFAULT_NODE_MAJOR),
    artifacts: results.map((item) => ({
      role: item.role,
      platform: item.platform,
      file: path.basename(item.file),
      sha256: item.sha256,
      size: item.size,
      uncompressedSize: item.uncompressedSize,
    })),
  };
  writeFileSync(
    path.join(args.out, `stackpanel-${args.version}-${args.platform}.artifacts.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log('\n=== 产物 ===');
  for (const item of summary.artifacts) {
    const mb = (item.size / 1024 / 1024).toFixed(1);
    const raw = (item.uncompressedSize / 1024 / 1024).toFixed(1);
    console.log(`  ${item.file}  ${mb}MB（解包 ${raw}MB）`);
    console.log(`    sha256 ${item.sha256}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
