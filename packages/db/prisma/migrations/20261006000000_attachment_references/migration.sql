CREATE TABLE "attachment_references" (
    "attachmentId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "field" TEXT NOT NULL DEFAULT '',
    "ownerPluginId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attachment_references_pkey" PRIMARY KEY ("attachmentId", "resourceType", "resourceId", "field"),
    CONSTRAINT "attachment_references_attachmentId_fkey"
      FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "attachment_references_resource_idx"
  ON "attachment_references"("resourceType", "resourceId");
CREATE INDEX "attachment_references_owner_idx"
  ON "attachment_references"("ownerPluginId");
