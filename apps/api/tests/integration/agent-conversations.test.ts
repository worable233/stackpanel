import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isPluginError } from '@stackpanel/sdk';
import { agentConversationRoutes } from '../../src/agent/conversations.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { getSessionStore } from '../../src/auth/session-store.ts';

const db = getPrisma();
const app = Fastify();
let userId: string; let otherId: string; let session: string; let other: string;
const prefix = '/api/v1/agent/conversations';
const auth = () => ({ authorization: `Bearer ${session}` });
const make = async (title = '云产品检查') => {
  const id = randomUUID();
  const response = await app.inject({ method: 'POST', url: prefix, headers: auth(), payload: { id, title } });
  expect(response.statusCode).toBe(201); return id;
};
const put = (id: string, messageId: string, content = '检查我的云产品', attachmentIds: string[] = []) => app.inject({
  method: 'PUT', url: `${prefix}/${id}/messages/${messageId}`, headers: auth(), payload: { content, attachmentIds, reasoning: '深入' },
});

beforeAll(async () => {
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (isPluginError(error)) return reply.code(error.status).send({ code: error.code, detail: error.message });
    return reply.code(500).send({ error: String(error) });
  });
  await app.register(agentConversationRoutes);
  userId = (await db.user.create({ data: { email: `chat-${randomUUID()}@example.test` } })).id;
  otherId = (await db.user.create({ data: { email: `chat-${randomUUID()}@example.test` } })).id;
  session = await getSessionStore().create(userId);
  other = await getSessionStore().create(otherId);
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await db.attachment.deleteMany({ where: { ownerId: { in: [userId, otherId] } } });
  await app.close(); await db.$disconnect();
});

describe('Agent chat history with real auth and PostgreSQL', () => {
  it('requires a login and rejects client-supplied identity or assistant output', async () => {
    expect((await app.inject({ url: prefix })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: prefix, headers: auth(), payload: { id: randomUUID(), title: 'bad', userId: otherId } })).statusCode).toBe(422);
    const id = await make();
    expect((await app.inject({ method: 'PUT', url: `${prefix}/${id}/messages/${randomUUID()}`, headers: auth(), payload: { content: 'test', role: 'assistant' } })).statusCode).toBe(422);
  });
  it('persists messages and reasoning, deduplicates concurrent retries, rejects changed payloads', async () => {
    const id = await make(); const messageId = randomUUID();
    const responses = await Promise.all([put(id, messageId), put(id, messageId)]);
    expect(responses.map((res) => res.statusCode)).toEqual([201, 201]);
    expect((await put(id, messageId, 'changed')).statusCode).toBe(409);
    const page = (await app.inject({ url: `${prefix}/${id}`, headers: auth() })).json();
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]).toMatchObject({ id: messageId, objective: '检查我的云产品', reasoning: '深入', attachments: [] });
    expect(page.turns[0].summary).toBeUndefined();
    expect(await db.agentChatMessage.count({ where: { conversationId: id } })).toBe(1);
    const recreate = await app.inject({ method: 'POST', url: prefix, headers: auth(), payload: { id, title: '重试' } });
    expect(recreate.statusCode).toBe(201);
    expect(recreate.json().conversation.title).toBe('云产品检查');
  });
  it('blocks other users from reading, appending, renaming, deleting or reusing a conversation ID', async () => {
    const id = await make(); const headers = { authorization: `Bearer ${other}` };
    for (const [method, path, payload] of [
      ['GET', `/${id}`, undefined], ['PUT', `/${id}`, { title: 'hijack' }], ['DELETE', `/${id}`, undefined],
      ['POST', '', { id, title: 'hijack' }], ['PUT', `/${id}/messages/${randomUUID()}`, { content: 'hijack' }],
    ] as const) {
      expect((await app.inject({ method, url: `${prefix}${path}`, headers, ...(payload ? { payload } : {}) })).statusCode).toBe(404);
    }
    const list = (await app.inject({ url: prefix, headers })).json(); expect(list.conversations).toEqual([]);
  });
  it('paginates history without gaps, validates owned cursors, renames and searches on the server', async () => {
    const id = await make('unique-before');
    for (let i = 0; i < 5; i++) expect((await put(id, randomUUID(), `message ${i}`)).statusCode).toBe(201);
    const first = (await app.inject({ url: `${prefix}/${id}?limit=2`, headers: auth() })).json();
    const second = (await app.inject({ url: `${prefix}/${id}?limit=2&cursor=${first.nextCursor}`, headers: auth() })).json();
    const third = (await app.inject({ url: `${prefix}/${id}?limit=2&cursor=${second.nextCursor}`, headers: auth() })).json();
    expect([...third.turns, ...second.turns, ...first.turns].map((row: { objective: string }) => row.objective)).toEqual(['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);
    expect(third.nextCursor).toBeNull();
    expect((await app.inject({ method: 'PUT', url: `${prefix}/${id}`, headers: auth(), payload: { title: 'unique-renamed' } })).statusCode).toBe(200);
    const results = (await app.inject({ url: `${prefix}?search=unique-renamed`, headers: auth() })).json();
    expect(results.conversations.map((row: { id: string }) => row.id)).toEqual([id]);
    const headers = { authorization: `Bearer ${other}` };
    expect((await app.inject({ url: `${prefix}?cursor=${id}`, headers })).statusCode).toBe(404);
    const allIds = new Set<string>(); let cursor: string | null = null;
    do {
      const page: { conversations: { id: string }[]; nextCursor: string | null } = (await app.inject({ url: `${prefix}?limit=2${cursor ? `&cursor=${cursor}` : ''}`, headers: auth() })).json();
      for (const row of page.conversations) { expect(allIds.has(row.id)).toBe(false); allIds.add(row.id); }
      cursor = page.nextCursor;
    } while (cursor);
    expect(allIds.size).toBe(await db.agentConversation.count({ where: { userId } }));
  });
  it('only links owned private images, protects referenced bytes and cascades conversation deletion', async () => {
    const id = await make();
    const file = async (ownerId: string, visibility: string, mime = 'image/png') => db.attachment.create({ data: { key: randomUUID(), filename: 'photo.png', mime, size: 100, ownerId, visibility } });
    const own = await file(userId, 'private'); const foreign = await file(otherId, 'private'); const publicImage = await file(userId, 'public'); const svg = await file(userId, 'private', 'image/svg+xml');
    for (const invalid of [foreign, publicImage, svg]) expect((await put(id, randomUUID(), '', [invalid.id])).statusCode).toBe(422);
    expect((await put(id, randomUUID(), '', [own.id])).statusCode).toBe(201);
    const page = (await app.inject({ url: `${prefix}/${id}`, headers: auth() })).json();
    expect(page.turns[0].attachments[0]).toEqual({ id: own.id, name: own.filename, url: `/api/agent/attachments/${own.id}` });
    await expect(db.attachment.delete({ where: { id: own.id } })).rejects.toThrow();
    expect((await app.inject({ method: 'DELETE', url: `${prefix}/${id}`, headers: auth() })).statusCode).toBe(204);
    expect(await db.agentChatMessage.count({ where: { conversationId: id } })).toBe(0);
    expect(await db.agentMessageAttachment.count({ where: { attachmentId: own.id } })).toBe(0);
    expect((await app.inject({ url: `${prefix}/${id}`, headers: auth() })).statusCode).toBe(404);
  });
});
