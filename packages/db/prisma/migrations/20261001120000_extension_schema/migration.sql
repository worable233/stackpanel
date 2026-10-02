-- Extension 引擎元表（ADR-0009 §6 / PLAN-E1 S2）
-- 每个插件声明的模型一行：定义哈希 + 引擎生成的物理表名。
-- ext_* 物理表由引擎迁移器生成，不归 Prisma 迁移管理。
CREATE TABLE "extension_schema" (
    "kind" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "legacyImported" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_schema_pkey" PRIMARY KEY ("kind")
);

-- CreateIndex
CREATE INDEX "extension_schema_pluginId_idx" ON "extension_schema"("pluginId");
