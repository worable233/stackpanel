CREATE TABLE "agent_conversations" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "agent_conversations_userId_createdAt_id_idx" ON "agent_conversations"("userId", "createdAt", "id");
CREATE TABLE "agent_chat_messages" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
  "content" TEXT NOT NULL,
  "reasoning" TEXT NOT NULL DEFAULT '均衡',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "agent_chat_messages_conversationId_createdAt_id_idx" ON "agent_chat_messages"("conversationId", "createdAt", "id");
CREATE TABLE "agent_message_attachments" (
  "messageId" TEXT NOT NULL REFERENCES "agent_chat_messages"("id") ON DELETE CASCADE,
  "attachmentId" TEXT NOT NULL REFERENCES "attachments"("id") ON DELETE RESTRICT,
  PRIMARY KEY ("messageId", "attachmentId")
);
