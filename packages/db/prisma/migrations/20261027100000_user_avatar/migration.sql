-- Avatar as a pointer into the kernel media domain.
--
-- Deliberately not a foreign key: the media module owns an attachment's
-- lifecycle (ADR-0014 §2), and a dangling pointer is already a supported state —
-- the avatar falls back to the account initial. A FK would instead let an
-- attachment delete block a user row, coupling two domains for no gain.
ALTER TABLE "users" ADD COLUMN "avatarAttachmentId" TEXT;
