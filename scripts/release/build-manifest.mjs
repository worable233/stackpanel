#!/usr/bin/env node
/**
 * 由已打包的扩展 ZIP 生成一份**已校验的包清单**（`PackageManifest`），
 * 供市场目录引用（PLAN-github-distribution-and-updates §3.2、§12）。
 *
 * 目录只引用不保存安装包：本脚本计算 ZIP 的 SHA-256 与大小并写入 `artifact`，
 * 其余（来源仓库/tag/asset、兼容范围、依赖、权限、前端模式、迁移、自动资格）由
 * 调用方以 JSON 描述文件提供，脚本只做契约校验，不臆造业务字段。
 *
 * 用法：
 *   node scripts/release/build-manifest.mjs \
 *     --zip dist-pack/llm-gateway-1.2.3.zip \
 *     --input market/llm-gateway.meta.json \
 *     --out market/llm-gateway-1.2.3.manifest.json
 *
 * `--input` 描述文件形状（除 artifact 外均为 PackageManifest 字段）：
 *   {
 *     "kind": "plugin", "id": "llm-gateway", "version": "1.2.3", "channel": "stable",
 *     "source": { "repository": "worable233/stackpanel-plugins", "tag": "plugin-llm-gateway-v1.2.3", "asset": "llm-gateway-1.2.3.zip" },
 *     "compatibility": { "kernel": ">=0.2.0 <0.3.0", "kernelApi": "^0.4.0", "frontendAbi": "^1.0.0", "packageFormat": 1 },
 *     "requires": [], "conflicts": [], "permissions": [], "frontendModes": ["M2"],
 *     "migration": { "mode": "none", "rollback": "code-compatible" },
 *     "automatic": { "eligible": true },
 *     "publisher": "stackpanel", "name": "LLM Gateway"
 *   }
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSpec, parseArgs, readPackageManifest, sha256 } from './lib/catalog.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const zipPath = args.zip;
  const inputPath = args.input;
  const outPath = args.out;
  if (!zipPath || !inputPath || !outPath) {
    console.error(
      'Usage: node scripts/release/build-manifest.mjs --zip <zip> --input <meta.json> --out <manifest.json>',
    );
    process.exit(1);
  }
  const spec = await loadSpec();
  const bytes = await readFile(zipPath);
  const meta = JSON.parse(await readFile(inputPath, 'utf8'));
  const manifest = {
    formatVersion: spec.PACKAGE_MANIFEST_FORMAT_VERSION,
    ...meta,
    artifact: { sha256: sha256(bytes), size: bytes.byteLength },
  };
  const issues = spec.validatePackageManifest(manifest);
  if (issues.length > 0) {
    throw new Error(`清单非法：${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }
  // 回读一次，确保落盘后仍可被契约解析。
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await readPackageManifest(outPath);
  console.log(`manifest -> ${outPath} (sha256 ${manifest.artifact.sha256.slice(0, 12)}…)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
