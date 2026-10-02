-- 内核附件域（ADR-0014 §2）：二进制在对象存储，元数据在主库。
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "ownerId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "variants" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attachments_key_key" ON "attachments"("key");
CREATE INDEX "attachments_ownerId_createdAt_idx" ON "attachments"("ownerId", "createdAt");
CREATE INDEX "attachments_createdAt_idx" ON "attachments"("createdAt");
