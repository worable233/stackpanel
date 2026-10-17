-- Pre-upgrade pending approvals have no trusted definition snapshot and cannot execute.
ALTER TABLE "agent_approvals" ADD COLUMN "capabilityHash" TEXT;
UPDATE "agent_approvals" SET "status" = 'EXPIRED', "decidedAt" = CURRENT_TIMESTAMP, "reason" = '升级后需重新确认能力定义' WHERE "status" = 'PENDING';
