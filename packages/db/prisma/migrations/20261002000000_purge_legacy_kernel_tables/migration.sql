-- D8：内核业务域归位（ADR-0008 / ADR-0009 / ADR-0019）
--
-- 以下旧表曾是插件域（工单 / API 中转网关 / zjmf 上游 / 自定义资源 CR）的物理
-- 存储，已全部迁至 Extension 引擎（`ext_*`，运行期由引擎迁移器建表，不归 Prisma
-- 迁移管理）。内核与插件均不再读写这些表，一并下架；`extension_schema.legacyImported`
-- 是 CR 一次性导入的遗留标记，随导入路径移除。
--
-- 说明：本平台上线前无存量数据（各表均为空）；如需保留历史数据，须在应用本迁移
-- 前经插件管理面或一次性脚本导入对应 `ext_*` 表（数据归属备份 `content` 域）。
DROP TABLE IF EXISTS "zjmf_product_mappings" CASCADE;
DROP TABLE IF EXISTS "zjmf_sync_runs" CASCADE;
DROP TABLE IF EXISTS "zjmf_upstreams" CASCADE;
DROP TABLE IF EXISTS "ticket_messages" CASCADE;
DROP TABLE IF EXISTS "tickets" CASCADE;
DROP TABLE IF EXISTS "gateway_usage_logs" CASCADE;
DROP TABLE IF EXISTS "gateway_model_prices" CASCADE;
DROP TABLE IF EXISTS "gateway_user_settings" CASCADE;
DROP TABLE IF EXISTS "gateway_key_policies" CASCADE;
DROP TABLE IF EXISTS "gateway_api_keys" CASCADE;
DROP TABLE IF EXISTS "gateway_accounts" CASCADE;
DROP TABLE IF EXISTS "custom_resources" CASCADE;

ALTER TABLE "extension_schema" DROP COLUMN IF EXISTS "legacyImported";
