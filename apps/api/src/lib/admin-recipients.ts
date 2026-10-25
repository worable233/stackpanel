import type { PrismaClient } from '@stackpanel/db';

/**
 * 「管理员」在数据模型里不是一个字段，而是权限组授予的 `platform.admin`（RBAC）。
 *
 * 告警类通知需要一个收件人列表时，必须按**同一口径**取人：写死 `role: 'ADMIN'`
 * 之类的判断会挑出「看起来是管理员但没有权限」的收件人，或者漏掉真正有权的人。
 * 时限成员（会员商品授予）按读路径规则过滤过期行 —— 与 `hasPermission` 一致。
 */
export const ADMIN_PERMISSION = 'platform.admin';

export async function listAdminUserIds(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<string[]> {
  const admins = await db.user.findMany({
    where: {
      groups: {
        some: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          group: { permissions: { some: { permission: { key: ADMIN_PERMISSION } } } },
        },
      },
    },
    select: { id: true },
  });
  return admins.map((admin) => admin.id);
}
