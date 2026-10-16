#!/usr/bin/env node
/**
 * 分发链路**离线端到端演练**（PLAN-github-distribution-and-updates §12/§13）。
 *
 * 在没有 GitHub 发布权限、也不接触网络时，用临时密钥在本地跑通整条链：
 *
 *   1. 生成目录/包 Ed25519 密钥并写出信任根（keyring）。
 *   2. 构造一份扩展包 ZIP，生成 `signature.json`（发布端签名）。
 *   3. 由 ZIP 生成已校验的 `PackageManifest`（目录只引用）。
 *   4. 构建并签名目录快照，写出 `catalog.json` / `catalog.sig` / `channels.json`。
 *   5. 用**与实例端同一**验证器回读：目录签名、结构、发布者绑定、包签名与绑定。
 *   6. 故障注入：篡改目录字节、伪造包、过期目录、回放旧 sequence —— 必须全部被拒。
 *
 * 任一断言失败即非零退出。这是「发布端怎么签」与「实例端怎么验」漂移的回归门禁，
 * 也是无 GitHub 权限时的可重放演练证据。
 *
 * 用法：node scripts/release/rehearse-distribution.mjs [--keep <dir>]
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalog,
  loadSpec,
  parseArgs,
  readPackageManifest,
  sha256,
  signCatalogBytes,
  writeCatalog,
  writeChannelPointers,
} from './lib/catalog.mjs';

const KERNEL_VERSION = '0.2.0';
const KERNEL_API_VERSION = '0.4.0';

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

async function expectReject(label, fn) {
  try {
    await fn();
  } catch {
    console.log(`  ✓ 已拒绝：${label}`);
    return;
  }
  throw new Error(`本应被拒但通过了：${label}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.keep
    ? path.resolve(args.keep)
    : await mkdtemp(path.join(os.tmpdir(), 'stackpanel-dist-'));
  await mkdir(root, { recursive: true });

  const spec = await loadSpec();
  const fail = (error) => {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  };
  process.on('unhandledRejection', fail);

  // 1) 密钥与信任根。
  console.log('1) 生成密钥与信任根');
  const catalogKp = generateKeyPairSync('ed25519');
  const packageKp = generateKeyPairSync('ed25519');
  const kernelKp = generateKeyPairSync('ed25519');
  const catalogPrivatePem = catalogKp.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const kernelPrivatePem = kernelKp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyring = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'catalog-rehearsal',
        purpose: 'catalog',
        publicKeyPem: catalogKp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        allowedRepositories: ['worable233/stackpanel-market'],
      },
      {
        keyId: 'pkg-rehearsal',
        purpose: 'package',
        publicKeyPem: packageKp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        publisher: 'stackpanel',
        allowedRepositories: ['worable233/stackpanel-plugins'],
      },
      {
        keyId: 'kernel-rehearsal',
        purpose: 'kernel',
        publicKeyPem: kernelKp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        allowedRepositories: ['worable233/stackpanel'],
      },
    ],
  };
  await writeFile(path.join(root, 'keyring.json'), `${JSON.stringify(keyring, null, 2)}\n`);
  assert(keyring.keys.length === 3, '信任根含目录、包与内核三把公钥');

  // 2) 构造包 ZIP 文件集合并签名（发布端）。
  console.log('2) 发布端签名扩展包');
  const files = new Map([
    ['manifest.json', new TextEncoder().encode('{"id":"rehearsal","version":"1.0.0"}')],
    ['dist/index.js', new TextEncoder().encode('export default {}')],
  ]);
  const packageSignature = spec.signPackageFiles(
    files,
    packageKp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  files.set('signature.json', new TextEncoder().encode(JSON.stringify(packageSignature)));
  const zipBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(files)));
  await writeFile(path.join(root, 'rehearsal-1.0.0.zip'), zipBytes);
  assert(sha256(zipBytes).length === 64, '包摘要为 64 位 SHA-256');

  // 3) 由 ZIP 生成已校验清单。
  console.log('3) 生成并校验包清单');
  const manifest = {
    formatVersion: spec.PACKAGE_MANIFEST_FORMAT_VERSION,
    kind: 'plugin',
    id: 'rehearsal',
    version: '1.0.0',
    channel: 'stable',
    source: {
      repository: 'worable233/stackpanel-plugins',
      tag: 'plugin-rehearsal-v1.0.0',
      asset: 'rehearsal-1.0.0.zip',
    },
    artifact: { sha256: sha256(zipBytes), size: zipBytes.byteLength },
    compatibility: {
      kernel: `>=${KERNEL_VERSION} <0.3.0`,
      kernelApi: `^${KERNEL_API_VERSION}`,
      frontendAbi: '^1.0.0',
      packageFormat: 1,
    },
    requires: [],
    conflicts: [],
    permissions: [],
    frontendModes: ['M2'],
    migration: { mode: 'none', rollback: 'code-compatible' },
    automatic: { eligible: true },
    publisher: 'stackpanel',
    name: 'Rehearsal',
  };
  const manifestPath = path.join(root, 'rehearsal.manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await readPackageManifest(manifestPath);
  assert(spec.validatePackageManifest(manifest).length === 0, '包清单通过契约校验');

  // 4) 构建并签名目录。
  console.log('4) 构建并签名目录快照');
  // 内核清单（§13-4）：发布端签 `kernel-manifest.json`，目录只引用其摘要与 keyId。
  const kernelManifest = {
    formatVersion: spec.PACKAGE_MANIFEST_FORMAT_VERSION,
    kind: 'kernel',
    version: '0.3.0',
    channel: 'stable',
    kernelApi: KERNEL_API_VERSION,
    frontendAbi: '1.0.0',
    updateProtocol: spec.UPDATE_PROTOCOL_VERSION,
    upgradeFrom: '>=0.1.0',
    migrationPath: 'direct',
    schemaRange: '*',
    images: [
      {
        platform: 'linux/amd64',
        digest: `ghcr.io/worable233/stackpanel@sha256:${sha256(new TextEncoder().encode('amd64'))}`,
      },
    ],
    corePackages: [],
    supportedPlatforms: ['linux/amd64'],
    smokeProbeVersion: 1,
    databaseMigration: '20261010000000_kernel_0_3_0',
  };
  assert(spec.validateKernelManifest(kernelManifest).length === 0, '内核清单通过契约校验');
  const kernelBytes = spec.kernelManifestBytes(kernelManifest);
  const kernelSig = spec.signKernelManifest(kernelBytes, kernelPrivatePem, 'kernel-rehearsal');
  spec.verifyKernelManifestSignature({
    manifestBytes: kernelBytes,
    signature: kernelSig,
    keyring,
    repository: 'worable233/stackpanel',
  });
  assert(true, '内核清单签名通过（用途 kernel + 仓库绑定）');
  const kernelRef = {
    version: kernelManifest.version,
    channel: kernelManifest.channel,
    source: {
      repository: 'worable233/stackpanel',
      tag: 'v0.3.0',
      asset: 'kernel-manifest.json',
    },
    digest: sha256(kernelBytes),
    keyId: 'kernel-rehearsal',
  };
  const resolvedKernel = spec.resolveKernelUpgrade({
    currentVersion: KERNEL_VERSION,
    platform: 'linux/amd64',
    channel: 'stable',
    candidates: [kernelManifest],
  });
  assert(
    resolvedKernel.ok && resolvedKernel.target.version === '0.3.0',
    '内核自身升级求解选中 0.3.0 目标',
  );

  const { catalogBytes, catalogJson } = await buildCatalog({
    sequence: 7,
    channels: ['stable', 'beta'],
    publishers: [
      {
        publisher: 'stackpanel',
        keyIds: ['pkg-rehearsal'],
        repositories: ['worable233/stackpanel-plugins'],
      },
    ],
    entries: [manifest],
    kernels: [kernelRef],
  });
  const { catalogSigJson } = await signCatalogBytes(
    catalogBytes,
    catalogPrivatePem,
    'catalog-rehearsal',
  );
  const catalogDir = path.join(root, 'catalog-v1', '7');
  await writeCatalog(catalogDir, { catalogJson, catalogSigJson });
  await writeChannelPointers(path.join(root, 'catalog-v1'), [
    { channel: 'stable', sequence: 7 },
    { channel: 'beta', sequence: 7 },
  ]);
  assert(spec.parseCatalogReleaseTag('catalog-v1/7') === 7, '目录 tag 可解析 sequence=7');

  // 5) 回读：用实例端同一验证器。
  console.log('5) 回读验证（与实例端同一验证器）');
  const readCatalogBytes = new Uint8Array(await readFile(path.join(catalogDir, 'catalog.json')));
  const signature = JSON.parse(await readFile(path.join(catalogDir, 'catalog.sig'), 'utf8'));
  spec.verifyCatalogSignatureBytes({
    catalogBytes: readCatalogBytes,
    signature,
    keyring,
    repository: 'worable233/stackpanel-market',
  });
  assert(true, '目录签名通过（keyId/用途/仓库绑定）');
  const parsedCatalog = JSON.parse(new TextDecoder().decode(readCatalogBytes));
  assert(spec.validateCatalogSnapshot(parsedCatalog).length === 0, '目录结构合法');
  assert(
    spec.catalogCandidates(parsedCatalog, 'plugin', 'rehearsal').length === 1,
    '目录含 1 个候选',
  );
  assert(
    spec.catalogKernelRefs(parsedCatalog, 'stable').length === 1,
    '目录含 1 条内核引用（stable）',
  );

  const boundFiles = new Map([
    ['manifest.json', files.get('manifest.json')],
    ['dist/index.js', files.get('dist/index.js')],
    ['signature.json', files.get('signature.json')],
  ]);
  spec.verifyPackageSignatureBound({
    files: boundFiles,
    keyId: 'pkg-rehearsal',
    expectedPublisher: 'stackpanel',
    expectedRepository: 'worable233/stackpanel-plugins',
    keyring,
  });
  assert(true, '包签名通过（发布者/仓库绑定）');

  // 6) 故障注入。
  console.log('6) 故障注入（必须全部被拒）');
  await expectReject('篡改 catalog.json 字节', () =>
    spec.verifyCatalogSignatureBytes({
      catalogBytes: new TextEncoder().encode(catalogJson.replace('7', '9')),
      signature,
      keyring,
      repository: 'worable233/stackpanel-market',
    }),
  );
  await expectReject('来源仓库不在信任根白名单', () =>
    spec.verifyCatalogSignatureBytes({
      catalogBytes: readCatalogBytes,
      signature,
      keyring,
      repository: 'evil/market',
    }),
  );
  await expectReject('篡改包文件（摘要不一致）', () => {
    const tampered = new Map(boundFiles);
    tampered.set('dist/index.js', new TextEncoder().encode('export default { evil: true }'));
    return spec.verifyPackageSignatureBound({
      files: tampered,
      keyId: 'pkg-rehearsal',
      expectedPublisher: 'stackpanel',
      expectedRepository: 'worable233/stackpanel-plugins',
      keyring,
    });
  });
  await expectReject('包发布者绑定不符', () =>
    spec.verifyPackageSignatureBound({
      files: boundFiles,
      keyId: 'pkg-rehearsal',
      expectedPublisher: 'impostor',
      expectedRepository: 'worable233/stackpanel-plugins',
      keyring,
    }),
  );
  await expectReject('回放旧 sequence', () => {
    if (!spec.isNewerSequence(6, 7)) throw new Error('回放未拒绝');
  });
  await expectReject('篡改内核清单（摘要不符）', () =>
    spec.verifyKernelManifestSignature({
      manifestBytes: spec.kernelManifestBytes({ ...kernelManifest, version: '9.9.9' }),
      signature: kernelSig,
      keyring,
      repository: 'worable233/stackpanel',
    }),
  );
  await expectReject('内核清单签名 key 用途不是 kernel', () =>
    spec.verifyKernelManifestSignature({
      manifestBytes: kernelBytes,
      signature: kernelSig,
      keyring: {
        formatVersion: 1,
        keys: [
          {
            keyId: 'kernel-rehearsal',
            purpose: 'package',
            publicKeyPem: kernelKp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        ],
      },
    }),
  );

  // 过期目录：生成一份已过期目录并确认 isCatalogExpired。
  const expired = await buildCatalog({
    sequence: 8,
    channels: ['stable'],
    publishers: [],
    entries: [],
    now: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    ttlDays: 14,
  });
  const expiredObj = JSON.parse(new TextDecoder().decode(expired.catalogBytes));
  assert(
    spec.isCatalogExpired(expiredObj, new Date()) === true,
    '过期目录被识别（禁止据此发起新自动安装）',
  );

  if (!args.keep) await rm(root, { recursive: true, force: true });
  console.log(`\n✓ 分发链路离线演练通过（产物${args.keep ? `保留于 ${root}` : '已清理'}）`);
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
