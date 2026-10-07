-- 实况通知（live notification）：为通知增加生命周期状态、进度与可更新标识。
--   status    info | active | success | error；active 表示进行中的实况活动
--   progress  0–100，仅 active 有意义
--   dedupeKey 实况通知的稳定标识，与 userId 唯一；NULL 允许重复（普通通知）
--   updatedAt 原地更新时刷新，供客户端判断内容新鲜度
ALTER TABLE "notifications" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "notifications" ADD COLUMN "progress" INTEGER;
ALTER TABLE "notifications" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "notifications" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");
