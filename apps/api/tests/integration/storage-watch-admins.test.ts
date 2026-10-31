import { afterAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { ADMIN_PERMISSION, listAdminUserIds } from '../../src/lib/admin-recipients.ts';

/**
 * 告警收件人解析（`listAdminUserIds`，供存储巡检告警使用）。
 *
 * 这条查询很容易写「看起来对」但其实错：管理员在数据模型里**不是** `User` 上的字段，
 * 而是权限组授予的 `platform.admin`；而且限时成员（会员商品授予）必须按读路径
 * 规则过滤掉过期行，否则一条早就过期的管理员权益会让告警一直发给无权的人。
 * 用真实 DB 验，避免只靠假对象自证。
 */
const dbAvailable = await checkDbAvailable();
const prisma = getPrisma();

describe.skipIf(!dbAvailable)('listAdminUserIds（真实 DB）', () => {
  const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const groupId = `test-admins-${stamp}`;
  const otherGroupId = `test-plain-${stamp}`;
  const created: string[] = [];

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    }
    await prisma.permissionGroup.deleteMany({ where: { id: { in: [groupId, otherGroupId] } } })
      .catch(() => undefined);
  });

  it('只返回「有效管理员」，过期成员与非管理员都不算', async () => {
    const permission = await prisma.permission.upsert({
      where: { key: ADMIN_PERMISSION },
      update: {},
      create: { key: ADMIN_PERMISSION, name: '平台管理员' },
    });
    await prisma.permissionGroup.create({
      data: {
        id: groupId,
        name: `测试管理员组 ${stamp}`,
        permissions: { create: { permissionId: permission.id } },
      },
    });
    await prisma.permissionGroup.create({
      data: { id: otherGroupId, name: `测试普通组 ${stamp}` },
    });

    const admin = await prisma.user.create({
      data: { email: `admin-${stamp}@example.test`, groups: { create: { groupId } } },
    });
    const expiredAdmin = await prisma.user.create({
      data: {
        email: `expired-admin-${stamp}@example.test`,
        groups: {
          create: {
            groupId,
            // 会员权益到期：读路径会把它当作「无此权限」，收件人列表必须一致。
            expiresAt: new Date(Date.now() - 60_000),
          },
        },
      },
    });
    const plain = await prisma.user.create({
      data: { email: `plain-${stamp}@example.test`, groups: { create: { groupId: otherGroupId } } },
    });
    created.push(admin.id, expiredAdmin.id, plain.id);

    const ids = await listAdminUserIds(prisma);

    expect(ids).toContain(admin.id);
    expect(ids).not.toContain(expiredAdmin.id);
    expect(ids).not.toContain(plain.id);
  }, 30_000);
});
