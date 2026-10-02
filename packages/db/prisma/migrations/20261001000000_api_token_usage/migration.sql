-- 开放平台逐请求用量审计（PLAN-open-platform P1）
CREATE TABLE "api_token_usage" (
    "id" TEXT NOT NULL,
    "apiTokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "capabilityId" TEXT,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_token_usage_apiTokenId_createdAt_idx" ON "api_token_usage"("apiTokenId", "createdAt");

-- CreateIndex
CREATE INDEX "api_token_usage_userId_createdAt_idx" ON "api_token_usage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "api_token_usage_createdAt_idx" ON "api_token_usage"("createdAt");

-- AddForeignKey
ALTER TABLE "api_token_usage" ADD CONSTRAINT "api_token_usage_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
