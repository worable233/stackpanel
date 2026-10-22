-- 真机升级演练专用迁移（drill 分支，不合并回 main）。
--
-- 目的：让 v0.2.0 → v0.2.1 的 `migrating` 步骤执行一次**真实**的 schema 变更，
-- 从而验证「一次性迁移 → 切换 → 探针 → 提交」与「迁移失败 → 恢复快照」两条路径。
CREATE TABLE "drill_upgrade_marker" (
    "id" TEXT NOT NULL,
    "kernelVersion" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "drill_upgrade_marker_pkey" PRIMARY KEY ("id")
);
