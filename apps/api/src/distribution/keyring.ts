/**
 * 信任根（keyring）加载（PLAN-github-distribution-and-updates §3.3、§11）。
 *
 * 信任根**随内核/updater 安装**，不能由下载到的目录自我授权。内核从实例数据目录
 * 读取 `trust/keyring.json`（随部署写入，升级不覆盖），并兼容既有的单一签名公钥
 * 环境变量 `STACKPANEL_SIGNING_PUBLIC_KEY`（迁移期：它作为一把用途为 `package`
 * 的 key 并入，不丢失现有上传校验能力）。
 *
 * 目录签名不信任 env 里那把包公钥（用途不符会被 {@link catalogKeyAllowed} 拒绝），
 * 必须由 keyring 中用途为 `catalog` 的公钥承担——避免「一把 key 通吃」。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { KEYRING_FORMAT_VERSION, type Keyring, type TrustedKey } from '@stackpanel/spec';
import { env } from '../config/env.ts';

export const KEYRING_FILE = path.join('trust', 'keyring.json');

/** 迁移期 env 公钥在 keyring 中的稳定 keyId。 */
export const ENV_PACKAGE_KEY_ID = 'env-package-key';

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTrustedKey(value: unknown, index: number): asserts value is TrustedKey {
  if (!isRecord(value)) throw new KeyringError(`keyring.keys[${index}] 必须是对象`);
  if (typeof value.keyId !== 'string' || value.keyId.length === 0) {
    throw new KeyringError(`keyring.keys[${index}].keyId 缺失`);
  }
  if (value.purpose !== 'catalog' && value.purpose !== 'package') {
    throw new KeyringError(`keyring.keys[${index}].purpose 必须是 catalog 或 package`);
  }
  if (typeof value.publicKeyPem !== 'string' || value.publicKeyPem.length === 0) {
    throw new KeyringError(`keyring.keys[${index}].publicKeyPem 缺失`);
  }
}

/** 校验并规范化一个 keyring 对象。 */
export function parseKeyring(input: unknown): Keyring {
  if (!isRecord(input)) throw new KeyringError('keyring 必须是对象');
  const keys = input.keys;
  if (!Array.isArray(keys)) throw new KeyringError('keyring.keys 必须是数组');
  keys.forEach((key, index) => assertTrustedKey(key, index));
  return {
    formatVersion:
      typeof input.formatVersion === 'number' ? input.formatVersion : KEYRING_FORMAT_VERSION,
    keys: keys as TrustedKey[],
  };
}

/** 从数据目录读取 `trust/keyring.json`；不存在返回 null（由调用方降级/报错）。 */
export async function readStoredKeyring(): Promise<Keyring | null> {
  const file = path.join(resolveStackPanelDataDir(), KEYRING_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseKeyring(JSON.parse(raw));
  } catch (error) {
    throw new KeyringError(
      `信任根文件非法（${file}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 解析内核当前信任根：数据目录 keyring 优先，迁移期把 env 的包公钥并入
 * （keyId 固定为 {@link ENV_PACKAGE_KEY_ID}，不覆盖已声明的同 keyId 条目）。
 */
export async function loadKeyring(): Promise<Keyring> {
  const stored = (await readStoredKeyring()) ?? {
    formatVersion: KEYRING_FORMAT_VERSION,
    keys: [],
  };
  if (env.STACKPANEL_SIGNING_PUBLIC_KEY) {
    const exists = stored.keys.some((key) => key.keyId === ENV_PACKAGE_KEY_ID);
    if (!exists) {
      return {
        ...stored,
        keys: [
          ...stored.keys,
          {
            keyId: ENV_PACKAGE_KEY_ID,
            purpose: 'package',
            publicKeyPem: env.STACKPANEL_SIGNING_PUBLIC_KEY,
          },
        ],
      };
    }
  }
  return stored;
}
