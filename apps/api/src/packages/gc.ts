/**
 * 未引用产物回收（PLAN-github-distribution-and-updates §7.6、§7.8）。
 *
 * 安装采用「暂存目录 → 原子切换 → 提交/回滚」：`stageAndSwap` 正常路径会自行清理
 * 暂存与备份，但**进程崩溃/断电**会留下 `.stage-*`、`.backup-*`、`.market-*`、
 * `.upload-*` 等未被任何活动部署引用的目录。本模块保守回收这些**已知瞬态前缀**
 * 的目录：
 *
 * - 只删除**明确属于本内核瞬态产物**的目录（前缀白名单），绝不触碰插件/主题本体。
 * - 只删除超过保留期的目录，避免误删正在进行中的切换（存在竞争时保留旧目录，由
 *   下次回收处理，宁可晚删不可误删）。
 * - 「默认至少保留上一成功版本且保留七天」（§7.8）由 `collectGcCandidates` 承担；
 *   这里只处理**未被引用**的瞬态目录，二者正交。
 */

import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

/** 本内核瞬态目录前缀（暂存 / 备份 / 市场临时 / 上传临时）。 */
export const TRANSIENT_PREFIXES: readonly string[] = [
  '.stage-',
  '.backup-',
  '.market-',
  '.upload-',
];

export interface ReapOptions {
  /** 只回收早于该毫秒数的目录；缺省 6 小时。 */
  maxAgeMs?: number;
  /** 时钟（测试）。 */
  now?: () => number;
}

/**
 * 回收 `parent` 下未被引用的瞬态目录，返回被删目录名（相对 parent）。
 *
 * 安全边界：
 * - 只匹配 {@link TRANSIENT_PREFIXES}；`.seed-*` 不在其列（内置插件播种本身会在
 *   下次启动重建，且种子目录在播种过程中短暂存在，交由播种逻辑自身清理）。
 * - 只回收**目录**，且 mtime 早于保留期。
 * - 任何单个删除失败都被忽略（可能正被占用），不影响其他回收。
 */
export async function reapTransientArtifacts(
  parent: string,
  options: ReapOptions = {},
): Promise<string[]> {
  const maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const now = (options.now ?? Date.now)();
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  const reaped: string[] = [];
  for (const name of names) {
    if (!TRANSIENT_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = path.join(parent, name);
    try {
      const info = await stat(full);
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(full, { recursive: true, force: true });
      reaped.push(name);
    } catch {
      // 正被并发使用或已消失：跳过。
    }
  }
  return reaped;
}
