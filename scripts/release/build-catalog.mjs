#!/usr/bin/env node
/**
 * 构建并签名一份市场目录快照（PLAN-github-distribution-and-updates §2、§3.3、§12）。
 *
 * 输入：一组已校验的包清单 JSON（`--entries <dir>`）与发布者/渠道配置
 * （`--config <catalog.config.json>`）。输出：`catalog.json` + `catalog.sig`
 * （逐字规范化字节）与渠道指针 `channels.json`。
 *
 * 生产用法：私钥经受保护环境注入（`--key-file`），目录以
 * `catalog-v1/<sequence>` 唯一 Release tag 发布；**不得覆盖同一 sequence**。
 *
 * 本地演练：`--key-file` 用临时生成的测试私钥，产物落到 `--out` 指定目录。
 *
 * 配置形状 `catalog.config.json`：
 *   {
 *     "sequence": 7,
 *     "channels": ["stable", "beta"],
 *     "ttlDays": 14,
 *     "keyId": "catalog-2026",
 *     "publishers": [
 *       { "publisher": "stackpanel", "keyIds": ["pkg-stackpanel"], "repositories": ["worable233/stackpanel-plugins"] }
 *     ]
 *   }
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildCatalog,
  loadSpec,
  parseArgs,
  readPackageManifest,
  signCatalogBytes,
  writeCatalog,
  writeChannelPointers,
} from './lib/catalog.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entriesDir = args.entries;
  const configPath = args.config;
  const keyFile = args['key-file'];
  const outDir = args.out ?? '.';
  const keyIdOverride = args['key-id'];
  if (!entriesDir || !configPath || !keyFile) {
    console.error(
      'Usage: node scripts/release/build-catalog.mjs --entries <dir> --config <config.json> --key-file <ed25519.pem> --out <dir> [--key-id <id>]',
    );
    process.exit(1);
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const keyId = keyIdOverride ?? config.keyId;
  if (!keyId) throw new Error('缺少目录签名 keyId（--key-id 或 config.keyId）');
  const privateKeyPem = await readFile(keyFile, 'utf8');

  const files = (await readdir(entriesDir)).filter((name) => name.endsWith('.json')).sort();
  const entries = [];
  for (const name of files) {
    const manifest = await readPackageManifest(path.join(entriesDir, name));
    if (manifest.channel === 'beta' && !(config.channels ?? []).includes('beta')) continue;
    entries.push(manifest);
  }

  const { catalogBytes, catalogJson, catalog } = await buildCatalog({
    sequence: config.sequence,
    channels: config.channels,
    ttlDays: config.ttlDays,
    publishers: config.publishers ?? [],
    entries,
  });
  const { catalogSigJson } = await signCatalogBytes(catalogBytes, privateKeyPem, keyId);

  // 目录 CI 自检：签名 + 结构 + 回放保护（序列号与已发布最高值比对由调用方完成）。
  const spec = await loadSpec();
  const keyringConfig = args.keyring ? JSON.parse(await readFile(args.keyring, 'utf8')) : null;
  if (keyringConfig) {
    spec.verifyCatalogSignatureBytes({
      catalogBytes,
      signature: JSON.parse(catalogSigJson),
      keyring: keyringConfig,
      repository: config.repository ?? keyringConfig.repository ?? '',
    });
  }

  const written = await writeCatalog(outDir, { catalogJson, catalogSigJson });
  await writeFile(
    path.join(outDir, 'catalog.meta.json'),
    `${JSON.stringify({ sequence: catalog.sequence, channels: catalog.channels }, null, 2)}\n`,
  );
  const pointers = config.channels.map((channel) => ({ channel, sequence: catalog.sequence }));
  await writeChannelPointers(outDir, pointers);
  console.log(
    `catalog-v1/${catalog.sequence}: ${written.catalogJson}, ${written.catalogSig} (+ channels.json)`,
  );
  console.log(`entries: ${entries.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
