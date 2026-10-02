#!/usr/bin/env node
// S2 验证：对象存储双驱动 + Redis 客户端 + 生产校验。
//
//   node scripts/verify-s2.mjs
//
// 覆盖：
//   - LocalDiskDriver 的 put/get/delete/exists/stat/list/url（临时目录）
//   - S3Driver 对 MinIO 的 put/get/delete/stat/list + ensureBucket
//     （需 S2_S3_ENDPOINT/_BUCKET/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY，未配置则跳过）
//   - getRedis 连接 + SET/GET/DEL（需 REDIS_URL；未配置则跳过）
//   - readInfraConfig 的生产硬校验（缺少 Redis / 本地盘）
// 退出码非 0 表示失败。
//
// 示例（本机 Colima 版 MinIO）：
//   REDIS_URL=redis://127.0.0.1:6379 \
//   S2_S3_ENDPOINT=http://127.0.0.1:9000 S2_S3_ACCESS_KEY_ID=stackpanel \
//   S2_S3_SECRET_ACCESS_KEY=stackpanel123 pnpm verify:s2

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  closeRedis,
  getRedis,
  readInfraConfig,
  LocalDiskDriver,
  S3Driver,
} from '../packages/db/dist/client.js';

let failures = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};

const eq = (actual, expected, label) => {
  if (actual === expected) ok(label);
  else bad(`${label}（期望 ${expected}，实际 ${actual}）`);
};

console.log('\n[1] LocalDiskDriver');
{
  const root = await mkdtemp(path.join(tmpdir(), 'sp-s2-'));
  const d = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
  const bytes = new TextEncoder().encode('hello');
  await d.put('brand/logo.png', bytes);
  eq(Buffer.from(await d.get('brand/logo.png')).toString(), 'hello', 'put/get');
  eq(await d.exists('brand/logo.png'), true, 'exists=true');
  eq((await d.stat('brand/logo.png'))?.size, 5, 'stat size');
  eq((await d.list('brand')).length, 1, 'list prefix');
  eq(d.url('brand/logo.png'), '/storage/brand/logo.png', 'url');
  await d.delete('brand/logo.png');
  eq(await d.exists('brand/logo.png'), false, 'delete');
  await rm(root, { recursive: true, force: true });
}

console.log('\n[2] Redis');
const redisUrl = process.env['REDIS_URL'];
if (!redisUrl) {
  console.log('  \x1b[33m•\x1b[0m 未设置 REDIS_URL，跳过');
} else {
  const redis = await getRedis(redisUrl);
  await redis.set('sp:verify:s2', 'ok', 'PX', 5000);
  eq(await redis.get('sp:verify:s2'), 'ok', 'SET/GET');
  await redis.del('sp:verify:s2');
  eq(await redis.get('sp:verify:s2'), null, 'DEL');
}

console.log('\n[3] S3Driver (MinIO)');
const endpoint = process.env['S2_S3_ENDPOINT'];
if (!endpoint) {
  console.log('  \x1b[33m•\x1b[0m 未设置 S2_S3_ENDPOINT，跳过');
} else {
  const driver = new S3Driver({
    driver: 's3',
    endpoint,
    region: process.env['S2_S3_REGION'] ?? 'us-east-1',
    bucket: process.env['S2_S3_BUCKET'] ?? 'stackpanel',
    accessKeyId: process.env['S2_S3_ACCESS_KEY_ID'] ?? 'stackpanel',
    secretAccessKey: process.env['S2_S3_SECRET_ACCESS_KEY'] ?? 'stackpanel',
    forcePathStyle: true,
    publicBaseUrl: `${endpoint}/${process.env['S2_S3_BUCKET'] ?? 'stackpanel'}`,
  });
  await driver.ensureBucket();
  ok('ensureBucket');
  const bytes = new TextEncoder().encode('hello-s3');
  await driver.put('brand/logo.png', bytes, { contentType: 'image/png' });
  eq(Buffer.from(await driver.get('brand/logo.png')).toString(), 'hello-s3', 'put/get');
  eq((await driver.stat('brand/logo.png'))?.size, 8, 'stat size');
  const listed = await driver.list('brand');
  if (listed.some((o) => o.key === 'brand/logo.png')) ok('list');
  else bad('list（未列出 brand/logo.png）');
  await driver.delete('brand/logo.png');
  eq(await driver.exists('brand/logo.png'), false, 'delete');
  eq(await driver.ping(), true, 'ping');
}

console.log('\n[4] 生产硬校验');
{
  try {
    readInfraConfig({ env: { NODE_ENV: 'production' }, dataDir: '/data' });
    bad('缺少 Redis/对象存储时生产应报错');
  } catch {
    ok('生产缺少基础设施时报错');
  }
  try {
    readInfraConfig({
      env: { NODE_ENV: 'production', REDIS_URL: 'redis://x:6379' },
      dataDir: '/data',
    });
    bad('生产用本地盘应报错');
  } catch {
    ok('生产拒绝本地盘存储');
  }
}

console.log('');
if (failures > 0) {
  await closeRedis();
  console.error(`\x1b[31m失败 ${failures} 项\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mS2 验证通过\x1b[0m');
await closeRedis();
