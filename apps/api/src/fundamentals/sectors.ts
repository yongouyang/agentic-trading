/**
 * Phase 7 P2 — sector bucketing (docs/phase-7-plan.md §E3), pure half.
 *
 * Both markets are mapped onto ONE shared coarse bucket list so the §5
 * subgroup analysis never has to reconcile two taxonomies mid-computation.
 * The mapping is deliberately coarse: these buckets drive subgroup labels,
 * not selection. Raw source values (SIC code / eastmoney industry string)
 * are kept in the ingest log, not the store.
 *
 * US: SIC code → bucket. 4-digit overrides first (software, drugs, medical
 * instruments hide inside broad major groups), then 2-digit major group.
 * HK: eastmoney BELONG_INDUSTRY (Chinese label) → bucket by keyword.
 */

export const SECTOR_BUCKETS = [
  "Technology",
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Healthcare",
  "Financials",
  "Industrials",
  "Energy",
  "Materials",
  "Utilities",
  "Real Estate",
  "Other",
] as const;
export type SectorBucket = (typeof SECTOR_BUCKETS)[number];

// ---------------------------------------------------------------------------
// US — SIC → bucket
// ---------------------------------------------------------------------------

/** 4-digit (prefix) overrides checked before the major-group table. */
const SIC_PREFIX_OVERRIDES: [string, SectorBucket][] = [
  ["283", "Healthcare"], // drugs
  ["384", "Healthcare"], // medical instruments
  ["737", "Technology"], // computer programming / software / data processing
  ["367", "Technology"], // semiconductors & electronic components
  ["6798", "Real Estate"], // REITs (file under major group 67, holding companies)
];

/** 2-digit major-group → bucket. Ranges are [lo, hi] inclusive. */
const SIC_MAJOR_GROUPS: [number, number, SectorBucket][] = [
  [1, 9, "Other"], // agriculture
  [10, 12, "Materials"], // metal & coal mining
  [13, 13, "Energy"], // oil & gas extraction
  [14, 14, "Materials"], // nonmetallic mining
  [15, 17, "Industrials"], // construction
  [20, 21, "Consumer Staples"], // food & tobacco
  [22, 23, "Consumer Discretionary"], // textiles & apparel
  [24, 24, "Materials"], // lumber & wood
  [25, 25, "Consumer Discretionary"], // furniture
  [26, 26, "Materials"], // paper
  [27, 27, "Communication Services"], // printing & publishing
  [28, 28, "Materials"], // chemicals (283 overridden to Healthcare)
  [29, 29, "Energy"], // petroleum refining
  [30, 30, "Materials"], // rubber & plastics
  [31, 31, "Consumer Discretionary"], // leather & footwear
  [32, 33, "Materials"], // stone/clay/glass, primary metals
  [34, 34, "Industrials"], // fabricated metals
  [35, 36, "Technology"], // industrial machinery (incl. computers 3571), electronics
  [37, 37, "Consumer Discretionary"], // transportation equipment (autos)
  [38, 38, "Industrials"], // instruments (384 overridden to Healthcare)
  [39, 39, "Consumer Discretionary"], // misc manufacturing
  [40, 47, "Industrials"], // transportation & logistics
  [48, 48, "Communication Services"], // telecommunications
  [49, 49, "Utilities"],
  [50, 51, "Industrials"], // wholesale trade
  [52, 59, "Consumer Discretionary"], // retail
  [60, 64, "Financials"], // banking, brokers, insurance
  [65, 65, "Real Estate"],
  [67, 67, "Financials"], // holding & investment companies
  [70, 72, "Consumer Discretionary"], // hotels & personal services
  [73, 73, "Industrials"], // business services (737 overridden to Technology)
  [75, 75, "Consumer Discretionary"], // auto repair & rental
  [76, 76, "Industrials"], // misc repair
  [78, 79, "Communication Services"], // motion pictures & entertainment
  [80, 80, "Healthcare"], // health services
  [82, 83, "Consumer Discretionary"], // education & social services
  [84, 84, "Communication Services"], // museums
  [87, 87, "Industrials"], // engineering & professional services
];

/** EDGAR submissions `sic` (string, may be empty) → coarse bucket. */
export function sectorFromSic(sic: string | null | undefined): SectorBucket {
  const code = (sic ?? "").replace(/\D/g, "");
  if (!code) return "Other";
  for (const [prefix, bucket] of SIC_PREFIX_OVERRIDES) {
    if (code.startsWith(prefix)) return bucket;
  }
  const major = Number(code.slice(0, 2));
  for (const [lo, hi, bucket] of SIC_MAJOR_GROUPS) {
    if (major >= lo && major <= hi) return bucket;
  }
  return "Other";
}

// ---------------------------------------------------------------------------
// HK — eastmoney BELONG_INDUSTRY (Chinese label) → bucket
// ---------------------------------------------------------------------------

const EM_INDUSTRY_KEYWORDS: [RegExp, SectorBucket][] = [
  [/软件|互联网|资讯科技|电脑|半导体|电子/, "Technology"],
  [/电讯|通信|媒体|出版|广播|娱乐/, "Communication Services"],
  [/汽车|家电|服装|纺织|零售|旅游|酒店|餐饮|消闲|体育用品|珠宝|钟表/, "Consumer Discretionary"],
  [/食品|饮料|烟草|农业|超市|日用品|个人护理|啤酒/, "Consumer Staples"],
  [/医疗|医药|生物|制药|保健/, "Healthcare"],
  [/银行|保险|证券|金融|投资|信贷|地产代理|资产管理/, "Financials"],
  [/工业|制造|机械|设备|工程|建筑|运输|物流|航空|航运|铁路|港口|包装|印刷|贸易|分销/, "Industrials"],
  [/石油|天然气|煤炭|燃气|能源|油服/, "Energy"],
  [/钢铁|金属|矿业|采矿|化工|化学|建材|水泥|玻璃|纸|林业|稀土/, "Materials"],
  [/电力|水务|公用|燃气分销|新能源发电/, "Utilities"],
  [/地产|房地产|物业|REIT|房托/, "Real Estate"],
];

/** eastmoney F10 orgprofile `BELONG_INDUSTRY` → coarse bucket. Order matters:
 *  first matching keyword group wins; unknown labels land in "Other". */
export function sectorFromEastmoneyIndustry(industry: string | null | undefined): SectorBucket {
  const s = (industry ?? "").trim();
  if (!s) return "Other";
  for (const [re, bucket] of EM_INDUSTRY_KEYWORDS) {
    if (re.test(s)) return bucket;
  }
  return "Other";
}
