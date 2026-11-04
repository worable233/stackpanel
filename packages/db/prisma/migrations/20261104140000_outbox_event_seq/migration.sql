-- 消费游标从 `(createdAt, id)` 换成单调递增的 `seq`。
--
-- 为什么必须换（真实的静默丢事件，不是理论问题）：
--
-- 副本消费靠 `event_cursors` 的 `(lastAt, lastId)` 复合游标续位，SQL 是
--
--   createdAt > lastAt OR (createdAt = lastAt AND id > lastId)
--
-- 这依赖「同一毫秒内 id 递增」。但 `id` 是 cuid：它只在**同一生成器实例内**
-- 递增，多个 API / worker 进程并发写同一毫秒时，后插入的行完全可能拿到更小
-- 的 id。实测生产库 601 行里 **36 组逆序**，例如：
--
--   createdAt = 2026-10-31 20:10:42.703
--   按 ctid（插入序）: cmvwu5vgv000ay8zle… , cmvwu5vgv000ay7zl7…
--   按 id   （字典序）: cmvwu5vgv000ay7zl7… , cmvwu5vgv000ay8zle…
--
-- 游标若推进到 `…y8zle`（先插入但 id 更大），之后 `id > lastId` 就永远读不到
-- `…y7zl7` —— 事件静默丢失，且没有任何报错。
--
-- `createdAt` 单独也不够：只到毫秒精度，同毫秒内的先后无法区分。
--
-- `BIGSERIAL` 由序列在**插入时**赋值，天然单调且唯一，与插入提交顺序一致。
-- 加列时 Postgres 会按物理存储顺序回填现有行，因此历史数据的相对顺序也是对的。
ALTER TABLE "outbox_events" ADD COLUMN "seq" BIGSERIAL NOT NULL;

-- 游标扫描走 (seq)：`seq > lastSeq ORDER BY seq ASC LIMIT n`。
-- 主键 `id` 的索引帮不上这个查询，没有它会退化成全表扫描 + 排序。
CREATE INDEX "outbox_events_seq_idx" ON "outbox_events" ("seq");

-- 游标改存 `seq`。旧列保留（滚动升级期间旧进程还在写 `lastId`/`lastAt`），
-- 但新代码只认 `lastSeq`。
--
-- 迁移时**不**用旧的 `(lastAt, lastId)` 反推 `lastSeq`：那个游标本身可能已经
-- 越过了逆序对里 id 较大的那条，反推出来的位置会把丢失的事件永久跳过。留空
-- 表示「从此刻起重新开始」，宁可重放（消费端本就要求幂等）也不丢。
ALTER TABLE "event_cursors" ADD COLUMN "lastSeq" BIGINT;
