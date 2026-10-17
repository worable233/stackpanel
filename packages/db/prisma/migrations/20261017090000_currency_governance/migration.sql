-- 币种、金额精度与结算治理（PLAN-currency-accuracy-and-governance）。
--
-- 1) 币种目录：内核静态白名单 + 本表的启用状态。表里只存治理状态，不新增代码。
-- 2) 汇率增加可选有效期；过期汇率不得用于新订单。
-- 3) 支付方式声明其支持的结算币种；空数组 = 支持全部已启用币种。
-- 4) 平台结算币种落在 settings('currency.settlement')，默认 CNY。

CREATE TABLE "currency_definitions" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "minorUnit" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currency_definitions_pkey" PRIMARY KEY ("code")
);

ALTER TABLE "fx_rates" ADD COLUMN "validUntil" TIMESTAMP(3);

ALTER TABLE "payment_methods" ADD COLUMN "currencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 存量非法/别名币种：统一规范化。可安全自动处理的部分在此完成；无法确定的
-- 未知币种不改写金额，仅由迁移报告标记为待人工确认（见 docs 迁移报告）。

-- 小写 → 大写
UPDATE "fx_rates" SET "fromCurrency" = upper("fromCurrency") WHERE "fromCurrency" <> upper("fromCurrency");
UPDATE "fx_rates" SET "toCurrency" = upper("toCurrency") WHERE "toCurrency" <> upper("toCurrency");
UPDATE "payments" SET "currency" = upper("currency") WHERE "currency" <> upper("currency");
UPDATE "payments" SET "orderCurrency" = upper("orderCurrency") WHERE "orderCurrency" IS NOT NULL AND "orderCurrency" <> upper("orderCurrency");
UPDATE "wallet_accounts" SET "currency" = upper("currency") WHERE "currency" <> upper("currency");
UPDATE "wallet_ledger_entries" SET "currency" = upper("currency") WHERE "currency" <> upper("currency");

-- RMB 别名 → CNY（历史数据里最常见的别名）
UPDATE "fx_rates" SET "fromCurrency" = 'CNY' WHERE "fromCurrency" = 'RMB';
UPDATE "fx_rates" SET "toCurrency" = 'CNY' WHERE "toCurrency" = 'RMB';
UPDATE "payments" SET "currency" = 'CNY' WHERE "currency" = 'RMB';
UPDATE "payments" SET "orderCurrency" = 'CNY' WHERE "orderCurrency" = 'RMB';
UPDATE "wallet_accounts" SET "currency" = 'CNY' WHERE "currency" = 'RMB';
UPDATE "wallet_ledger_entries" SET "currency" = 'CNY' WHERE "currency" = 'RMB';
