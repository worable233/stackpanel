-- 对标 #12.6：平台凭证可登记 Ed25519 公钥，此后该凭证的请求必须带请求签名。
--
-- 可空是刻意的：存量凭证保持 Bearer 行为不变，登记公钥是显式的、逐凭证的选择。
ALTER TABLE "api_tokens" ADD COLUMN "publicKey" TEXT;
