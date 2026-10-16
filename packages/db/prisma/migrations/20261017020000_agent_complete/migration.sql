CREATE TABLE "agent_mcp_servers" (
 "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "url" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT false, "tools" JSONB NOT NULL DEFAULT '[]',
 "revision" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "agent_operations" (
 "id" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, "runId" TEXT, "kind" TEXT NOT NULL,
 "requestHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'STARTED', "result" JSONB,
 "reservedMinor" INTEGER NOT NULL DEFAULT 0, "costMinor" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "agent_operations_actorId_createdAt_idx" ON "agent_operations"("actorId", "createdAt");
CREATE INDEX "agent_operations_runId_kind_idx" ON "agent_operations"("runId", "kind");
CREATE TABLE "agent_dispatches" (
 "runId" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, "clientIp" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "pending" BOOLEAN NOT NULL DEFAULT true,
 "lockedUntil" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "agent_dispatches_pending_lockedUntil_idx" ON "agent_dispatches"("pending", "lockedUntil");
CREATE TABLE "agent_deliveries" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "runId" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "deliveredAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "agent_deliveries_deliveredAt_nextAttemptAt_idx" ON "agent_deliveries"("deliveredAt", "nextAttemptAt");

CREATE TABLE "agent_oauth_clients" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL,
 "redirectUris" JSONB NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "agent_oauth_grants" ("hash" TEXT PRIMARY KEY, "kind" TEXT NOT NULL,
 "clientId" TEXT NOT NULL, "userId" TEXT NOT NULL, "scopes" JSONB NOT NULL,
 "redirectUri" TEXT, "challenge" TEXT, "tokenId" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL,
 "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "agent_oauth_grants_expiresAt_idx" ON "agent_oauth_grants"("expiresAt");
INSERT INTO "agent_mcp_servers" ("id", "name", "url", "enabled", "tools", "updatedAt")
VALUES ('github', 'GitHub MCP', 'https://api.githubcopilot.com/mcp/', false, '[]', CURRENT_TIMESTAMP);

ALTER TABLE "api_tokens" ADD COLUMN "audience" TEXT;
ALTER TABLE "agent_oauth_grants" ADD COLUMN "familyId" TEXT NOT NULL;
CREATE INDEX "agent_oauth_grants_familyId_idx" ON "agent_oauth_grants"("familyId");

ALTER TABLE "agent_runs" ADD COLUMN "parentId" TEXT, ADD COLUMN "rootId" TEXT, ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "agent_runs_rootId_idx" ON "agent_runs"("rootId");
