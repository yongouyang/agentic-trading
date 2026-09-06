-- Phase-2 CA-source decision (2026-09-06, architecture §4): CorporateAction
-- gains type "IN_SPECIE" (weekly eastmoney F10 enrichment). `amount` becomes
-- nullable (ratio-only in-specie rows publish no HKD equivalent) and `detail`
-- carries the raw PLAN_EXPLAIN + parsed ratio for audit. Hand-written rebuild
-- (SQLite has no ALTER COLUMN), deliberately scoped to CorporateAction only —
-- the pre-existing Float/"double precision" drift on VendorBar/SplitEvent is
-- cosmetic (SQLite REAL) and rewriting 15M VendorBar rows is not this change.

CREATE TABLE "new_CorporateAction" (
    "instrumentId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL,
    "currency" TEXT NOT NULL,
    "detail" TEXT,

    PRIMARY KEY ("instrumentId", "date", "type"),
    CONSTRAINT "CorporateAction_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_CorporateAction" ("instrumentId", "date", "type", "amount", "currency")
SELECT "instrumentId", "date", "type", "amount", "currency" FROM "CorporateAction";

DROP TABLE "CorporateAction";
ALTER TABLE "new_CorporateAction" RENAME TO "CorporateAction";
