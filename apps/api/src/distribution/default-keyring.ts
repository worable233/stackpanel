/**
 * 默认信任根：**随内核安装**的公钥集合，首次启动时写进实例。
 *
 * 为什么需要它（v0.1.0/v0.1.1 线上事故）：全新实例的数据目录里没有
 * `trust/keyring.json`，而市场目录只声明 keyId、公钥必须由实例自己持有。结果是
 * 「装得上目录、装不上任何插件/主题」，报错只有一句 `信任根缺少 keyId pkg-2026-11`，
 * 界面则显示「安装失败」——文档里那句「部署时写入 keyring」在无人值守安装里根本
 * 不会被执行。契约（`packages/spec/src/distribution/trust.ts`）本来就写明
 * 「信任根随内核/updater 安装，不能由下载到的目录自我授权」，缺的只是这段 seed。
 *
 * 语义（刻意保守）：
 * - **只在文件不存在时写入**。文件已存在就原样保留，哪怕它只有一把自定义 key：
 *   运维有权删掉不用的默认 key，我们不能每次启动又加回去。
 * - 文件存在但解析失败 → 告警并且**绝不覆盖**（覆盖等于把实例的信任根清空）。
 * - 写入用「临时文件 + rename」，避免两个进程（api / worker）同时首启时读到半截。
 *
 * 密钥轮换：轮换时把新公钥同时加进这里（随新内核发布），并按
 * `docs/RELEASE.md` 的流程先把新公钥补进老实例的 keyring。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { KEYRING_FORMAT_VERSION, type Keyring } from '@stackpanel/spec';
import { KEYRING_FILE, parseKeyring } from './keyring.ts';

/**
 * 当前发布用的公钥（私钥只在发布环境）。
 *
 * - `catalog-2026`：默认目录仓 `worable233/stackpanel-plugins` 的目录签名；
 * - `pkg-2026-11`：`stackpanel` 发布者的包签名；
 * - `kernel-2026-11`：内核清单 `kernel-manifest.sig` 的签名。
 *
 * `allowedRepositories` 只绑定默认仓：换了目录源的实例不会因为默认 key 而误信任
 * 别的仓库（验签还会校验用途与有效期）。
 */
export const DEFAULT_KEYRING: Keyring = {
  formatVersion: KEYRING_FORMAT_VERSION,
  keys: [
    {
      keyId: 'catalog-2026',
      purpose: 'catalog',
      publicKeyPem:
        '-----BEGIN PUBLIC KEY-----\n' +
        'MCowBQYDK2VwAyEA/cF0B0ra0cnhdsg2WxswdNubuymbPIqH4VzmgaD+jmk=\n' +
        '-----END PUBLIC KEY-----\n',
      allowedRepositories: ['worable233/stackpanel-plugins'],
    },
    {
      keyId: 'pkg-2026-11',
      purpose: 'package',
      publicKeyPem:
        '-----BEGIN PUBLIC KEY-----\n' +
        'MCowBQYDK2VwAyEA1/KU/Lr5J5TsorafFLZyxZaPCNQGUA81PL5URP0Aqgg=\n' +
        '-----END PUBLIC KEY-----\n',
      publisher: 'stackpanel',
      allowedRepositories: ['worable233/stackpanel-plugins'],
    },
    {
      keyId: 'kernel-2026-11',
      purpose: 'kernel',
      publicKeyPem:
        '-----BEGIN PUBLIC KEY-----\n' +
        'MCowBQYDK2VwAyEAfqKZhe/L/aKDshV/Eg7prFChrr0hVI2979HLUtvONI8=\n' +
        '-----END PUBLIC KEY-----\n',
    },
  ],
};

export const DEFAULT_KEYRING_KEY_IDS = DEFAULT_KEYRING.keys.map((key) => key.keyId);

export interface SeedKeyringResult {
  /** 这次是否真的写了文件。 */
  seeded: boolean;
  path: string;
  /** 写进去（或已有）的 keyId。 */
  keyIds: string[];
  /** `exists`：已存在且可解析，未改动；`invalid`：已存在但非法，未改动。 */
  reason?: 'exists' | 'invalid';
}

/**
 * 首次启动把默认信任根写进 `<数据目录>/trust/keyring.json`（幂等）。
 *
 * 不抛异常：信任根的问题不应该让 API 起不来——没有信任根时市场安装会被明确拒绝，
 * 而实例的其它功能（登录、设置、健康检查）仍然可用，运维也有界面去排查。
 */
export async function seedDefaultKeyring(
  options: { dataDir?: string; log?: (message: string) => void } = {},
): Promise<SeedKeyringResult> {
  const dataDir = options.dataDir ?? resolveStackPanelDataDir();
  const file = path.join(dataDir, KEYRING_FILE);
  const log = options.log ?? ((message: string) => console.info(message));

  let raw: string | null = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    raw = null;
  }

  if (raw !== null) {
    try {
      const keyring = parseKeyring(JSON.parse(raw));
      return {
        seeded: false,
        path: file,
        keyIds: keyring.keys.map((key) => key.keyId),
        reason: 'exists',
      };
    } catch (error) {
      log(
        `[trust] ${file} 无法解析，保持原样不覆盖（${error instanceof Error ? error.message : String(error)}）：` +
          '市场安装会因缺少信任根失败，请修正该文件或删除它以重新生成默认信任根。',
      );
      return { seeded: false, path: file, keyIds: [], reason: 'invalid' };
    }
  }

  await mkdir(path.dirname(file), { recursive: true });
  // 临时文件 + rename：api 与 worker 可能同时首启，rename 是原子的，谁先谁后
  // 都只会留下同一份内容（默认信任根是常量）。
  // 名字必须带随机后缀：同一进程内并发调用（测试、以及将来的热重载）用 pid
  // 做后缀会撞在一起，先 rename 的那个把另一个的临时文件吃掉 → ENOENT。
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(DEFAULT_KEYRING, null, 2)}\n`, { mode: 0o644 });
  await rename(temp, file);
  log(`[trust] 已写入默认信任根（${DEFAULT_KEYRING_KEY_IDS.join(', ')}）→ ${file}`);
  return { seeded: true, path: file, keyIds: DEFAULT_KEYRING_KEY_IDS };
}
