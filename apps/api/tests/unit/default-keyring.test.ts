import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYRING,
  DEFAULT_KEYRING_KEY_IDS,
  seedDefaultKeyring,
} from '../../src/distribution/default-keyring.ts';
import { parseKeyring } from '../../src/distribution/keyring.ts';

/**
 * 默认信任根：v0.1.0/v0.1.1 的部署事故根因是「全新实例没有任何信任根」，
 * 市场里一个包都装不上，界面却只说「安装失败」。这里锁住 seed 的契约：
 * 首启写入、已存在绝不覆盖、非法文件也不覆盖。
 */
const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'stackpanel-trust-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('DEFAULT_KEYRING', () => {
  it('每把公钥都能被 Node 解析成 Ed25519 公钥（手抄 PEM 的防错）', () => {
    for (const key of DEFAULT_KEYRING.keys) {
      const parsed = createPublicKey(key.publicKeyPem);
      expect(parsed.asymmetricKeyType).toBe('ed25519');
    }
  });

  it('三种用途都有，且目录/包公钥绑定默认目录仓', () => {
    expect(DEFAULT_KEYRING_KEY_IDS).toEqual(
      expect.arrayContaining(['catalog-2026', 'pkg-2026-11', 'kernel-2026-11']),
    );
    const byPurpose = (purpose: string) => DEFAULT_KEYRING.keys.filter((k) => k.purpose === purpose);
    expect(byPurpose('catalog')).toHaveLength(1);
    expect(byPurpose('package')).toHaveLength(1);
    expect(byPurpose('kernel')).toHaveLength(1);
    expect(byPurpose('catalog')[0]?.allowedRepositories).toEqual(['worable233/stackpanel-plugins']);
    expect(byPurpose('package')[0]?.allowedRepositories).toEqual([
      'worable233/stackpanel-plugins',
    ]);
    expect(byPurpose('package')[0]?.publisher).toBe('stackpanel');
    // 内核公钥不绑定仓库：清单来自内核发布通道，与插件目录无关。
    expect(byPurpose('kernel')[0]?.allowedRepositories).toBeUndefined();
  });

  it('本身通过内核的 keyring 校验（parseKeyring）', () => {
    expect(() => parseKeyring(DEFAULT_KEYRING)).not.toThrow();
  });
});

describe('seedDefaultKeyring', () => {
  it('数据目录没有 keyring 时写入默认信任根', async () => {
    const dataDir = tempDataDir();
    const messages: string[] = [];
    const result = await seedDefaultKeyring({ dataDir, log: (m) => messages.push(m) });

    expect(result.seeded).toBe(true);
    expect(result.keyIds).toEqual(DEFAULT_KEYRING_KEY_IDS);
    const written = parseKeyring(JSON.parse(readFileSync(path.join(dataDir, 'trust/keyring.json'), 'utf8')));
    expect(written.keys.map((key) => key.keyId)).toEqual(DEFAULT_KEYRING_KEY_IDS);
    expect(messages.join('\n')).toContain('已写入默认信任根');

    // trust/ 目录本身也要建出来（否则运维手动放文件时会踩一次「目录不存在」）。
    expect(readFileSync(path.join(dataDir, 'trust/keyring.json'), 'utf8')).toContain('pkg-2026-11');
  });

  it('已有合法 keyring 时原样保留，不补也不改（运维删掉的默认 key 不许复活）', async () => {
    const dataDir = tempDataDir();
    mkdirSync(path.join(dataDir, 'trust'), { recursive: true });
    const custom = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'operator-key',
          purpose: 'package',
          publicKeyPem: DEFAULT_KEYRING.keys[1]!.publicKeyPem,
          publisher: 'in-house',
        },
      ],
    };
    const file = path.join(dataDir, 'trust/keyring.json');
    const before = `${JSON.stringify(custom, null, 2)}\n`;
    writeFileSync(file, before);

    const result = await seedDefaultKeyring({ dataDir, log: () => undefined });

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('exists');
    expect(result.keyIds).toEqual(['operator-key']);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('文件存在但解析失败时只告警，绝不覆盖（覆盖等于清空实例信任根）', async () => {
    const dataDir = tempDataDir();
    mkdirSync(path.join(dataDir, 'trust'), { recursive: true });
    const file = path.join(dataDir, 'trust/keyring.json');
    writeFileSync(file, '{ not json');

    const messages: string[] = [];
    const result = await seedDefaultKeyring({ dataDir, log: (m) => messages.push(m) });

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(messages.join('\n')).toContain('保持原样不覆盖');
  });

  it('并发首启（api 与 worker 同时）不会写坏文件', async () => {
    const dataDir = tempDataDir();
    await Promise.all([
      seedDefaultKeyring({ dataDir, log: () => undefined }),
      seedDefaultKeyring({ dataDir, log: () => undefined }),
    ]);
    const raw = readFileSync(path.join(dataDir, 'trust/keyring.json'), 'utf8');
    expect(parseKeyring(JSON.parse(raw)).keys).toHaveLength(DEFAULT_KEYRING.keys.length);
    expect(raw.endsWith('\n')).toBe(true);
  });
});
