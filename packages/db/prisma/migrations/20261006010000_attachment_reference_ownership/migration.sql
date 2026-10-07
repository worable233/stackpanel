ALTER TABLE "attachment_references"
  ADD COLUMN IF NOT EXISTS "ownerPluginId" TEXT;

ALTER TABLE "attachment_references"
  DROP CONSTRAINT IF EXISTS "attachment_references_attachmentId_fkey";

ALTER TABLE "attachment_references"
  ADD CONSTRAINT "attachment_references_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "attachment_references_owner_idx"
  ON "attachment_references"("ownerPluginId");
