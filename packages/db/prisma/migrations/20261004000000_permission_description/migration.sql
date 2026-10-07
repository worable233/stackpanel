-- 权限说明：可选的人类可读说明，由声明该权限的插件提供。
-- 管理端“编辑权限组”弹窗通过悬浮 (?) 图标展示，便于理解每条权限的含义。
ALTER TABLE "permissions" ADD COLUMN "description" TEXT;
