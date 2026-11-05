/**
 * 判断一个错误是不是**唯一约束冲突**（Prisma P2002 / PostgreSQL 23505）。
 *
 * ## 为什么插件需要它
 *
 * 扩展模型上的唯一索引是最可靠的「唯一性闸门」：应用层先查后写只能给出好读的
 * 提示，挡不住并发（两个请求可以同时通过 `existing.items.length === 0`）。
 *
 * 但索引冲突抛出的是数据库错误，用户看不懂。插件应当在 create 失败时把它译回
 * 业务错误 —— 这个函数就是那次判断，且必须同时认出两种形态：
 *
 * - Prisma 顶层 `code: 'P2002'`；
 * - Prisma 7 走 driver adapter 时藏在 `meta.driverAdapterError.cause.originalCode`
 *   的 PostgreSQL `23505`。
 *
 * 只认这两种。其他错误一律返回 false —— 把无关错误当成冲突吞掉，比冲突本身更
 * 危险。
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === 'P2002') return true;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })
    .meta;
  return meta?.driverAdapterError?.cause?.originalCode === '23505';
}
