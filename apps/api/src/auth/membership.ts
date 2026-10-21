/**
 * 限时权限组成员关系（会员权益）的读路径判定。
 *
 * 设计：`user_groups.expiresAt` 非空即「限时成员」。判定必须在**读路径**生效——
 * 过期后即使清扫任务还没跑，权限也不再生效。否则一次任务延迟或失败就会让过期
 * 会员继续享受权益（fail-open），这是不可接受的。
 *
 * 因此凡是「按用户读组/权限」的地方都要经过 {@link activeMembershipWhere}；
 * 清扫任务（`pruneExpiredUserGroups`）只负责清理残留行与发通知。
 */

/** Prisma where 片段：只保留永久成员（expiresAt=null）或尚未到期的成员。 */
export function activeMembershipWhere(now: Date = new Date()): {
  OR: Array<{ expiresAt: null } | { expiresAt: { gt: Date } }>;
} {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/** 判断一条成员关系是否仍然有效（未过期）。 */
export function isMembershipActive(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (expiresAt === null || expiresAt === undefined) return true;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() > now.getTime();
}
