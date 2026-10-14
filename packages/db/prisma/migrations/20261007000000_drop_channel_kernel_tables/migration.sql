-- ADR-0021 §D4：渠道 / 开放平台业务域下沉为 channel 插件。
--
-- `resellers` / `webhook_deliveries` 原为内核表；现由 channel 插件经 Extension
-- 引擎的 `ext_channel_partner` / `ext_channel_delivery` 自治持有。内核不再读写
-- 这两张表，一并下架（与 20261002000000_purge_legacy_kernel_tables 同一归位策略：
-- 平台上线前无存量数据）。
DROP TABLE IF EXISTS "webhook_deliveries" CASCADE;
DROP TABLE IF EXISTS "resellers" CASCADE;
