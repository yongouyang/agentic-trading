-- CreateTable
CREATE TABLE "ScreenRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "market" TEXT NOT NULL,
    "universeSize" INTEGER NOT NULL,
    "ok" INTEGER NOT NULL,
    "genuinelyAbsent" INTEGER NOT NULL,
    "fetchFailed" INTEGER NOT NULL,
    "degraded" BOOLEAN NOT NULL,
    "warningsJson" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ScreenResult" (
    "runId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" REAL NOT NULL,
    "metricsJson" TEXT NOT NULL,

    PRIMARY KEY ("runId", "symbol"),
    CONSTRAINT "ScreenResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScreenRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
