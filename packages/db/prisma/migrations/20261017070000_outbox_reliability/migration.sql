-- 事件可靠性（审计 §4 / 工单 FIX-4）：
--   * relay 退避/停滞可观测：OutboxEvent 增加 nextAttemptAt / maxAttempts / parkedAt。
--   * 消费幂等原语：processed_events(consumer, eventId) 唯一。
--   * 组级持久消费游标：event_cursors 记录集群已消费位置，供滞后告警与离线补齐。
--
-- 语义仍为「原子写 + at-least-once + 消费幂等」；未承诺恰好一次（ADR-0013 非目标）。

ALTER TABLE "outbox_events"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "parkedAt" TIMESTAMP(3);

-- relay 扫描：到期且未发布的记录。旧的 (publishedAt, lockedAt) 索引保留用于租约判定。
CREATE INDEX "outbox_events_publishedAt_nextAttemptAt_idx"
  ON "outbox_events"("publishedAt", "nextAttemptAt");

-- 消费幂等：同一 consumer 对同一 eventId 只处理一次。
CREATE TABLE "processed_events" (
    "consumer" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer", "eventId")
);

-- 组级持久消费游标：每个 consumer（默认集群级 "__outbox__"）的已消费位置。
CREATE TABLE "event_cursors" (
    "consumer" TEXT NOT NULL,
    "lastId" TEXT,
    "lastAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_cursors_pkey" PRIMARY KEY ("consumer")
);
