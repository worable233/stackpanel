#!/usr/bin/env node
/**
 * 目录发布后回读校验（PLAN-github-distribution-and-updates §12）。
 *
 * 对本地已构建/已下载的目录产物执行与**实例端一致**的验证：签名、结构、发布者
 * 绑定、渠道指针、回放保护输入。CI 在发布目录后回读并跑本脚本，防止「发布端怎么
 * 签」与「实例端怎么验」漂移，或目录被篡改。
 *
 * 用法：
 *   node scripts/release/verify-catalog.mjs \
 *     --dir dist/catalog/catalog-v1/7 \
 *     --keyring trust/keyring.json \
 *     --repository worable233/stackpanel-market \
 *     [--highest <n>]   # 已发布最高 sequence；给出时校验不回放
 *     [--allow-expired] # 过期目录允许（仅展示，不据其发起新自动安装）
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSpec, parseArgs } from './lib/catalog.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  const keyringPath = args.keyring;
  const repository = args.repository;
  if (!dir || !keyringPath || !repository) {
    console.error(
      'Usage: node scripts/release/verify-catalog.mjs --dir <catalog-dir> --keyring <keyring.json> --repository <owner/repo> [--highest n] [--allow-expired]',
    );
    process.exit(1);
  }
  const spec = await loadSpec();
  const catalogBytes = new Uint8Array(await readFile(path.join(dir, 'catalog.json')));
  const signatureRaw = await readFile(path.join(dir, 'catalog.sig'));
  let signature;
  try {
    signature = JSON.parse(signatureRaw.toString('utf8'));
  } catch {
    throw new Error('catalog.sig 不是有效的 JSON');
  }
  const keyring = JSON.parse(await readFile(keyringPath, 'utf8'));

  spec.verifyCatalogSignatureBytes({ catalogBytes, signature, keyring, repository });

  const parsed = JSON.parse(new TextDecoder().decode(catalogBytes));
  const issues = spec.validateCatalogSnapshot(parsed);
  if (issues.length > 0) {
    throw new Error(`目录结构非法：${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }

  // 发布者绑定：每条目的 publisher/source 必须在 publishers 白名单内。
  const publishers = new Map(parsed.publishers.map((p) => [p.publisher, p]));
  for (const entry of parsed.entries) {
    const publisher = entry.publisher;
    if (!publisher) throw new Error(`条目 ${entry.kind}/${entry.id} 缺 publisher 字段`);
    const allowed = publishers.get(publisher);
    if (!allowed) throw new Error(`条目发布者未在 publishers 白名单：${publisher}`);
    if (!allowed.repositories.includes(entry.source.repository)) {
      throw new Error(`条目来源仓库不在发布者白名单：${entry.source.repository}`);
    }
  }

  if (args.highest !== undefined) {
    const highest = Number(args.highest);
    if (!spec.isNewerSequence(parsed.sequence, highest)) {
      throw new Error(`目录 sequence ${parsed.sequence} 不大于已发布最高值 ${highest}（疑似回放）`);
    }
  }

  const expired = spec.isCatalogExpired(parsed);
  if (expired && !args['allow-expired']) {
    throw new Error('目录已过期；如确为历史快照请显式加 --allow-expired');
  }

  console.log(
    `catalog-v1/${parsed.sequence} 校验通过：${parsed.entries.length} 条目，过期=${expired}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
