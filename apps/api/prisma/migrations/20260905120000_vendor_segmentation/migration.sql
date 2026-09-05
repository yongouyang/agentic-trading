-- Empirical symbol-identity segmentation (research-databento-import.md §6.8):
-- nullable segmentId on VendorBar + the VendorSegment registry. Additive only.

ALTER TABLE "VendorBar" ADD COLUMN "segmentId" TEXT;

CREATE TABLE "VendorSegment" (
    "vendor" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "firstDate" TEXT NOT NULL,
    "lastDate" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    PRIMARY KEY ("vendor", "symbol", "segmentId")
);
