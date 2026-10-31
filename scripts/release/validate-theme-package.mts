/**
 * 用**内核自己的校验器**验一遍待发布的主题包目录。
 *
 * 打包脚本是普通 Node，内核逻辑是 TS；与其在打包器里重写一遍规则（迟早漂移），
 * 不如直接调 `assembleThemeFiles`——它就是远程安装时真正跑的那段代码
 * （`prepareCatalogInstall` → `assembleThemeFiles`）。校验不过就退出码 1，
 * 让打包在产生任何可发布字节之前中止。
 *
 * 用法：apps/api/node_modules/.bin/tsx scripts/release/validate-theme-package.mts <dir>
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assembleThemeFiles } from '../../apps/api/src/lib/themes.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：tsx scripts/release/validate-theme-package.mts <解包目录>');
  process.exit(2);
}

function collect(root: string, prefix: string, into: Record<string, Uint8Array>): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collect(absolute, `${prefix}${entry.name}/`, into);
      continue;
    }
    into[`${prefix}${entry.name}`] = new Uint8Array(readFileSync(absolute));
  }
}

const entries: Record<string, Uint8Array> = {};
collect(path.resolve(dir), '', entries);

try {
  const { manifest, files } = assembleThemeFiles(entries);
  console.log(
    `内核校验通过：${manifest.id}@${manifest.version}（${manifest.name}），落盘文件 ${files.size} 个`,
  );
} catch (error) {
  console.error(`内核校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
