/**
 * 升级任务通道的文件布局契约（PLAN-github-distribution-and-updates §5.1）。
 *
 * 内核（API）只**提交声明式任务**，updater 通过实例私有通道认领并回写结果。两侧进程
 * 可能运行在不同容器，但共享同一个实例私有卷，因此目录布局必须是**单一来源**，避免
 * 两端各自拼路径而漂移。本模块只产出相对/片段路径字符串（POSIX 分隔），零运行时依赖。
 *
 * 布局：
 *   <root>/inbox/<instanceId>/<key>.json      待执行
 *   <root>/claimed/<instanceId>/<key>.json    已认领（防并发）
 *   <root>/results/<instanceId>/<key>.json    结果投影
 */

/** 通道子目录名（相对通道根）。 */
export const UPDATE_CHANNEL_SUBDIRS = Object.freeze({
  inbox: 'inbox',
  claimed: 'claimed',
  results: 'results',
});

/** 任务/结果文件名：由幂等键构成，不含路径分隔。 */
export function updateTaskFileName(idempotencyKey: string): string {
  if (idempotencyKey.length === 0) throw new Error('幂等键不得为空');
  if (
    idempotencyKey.includes('/') ||
    idempotencyKey.includes('\\') ||
    idempotencyKey.includes('..')
  ) {
    throw new Error(`幂等键含非法路径字符：${idempotencyKey}`);
  }
  return `${idempotencyKey}.json`;
}

/**
 * 组装通道内的目录路径（POSIX 分隔）。`root` 由调用方按其容器挂载点给出；
 * 本函数只负责 `subdir/instanceId` 的稳定拼接。
 */
export function updateChannelDir(
  root: string,
  subdir: keyof typeof UPDATE_CHANNEL_SUBDIRS,
  instanceId: string,
): string {
  if (instanceId.length === 0) throw new Error('实例 ID 不得为空');
  if (instanceId.includes('/') || instanceId.includes('\\') || instanceId.includes('..')) {
    throw new Error(`实例 ID 含非法路径字符：${instanceId}`);
  }
  return [root.replace(/\/+$/, ''), UPDATE_CHANNEL_SUBDIRS[subdir], instanceId].join('/');
}
