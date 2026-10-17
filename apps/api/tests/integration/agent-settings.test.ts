import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPluginError } from '@stackpanel/sdk';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { getSessionStore } from '../../src/auth/session-store.ts';
import { agentSettingsRoutes } from '../../src/agent/settings.ts';
import {
  cleanupConversations,
  readRetention,
  RETENTION_KEY,
  CLEANUP_KEY,
  registerConversationRetentionJobs,
} from '../../src/agent/retention.ts';

const db = getPrisma();
const app = Fastify();
let adminId: string;
let userId: string;
let token: string;
let userToken: string;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * 86400_000);
const policy = (retentionDays: number | null, maxConversationsPerUser: number | null) =>
  db.setting.upsert({
    where: { key: RETENTION_KEY },
    create: { key: RETENTION_KEY, value: { retentionDays, maxConversationsPerUser } },
    update: { value: { retentionDays, maxConversationsPerUser } },
  });
const chat = (owner: string, updatedAt: Date) =>
  db.agentConversation.create({
    data: {
      id: randomUUID(),
      userId: owner,
      title: 'retention-test',
      createdAt: ago(300),
      updatedAt,
    },
  });
beforeAll(async () => {
  app.setErrorHandler((error, _request, reply) =>
    isPluginError(error)
      ? reply.code(error.status).send({ detail: error.message })
      : reply.code(500).send({ error: String(error) }),
  );
  await app.register(agentSettingsRoutes);
  adminId = (
    await db.user.create({ data: { email: `retention-admin-${randomUUID()}@example.test` } })
  ).id;
  await db.userGroup.create({ data: { userId: adminId, groupId: 'group_admin' } });
  userId = (
    await db.user.create({ data: { email: `retention-user-${randomUUID()}@example.test` } })
  ).id;
  token = await getSessionStore().create(adminId);
  userToken = await getSessionStore().create(userId);
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
  await db.setting.deleteMany({ where: { key: { in: [RETENTION_KEY, CLEANUP_KEY] } } });
  await app.close();
  await db.$disconnect();
});
describe('Agent retention settings and real PostgreSQL cleanup', () => {
  it('requires admin and rejects malformed rules; defaults preserve history', async () => {
    expect((await app.inject({ url: '/admin/agent/retention' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/admin/agent/retention',
          headers: { authorization: `Bearer ${userToken}` },
        })
      ).statusCode,
    ).toBe(403);
    const headers = { authorization: `Bearer ${token}` };
    for (const value of [-1, 0, 1.5, 3651])
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/admin/agent/retention',
            headers,
            payload: { retentionDays: value, maxConversationsPerUser: null },
          })
        ).statusCode,
      ).toBe(422);
    await db.setting.deleteMany({ where: { key: RETENTION_KEY } });
    const old = await chat(userId, ago(200));
    expect(await readRetention(db)).toEqual({ retentionDays: null, maxConversationsPerUser: null });
    expect((await cleanupConversations(db, now)).deleted).toBe(0);
    expect(await db.agentConversation.findUnique({ where: { id: old.id } })).not.toBeNull();
  });
  it('expires by last activity, cascades messages and links, preserves media', async () => {
    await db.agentConversation.deleteMany({ where: { userId } });
    await policy(30, null);
    const old = await chat(userId, ago(31));
    const active = await chat(userId, ago(1));
    const file = await db.attachment.create({
      data: {
        ownerId: userId,
        filename: 'keep.png',
        mime: 'image/png',
        size: 1,
        visibility: 'private',
        key: `retention/${randomUUID()}`,
      },
    });
    const message = await db.agentChatMessage.create({
      data: {
        id: randomUUID(),
        conversationId: old.id,
        content: 'old',
        attachments: { create: { attachmentId: file.id } },
      },
    });
    expect((await cleanupConversations(db, now)).deleted).toBe(1);
    expect(await db.agentChatMessage.findUnique({ where: { id: message.id } })).toBeNull();
    expect(await db.agentMessageAttachment.count({ where: { attachmentId: file.id } })).toBe(0);
    expect(await db.attachment.findUnique({ where: { id: file.id } })).not.toBeNull();
    expect(await db.agentConversation.findUnique({ where: { id: active.id } })).not.toBeNull();
    await db.attachment.delete({ where: { id: file.id } });
  });
  it('caps each user independently and safely handles concurrent cleanup', async () => {
    await db.agentConversation.deleteMany({ where: { userId: { in: [adminId, userId] } } });
    await policy(null, 2);
    const oldest = await chat(userId, ago(8));
    const middle = await chat(userId, ago(4));
    const newest = await chat(userId, ago(1));
    const other = await chat(adminId, ago(100));
    const results = await Promise.all([
      cleanupConversations(db, now),
      cleanupConversations(db, now),
    ]);
    expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBe(1);
    expect(await db.agentConversation.findUnique({ where: { id: oldest.id } })).toBeNull();
    for (const row of [middle, newest, other])
      expect(await db.agentConversation.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('saves via admin API and applies manual cleanup, including stats', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const save = await app.inject({
      method: 'PUT',
      url: '/admin/agent/retention',
      headers,
      payload: { retentionDays: 30, maxConversationsPerUser: null },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().policy.retentionDays).toBe(30);
    const clean = await app.inject({
      method: 'POST',
      url: '/admin/agent/retention/cleanup',
      headers,
      payload: {},
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().result.deleted).toBe(1);
    expect(clean.json().stats.conversations).toBe(2);
    expect(clean.json().lastCleanup.completedAt).toBeTruthy();
  });
  it('registers the hourly job with a handler on the common kernel context', () => {
    let handler = '';
    let schedule: unknown;
    registerConversationRetentionJobs({
      enqueue: async () => 'test-job',
      handle: (name: string) => {
        handler = name;
        return () => {};
      },
      schedule: async (name: string, interval: unknown) => {
        schedule = { name, interval };
      },
    } as Parameters<typeof registerConversationRetentionJobs>[0]);
    expect(handler).toBe('agent.conversation-cleanup');
    expect(schedule).toEqual({ name: handler, interval: { everyMs: 3600000 } });
  });
});
