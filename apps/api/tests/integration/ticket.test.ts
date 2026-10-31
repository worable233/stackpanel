import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../src/config/env.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 工单插件（#9）契约验收。
 *
 * #9 审计指出「工单」被当成一行笼统能力：一边**高估**（把「指派」说成了完整
 * 接单/转交流程），一边**漏记**（用户关单、催单、部门/分类/关联业务对象都
 * 没有）。这份用例按真实缺口逐条锁死行为，而不是只验「接口存在」：
 *
 *  - 用户能关自己的单，**不能**关别人的单；关单幂等。
 *  - 催单有冷却，且不改状态、不写消息（不污染时间线）。
 *  - 接单 = 指派给自己并从 OPEN 自动进 IN_PROGRESS（单一写入路径）。
 *  - 转交只换处理人并通知新处理人；CLOSED 是终态，不能回退。
 *  - 内部备注对用户不可见 —— 这是最容易在视图层漏掉的越权。
 *  - 分类/部门/关联对象能存下来，并能被管理端筛选。
 *
 * 工单插件是**运行时安装**的（`data/plugins/ticket`，源码在 StackPanel-plugins），
 * 缺产物时整组跳过而不是误报失败。
 */
const TICKET_TABLE = 'ext_ticket_ticket';
const MESSAGE_TABLE = 'ext_ticket_message';

/**
 * 注释里写了「缺产物时整组跳过」，但原先只判了数据库可用性 —— 注释与代码
 * 不一致，CI 上就变成 `PATCH /admin/plugins/ticket` 返回 404 而不是跳过。
 * 真实探测一下安装产物：插件不在内核仓库里，只在装过它的 data 目录存在。
 */
const ticketInstalled = existsSync(
  path.join(
    env.STACKPANEL_DATA_DIR ?? path.join(process.cwd(), 'data'),
    'plugins',
    'ticket',
    'manifest.json',
  ),
);

describe.skipIf(!dbAvailable || !ticketInstalled)(
  'ticket plugin contract (real DB, runtime-installed)',
  () => {
    let app: FastifyInstance;
    const adminEmail = `tk_admin_${Date.now()}@example.com`;
    const userEmail = `tk_user_${Date.now()}@example.com`;
    const otherEmail = `tk_other_${Date.now()}@example.com`;
    const password = 'IntegrationPass123';
    let adminToken = '';
    let userToken = '';
    let otherToken = '';
    let ticketId = '';
    let otherTicketId = '';
    const userIds: string[] = [];

    beforeAll(async () => {
      app = buildApp();
      await app.ready();
      await app.pluginRuntime.activate('login');
      const prisma = getPrisma();
      const admin = await createAdminUser(app, adminEmail, password);
      const user = await createTestUser(app, userEmail, password);
      const other = await createTestUser(app, otherEmail, password);
      userIds.push(admin.userId, user.userId, other.userId);
      adminToken = admin.token;
      userToken = user.token;
      otherToken = other.token;
      await prisma.plugin.deleteMany({ where: { id: 'ticket' } });
      const enable = await app.inject({
        method: 'PATCH',
        url: '/admin/plugins/ticket',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { enabled: true },
      });
      expect(enable.statusCode).toBe(200);
    });

    afterAll(async () => {
      const prisma = getPrisma();
      await prisma
        .$executeRawUnsafe(`DELETE FROM "${MESSAGE_TABLE}" WHERE true`)
        .catch(() => undefined);
      await prisma
        .$executeRawUnsafe(`DELETE FROM "${TICKET_TABLE}" WHERE true`)
        .catch(() => undefined);
      await prisma.plugin.deleteMany({ where: { id: 'ticket' } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await app.close();
    });

    it('requires auth on user ticket routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/tickets' });
      expect(res.statusCode).toBe(401);
    });

    it('creates a ticket carrying category / department / related object', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tickets',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          subject: '订单 42 未开通',
          body: '已付款但服务没到账',
          category: 'billing',
          relatedType: 'order',
          relatedId: 'order_42',
        },
      });
      expect(res.statusCode).toBe(201);
      const ticket = (
        res.json() as {
          ticket: { id: string; category: string; relatedType: string; relatedId: string };
        }
      ).ticket;
      ticketId = ticket.id;
      expect(ticket.category).toBe('billing');
      expect(ticket.relatedType).toBe('order');
      expect(ticket.relatedId).toBe('order_42');
    });

    it('rejects a one-sided related reference', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tickets',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { subject: 'x', body: 'y', relatedId: 'order_1' },
      });
      expect(res.statusCode).toBe(400);
    });

    /**
     * `?all=true` exists because the account pages used to assemble their ticket
     * list by looping over `/tickets?page=n` **inside a web-process finder** —
     * plugin code running in the host purely to paginate. The pages now declare a
     * single bounded read instead, so the endpoint has to return the same set the
     * loop did, and only the caller's own tickets.
     */
    it('all=true returns the whole set, scoped to the caller', async () => {
      const mine = await app.inject({
        method: 'GET',
        url: '/tickets?all=true',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(mine.statusCode).toBe(200);
      const body = mine.json() as { tickets: Array<{ id: string }>; total: number };
      expect(body.total).toBe(body.tickets.length);
      expect(body.tickets.some((ticket) => ticket.id === ticketId)).toBe(true);

      const others = await app.inject({
        method: 'GET',
        url: '/tickets?all=true',
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(others.statusCode).toBe(200);
      const otherBody = others.json() as { tickets: Array<{ id: string }> };
      expect(otherBody.tickets.some((ticket) => ticket.id === ticketId)).toBe(false);
    });

    it('paginates as before when all=true is absent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tickets?page=1&pageSize=1',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { tickets: unknown[]; page: number; pageSize: number };
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(1);
      expect(body.tickets.length).toBeLessThanOrEqual(1);
    });

    it('keeps internal notes out of the user view', async () => {
      const note = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: '怀疑是渠道回调没到，内部排查', internal: true },
      });
      expect(note.statusCode).toBe(201);
      const userView = await app.inject({
        method: 'GET',
        url: `/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      const bodies = (userView.json() as { messages: Array<{ body: string }> }).messages.map(
        (m) => m.body,
      );
      expect(bodies).not.toContain('怀疑是渠道回调没到，内部排查');
      const adminView = await app.inject({
        method: 'GET',
        url: `/ticket/admin/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const adminBodies = (
        adminView.json() as { messages: Array<{ body: string; internal: boolean }> }
      ).messages;
      expect(adminBodies.some((m) => m.internal)).toBe(true);
    });

    it('forbids a non-admin from writing an internal note', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: 'let me see', internal: true },
      });
      expect(res.statusCode).toBe(403);
    });

    it('accepting a ticket moves it to IN_PROGRESS and assigns the admin', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/ticket/admin/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { assigneeId: userIds[0] },
      });
      expect(res.statusCode).toBe(200);
      const ticket = (res.json() as { ticket: { status: string; assigneeId: string } }).ticket;
      expect(ticket.assigneeId).toBe(userIds[0]);
      expect(ticket.status).toBe('IN_PROGRESS');
    });

    it('transferring changes the assignee without touching status', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/ticket/admin/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { assigneeId: userIds[1] },
      });
      expect(res.statusCode).toBe(200);
      const ticket = (res.json() as { ticket: { status: string; assigneeId: string } }).ticket;
      expect(ticket.assigneeId).toBe(userIds[1]);
      expect(ticket.status).toBe('IN_PROGRESS');
    });

    it('filters the admin queue by category and unassigned', async () => {
      const byCategory = await app.inject({
        method: 'GET',
        url: '/ticket/admin/tickets?category=billing',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect((byCategory.json() as { total: number }).total).toBe(1);
      const unassigned = await app.inject({
        method: 'GET',
        url: '/ticket/admin/tickets?unassigned=true',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect((unassigned.json() as { total: number }).total).toBe(0);
    });

    it('urges once, then rate-limits within the cooldown', async () => {
      const first = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(first.statusCode).toBe(200);
      expect((first.json() as { ticket: { reminderCount: number } }).ticket.reminderCount).toBe(1);
      const second = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(second.statusCode).toBe(429);
    });

    it('does not let a user close somebody else ticket', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/close`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('lets the owner close the ticket and is idempotent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { reason: '问题已自行解决' },
      });
      expect(res.statusCode).toBe(200);
      const ticket = (res.json() as { ticket: { status: string; closedBy: string } }).ticket;
      expect(ticket.status).toBe('CLOSED');
      expect(ticket.closedBy).toBe('user');
      const again = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      expect(again.statusCode).toBe(200);
      // 幂等：第二次不应再写一条「关闭原因」消息。
      const messages = await app.inject({
        method: 'GET',
        url: `/ticket/admin/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const bodies = (messages.json() as { messages: Array<{ body: string }> }).messages.map(
        (m) => m.body,
      );
      expect(bodies.filter((b) => b === '问题已自行解决').length).toBe(1);
    });

    it('blocks replies and remiders on a closed ticket', async () => {
      const reply = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: 'still broken' },
      });
      expect(reply.statusCode).toBe(409);
      const remind = await app.inject({
        method: 'POST',
        url: `/tickets/${ticketId}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(remind.statusCode).toBe(409);
    });

    it('refuses to reopen a closed ticket through the admin update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/ticket/admin/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'OPEN' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('reopens automatically when the user replies to a RESOLVED ticket', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/tickets',
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { subject: 'second ticket', body: 'first' },
      });
      otherTicketId = (created.json() as { ticket: { id: string } }).ticket.id;
      await app.inject({
        method: 'PATCH',
        url: `/ticket/admin/tickets/${otherTicketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'RESOLVED' },
      });
      const reply = await app.inject({
        method: 'POST',
        url: `/tickets/${otherTicketId}/messages`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { body: 'not fixed yet' },
      });
      expect(reply.statusCode).toBe(201);
      const view = await app.inject({
        method: 'GET',
        url: `/tickets/${otherTicketId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect((view.json() as { status: string }).status).toBe('IN_PROGRESS');
    });
  },
);
