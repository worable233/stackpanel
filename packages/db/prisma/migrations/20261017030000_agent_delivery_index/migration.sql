-- Recovery queries look up notifications by run, regardless of delivery status.
CREATE INDEX "agent_deliveries_runId_idx" ON "agent_deliveries"("runId");
