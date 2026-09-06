-- Phase 2 agent pipeline (phase-2-plan.md, 2026-09-06): AgentDecision is the
-- content-addressed decision log (hash = sha256 of agent|model|promptVersion|
-- system|user, so an unchanged snapshot reruns at $0) — DeepDiveRun +
-- DeepDiveReport persist each daily deep-dive batch. Hand-written migration
-- (prisma migrate dev refuses non-interactive shells, same as the
-- ca_inspecie_events precedent), applied via migrate deploy.

CREATE TABLE "AgentDecision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hash" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "responseText" TEXT NOT NULL,
    "usageJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DeepDiveRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "market" TEXT NOT NULL,
    "screenRunId" INTEGER NOT NULL,
    "topN" INTEGER NOT NULL,
    "llmCalls" INTEGER NOT NULL,
    "cacheHits" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "warningsJson" TEXT NOT NULL
);

CREATE TABLE "DeepDiveReport" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "verdictJson" TEXT,
    "decisionHashesJson" TEXT,

    CONSTRAINT "DeepDiveReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DeepDiveRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentDecision_hash_key" ON "AgentDecision"("hash");

CREATE UNIQUE INDEX "DeepDiveReport_runId_symbol_key" ON "DeepDiveReport"("runId", "symbol");
