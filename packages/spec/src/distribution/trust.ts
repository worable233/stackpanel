/**
 * 信任链与 keyring 契约（PLAN-github-distribution-and-updates §3.3）。
 *
 * 关键约束（全部可测）：
 * - 信任根**随内核/updater 安装**，不能由下载到的目录自我授权。
 * - 市场目录用独立目录签名；每个 key 有 keyId、用途与有效期。
 * - 插件/主题的 `signature.json` 由**目录绑定**组件 ID、发布者与允许公钥——不得用
 *   「上传者提交的公钥」直接信任上传包。
 * - 密钥轮换由旧信任根授权；根密钥丢失走独立显式恢复流程，不能静默信任新 key。
 */

/** 密钥用途。 */
export type KeyPurpose = 'package' | 'catalog';

/** 信任根中的一把公钥。 */
export interface TrustedKey {
  keyId: string;
  purpose: KeyPurpose;
  /** PEM 编码的 Ed25519 公钥。 */
  publicKeyPem: string;
  /** 所属发布者（包签名时用于绑定）。 */
  publisher?: string;
  /** 允许签名的用途范围（如允许的仓库）。 */
  allowedRepositories?: string[];
  /** 生效期（ISO）。 */
  notBefore?: string;
  /** 失效期（ISO）；过期 key 不得用于**新**目录/安装签名校验。 */
  notAfter?: string;
  /** 是否已撤销（撤销后不得再信任）。 */
  revoked?: boolean;
}

/** keyring：实例持公钥集合（根随安装分发）。 */
export interface Keyring {
  formatVersion: number;
  keys: TrustedKey[];
}

export const KEYRING_FORMAT_VERSION = 1;

/** 找出满足用途且有效期内的候选 key（多发布者）。 */
export function activeKeys(
  keyring: Keyring,
  purpose: KeyPurpose,
  now: Date = new Date(),
): TrustedKey[] {
  return keyring.keys.filter((key) => {
    if (key.purpose !== purpose || key.revoked) return false;
    if (key.notBefore && Date.parse(key.notBefore) > now.getTime()) return false;
    if (key.notAfter && Date.parse(key.notAfter) < now.getTime()) return false;
    return true;
  });
}

/** 按 keyId 查 key（含已撤销，用于审计）。 */
export function findKey(keyring: Keyring, keyId: string): TrustedKey | null {
  return keyring.keys.find((key) => key.keyId === keyId) ?? null;
}

/** 目录签名者必须同时满足：keyId 在 keyring、用途为 catalog、有效、且允许该仓库。 */
export function catalogKeyAllowed(
  keyring: Keyring,
  keyId: string,
  selectedRepository: string,
  now: Date = new Date(),
): boolean {
  const key = findKey(keyring, keyId);
  if (!key || key.revoked || key.purpose !== 'catalog') return false;
  if (key.notBefore && Date.parse(key.notBefore) > now.getTime()) return false;
  if (key.notAfter && Date.parse(key.notAfter) < now.getTime()) return false;
  if (key.allowedRepositories && !key.allowedRepositories.includes(selectedRepository)) {
    return false;
  }
  return true;
}

/**
 * 包签名允许判定：目录绑定「组件 ID + 发布者 + 允许公钥」后，才信任该包签名。
 * 提交包的公钥**不在** keyring 中或与目录绑定不符时，一律拒绝。
 */
export function packageKeyAllowed(
  keyring: Keyring,
  keyId: string,
  expectedPublisher: string,
  expectedRepository: string,
  now: Date = new Date(),
): boolean {
  const key = findKey(keyring, keyId);
  if (!key || key.revoked || key.purpose !== 'package') return false;
  if (key.notBefore && Date.parse(key.notBefore) > now.getTime()) return false;
  if (key.notAfter && Date.parse(key.notAfter) < now.getTime()) return false;
  if (key.publisher !== expectedPublisher) return false;
  if (key.allowedRepositories && !key.allowedRepositories.includes(expectedRepository)) {
    return false;
  }
  return true;
}

/** 密钥轮换动作：由旧信任根授权，先分发新公钥再换签。 */
export interface KeyRotation {
  /** 授权本次轮换的旧 keyId（必须已在 keyring 且有效）。 */
  authorizedBy: string;
  /** 新增的公钥。 */
  newKey: TrustedKey;
  /** 被替换的公钥 keyId（轮换后可保留为历史）。 */
  replaces?: string;
}

/**
 * 应用一次轮换：旧 key 必须存在且有效，否则拒绝（不能静默信任新 key）。
 * 返回新的 keyring（纯函数，不改入参）。
 */
export function applyKeyRotation(
  keyring: Keyring,
  rotation: KeyRotation,
  now: Date = new Date(),
): Keyring {
  const authorizer = findKey(keyring, rotation.authorizedBy);
  if (!authorizer || authorizer.revoked || authorizer.purpose !== 'catalog') {
    throw new Error(`轮换授权无效：${rotation.authorizedBy}`);
  }
  if (authorizer.notAfter && Date.parse(authorizer.notAfter) < now.getTime()) {
    throw new Error(`轮换授权已过期：${rotation.authorizedBy}`);
  }
  if (findKey(keyring, rotation.newKey.keyId)) {
    throw new Error(`新公钥 keyId 已存在：${rotation.newKey.keyId}`);
  }
  return { ...keyring, keys: [...keyring.keys, rotation.newKey] };
}

/**
 * 根密钥恢复（§3.3）：根丢失时通过**独立、显式**流程更换，不能静默信任。
 * 本函数要求显式提供恢复凭据（如离线签名的恢复声明），否则拒绝。
 */
export interface RootRecovery {
  /** 由带外渠道确认的恢复声明（非空即视为已完成显式确认）。 */
  recoveryAssertion: string;
  newRootKey: TrustedKey;
}

export function applyRootRecovery(keyring: Keyring, recovery: RootRecovery): Keyring {
  if (!recovery.recoveryAssertion || recovery.recoveryAssertion.trim().length === 0) {
    throw new Error('根密钥恢复缺少显式恢复声明');
  }
  if (findKey(keyring, recovery.newRootKey.keyId)) {
    throw new Error(`新根 keyId 已存在：${recovery.newRootKey.keyId}`);
  }
  return { ...keyring, keys: [...keyring.keys, recovery.newRootKey] };
}
