import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { KernelAuthService } from '../../src/auth/auth-service.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { permissionsOf } from '../../src/plugins/auth.ts';
import { checkDbAvailable } from '../helpers.ts';

/**
 * 会员权益（限时权限组）真实 Postgres 验收。
 *
 * 这组测试要证明的是**授权正确性**，不是插件 UI：
 *  1. 到期后 `hasPermission` / `permissionsOf` / `listUserGroups` 立即失效，
 *     即使清扫任务从未运行（读路径判定）。
 *  2. 折扣随到期一起失效（`listUserGroups` 是结账折扣的唯一来源）。
 *  3. 清扫只删除过期行，永久成员（管理员手工授予）不受影响。
 *  4. 管理员编辑用户时不会把限时成员静默改成永久成员（静默提权）。
 */

const dbAvailable = await checkDbAvailable();
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let auth: KernelAuthService;
let groupId: string;

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  if (!dbAvailable) return;
  app = await buildApp();
  await app.ready();
  auth = new KernelAuthService({ db: getPrisma() });
  // 专用权限组：带折扣 + 一个可判定的权限，避免与种子组互相干扰。
  const suffix = newId('m');
  const permission = await getPrisma().permission.create({
    data: { key: `membership.test.${suffix}`, name: '会员测试权限' },
  });
  const group = await getPrisma().permissionGroup.create({
    data: {
      name: `会员测试组 ${suffix}`,
      description: '限时会员权益测试',
      discount: 15,
      permissions: { create: [{ permissionId: permission.id }] },
    },
  });
  groupId = group.id;
  process.env['__MEMBERSHIP_TEST_PERMISSION'] = permission.key;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await getPrisma().userGroup.deleteMany({ where: { groupId } });
  await getPrisma().permissionGroup.deleteMany({ where: { id: groupId } });
  await app.close();
});

async function createUser(): Promise<string> {
  const email = `${newId('member')}@example.test`;
  const user = await getPrisma().user.create({ data: { email, status: 'ACTIVE' } });
  return user.id;
}

function permission(): string {
  return process.env['__MEMBERSHIP_TEST_PERMISSION'] ?? '';
}

describe.runIf(dbAvailable)('会员权益：限时权限组', () => {
  it('授予后立即生效，并带上折扣与到期时间', async () => {
    const userId = await createUser();
    const expiresAt = new Date(Date.now() + 30 * DAY);
    await auth.grantUserGroup({ userId, groupId, expiresAt });

    await expect(auth.hasPermission(userId, permission())).resolves.toBe(true);
    expect(await permissionsOf(userId)).toContain(permission());
    const groups = await auth.listUserGroups(userId);
    const group = groups.find((candidate) => candidate.id === groupId);
    expect(group?.discount).toBe(15);
    expect(group?.expiresAt).toBe(expiresAt.toISOString());
  });

  it('到期后即使不跑清扫任务，权限与折扣也立即失效', async () => {
    const userId = await createUser();
    // 授予一个「马上到期」的成员关系，绕过 grant 的过去时间校验。
    await getPrisma().userGroup.create({
      data: { userId, groupId, expiresAt: new Date(Date.now() + 50) },
    });
    await expect(auth.hasPermission(userId, permission())).resolves.toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 120));

    // 读路径必须已经拒绝——这是「到期即失效」的权威判定。
    await expect(auth.hasPermission(userId, permission())).resolves.toBe(false);
    expect(await permissionsOf(userId)).not.toContain(permission());
    // 折扣来源也必须是空的，否则过期会员还能继续打折。
    expect(await auth.listUserGroups(userId)).toEqual([]);
    // 记录还在（等待清扫），说明结论来自读路径而非删除。
    expect(await auth.listUserGroupGrants(userId)).toHaveLength(1);
  });

  it('grantUserGroup 拒绝已经过去的到期时间（避免写入即过期）', async () => {
    const userId = await createUser();
    await expect(
      auth.grantUserGroup({ userId, groupId, expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toThrow(/到期时间必须晚于当前时间/);
    await expect(auth.hasPermission(userId, permission())).resolves.toBe(false);
  });

  it('grantUserGroup 幂等：重复授予按新到期时间覆盖，不产生重复行', async () => {
    const userId = await createUser();
    const first = new Date(Date.now() + 10 * DAY);
    const second = new Date(Date.now() + 40 * DAY);
    await auth.grantUserGroup({ userId, groupId, expiresAt: first });
    await auth.grantUserGroup({ userId, groupId, expiresAt: second });

    const rows = await getPrisma().userGroup.findMany({ where: { userId, groupId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt?.toISOString()).toBe(second.toISOString());
  });

  it('清扫只删过期行，永久成员（管理员授予）保留', async () => {
    const expiredUser = await createUser();
    const permanentUser = await createUser();
    await getPrisma().userGroup.create({
      data: { userId: expiredUser, groupId, expiresAt: new Date(Date.now() - 1000) },
    });
    // 永久成员：expiresAt 为 null，代表管理员手工授予。
    await auth.grantUserGroup({ userId: permanentUser, groupId, expiresAt: null });

    const removed = await auth.pruneExpiredUserGroups();
    expect(removed.some((row) => row.userId === expiredUser)).toBe(true);

    const expiredRows = await getPrisma().userGroup.findMany({
      where: { userId: expiredUser, groupId },
    });
    expect(expiredRows).toHaveLength(0);
    const permanentRows = await getPrisma().userGroup.findMany({
      where: { userId: permanentUser, groupId },
    });
    expect(permanentRows).toHaveLength(1);
    await expect(auth.hasPermission(permanentUser, permission())).resolves.toBe(true);
  });

  it('revokeUserGroup 幂等：不存在时返回 false 而不是抛错', async () => {
    const userId = await createUser();
    await expect(auth.revokeUserGroup(userId, groupId)).resolves.toBe(false);
  });

  it('管理员编辑用户不会把限时成员静默改成永久成员', async () => {
    const userId = await createUser();
    const expiresAt = new Date(Date.now() + 20 * DAY);
    await auth.grantUserGroup({ userId, groupId, expiresAt });

    // 管理员只改状态、同时提交「保持原组」——旧实现会 deleteMany + createMany，
    // 把 expiresAt 丢掉，等价于一次静默提权。
    const { UserAdminService } = await import('../../src/lib/user-admin.ts');
    const admin = await getPrisma().user.create({
      data: { email: `${newId('admin')}@example.test`, status: 'ACTIVE' },
    });
    const service = new UserAdminService({
      prisma: getPrisma(),
      wallet: app.wallet,
      auth: app.auth,
    });
    await service.updateUser(
      userId,
      { groupIds: ['group_user', groupId] },
      { id: admin.id, permissions: new Set(['platform.admin']) },
      {},
    );

    const rows = await getPrisma().userGroup.findMany({ where: { userId, groupId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it('限时授予不会把管理员手工授予的永久成员降级为到期成员', async () => {
    const userId = await createUser();
    // 管理员手工授予永久成员（expiresAt=null）。
    await auth.grantUserGroup({ userId, groupId, expiresAt: null });
    // 会员商品开通：带到期时间。若直接 upsert 覆盖，就把永久权益改成了会到期的。
    const timed = new Date(Date.now() + 5 * DAY);
    const result = await auth.grantUserGroup({ userId, groupId, expiresAt: timed });
    expect(result.expiresAt).toBeNull();

    const rows = await getPrisma().userGroup.findMany({ where: { userId, groupId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt).toBeNull();
  });

  it('限时授予可以延长（续费），不会被永久保护挡住', async () => {
    const userId = await createUser();
    const first = new Date(Date.now() + 5 * DAY);
    const second = new Date(Date.now() + 35 * DAY);
    await auth.grantUserGroup({ userId, groupId, expiresAt: first });
    const result = await auth.grantUserGroup({ userId, groupId, expiresAt: second });
    expect(result.expiresAt).toBe(second.toISOString());
  });

  it('listPermissionGroups 返回全部组（供商品表单选择授予目标）', async () => {
    const groups = await auth.listPermissionGroups();
    expect(groups.some((group) => group.id === groupId)).toBe(true);
    expect(groups.some((group) => group.id === 'group_admin')).toBe(true);
  });
});
