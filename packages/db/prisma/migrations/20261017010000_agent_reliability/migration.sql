ALTER TABLE "agent_runs" ADD COLUMN "policy" JSONB,
    ADD COLUMN "requestKey" TEXT,
    ADD COLUMN "requestHash" TEXT;
CREATE UNIQUE INDEX "agent_runs_tokenId_requestKey_key" ON "agent_runs"("tokenId", "requestKey");
