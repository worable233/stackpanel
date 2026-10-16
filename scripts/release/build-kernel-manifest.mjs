#!/usr/bin/env node
/**
 * 生成并签名一份**内核版本清单**（PLAN-github-distribution-and-updates §3.2、§12、§13-4）。
 *
 * 内核清单比包清单多出多架构镜像 digest、最低 updateProtocol、允许升级来源、迁移路径、
 * 旧版本可运行 schema 范围、受支持平台、核心包兼容集合与冒烟探针版本。目录只**引用**
 * 该清单（仓库/tag/asset/摘要/keyId），实例端取回后按 keyring 中用途为 `kernel` 的
 * 公钥独立验签（`kernel-manifest.sig`）。
 *
 * 用法：
 *   node scripts/release/build-kernel-manifest.mjs \
 *     --input kernel.meta.json \
 *     --key-file kernel-signing.pem \
 *     --key-id kernel-2026 \
 *     --out kernel-out
 *
 * 产出：`kernel-manifest.json`（规范化字节）、`kernel-manifest.sig`，以及一份可直接并入
 * 目录的 `kernel-ref.json`（含清单 SHA-256 与 keyId）。`--input` 描述文件形状为
 * `KernelManifest` 除 `formatVersion` 外的字段，另可含 `source`（仓库/tag/asset）：
 *   {
 *     "kind": "kernel", "version": "0.3.0", "channel": "stable",
 *     "kernelApi": "0.4.0", "frontendAbi": "1.0.0", "updateProtocol": 1,
 *     "upgradeFrom": ">=0.1.0", "migrationPath": "direct", "schemaRange": "*",
 *     "images": [{ "platform": "linux/amd64", "digest": "ghcr.io/...@sha256:..." }, ...],
 *     "corePackages": [], "supportedPlatforms": ["linux/amd64","linux/arm64"],
 *     "smokeProbeVersion": 1, "databaseMigration": "20261010000000_x",
 *     "source": { "repository": "worable233/stackpanel", "tag": "v0.3.0", "asset": "kernel-manifest.json" }
 *   }
 *
 * 自检：本脚本用**与实例端同一** `verifyKernelManifestSignature` 回读（需 `--keyring`）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSpec, parseArgs, sha256 } from './lib/catalog.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input;
  const keyFile = args['key-file'];
  const outDir = args.out ?? '.';
  const keyId = args['key-id'];
  if (!inputPath || !keyFile || !keyId) {
    console.error(
      'Usage: node scripts/release/build-kernel-manifest.mjs --input <meta.json> --key-file <ed25519.pem> --key-id <id> --out <dir> [--keyring <keyring.json>]',
    );
    process.exit(1);
  }

  const spec = await loadSpec();
  const meta = JSON.parse(await readFile(inputPath, 'utf8'));
  const { source, ...manifestFields } = meta;
  const manifest = {
    formatVersion: spec.PACKAGE_MANIFEST_FORMAT_VERSION,
    kind: 'kernel',
    ...manifestFields,
  };
  const issues = spec.validateKernelManifest(manifest);
  if (issues.length > 0) {
    throw new Error(`内核清单非法：${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }

  const bytes = spec.kernelManifestBytes(manifest);
  const manifestJson = new TextDecoder().decode(bytes);
  const privateKeyPem = await readFile(keyFile, 'utf8');
  const signature = spec.signKernelManifest(bytes, privateKeyPem, keyId);

  // 目录自检：用与实例端同一验证器回读（需 keyring）。
  if (args.keyring) {
    const keyring = JSON.parse(await readFile(args.keyring, 'utf8'));
    spec.verifyKernelManifestSignature({
      manifestBytes: bytes,
      signature,
      keyring,
      ...(source?.repository ? { repository: source.repository } : {}),
    });
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'kernel-manifest.json'), manifestJson);
  await writeFile(
    path.join(outDir, 'kernel-manifest.sig'),
    `${JSON.stringify(signature, null, 2)}\n`,
  );

  const digest = sha256(bytes);
  const ref = {
    version: manifest.version,
    channel: manifest.channel,
    source: source ?? {
      repository: 'worable233/stackpanel',
      tag: `v${manifest.version}`,
      asset: 'kernel-manifest.json',
    },
    digest,
    keyId,
  };
  await writeFile(path.join(outDir, 'kernel-ref.json'), `${JSON.stringify(ref, null, 2)}\n`);

  console.log(`kernel-manifest ${manifest.version}: ${path.join(outDir, 'kernel-manifest.json')}`);
  console.log(`digest: ${digest}`);
  console.log(
    '将 kernel-ref.json 并入目录的 kernels[]（build-catalog.mjs --kernels <dir>）后发布。',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
