/**
 * 发布端目录工具库（PLAN-github-distribution-and-updates §2、§3.3、§12）。
 *
 * 与实例端**共用**契约单一来源 `packages/spec`（`distribution/index`）：目录摘要、
 * 规范化字节、manifest/目录结构校验、keyring 判定都从这里取，避免「发布端怎么签」
 * 与「实例端怎么验」两处漂移。
 *
 * 目录只**引用**允许仓库 / release / asset / 摘要 / 大小 / 签名身份 / 兼容性；
 * 不保存安装包本体（主计划 §2）。
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

let specPromise;
/** 载入契约单一来源（构建产物）。发布脚本与 CI 均先 `pnpm --filter @stackpanel/spec build`。 */
export async function loadSpec() {
  specPromise ??= import(
    pathToFileURL(path.join(REPO_ROOT, 'packages', 'spec', 'dist', 'index.js')).href
  );
  return specPromise;
}

/** 读取并校验一个包清单（JSON 文本），返回 {@link import('@stackpanel/spec').PackageManifest}。 */
export async function readPackageManifest(file) {
  const spec = await loadSpec();
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const issues = spec.validatePackageManifest(raw);
  if (issues.length > 0) {
    throw new Error(
      `清单非法（${file}）：${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
  }
  return raw;
}

/**
 * 由条目与元数据构建一份目录快照（不含签名）。
 *
 * @param {object} input
 * @param {number} input.sequence 单调递增序号。
 * @param {string[]} input.channels 需要写入稳定指针的渠道（stable/beta）。
 * @param {Array} [input.publishers] 发布者白名单（publisher → keyIds/repositories）。
 * @param {Array} input.entries 已校验包清单（可带 `revoked`）。
 * @param {object} [input.now] 生成时刻（Date）。
 * @param {number} [input.ttlDays] 有效期天数；缺省 14。
 * @returns {Promise<{ catalog: object, catalogJson: string, catalogBytes: Uint8Array }>}
 */
export async function buildCatalog(input) {
  const spec = await loadSpec();
  const now = input.now ?? new Date();
  const ttlDays = input.ttlDays ?? 14;
  const catalog = {
    formatVersion: spec.CATALOG_SNAPSHOT_FORMAT_VERSION,
    sequence: input.sequence,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
    channels: (input.channels ?? ['stable', 'beta']).map((channel) => ({
      channel,
      sequence: input.sequence,
    })),
    publishers: input.publishers ?? [],
    entries: input.entries ?? [],
  };
  const issues = spec.validateCatalogSnapshot(catalog);
  if (issues.length > 0) {
    throw new Error(`目录非法：${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }
  const catalogBytes = spec.canonicalizeCatalogSnapshot(catalog);
  const catalogJson = new TextDecoder().decode(catalogBytes);
  return { catalog, catalogBytes, catalogJson };
}

/** 用目录私钥签名目录字节，返回 catalog.sig 的 JSON 文本。 */
export async function signCatalogBytes(catalogBytes, privateKeyPem, keyId) {
  const spec = await loadSpec();
  const signature = spec.signCatalog(catalogBytes, privateKeyPem, keyId);
  return { signature, catalogSigJson: `${JSON.stringify(signature, null, 2)}\n` };
}

/** 写出 `catalog.json` 与 `catalog.sig` 到目录（逐字写入规范化字节）。 */
export async function writeCatalog(dir, { catalogJson, catalogSigJson }) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'catalog.json'), catalogJson);
  await writeFile(path.join(dir, 'catalog.sig'), catalogSigJson);
  return {
    catalogJson: path.join(dir, 'catalog.json'),
    catalogSig: path.join(dir, 'catalog.sig'),
  };
}

/** 写出渠道指针文件 `channels.json`（默认分支，客户端据此发现 sequence）。 */
export async function writeChannelPointers(dir, pointers) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'channels.json');
  await writeFile(file, `${JSON.stringify({ channels: pointers }, null, 2)}\n`);
  return file;
}

/** 对文件/字节做 SHA-256（十六进制）。 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// —— CLI 参数解析（最小依赖，供各 release 脚本共用） ——

/** 解析 `--key value` 与 `--flag` 形式参数。 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}
