-- ADR-0022 P16：钱包预授权（hold/settle）。
--
-- 冻结记法：hold 时 `balance -= amount, held += amount`；结算时
-- `held -= amount, balance += (amount - settled)`。于是 `balance` 恒为**可用余额**，
-- 普通 debit/credit 不必感知 held。
--
-- 幂等：`(referenceType, referenceId)` 唯一。状态单向流转 HELD → SETTLED/RELEASED/EXPIRED。

ALTER TABLE "wallet_accounts" ADD COLUMN "held" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "wallet_holds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "settledAmount" INTEGER,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_holds_pkey" PRIMARY KEY ("id")
);

-- 同一业务引用只能冻结一次：重试/重复投递不会双倍占用余额。
CREATE UNIQUE INDEX "wallet_holds_referenceType_referenceId_key"
  ON "wallet_holds"("referenceType", "referenceId");

-- 内核 sweep 按 (status, expiresAt) 找可归位的冻结。
CREATE INDEX "wallet_holds_status_expiresAt_idx"
  ON "wallet_holds"("status", "expiresAt");

CREATE INDEX "wallet_holds_userId_createdAt_idx"
  ON "wallet_holds"("userId", "createdAt");
