-- 「思考强度」控件（快速 / 均衡 / 深入 / 极高）的值只被存进对话消息，
-- `stepOnce` 的 maxTokens 却写死 4096，于是选哪个档执行结果都一样。
-- 这一列是它落到执行侧的唯一出口；默认值与历史硬编码一致，老运行行为不变。
ALTER TABLE "agent_profiles" ADD COLUMN "maxTokens" INTEGER NOT NULL DEFAULT 4096;
