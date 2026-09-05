-- DataBento XNAS vendor archive (research-databento-import.md §6.5–6.7):
-- as-traded bars + split registry + listing classification + import journal.
-- Additive only — Instrument/Bar and the R1 store boundary are untouched.

CREATE TABLE "VendorBar" (
    "vendor" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "open" DOUBLE PRECISION,
    "high" DOUBLE PRECISION,
    "low" DOUBLE PRECISION,
    "close" DOUBLE PRECISION,
    "volume" DOUBLE PRECISION,
    PRIMARY KEY ("vendor", "symbol", "date")
);

CREATE TABLE "SplitEvent" (
    "symbol" TEXT NOT NULL,
    "exDate" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "ratioNew" DOUBLE PRECISION NOT NULL,
    "ratioOld" DOUBLE PRECISION NOT NULL,
    "factor" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    PRIMARY KEY ("symbol", "exDate")
);

CREATE TABLE "VendorInstrument" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "listingExchange" TEXT,
    "type" TEXT,
    "flag" TEXT,
    "securityName" TEXT
);

CREATE TABLE "VendorImportFile" (
    "vendor" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "noTradeSkipped" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("vendor", "file")
);
