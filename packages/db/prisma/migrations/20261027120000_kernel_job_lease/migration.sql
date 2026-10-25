-- 对标 #12.5：无 Redis 时的跨副本单实例保证。
--
-- 进程内任务后端的每个副本各有一份定时器，同一 tick 会执行 N 次。执行前抢
-- 一次租约（这里的表就是租约本身），抢到才干活；租约按 expiresAtMs 自然过期，
-- 持有者崩溃后由下一个副本接手，不需要死节点检测。
--
-- 有 Redis 时走 BullMQ 抢占，本表不参与。
CREATE TABLE "kernel_job_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAtMs" BIGINT NOT NULL,

    CONSTRAINT "kernel_job_leases_pkey" PRIMARY KEY ("name")
);
