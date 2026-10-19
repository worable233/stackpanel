#!/usr/bin/env node
/**
 * 打包产物载体的升级执行者（ADR-0025 决策 4）。
 *
 * runner 位于 `/opt/stackpanel/bin/`，**不在** `releases/<version>` 内，因此内核升级
 * 不会替换它；它自己的更新是独立的运维动作。这里只把已构建的单文件 ESM 与一个
 * POSIX 包装脚本放进发布目录，并输出摘要供发布端登记。
 *
 * 前置：`pnpm --filter @stackpanel/updater build`（产出 `dist/artifact/main.js`）。
 *
 * 用法：
 *   node scripts/release/build-upgrade-runner.mjs --out dist-artifacts
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
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

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, 'dist-artifacts'));
  const entry = path.join(REPO_ROOT, 'apps/updater/dist/artifact/main.js');
  let source;
  try {
    source = readFileSync(entry);
  } catch {
    throw new Error(`找不到 ${entry}：请先运行 pnpm --filter @stackpanel/updater build`);
  }
  mkdirSync(outDir, { recursive: true });

  const bundle = path.join(outDir, 'stackpanel-upgrade.mjs');
  writeFileSync(bundle, source);

  // 包装脚本固定用生产 Node 启动，并显式转发退出码；不在这里拼任何参数。
  const wrapper = path.join(outDir, 'stackpanel-upgrade');
  writeFileSync(
    wrapper,
    `#!/bin/sh
# StackPanel 产物载体升级执行者（由 scripts/release/build-upgrade-runner.mjs 生成）。
# 位置：/opt/stackpanel/bin/stackpanel-upgrade；不随内核版本目录替换。
exec \${STACKPANEL_NODE:-node} "$(dirname "$0")/stackpanel-upgrade.mjs" "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  const summary = {
    files: [
      { file: path.basename(bundle), sha256: sha256(bundle), size: readFileSync(bundle).length },
      { file: path.basename(wrapper), sha256: sha256(wrapper), size: readFileSync(wrapper).length },
    ],
  };
  writeFileSync(
    path.join(outDir, 'stackpanel-upgrade.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  for (const item of summary.files) {
    console.log(`  ${item.file}  ${(item.size / 1024).toFixed(1)}KB`);
    console.log(`    sha256 ${item.sha256}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
