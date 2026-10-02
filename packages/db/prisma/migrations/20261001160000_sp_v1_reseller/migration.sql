-- SP-V1（P3）：渠道伙伴 + 签名 webhook 投递记录
CREATE TABLE "resellers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "keyId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "webhookPrivateKey" TEXT,
    "webhookPublicKey" TEXT,
    "webhookUrl" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "rateLimitRpm" INTEGER NOT NULL DEFAULT 240,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resellers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resellers_name_key" ON "resellers"("name");
CREATE UNIQUE INDEX "resellers_keyId_key" ON "resellers"("keyId");
CREATE INDEX "resellers_status_idx" ON "resellers"("status");

CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "responseCode" INTEGER,
    "error" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_resellerId_createdAt_idx" ON "webhook_deliveries"("resellerId", "createdAt");
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
