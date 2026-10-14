-- CreateEnum
CREATE TYPE "AgentAutonomy" AS ENUM ('read', 'propose', 'act');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentStepKind" AS ENUM ('assistant', 'tool_call', 'tool_result', 'approval');

-- CreateEnum
CREATE TYPE "AgentApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "apiTokenId" TEXT NOT NULL,
    "autonomy" "AgentAutonomy" NOT NULL DEFAULT 'read',
    "dailyBudgetMinor" INTEGER,
    "dailySteps" INTEGER,
    "budgetMinor" INTEGER,
    "budgetWindow" TEXT,
    "maxSteps" INTEGER NOT NULL DEFAULT 50,
    "maxRunSeconds" INTEGER NOT NULL DEFAULT 600,
    "allowedModels" JSONB NOT NULL DEFAULT '[]',
    "approvalNotify" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "model" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "spendMinor" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" "AgentStepKind" NOT NULL,
    "toolName" TEXT,
    "args" JSONB,
    "result" JSONB,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costMinor" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_approvals" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "args" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AgentApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_apiTokenId_key" ON "agent_profiles"("apiTokenId");

-- CreateIndex
CREATE INDEX "agent_runs_actorId_startedAt_idx" ON "agent_runs"("actorId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_tokenId_startedAt_idx" ON "agent_runs"("tokenId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_steps_approvalId_idx" ON "agent_steps"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_steps_runId_index_key" ON "agent_steps"("runId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "agent_approvals_idempotencyKey_key" ON "agent_approvals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "agent_approvals_runId_idx" ON "agent_approvals"("runId");

-- CreateIndex
CREATE INDEX "agent_approvals_stepId_idx" ON "agent_approvals"("stepId");

-- CreateIndex
CREATE INDEX "agent_approvals_status_expiresAt_idx" ON "agent_approvals"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "agent_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

