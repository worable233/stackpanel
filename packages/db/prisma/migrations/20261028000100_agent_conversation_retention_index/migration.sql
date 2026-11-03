-- 保留策略清理（apps/api/src/agent/retention.ts）按
--   row_number() OVER (PARTITION BY "userId" ORDER BY "updatedAt" DESC, "id" DESC)
-- 选出要删的会话。已有索引是 (userId, createdAt, id)，排序键不匹配，于是每次
-- 清理都要对整张 agent_conversations 做窗口排序 —— 而它每小时跑一次。
CREATE INDEX "agent_conversations_userId_updatedAt_id_idx"
  ON "agent_conversations" ("userId", "updatedAt", "id");
