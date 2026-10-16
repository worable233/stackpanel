#!/usr/bin/env node
/**
 * 生成 Ed25519 发布密钥对（PLAN-github-distribution-and-updates §3.3）。
 *
 * - 公钥写入实例信任根（`keyring`）或随内核分发；私钥只在受保护的发布环境。
 * - 生产发布**不**用本脚本生成临时密钥；本脚本用于初始化密钥轮换流程与本地演练。
 *
 * 用法：
 *   node scripts/release/generate-key.mjs --purpose catalog --key-id catalog-2026 --repo worable233/stackpanel-market --out-dir keys
 *   node scripts/release/generate-key.mjs --purpose package --key-id pkg-stackpanel --publisher stackpanel --repo worable233/stackpanel-plugins --out-dir keys
 *
 * 产物：`<out-dir>/<key-id>.private.pem`、`<out-dir>/<key-id>.public.pem`，以及追加
 * 到 `<out-dir>/keyring.json` 的信任根条目（已存在则合并，同一 keyId 拒绝覆盖）。
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from './lib/catalog.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const purpose = args.purpose;
  const keyId = args['key-id'];
  const outDir = args['out-dir'] ?? 'keys';
  if (!purpose || !keyId) {
    console.error(
      'Usage: node scripts/release/generate-key.mjs --purpose catalog|package --key-id <id> --out-dir <dir> [--publisher <p>] [--repo <owner/repo>] [--not-after <iso>]',
    );
    process.exit(1);
  }
  if (purpose !== 'catalog' && purpose !== 'package') {
    throw new Error('purpose 必须是 catalog 或 package');
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  await mkdir(outDir, { recursive: true });
  const privatePath = path.join(outDir, `${keyId}.private.pem`);
  const publicPath = path.join(outDir, `${keyId}.public.pem`);
  await writeFile(privatePath, privateKeyPem, { mode: 0o600 });
  await writeFile(publicPath, publicKeyPem);

  const keyringPath = path.join(outDir, 'keyring.json');
  let keyring = { formatVersion: 1, keys: [] };
  try {
    keyring = JSON.parse(await readFile(keyringPath, 'utf8'));
  } catch {
    // 首次生成。
  }
  if (keyring.keys.some((key) => key.keyId === keyId)) {
    throw new Error(`keyring 已存在 keyId：${keyId}（不覆盖既有信任根）`);
  }
  const repos = args.repo ? String(args.repo).split(',') : undefined;
  keyring.keys.push({
    keyId,
    purpose,
    publicKeyPem,
    ...(args.publisher ? { publisher: args.publisher } : {}),
    ...(repos ? { allowedRepositories: repos } : {}),
    ...(args['not-after'] ? { notAfter: args['not-after'] } : {}),
  });
  await writeFile(keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);

  console.log(`key pair -> ${privatePath} (0600), ${publicPath}`);
  console.log(`trusted key "${keyId}" (${purpose}) appended -> ${keyringPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
