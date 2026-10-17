-- 外部通知渠道的持久投递记录（审计 §4/§5）。
--
-- 内核拥有收件人授权、幂等键、退避重试与失败重放；SMTP/webhook 等渠道插件只执行
-- 投递（见 notification.channel 扩展点）。站内消息落库（notifications）不代表外部
-- 邮件已被接受或送达，故单独记录每个渠道的投递状态。
--
-- 幂等：按 (notificationId, channelId) 唯一，重放不会重复投递同一通知到同一渠道。

CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_deliveries_notificationId_channelId_key"
  ON "notification_deliveries"("notificationId", "channelId");

-- 重试扫描：找到期未投递的记录。
CREATE INDEX "notification_deliveries_status_nextAttemptAt_idx"
  ON "notification_deliveries"("status", "nextAttemptAt");
