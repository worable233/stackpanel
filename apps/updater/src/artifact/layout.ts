/**
 * 产物载体 runner 的目录布局（ADR-0025 决策 3）。
 *
 * ```
 * /opt/stackpanel/
 * ├── current -> releases/<version>        # 原子切换点
 * ├── releases/<version>/
 * ├── bin/stackpanel-upgrade               # runner，位于版本目录之外
 * └── .staging/<version>                   # 解包暂存（必须与 releases 同文件系统）
 *
 * /var/lib/stackpanel/
 * ├── data/ logs/
 * ├── backups/<ts>-<version>/{database.dump,pointer.json,...}
 * └── update/
 *     ├── inbox/<instance>/*.json           # API 提交（systemd path 监听点）
 *     ├── claimed/  results/  archived/
 *     ├── downloads/<key>/
 *     ├── work/
 *     ├── update-journal.jsonl
 *     ├── executor.lock
 *     ├── deployment-pointer.json
 *     └── status.json
 * ```
 *
 * `data/`、`logs/` 与版本目录分离：版本目录会被整体替换，任何运行期写入都会在升级
 * 时丢失，因此只允许通过 `STACKPANEL_DATA_DIR` / `STACKPANEL_LOG_DIR` 注入绝对路径，
 * 绝不以产物目录为缺省。
 */

import path from 'node:path';

export interface RunnerLayout {
  root: string;
  stateDir: string;
  /** `current` 符号链接。 */
  currentLink: string;
  releasesDir: string;
  /** 与 `releases/` 同文件系统的解包暂存目录。 */
  stagingDir: string;
  binDir: string;
  dataDir: string;
  logsDir: string;
  backupsDir: string;
  updateDir: string;
  /** 任务通道根；与 `updateChannelDir()` 拼接后使用。 */
  channelRoot: string;
  workDir: string;
  downloadsDir: string;
  journalFile: string;
  lockFile: string;
  pointerFile: string;
  statusFile: string;
  instanceId: string;
  /** 保留的 release 数量（含 `current`）。 */
  releaseRetention: number;
}

export interface RunnerLayoutInput {
  root?: string;
  stateDir?: string;
  instanceId?: string;
  releaseRetention?: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 解析并校验布局。非法实例 ID 直接拒绝（它会拼进通道路径）。 */
export function resolveLayout(input: RunnerLayoutInput = {}): RunnerLayout {
  const root = path.resolve(input.root ?? '/opt/stackpanel');
  const stateDir = path.resolve(input.stateDir ?? '/var/lib/stackpanel');
  const instanceId = input.instanceId ?? 'stackpanel';
  if (!ID_PATTERN.test(instanceId)) {
    throw new Error(`实例 ID 含非法字符：${instanceId}`);
  }
  const retention = input.releaseRetention ?? 2;
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error(`release 保留数量必须是 ≥1 的整数：${retention}`);
  }
  const updateDir = path.join(stateDir, 'update');
  return {
    root,
    stateDir,
    currentLink: path.join(root, 'current'),
    releasesDir: path.join(root, 'releases'),
    stagingDir: path.join(root, '.staging'),
    binDir: path.join(root, 'bin'),
    dataDir: path.join(stateDir, 'data'),
    logsDir: path.join(stateDir, 'logs'),
    backupsDir: path.join(stateDir, 'backups'),
    updateDir,
    channelRoot: updateDir,
    workDir: path.join(updateDir, 'work'),
    downloadsDir: path.join(updateDir, 'downloads'),
    journalFile: path.join(updateDir, 'update-journal.jsonl'),
    lockFile: path.join(updateDir, 'executor.lock'),
    pointerFile: path.join(updateDir, 'deployment-pointer.json'),
    statusFile: path.join(updateDir, 'status.json'),
    instanceId,
    releaseRetention: retention,
  };
}

/** 从环境变量装配布局（systemd `EnvironmentFile` / CLI 逃生门共用）。 */
export function layoutFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerLayout {
  const retentionRaw = env['STACKPANEL_RELEASE_RETENTION'];
  return resolveLayout({
    ...(env['STACKPANEL_ROOT'] ? { root: env['STACKPANEL_ROOT'] } : {}),
    ...(env['STACKPANEL_STATE_DIR'] ? { stateDir: env['STACKPANEL_STATE_DIR'] } : {}),
    ...(env['STACKPANEL_UPDATE_INSTANCE_ID']
      ? { instanceId: env['STACKPANEL_UPDATE_INSTANCE_ID'] }
      : {}),
    ...(retentionRaw ? { releaseRetention: Number(retentionRaw) } : {}),
  });
}

/** 版本目录名。版本号来自已验签清单，这里再校验一次防路径注入。 */
export function releaseDirName(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/.test(version)) {
    throw new Error(`非法内核版本号：${version}`);
  }
  return version;
}
