import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { STRUCTURAL_GROUP_IDS } from '../../lib/user.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const groupSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(191).optional(),
  /** 代理折扣（%），0-99；null/缺省 = 无折扣。 */
  discount: z.number().int().min(0).max(99).nullable().optional(),
});

const groupUpdateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    description: z.string().max(191).optional(),
    /** Replace the group's permission set. */
    permissionKeys: z.array(z.string().min(1)).optional(),
    discount: z.number().int().min(0).max(99).nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.permissionKeys !== undefined ||
      v.discount !== undefined,
    { message: '至少需要修改一个字段' },
  );

export async function adminPermissionGroupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/permission-groups', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const groups = await prisma.permissionGroup.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        discount: group.discount,
        permissions: group.permissions.map((gp) => ({
          key: gp.permission.key,
          name: gp.permission.name,
        })),
      })),
    };
  });

  app.post('/admin/permission-groups', { preHandler: adminOnly }, async (request, reply) => {
    const body = groupSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const exists = await prisma.permissionGroup.findUnique({ where: { name: body.data.name } });
    if (exists) return reply.code(409).send({ error: '权限组名称已存在' });
    const group = await prisma.permissionGroup.create({
      data: {
        name: body.data.name,
        ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        ...(body.data.discount !== undefined ? { discount: body.data.discount } : {}),
      },
    });
    await writeAudit({
      action: 'permission_group.create',
      resource: 'permission_group',
      resourceId: group.id,
      meta: {
        name: group.name,
        ...(body.data.discount !== undefined ? { discount: body.data.discount } : {}),
      },
      ...auditContext(request),
    });
    return reply.code(201).send({ group });
  });

  app.patch('/admin/permission-groups/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = groupUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
    const { id } = params.data;
    const prisma = getPrisma();
    const existing = await prisma.permissionGroup.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: '权限组不存在' });

    await prisma.$transaction(async (tx) => {
      const data: Record<string, string | number | null | undefined> = {};
      if (body.data.name !== undefined) data.name = body.data.name;
      if (body.data.description !== undefined) data.description = body.data.description;
      if (body.data.discount !== undefined) data.discount = body.data.discount;
      const updateData = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(updateData).length > 0) {
        await tx.permissionGroup.update({ where: { id }, data: updateData });
      }
      if (body.data.permissionKeys !== undefined) {
        const keys = body.data.permissionKeys;
        const perms = await tx.permission.findMany({ where: { key: { in: keys } } });
        if (perms.length !== keys.length) throw new Error('权限不存在');
        await tx.groupPermission.deleteMany({ where: { groupId: id } });
        await tx.groupPermission.createMany({
          data: perms.map((p) => ({ groupId: id, permissionId: p.id })),
        });
      }
    });
    await writeAudit({
      action: 'permission_group.update',
      resource: 'permission_group',
      resourceId: id,
      meta: {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.permissionKeys !== undefined
          ? { permissionKeys: body.data.permissionKeys }
          : {}),
        ...(body.data.discount !== undefined ? { discount: body.data.discount } : {}),
      },
      ...auditContext(request),
    });
    return { updated: true };
  });

  app.delete('/admin/permission-groups/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const group = await prisma.permissionGroup.findUnique({ where: { id: params.data.id } });
    if (!group) return reply.code(404).send({ error: '权限组不存在' });
    if (STRUCTURAL_GROUP_IDS.includes(group.id)) {
      return reply.code(403).send({ error: '系统内置权限组不可删除' });
    }
    await prisma.permissionGroup.delete({ where: { id: params.data.id } });
    await writeAudit({
      action: 'permission_group.delete',
      resource: 'permission_group',
      resourceId: params.data.id,
      ...auditContext(request),
    });
    return { deleted: true };
  });
}
