import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
import { currentUser, requireAuth } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { parseAgent } from './validation.ts';

const id = z.string().uuid();
const paramsSchema = z.object({ id });
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30), cursor: id.optional() });
const messageSchema = z.object({
  content: z.string().trim().max(4000),
  reasoning: z.enum(['快速', '均衡', '深入', '极高']).default('均衡'),
  attachmentIds: z.array(z.string().min(1).max(191)).max(4).default([]),
}).strict().refine((body) => body.content.length > 0 || body.attachmentIds.length > 0);
const attachmentInclude = { attachments: { include: { attachment: true } } } as const;
const missing = () => new PluginError('agent.conversation_not_found', 404, '对话不存在');

/** Chat history uses the logged-in human session; execution credentials are never needed or stored. */
export async function agentConversationRoutes(app: FastifyInstance) {
  const db = getPrisma();
  const authenticated = [requireAuth, async (request: FastifyRequest) => {
    if (currentUser(request).viaApiToken) throw new PluginError('agent.session_required', 403, '请使用登录会话管理对话');
  }];
  async function owned(request: FastifyRequest) {
    const { id } = parseAgent(paramsSchema, request.params);
    const row = await db.agentConversation.findFirst({ where: { id, userId: currentUser(request).id } });
    if (!row) throw missing();
    return row;
  }
  const messageView = (row: Awaited<ReturnType<typeof db.agentChatMessage.findMany>>[number] & {
    attachments: { attachment: { id: string; filename: string } }[];
  }) => ({
    id: row.id, objective: row.content, reasoning: row.reasoning, created: row.createdAt.getTime(),
    attachments: row.attachments.map(({ attachment }) => ({ id: attachment.id, name: attachment.filename, url: `/api/agent/attachments/${attachment.id}` })),
  });

  app.get('/api/v1/agent/conversations', { preHandler: authenticated }, async (request) => {
    const query = parseAgent(pageSchema.extend({ search: z.string().trim().max(200).optional() }), request.query);
    const userId = currentUser(request).id;
    const cursor = query.cursor ? await db.agentConversation.findFirst({ where: { id: query.cursor, userId } }) : null;
    if (query.cursor && !cursor) throw missing();
    const rows = await db.agentConversation.findMany({
      where: { userId, ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
        ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
    });
    return { conversations: rows.slice(0, query.limit), nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null };
  });
  app.post('/api/v1/agent/conversations', { preHandler: authenticated }, async (request, reply) => {
    const body = parseAgent(z.object({ id, title: z.string().trim().min(1).max(200) }).strict(), request.body);
    const userId = currentUser(request).id;
    // Client-generated IDs make a manually retried creation safe after a lost response.
    const row = await db.agentConversation.upsert({ where: { id: body.id }, create: { ...body, userId }, update: {} });
    if (row.userId !== userId) throw missing();
    return reply.code(201).send({ conversation: row });
  });
  app.get('/api/v1/agent/conversations/:id', { preHandler: authenticated }, async (request) => {
    const conversation = await owned(request);
    const query = parseAgent(pageSchema, request.query);
    const cursor = query.cursor ? await db.agentChatMessage.findFirst({ where: { id: query.cursor, conversationId: conversation.id } }) : null;
    if (query.cursor && !cursor) throw missing();
    const rows = await db.agentChatMessage.findMany({
      where: { conversationId: conversation.id, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, include: attachmentInclude,
    });
    return { conversation, turns: rows.slice(0, query.limit).reverse().map(messageView), nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null };
  });
  app.put('/api/v1/agent/conversations/:id', { preHandler: authenticated }, async (request) => {
    const row = await owned(request);
    const { title } = parseAgent(z.object({ title: z.string().trim().min(1).max(200) }).strict(), request.body);
    return { conversation: await db.agentConversation.update({ where: { id: row.id }, data: { title } }) };
  });
  app.delete('/api/v1/agent/conversations/:id', { preHandler: authenticated }, async (request, reply) => {
    const row = await owned(request);
    await db.agentConversation.deleteMany({ where: { id: row.id, userId: currentUser(request).id } });
    return reply.code(204).send();
  });
  app.put('/api/v1/agent/conversations/:id/messages/:messageId', { preHandler: authenticated }, async (request, reply) => {
    const params = parseAgent(paramsSchema.extend({ messageId: id }), request.params);
    const body = parseAgent(messageSchema, request.body);
    const userId = currentUser(request).id;
    const row = await db.$transaction(async (tx) => {
      // Serialize appends and deletion on this conversation, including duplicate requests.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "agent_conversations" WHERE "id" = ${params.id} AND "userId" = ${userId} FOR UPDATE`;
      if (!locked.length) throw missing();
      const existing = await tx.agentChatMessage.findUnique({ where: { id: params.messageId }, include: attachmentInclude });
      if (existing) {
        if (existing.conversationId !== params.id || existing.content !== body.content || existing.reasoning !== body.reasoning ||
          JSON.stringify(existing.attachments.map((a) => a.attachmentId).sort()) !== JSON.stringify([...new Set(body.attachmentIds)].sort())) {
          throw new PluginError('agent.message_conflict', 409, '该消息已保存，请刷新对话后再发送新消息');
        }
        return existing;
      }
      const attachmentIds = [...new Set(body.attachmentIds)];
      // Lock attachments against concurrent delete/visibility changes until linkage commits.
      for (const attachmentId of attachmentIds.sort()) {
        const files = await tx.$queryRaw<{ mime: string; size: number }[]>`SELECT "mime", "size" FROM "attachments" WHERE "id" = ${attachmentId} AND "ownerId" = ${userId} AND "visibility" = 'private' FOR UPDATE`;
        const file = files[0];
        if (!file || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime) || file.size > 5 * 1024 * 1024) {
          throw new PluginError('agent.attachment_invalid', 422, '请使用本人上传的私有图片，每张不超过 5 MB');
        }
      }
      const latest = await tx.agentChatMessage.findFirst({ where: { conversationId: params.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1));
      const message = await tx.agentChatMessage.create({ data: {
        createdAt,
        id: params.messageId, conversationId: params.id, content: body.content, reasoning: body.reasoning,
        attachments: { create: attachmentIds.map((attachmentId) => ({ attachmentId })) },
      }, include: attachmentInclude });
      await tx.agentConversation.update({ where: { id: params.id }, data: { updatedAt: new Date() } });
      return message;
    });
    return reply.code(201).send({ turn: messageView(row) });
  });
}
