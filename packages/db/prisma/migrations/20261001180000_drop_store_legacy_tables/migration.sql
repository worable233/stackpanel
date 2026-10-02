-- E4：store 域数据自治收尾（ADR-0008 / ADR-0009 / ADR-0019）
--
-- 商品 / 分类 / 购物车 / 订单 / 交付物 / 履约任务 / 卡密码池已迁至 Extension 引擎
-- 物理表（`ext_store_*` 等，运行期由引擎迁移器建表，不归 Prisma 迁移管理）。内核
-- 及各插件已不再读写这些旧表，一并下架。
--
-- 说明：`ext_*` 物理表在插件激活时才存在，因此无法在 SQL 迁移内做回填；本平台
-- 上线前无存量数据（各表均为空），如需保留历史数据须在应用本迁移前经插件管理面
-- 或一次性脚本导入。`ext_*` 数据归属备份 `content` 域（ADR-0018 §6）。
DROP TABLE IF EXISTS "cart_items" CASCADE;
DROP TABLE IF EXISTS "service_instances" CASCADE;
DROP TABLE IF EXISTS "delivery_tasks" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;
DROP TABLE IF EXISTS "categories" CASCADE;
DROP TABLE IF EXISTS "orders" CASCADE;
DROP TABLE IF EXISTS "card_codes" CASCADE;
