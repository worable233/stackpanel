-- 会员商品（审计 §6 / FIX-6）：权限组成员关系支持到期时间。
--
-- 设计取舍：权益载体复用 `permission_groups` + `user_groups`，不新建 membership 表。
-- `expiresAt` 为 null 表示永久成员（默认组、管理员手工授予）；非空表示限时成员，
-- 由会员商品履约授予、到期撤销。
--
-- 判定在读路径生效（hasPermission / listUserGroups / permissionsOf 过滤过期行），
-- 因此清扫任务延迟或失败都不会让过期权益继续生效；清扫只清理残留行并通知用户。

ALTER TABLE "user_groups" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- 到期清扫扫描：expiresAt 非空且已过期的行。
CREATE INDEX "user_groups_expiresAt_idx" ON "user_groups"("expiresAt");
