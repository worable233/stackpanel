/**
 * Prisma 唯一约束冲突的判定与幂等写入辅助。
 *
 * ## 为什么需要
 *
 * `api` 与 `worker` 是**两个容器**，共享同一个数据库，启动时都会执行
 * `registerPlugins()` → 权限 seed。Prisma 的 `upsert` 在唯一约束上**不是原子的**
 * （实现为 select-then-insert）：两个进程同时发现记录不存在、同时 insert，后到
 * 的一个就抛 P2002。
 *
 * 实测后果：全新部署 `docker compose up` 首次启动就崩 ——
 * `duplicate key value violates unique constraint "group_permissions_pkey"`，
 * api 容器进入重启循环。这不是罕见竞态，而是**每次全新安装都命中**。
 *
 * 这类写入本身是幂等的（授予一个已存在的权限 = 什么都不做），所以吞掉并发冲突
 * 是正确语义，不是掩盖错误。其他错误一律继续上报：吞错误比冲突本身更危险。
 */

/** 是不是唯一约束冲突（Prisma P2002 / PG 23505）。 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === 'P2002') return true;
  // Prisma 7 走 driver adapter 时 code 藏在 meta 里。
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })
    .meta;
  return meta?.driverAdapterError?.cause?.originalCode === '23505';
}

/**
 * 幂等的 `upsert`：并发被对手抢先时视为成功。
 *
 * `recover` 用于「create 冲突后需要把对手插入的行读回来」的场景；不传则返回
 * undefined（适合 `update: {}` 这类纯授予写入）。
 */
export async function upsertIgnoringRace<T>(
  run: () => Promise<T>,
  recover?: () => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return recover ? recover() : undefined;
  }
}
