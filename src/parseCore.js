/**
 * parseCore.js — Pure parsing + aggregation logic, no browser APIs.
 *
 * Performance-optimised rewrite (v2). Key changes vs the previous version:
 *
 *   1. Hand-rolled CSV parser replaces d3.csvParse for the person file.
 *      D3 allocates a full JS object per row including every column before
 *      the row-accessor can discard them. The new parser reads only the
 *      columns we actually need, identified by header-position lookup, so
 *      zero unused strings are ever interned or GC'd.
 *
 *   2. isValid() inlined and simplified — no String() allocation on every
 *      call; the fast-path for the common case (non-null, non-empty) is a
 *      single null-check + two char comparisons.
 *
 *   3. Wage-bin accumulation folded into the main single-pass loop — was a
 *      separate third full scan of yearRows; now done in the same pass as
 *      numeric/categorical aggregation.
 *
 *   4. Welford online mean/variance in performCrossRunAggregation — replaces
 *      storing every run's metric_value in a growing array then scanning it
 *      twice (once for mean, once for variance). Now O(1) extra memory per
 *      group regardless of run count, and one fewer pass over the data.
 *
 *   5. Per-row stratifier values pre-resolved once — was re-resolved inside
 *      every numAcc and catAcc inner loop iteration.
 *
 *   6. Benefit-map row trimmed with explicit key list instead of for...in
 *      over all columns.
 */

import { csvParse } from "./csvParse.js";

// ─── Binning helpers ──────────────────────────────────────────────────────────
/** Population pyramid: single years of age, with ages PYRAMID_TOP_AGE and over
 *  grouped together (very old single years have too few people to show). */
export const PYRAMID_TOP_AGE = 100;
export function pyramidAge(age) {
  if (age == null || isNaN(age) || age < 0) return null;
  return age >= PYRAMID_TOP_AGE ? `${PYRAMID_TOP_AGE}+` : String(Math.floor(age));
}
export function binAge(v) {
  const n=+v; if(isNaN(n)) return null;
  if(n<=18) return "Under 18"; if(n<=24) return "18-24"; if(n<=34) return "25-34";
  if(n<=44) return "35-44";    if(n<=54) return "45-54"; if(n<=64) return "55-64";
  return "65+";
}
export function binChildren(v) {
  const n=+v; if(isNaN(n)) return null;
  if(n<=0) return "None"; if(n<=1) return "1 Child"; if(n<=2) return "2 Children";
  return "3+ Children";
}

export const WAGE_BINS = [
  [0,   5,   "£0–5"],
  [5,   10,  "£5–10"],
  [10,  15,  "£10–15"],
  [15,  20,  "£15–20"],
  [20,  25,  "£20–25"],
  [25,  30,  "£25–30"],
  [30,  40,  "£30–40"],
  [40,  50,  "£40–50"],
  [50,  Infinity, "£50+"],
];
export function binWage(v) {
  const n = +v;
  if (isNaN(n) || n < 0) return null;
  for (const [lo, hi, label] of WAGE_BINS) {
    if (n >= lo && n < hi) return label;
  }
  return "£50+";
}

// Income variable bins — monthly/yearly monetary variables binned for distribution charts.
// Breaks chosen to span the realistic SimPaths range without too many empty buckets.
export const INCOME_BIN_VARS = {
  "Equivalised yearly disposable income": {
    breaks: [0, 5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000, Infinity],
    labels: ["£0–5k","£5–10k","£10–15k","£15–20k","£20–25k","£25–30k","£30–40k","£40–50k","£50k+"],
  },
  "Gross personal employment income": {
    breaks: [0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, Infinity],
    labels: ["£0–500","£500–1k","£1–1.5k","£1.5–2k","£2–2.5k","£2.5–3k","£3–4k","£4–5k","£5k+"],
  },
  "Amount of benefits received per month": {
    breaks: [0, 100, 200, 300, 400, 500, 750, 1000, Infinity],
    labels: ["£0–100","£100–200","£200–300","£300–400","£400–500","£500–750","£750–1k","£1k+"],
  },
  "Gross private pension income": {
    breaks: [0, 1000, 2000, 5000, 10000, 20000, Infinity],
    labels: ["£0–1k","£1–2k","£2–5k","£5–10k","£10–20k","£20k+"],
  },
  "Personal private pension income": {
    breaks: [0, 500, 1000, 2000, 5000, Infinity],
    labels: ["£0–500","£500–1k","£1–2k","£2–5k","£5k+"],
  },
  "Capital Income": {
    breaks: [0, 100, 500, 1000, 2000, Infinity],
    labels: ["£0–100","£100–500","£500–1k","£1–2k","£2k+"],
  },
};

export function binIncome(variable, v) {
  const def = INCOME_BIN_VARS[variable];
  if (!def) return null;
  const n = +v;
  if (isNaN(n) || n < 0) return null;
  for (let i = 0; i < def.breaks.length - 1; i++) {
    if (n >= def.breaks[i] && n < def.breaks[i + 1]) return def.labels[i];
  }
  return def.labels[def.labels.length - 1];
}

// ─── Lookup tables ────────────────────────────────────────────────────────────
export const REGION_MAP = {
  "UKC":"North East (England)","UKD":"North West (England)","UKE":"Yorkshire and The Humber",
  "UKF":"East Midlands (England)","UKG":"West Midlands (England)","UKH":"East of England",
  "UKI":"London","UKJ":"South East (England)","UKK":"South West (England)",
  "UKL":"Wales","UKM":"Scotland","UKN":"Northern Ireland",
};
export const DISABILITY_MAP      = {"false":"No disability","0":"No disability","true":"Has disability","1":"Has disability"};
export const FINANCIAL_MAP       = {"false":"Not financially distressed","0":"Not financially distressed","true":"Financially distressed","1":"Financially distressed"};
// Received care is coded 0–3 (none / informal / mixed / formal). "false" is
// accepted as "None" in case an older output writes it as a plain flag.
export const RECV_SOCIAL_CARE_MAP= {"0":"None","false":"None","1":"Informal","2":"Mixed","3":"Formal"};
export const PROV_SOCIAL_CARE_MAP= {"false":"Does not provide care","0":"Does not provide care","true":"Provides care","1":"Provides care"};
export const UC_BENEFITS_MAP     = {"false":"No benefits received","true":"Benefits received"};
export const EMPLOYMENT_MAP      = {
  // SimPaths Java enum values (spaces/hyphens/underscores stripped by recode step)
  "employedorselfemployed":     "Employed or self employed",
  "selfemployed":               "Employed or self employed",
  "employed":                   "Employed or self employed",
  "notemployed":                "Not employed",
  "unemployed":                 "Not employed",
  "unemployedbenefits":         "Not employed",
  "student":                    "Student",
  "retired":                    "Retired",
  // Numeric codes
  "1":                          "Employed or self employed",
  "2":                          "Not employed",
  "3":                          "Retired",
  "4":                          "Student",
};
export const HOUSEHOLD_MAP       = {
  // SimPaths Java enum values
  "couplechildren":             "Couple with children",
  "couplenochildren":           "Couple, no children",
  "singlechildren":             "Single with children",
  "singlenochildren":           "Single, no children",
  // Numeric codes
  "1":                          "Couple with children",
  "2":                          "Couple, no children",
  "3":                          "Single with children",
  "4":                          "Single, no children",
};

export const COLUMN_MAP = {
  "eduHighestC4":"Highest Level of Education","demAge":"Age","demMaleFlag":"Gender",
  "demEthnC6":"Ethnicity","healthDsblLongtermFlag":"Disability Status",
  //"demNChild":"Number of children",
  "yHhQuintilesMonthC5":"Income Quintile","region":"Region","demPartnerStatus":"Partnership status",
  "labC4":"Employment status","labHrsWorkWeek":"Hours worked",
  "yCapitalPersMonth":"Capital Income",
  "yFinDstrssFlag":"Financial distress flag",
  "dhhtp_c4":"Household Type",
  "yDispEquivYear":"Equivalised yearly disposable income",
  "yEmpPersGrossMonth":"Gross personal employment income",
  "yPensPersGrossMonth":"Personal private pension income",
  "labWageFullTimeHrly":"Hourly earnings",
  "yPensYear":"Gross private pension income",
  "yBenAmountMonth":"Amount of benefits received per month",
  "yBenUCReceivedFlag":"Universal Credit Benefits Flag",
  "healthPsyDstrss0to12":"Psychological distress score",
  "healthMentalMcs":"Mental Component Summary (MCS)","healthPhysicalPcs":"Physical Component Summary (PCS)",
  "healthSelfRated":"Self-Rated Health","demLifeSatScore0to10":"Life Satisfaction Score",
  "healthWbScore0to36":"Subjective wellbeing (GHQ)",
  // Care provided (benefit-unit flag) and care received (0–3: none / informal / mixed / formal).
  // SimPaths spells the received flag "careReceivedFlag"; "careRecievedFlag" is accepted too.
  "careProvidedFlag":"Provided care",
  "careReceivedFlag":"Received care",
  "careRecievedFlag":"Received care",
};

export const MODULE_MAP = {
  "Highest Level of Education":"Demographics","Age":"Demographics","Gender":"Demographics",
  "Ethnicity":"Demographics","Partnership status":"Demographics",
  "Region":"Demographics","Household Type":"Demographics",
  "Employment status":"Activity status","Hours worked":"Activity status",
  "Capital Income":"Income","Equivalised yearly disposable income":"Income",
  "Gross personal employment income":"Income","Gross private pension income":"Income",
  "Personal private pension income":"Income","Hourly earnings":"Income",
  "Amount of benefits received per month":"Income","Universal Credit Benefits Flag":"Income",
  "Financial distress flag":"Income","Income Quintile":"Income",
  "Disability Status":"Health","Self-Rated Health":"Health",
  "Psychological distress score":"Health","Mental Component Summary (MCS)":"Health",
  "Physical Component Summary (PCS)":"Health","Life Satisfaction Score":"Health",
  "Subjective wellbeing (GHQ)":"Health",
  "Provided care":"Health","Received care":"Health",
  "Population size":"Demographics",
};//"Number of children":"Demographics",

export const NUMERIC_VARS = new Set([
  "Capital Income","Equivalised yearly disposable income","Gross personal employment income",
  "Gross private pension income","Personal private pension income","Hourly earnings",
  "Amount of benefits received per month",
  "Mental Component Summary (MCS)","Physical Component Summary (PCS)",
  "Psychological distress score","Life Satisfaction Score","Subjective wellbeing (GHQ)","Hours worked",
]);

export const STRATIFIERS = ["Age","Gender","Disability Status","Region","Ethnicity","Income Quintile","Household Type"];//,"Number of children"

// Split a CSV line by delim but stop after maxCols fields — avoids allocating
// a 200-element array when we only need the first ~50 columns.
function splitUpTo(line, delim, maxCols) {
  const cells = [];
  let start = 0;
  for (let i = 0; i < line.length && cells.length < maxCols; i++) {
    if (line[i] === delim) {
      cells.push(line.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (cells.length < maxCols) cells.push(line.slice(start).trim());
  return cells;
}
export const STRAT_ONLY   = new Set(["Age","Gender","Region"]);

export const ALL_DISPLAY_VARS = [
  ...new Set(Object.values(COLUMN_MAP).filter(v=>!v.startsWith("_")))
].filter(v=>!STRAT_ONLY.has(v));

// ─── Fast inline validity check ───────────────────────────────────────────────
// Replaces the previous isValid() which called String() on every value.
// The hot path (non-null, non-empty string from a CSV cell) exits after
// one null check + a length check — no string allocation needed.
// SimPaths uses -9 as its missing-value code. Any cell equal to -9 is
// treated exactly like a blank cell, for every variable and stratifier.
// Fast path: only strings that start with "-" (or a space) can be −9, so
// everything else is rejected without converting it to a number. This runs
// for every cell, so it needs to be cheap.
export function isMissingCode(val) {
  if (typeof val === "number") return val === -9;
  if (typeof val !== "string" || val.length === 0) return false;
  const c = val.charCodeAt(0);
  if (c !== 45 /* - */ && c !== 32 /* space */) return false;
  return val === "-9" || +val === -9;
}
function notMissing(val) {
  if (val == null) return false;
  if (val === "") return false;
  // −9 has already been removed when each row was read (see the row builders),
  // so only the exact string needs checking here.
  if (val === "-9") return false;
  // only allocate a string comparison for the rare sentinel values
  if (val === "null" || val === "undefined") return false;
  return true;
}

// ─── Benefit CSV → lookup map ─────────────────────────────────────────────────
// We only need a small, fixed set of columns from the benefit file.
// Reading them by name from d3's parsed object is fine here because the
// benefit file is typically much smaller than the person file.
const BENEFIT_KEEP = new Set([
  ...Object.keys(COLUMN_MAP),
  "id_BenefitUnit","idbu","idBu","time","Time","Year","wgt","Wgt",
]);

function buildBenefitMap(benefitText) {
  // Strip BOM
  if (benefitText.charCodeAt(0) === 0xFEFF) benefitText = benefitText.slice(1);
  // Normalise line endings
  benefitText = benefitText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Auto-detect delimiter from header
  const firstNL = benefitText.indexOf("\n");
  const headerLine = firstNL > 0 ? benefitText.slice(0, firstNL).replace(/\r$/, "") : "";
  const nCommas     = (headerLine.match(/,/g)  || []).length;
  const nSemicolons = (headerLine.match(/;/g)  || []).length;
  const nTabs       = (headerLine.match(/\t/g) || []).length;
  const delim = nTabs > nCommas ? "\t" : nSemicolons > nCommas ? ";" : ",";

  const map = new Map();
  // Use d3.csvParse for comma, manual parse for other delimiters
  const parseRow = (raw) => {
    const yr   = raw.time || raw.Time || raw.Year;
    const buId = raw.id_BenefitUnit || raw.idbu || raw.idBu;
    if (!yr || !buId) return null;
    const slim = {};
    for (const k of BENEFIT_KEEP) {
      if (raw[k] !== undefined) slim[k] = raw[k];
    }
    map.set(`${yr}_${buId}`, slim);
    return null;
  };

  if (delim === ",") {
    csvParse(benefitText, parseRow);
  } else {
    // Manual parse for semicolon/tab delimited files
    const lines = benefitText.split("\n");
    const headers = lines[0].replace(/\r$/, "").split(delim).map(h => h.trim().replace(/^"|"$/g, ""));
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, "");
      if (!line) continue;
      const cells = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ""));
      const raw = {};
      headers.forEach((h, j) => { if (cells[j] !== undefined) raw[h] = cells[j]; });
      parseRow(raw);
    }
  }
  return map;
}

// ─── Hand-rolled CSV parser for the person file ───────────────────────────────
// d3.csvParse allocates a full JS object for every row (all columns) before
// the row-accessor gets a chance to discard what isn't needed. For a wide
// SimPaths person CSV the wasted allocation dominates parse time.
//
// This parser:
//   1. Reads the header once to build a position→displayName index covering
//      only the columns in COLUMN_MAP (+ the join/weight columns).
//   2. Splits each data line by comma and reads only those positions.
//   3. Returns a plain array of already-renamed, already-trimmed row objects.
//
// Limitation: does not handle quoted fields containing commas or newlines.
// SimPaths CSV output does not use such quoting, so this is safe here.

const PERSON_WANT = new Set([
  ...Object.keys(COLUMN_MAP),
  "time","Time","Year","idBu","idbu","id_BenefitUnit","wgt","Wgt",
]);
// careProvidedFlag is NOT here: SimPaths writes it to BenefitUnit.csv, so the
// benefit-unit value is used (and the person value only if the BU has none).
const PERSON_ONLY_KEYS = new Set(["careReceivedFlag","careRecievedFlag","yBenUCReceivedFlag","demNChild","demAge","demMaleFlag","demEthnC6","healthDsblLongtermFlag","demPartnerStatus","labC4","labHrsWorkWeek","labWageFullTimeHrly","labWageHrly","healthPsyDstrssFlag","healthPsyDstrss0to12","healthMentalMcs","healthSelfRated","healthPhysicalPcs","demLifeSatScore0to10","healthWbScore0to36","eduHighestC4"]);

// ─── Compact row values (memory) ──────────────────────────────────────────────
// Every person-row of a run is held in memory until the run is aggregated, so
// how each value is stored matters a lot for big runs:
//   • numeric variables are stored as numbers (8 bytes) instead of strings;
//   • everything else is "interned": all rows share ONE copy of each distinct
//     string (e.g. "EmployedOrSelfEmployed"), instead of one copy per row.
// Both also stop the row from pinning the whole CSV text chunk it was sliced
// from. Values that don't parse as numbers are kept as-is, so results are
// unchanged.
const NUMERIC_COLUMNS = new Set([...NUMERIC_VARS, "Age", "Number of children"]);
// Row objects: every row is a copy of one template with ALL fields already
// present. Adding ~30 fields to an object one by one (by name) makes the
// JavaScript engine switch it to a slow "dictionary" layout that takes roughly
// 4–5× the memory; copying a template (made by JSON.parse, which builds the
// compact layout) keeps every row compact. Missing values stay null.
const ROW_FIELDS = [...new Set(Object.values(COLUMN_MAP))];
const ROW_TEMPLATE = JSON.parse(JSON.stringify(
  Object.fromEntries([["Year", 0], ["wgt", 0], ["AgeYears", null], ...ROW_FIELDS.map(f => [f, null])])
));
function newRow(year, wgt) {
  const row = { ...ROW_TEMPLATE };
  row.Year = year;
  row.wgt = wgt;
  return row;
}

function makeCompactor() {
  const pool = new Map();
  return (disp, val) => {
    if (NUMERIC_COLUMNS.has(disp)) {
      const n = +val;
      if (!isNaN(n) && val.trim() !== "") return n;
    }
    let v = pool.get(val);
    if (v === undefined) { v = (" " + val).slice(1); pool.set(v, v); }  // flat copy, not a slice of the chunk
    return v;
  };
}

function parsePersonCsv(text, benefitMap) {
  // Strip BOM if present (UTF-8 BOM = \uFEFF, sometimes added by Excel/R)
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  // Normalise line endings — handle \r\n (Windows), \n (Unix), \r (old Mac)
  // Replace \r\n first so we don't double-convert, then remaining \r → \n
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Find first newline — everything before it is the header row
  const firstNL = text.indexOf("\n");
  if (firstNL < 0) return [];

  const headerLine = text.slice(0, firstNL).replace(/\r$/, "");
  // Auto-detect delimiter from the header line
  const nCommas     = (headerLine.match(/,/g)  || []).length;
  const nSemicolons = (headerLine.match(/;/g)  || []).length;
  const nTabs       = (headerLine.match(/\t/g) || []).length;
  const delim = nTabs > nCommas ? "\t" : nSemicolons > nCommas ? ";" : ",";
  const headers = headerLine.split(delim);
  const nCols   = headers.length;

  // Build two index arrays covering only the columns we need:
  //   wantedPos[i]  = column index in the CSV
  //   wantedKey[i]  = raw column name (for COLUMN_MAP lookup / join keys)
  const wantedPos = [];
  const wantedKey = [];
  for (let c = 0; c < nCols; c++) {
    const h = headers[c].trim();
    if (PERSON_WANT.has(h)) {
      wantedPos.push(c);
      wantedKey.push(h);
    }
  }
  const nWanted = wantedPos.length;

  // Pre-compute which wanted-slot indices map to COLUMN_MAP display names
  // vs. join/weight keys, to avoid repeated hash lookups inside the hot loop.
  const colMapEntries = Object.entries(COLUMN_MAP); // [rawKey, displayName]

  // Build a slot→displayName array (null for join/weight cols not in COLUMN_MAP)
  const slotDisplay = new Array(nWanted).fill(null);
  for (let i = 0; i < nWanted; i++) {
    const disp = COLUMN_MAP[wantedKey[i]];
    if (disp !== undefined) slotDisplay[i] = disp;
  }

  // Slot indices for the join/weight columns (resolved once from the header)
  let iYear = -1, iBu = -1, iWgt = -1;
  for (let i = 0; i < nWanted; i++) {
    const k = wantedKey[i];
    if (k === "time" || k === "Time" || k === "Year") { if (iYear < 0) iYear = i; }
    else if (k === "idBu" || k === "idbu" || k === "id_BenefitUnit") { if (iBu < 0) iBu = i; }
    else if (k === "wgt" || k === "Wgt") { if (iWgt < 0) iWgt = i; }
  }

  const maxWantedPos = wantedPos.length ? Math.max(...wantedPos) : 0;
  const rows = [];
  const compact = makeCompactor();
  let pos = firstNL + 1;
  const len = text.length;

  while (pos < len) {
    // Find end of this line
    let eol = text.indexOf("\n", pos);
    if (eol < 0) eol = len;

    // Skip blank lines
    if (eol > pos) {
      const line = text.slice(pos, eol).replace(/\r$/, "");
      if (line.length > 0) {
        // Split only up to the highest wanted column — avoids large temp arrays
        const cells = splitUpTo(line, delim, maxWantedPos + 1);

        // Read join keys
        const yr   = iYear >= 0 ? cells[wantedPos[iYear]] : undefined;
        const buId = iBu   >= 0 ? cells[wantedPos[iBu]]   : undefined;
        const bRow = (yr && buId) ? (benefitMap.get(`${yr}_${buId}`) || null) : null;

        let wgt = iWgt >= 0 ? +cells[wantedPos[iWgt]] : NaN;
        if (isNaN(wgt) || wgt <= 0) {
          // Try weight from benefit row
          wgt = bRow ? +(bRow.wgt || bRow.Wgt || 1) : 1;
          if (isNaN(wgt) || wgt <= 0) wgt = 1;
        }

        const row = newRow(+yr, wgt);

        // Populate display-name fields — for PERSON_ONLY_KEYS read from
        // person cells only; for everything else prefer the benefit row value
        // if it exists and is non-empty (same benefit-first logic as before).
        for (let i = 0; i < nWanted; i++) {
          const disp = slotDisplay[i];
          if (disp === null) continue; // join/weight col, already handled
          const rawKey  = wantedKey[i];
          const cellVal = cells[wantedPos[i]];

          let val;
          if (PERSON_ONLY_KEYS.has(rawKey) || !bRow) {
            val = cellVal;
          } else {
            const bv = bRow[rawKey];
            val = (bv !== undefined && bv !== "" && !isMissingCode(bv)) ? bv : cellVal;
          }
          if (val !== undefined && val !== "" && !isMissingCode(val)) row[disp] = compact(disp, val);
        }

        // Also pull benefit-only columns that aren't in the person file at all
        // (Income Quintile, Equivalised income, Benefit amount, Region live on
        // the benefit-unit row and may have no person-side slot at all).
        if (bRow) {
          for (const [rawKey, disp] of colMapEntries) {
            if (row[disp] == null) {
              const bv = bRow[rawKey];
              if (bv !== undefined && bv !== "" && !isMissingCode(bv)) row[disp] = compact(disp, bv);
            }
          }
        }

        // ── Recode / bin ────────────────────────────────────────────────────
        if (row["Age"]          != null) { row.AgeYears = +row["Age"]; row["Age"] = binAge(row["Age"]); }  // keep single year for the pyramid
        if (row["Number of children"] != null) row["Number of children"] = binChildren(row["Number of children"]);
        if (row["Region"]       != null) row["Region"]       = REGION_MAP[String(row["Region"])] ?? row["Region"];
        if (row["Disability Status"] != null) row["Disability Status"] = DISABILITY_MAP[String(row["Disability Status"]).toLowerCase()] ?? row["Disability Status"];
        if (row["Financial distress flag"] != null) row["Financial distress flag"] = FINANCIAL_MAP[String(row["Financial distress flag"]).toLowerCase()] ?? row["Financial distress flag"];
        if (row["Provided care"] != null) row["Provided care"] = PROV_SOCIAL_CARE_MAP[String(row["Provided care"]).toLowerCase()] ?? row["Provided care"];
        if (row["Received care"] != null) row["Received care"] = RECV_SOCIAL_CARE_MAP[String(row["Received care"]).toLowerCase()] ?? row["Received care"];
        if (row["Universal Credit Benefits Flag"] != null) row["Universal Credit Benefits Flag"] = UC_BENEFITS_MAP[String(row["Universal Credit Benefits Flag"]).toLowerCase()] ?? row["Universal Credit Benefits Flag"];
        if (row["Gender"] != null) {
          const g = String(row["Gender"]).toLowerCase();
          row["Gender"] = (g === "1" || g === "true" || g === "male") ? "Male" : "Female";
        }
        if (row["Employment status"] != null) {
          row["Employment status"] = EMPLOYMENT_MAP[String(row["Employment status"]).toLowerCase().replace(/[\s\-_]/g,"")] ?? row["Employment status"];
        }
        if (row["Household Type"] != null) {
          row["Household Type"] = HOUSEHOLD_MAP[String(row["Household Type"]).toLowerCase().replace(/[\s\-_]/g,"")] ?? row["Household Type"];
        }

        rows.push(row);
      }
    }
    pos = eol + 1;
  }
  return rows;
}

// ─── Streaming person CSV parser ─────────────────────────────────────────────
// Reads the person file in 32MB chunks via Blob.slice(), processing each line
// immediately without ever holding the full CSV string in memory.
// benefitMap must already be built before calling this.
export async function parsePersonCsvStream(personFileHandle, benefitMap) {
  const CHUNK = 32 * 1024 * 1024; // 32MB
  const decoder = new TextDecoder("utf-8");
  const rows = [];
  const compact = makeCompactor();

  let leftover  = "";   // partial line carried from previous chunk
  let headers   = null; // set after first line
  let delim     = ",";
  let wantedPos = [], wantedKey = [], slotDisplay = [];
  let iYear = -1, iBu = -1, iWgt = -1, maxPos = 0;
  const colMapEntries = Object.entries(COLUMN_MAP);

  const file   = await personFileHandle.getFile();
  let offset   = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK);
    const buf   = await slice.arrayBuffer();
    const isLast = offset + CHUNK >= file.size;
    const chunk  = leftover + decoder.decode(buf, { stream: !isLast });
    offset += CHUNK;

    // Split into lines, keep last partial line as leftover
    const nlIdx = chunk.lastIndexOf("\n");
    const toProcess = nlIdx >= 0 ? chunk.slice(0, nlIdx) : chunk;
    leftover = nlIdx >= 0 ? chunk.slice(nlIdx + 1) : "";

    const lines = toProcess.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) continue;

      if (!headers) {
        // First non-empty line is the header
        let h = line;
        if (h.charCodeAt(0) === 0xFEFF) h = h.slice(1);
        const nCommas     = (h.match(/,/g)  || []).length;
        const nSemicolons = (h.match(/;/g)  || []).length;
        const nTabs       = (h.match(/\t/g) || []).length;
        delim   = nTabs > nCommas ? "\t" : nSemicolons > nCommas ? ";" : ",";
        headers = h.split(delim);
        const nCols = headers.length;
        for (let c = 0; c < nCols; c++) {
          const hh = headers[c].trim();
          if (PERSON_WANT.has(hh)) { wantedPos.push(c); wantedKey.push(hh); }
        }
        const nWanted = wantedPos.length;
        slotDisplay = new Array(nWanted).fill(null);
        for (let i = 0; i < nWanted; i++) {
          const d = COLUMN_MAP[wantedKey[i]];
          if (d !== undefined) slotDisplay[i] = d;
        }
        for (let i = 0; i < nWanted; i++) {
          const k = wantedKey[i];
          if (k === "time" || k === "Time" || k === "Year") { if (iYear < 0) iYear = i; }
          else if (k === "idBu" || k === "idbu" || k === "id_BenefitUnit") { if (iBu < 0) iBu = i; }
          else if (k === "wgt" || k === "Wgt") { if (iWgt < 0) iWgt = i; }
        }
        maxPos = wantedPos.length ? Math.max(...wantedPos) : 0;
        continue;
      }

      // Data line — split only up to the highest wanted column index
      const nWanted = wantedPos.length;
      const cells = splitUpTo(line, delim, maxPos + 1);
      const yr   = iYear >= 0 ? cells[wantedPos[iYear]] : undefined;
      const buId = iBu   >= 0 ? cells[wantedPos[iBu]]   : undefined;
      const bRow = (yr && buId) ? (benefitMap.get(`${yr}_${buId}`) || null) : null;
      let wgt = iWgt >= 0 ? +cells[wantedPos[iWgt]] : NaN;
      if (isNaN(wgt) || wgt <= 0) { wgt = bRow ? +(bRow.wgt || bRow.Wgt || 1) : 1; if (isNaN(wgt)||wgt<=0) wgt=1; }
      const row = newRow(+yr, wgt);
      for (let i = 0; i < nWanted; i++) {
        const disp = slotDisplay[i]; if (disp===null) continue;
        const rawKey=wantedKey[i], cellVal=cells[wantedPos[i]];
        let val;
        if (PERSON_ONLY_KEYS.has(rawKey)||!bRow) { val=cellVal; }
        else { const bv=bRow[rawKey]; val=(bv!==undefined&&bv!==""&&!isMissingCode(bv))?bv:cellVal; }
        if (val!==undefined&&val!==""&&!isMissingCode(val)) row[disp]=compact(disp,val);
      }
      if (bRow) { for (const [rawKey,disp] of colMapEntries) { if (row[disp]==null) { const bv=bRow[rawKey]; if (bv!==undefined&&bv!==""&&!isMissingCode(bv)) row[disp]=compact(disp,bv); } } }
      if (row["Age"]!=null) { row.AgeYears=+row["Age"]; row["Age"]=binAge(row["Age"]); }  // keep single year for the pyramid
      if (row["Number of children"]!=null) row["Number of children"]=binChildren(row["Number of children"]);
      if (row["Region"]!=null) row["Region"]=REGION_MAP[String(row["Region"])]??row["Region"];
      if (row["Disability Status"]!=null) row["Disability Status"]=DISABILITY_MAP[String(row["Disability Status"]).toLowerCase()]??row["Disability Status"];
      if (row["Financial distress flag"]!=null) row["Financial distress flag"]=FINANCIAL_MAP[String(row["Financial distress flag"]).toLowerCase()]??row["Financial distress flag"];
      if (row["Provided care"]!=null) row["Provided care"]=PROV_SOCIAL_CARE_MAP[String(row["Provided care"]).toLowerCase()]??row["Provided care"];
      if (row["Received care"]!=null) row["Received care"]=RECV_SOCIAL_CARE_MAP[String(row["Received care"]).toLowerCase()]??row["Received care"];
      if (row["Universal Credit Benefits Flag"]!=null) row["Universal Credit Benefits Flag"]=UC_BENEFITS_MAP[String(row["Universal Credit Benefits Flag"]).toLowerCase()]??row["Universal Credit Benefits Flag"];
      if (row["Gender"]!=null) { const g=String(row["Gender"]).toLowerCase(); row["Gender"]=(g==="1"||g==="true"||g==="male")?"Male":"Female"; }
      if (row["Employment status"]!=null) row["Employment status"]=EMPLOYMENT_MAP[String(row["Employment status"]).toLowerCase().replace(/[\s\-_]/g,"")]??row["Employment status"];
      if (row["Household Type"]!=null) row["Household Type"]=HOUSEHOLD_MAP[String(row["Household Type"]).toLowerCase().replace(/[\s\-_]/g,"")]??row["Household Type"];
      rows.push(row);
    }
  }
  return rows;
}

// ─── Streaming public entry point ────────────────────────────────────────────
// Uses parsePersonCsvStream to avoid holding the full person CSV in memory.
// personFileHandle: a FileSystemFileHandle or File with a .getFile()/.slice() API.
// benefitText: full text of the benefit CSV (much smaller, safe to hold).
export async function processRunFiles(personFileHandle, benefitText, scenarioName, runId) {
  if (!benefitText || benefitText.trim().length === 0) {
    throw new Error(`Benefit CSV for ${scenarioName}/${runId} is empty (0 bytes).`);
  }
  const benefitMap = buildBenefitMap(benefitText);
  const personRows = await parsePersonCsvStream(personFileHandle, benefitMap);
  if (!personRows.length) {
    throw new Error(`Person CSV for ${scenarioName}/${runId} produced no rows after parsing.`);
  }
  return aggregateSingleRun(personRows, scenarioName, runId);
}

// ─── Public entry point (text-based, kept for CSV loading path) ──────────────
export function processRunTexts(personText, benefitText, scenarioName, runId) {
  if (!personText || personText.trim().length === 0) {
    throw new Error(`Person CSV for ${scenarioName}/${runId} is empty (0 bytes). Check the file exists and was written correctly by the simulation.`);
  }
  if (!benefitText || benefitText.trim().length === 0) {
    throw new Error(`Benefit CSV for ${scenarioName}/${runId} is empty (0 bytes). Check the file exists and was written correctly by the simulation.`);
  }

  const benefitMap = buildBenefitMap(benefitText);

  // Diagnostic: check benefit map has entries
  if (benefitMap.size === 0) {
    const firstLine = benefitText.slice(0, 200).replace(/\r?\n/g, " | ");
    throw new Error(
      `Benefit CSV produced no rows for ${scenarioName}/${runId}. ` +
      `Check that the benefit file has 'id_BenefitUnit' and 'time' columns. ` +
      `First 200 chars: ${firstLine}`
    );
  }

  // Diagnostic: detect delimiter and check headers match expected columns
  const firstNL = personText.indexOf("\n");
  if (firstNL > 0) {
    const headerLine = personText.slice(0, firstNL).replace(/\r$/, "");
    // Auto-detect delimiter
    const nCommas     = (headerLine.match(/,/g)  || []).length;
    const nSemicolons = (headerLine.match(/;/g)  || []).length;
    const nTabs       = (headerLine.match(/\t/g) || []).length;
    const delim = nTabs > nCommas ? "\t" : nSemicolons > nCommas ? ";" : ",";
    const headerCols = new Set(headerLine.split(delim).map(h => h.trim().replace(/^"|"$/g, "")));
    const knownCols  = [...PERSON_WANT].filter(k => headerCols.has(k));
    if (knownCols.length === 0) {
      const actualHeaders = [...headerCols].slice(0, 12).join(", ");
      throw new Error(
        `Person CSV for ${scenarioName}/${runId} has no recognised columns ` +
        `(detected delimiter: '${delim}', ${headerCols.size} columns found). ` +
        `Expected columns like: idBu, time, demAge, demMaleFlag, labC4. ` +
        `Actual first 12 headers: ${actualHeaders}`
      );
    }
  }

  const runRows = parsePersonCsv(personText, benefitMap);

  if (!runRows.length) {
    const raw = personText.slice(0, 300);
    const lines = raw.split("\n");
    throw new Error(
      `Person CSV for ${scenarioName}/${runId} parsed to 0 rows. ` +
      `File length: ${personText.length} chars. ` +
      `Line count in first 300 chars: ${lines.length}. ` +
      `First 200 chars (escaped): ${raw.slice(0,200).replace(/\n/g,"\\n").replace(/\r/g,"\\r")}`
    );
  }

  const metrics = aggregateSingleRun(runRows, scenarioName, runId);

  if (!metrics.length) {
    throw new Error(
      `Aggregation produced 0 metrics for ${scenarioName}/${runId}. ` +
      `${runRows.length} rows were parsed but no recognised variable values were found. ` +
      `Check that COLUMN_MAP keys match the CSV column names.`
    );
  }

  return metrics;
}

// ─── Single-pass per-run aggregation ─────────────────────────────────────────
// Unchanged structure but with two optimisations:
//   • Stratifier values for each row are pre-resolved into a flat string array
//     once per row, rather than being re-resolved inside every variable's inner
//     loop.
//   • The wage-bin accumulation is folded into this same pass rather than
//     running as a separate third scan of yearRows.
export function aggregateSingleRun(rows, scenario, runId) {
  const metrics = [];

  // Group rows by year
  const byYear = new Map();
  for (const r of rows) {
    let b = byYear.get(r.Year);
    if (!b) { b = []; byYear.set(r.Year, b); }
    b.push(r);
  }

  const nStrats = STRATIFIERS.length;

  for (const [year, yearRows] of byYear) {

    // Initialise accumulators
    const numAcc = new Map();
    const catAcc = new Map();
    for (const v of ALL_DISPLAY_VARS) {
      if (NUMERIC_VARS.has(v)) {
        numAcc.set(v, { sumW:0, sumVW:0, n:0, nTotal:0, strat:new Map() });
      } else {
        catAcc.set(v, { totalW:0, cats:new Map(), strat:new Map() });
      }
    }

    // Wage-bin accumulators (folded into main pass)
    const wageBinAcc   = new Map(); // binLabel → {sumW, n}
    const wageStratAcc = new Map(); // stratifier → stratVal → {totalW, bins: Map<binLabel,{sumW,n}>}
    let wageTotalW = 0, wageTotalN = 0, wageMissingN = 0;

    // Population size: number of simulated people (sum of weights; weights are 1
    // in SimPaths output), overall and in each stratifier group. Emitted as a
    // numeric "mean" row so it uses the same charts, intervals and threshold.
    let popW = 0, popN = 0;
    const popStrat = new Map();   // stratifier → stratVal → {sumW, n}

    // Income-bin accumulators — same pattern as wage bins, one set per income variable
    const incomeBinVarNames = Object.keys(INCOME_BIN_VARS);
    const incBinAcc   = new Map(); // varName → Map<binLabel, {sumW,n}>
    const incStratAcc = new Map(); // varName → stratifier → stratVal → {totalW, bins}
    const incTotals   = new Map(); // varName → {totalW, totalN, missingN}
    for (const iv of incomeBinVarNames) {
      incBinAcc.set(iv, new Map());
      incStratAcc.set(iv, new Map());
      incTotals.set(iv, {totalW:0, totalN:0, missingN:0});
    }

    // ── Single pass ──────────────────────────────────────────────────────────
    for (const r of yearRows) {
      const w = r.wgt;

      // Pre-resolve all stratifier values for this row once
      // svKeys[i] corresponds to STRATIFIERS[i]
      const svKeys = new Array(nStrats);
      for (let si = 0; si < nStrats; si++) {
        const rawSv = r[STRATIFIERS[si]];
        svKeys[si] = notMissing(rawSv) ? String(rawSv) : "Missing";
      }

      // Population size
      popW += w; popN++;
      for (let si = 0; si < nStrats; si++) {
        const svKey = svKeys[si];
        if (svKey === "Missing") continue;
        let sMap = popStrat.get(STRATIFIERS[si]);
        if (!sMap) { sMap = new Map(); popStrat.set(STRATIFIERS[si], sMap); }
        let pa = sMap.get(svKey);
        if (!pa) { pa = {sumW:0, n:0}; sMap.set(svKey, pa); }
        pa.sumW += w; pa.n++;
      }

      // Numeric variables
      for (const [v, acc] of numAcc) {
        const rawV = r[v];
        const numV = notMissing(rawV) ? +rawV : NaN;
        const valid = !isNaN(numV);
        acc.nTotal++;
        if (valid) { acc.sumW += w; acc.sumVW += numV * w; acc.n++; }

        for (let si = 0; si < nStrats; si++) {
          if (STRATIFIERS[si] === v) continue;
          const svKey = svKeys[si];
          if (svKey === "Missing") continue;  // skip rows with missing stratifier value
          const s     = STRATIFIERS[si];
          let sMap = acc.strat.get(s);
          if (!sMap) { sMap = new Map(); acc.strat.set(s, sMap); }
          let a = sMap.get(svKey);
          if (!a) { a = {sumW:0,sumVW:0,n:0,nTotal:0}; sMap.set(svKey, a); }
          a.nTotal++;
          if (valid) { a.sumW += w; a.sumVW += numV * w; a.n++; }
        }
      }

      // Categorical variables — only accumulate non-missing values.
      // Missing is excluded from the denominator so valid-category shares
      // sum to 100%, and no "Missing" row is ever emitted.
      for (const [v, acc] of catAcc) {
        const rawVv = r[v];
        if (!notMissing(rawVv)) continue;  // skip missing — don't add to totalW or cats
        const vvKey = String(rawVv);
        acc.totalW += w;
        let oa = acc.cats.get(vvKey);
        if (!oa) { oa = {sumW:0,n:0}; acc.cats.set(vvKey, oa); }
        oa.sumW += w; oa.n++;

        for (let si = 0; si < nStrats; si++) {
          if (STRATIFIERS[si] === v) continue;
          const svKey = svKeys[si];
          if (svKey === "Missing") continue;  // skip rows with missing stratifier value
          const s     = STRATIFIERS[si];
          let sMap = acc.strat.get(s);
          if (!sMap) { sMap = new Map(); acc.strat.set(s, sMap); }
          let svMap = sMap.get(svKey);
          if (!svMap) { svMap = {totalW:0,cats:new Map()}; sMap.set(svKey, svMap); }
          svMap.totalW += w;
          let ca = svMap.cats.get(vvKey);
          if (!ca) { ca = {sumW:0,n:0}; svMap.cats.set(vvKey, ca); }
          ca.sumW += w; ca.n++;
        }
      }

      // Wage-bin pass (folded in — no extra scan of yearRows)
      wageTotalN++;
      const rawWage = r["Hourly earnings"];
      const binLbl  = notMissing(rawWage) ? binWage(rawWage) : null;
      if (binLbl === null) {
        wageMissingN++;
      } else {
        wageTotalW += w;
        let ba = wageBinAcc.get(binLbl);
        if (!ba) { ba = {sumW:0,n:0}; wageBinAcc.set(binLbl, ba); }
        ba.sumW += w; ba.n++;

        for (let si = 0; si < nStrats; si++) {
          const svKey = svKeys[si];
          if (svKey === "Missing") continue;
          const s     = STRATIFIERS[si];
          let sMap = wageStratAcc.get(s);
          if (!sMap) { sMap = new Map(); wageStratAcc.set(s, sMap); }
          let svMap = sMap.get(svKey);
          if (!svMap) { svMap = {totalW:0, bins:new Map()}; sMap.set(svKey, svMap); }
          svMap.totalW += w;
          let bsa = svMap.bins.get(binLbl);
          if (!bsa) { bsa = {sumW:0,n:0}; svMap.bins.set(binLbl, bsa); }
          bsa.sumW += w; bsa.n++;
        }
      }

      // Income-bin pass — same pattern for other monetary income variables
      for (const iv of incomeBinVarNames) {
        const tot = incTotals.get(iv);
        tot.totalN++;
        const rawInc = r[iv];
        const incBinLbl = notMissing(rawInc) ? binIncome(iv, rawInc) : null;
        if (incBinLbl === null) {
          tot.missingN++;
        } else {
          tot.totalW += w;
          const binMap = incBinAcc.get(iv);
          let ba = binMap.get(incBinLbl);
          if (!ba) { ba = {sumW:0,n:0}; binMap.set(incBinLbl, ba); }
          ba.sumW += w; ba.n++;

          const stratMap = incStratAcc.get(iv);
          for (let si = 0; si < nStrats; si++) {
            const svKey = svKeys[si];
            if (svKey === "Missing") continue;
            const s     = STRATIFIERS[si];
            let sMap = stratMap.get(s);
            if (!sMap) { sMap = new Map(); stratMap.set(s, sMap); }
            let svMap = sMap.get(svKey);
            if (!svMap) { svMap = {totalW:0, bins:new Map()}; sMap.set(svKey, svMap); }
            svMap.totalW += w;
            let bsa = svMap.bins.get(incBinLbl);
            if (!bsa) { bsa = {sumW:0,n:0}; svMap.bins.set(incBinLbl, bsa); }
            bsa.sumW += w; bsa.n++;
          }
        }
      }
    }
    // ── End single pass ──────────────────────────────────────────────────────

    // Emit numeric metrics
    for (const [v, acc] of numAcc) {
      const nMissing = acc.nTotal - acc.n;
      if (acc.n > 0) {
        metrics.push({year,scenario,run:runId,variable:v,
          variable_value:"Continuous Mean",stratifier:"Overall",stratifier_value:"Overall",
          metric_type:"mean",n:acc.n,metric_value:acc.sumW>0?acc.sumVW/acc.sumW:0});
      }
      if (nMissing > 0) {
        metrics.push({year,scenario,run:runId,variable:v,
          variable_value:"Missing",stratifier:"Overall",stratifier_value:"Overall",
          metric_type:"share",n:nMissing,metric_value:acc.nTotal>0?nMissing/acc.nTotal:0});
      }
      for (const [s, sMap] of acc.strat) {
        for (const [svKey, a] of sMap) {
          const aMissing = a.nTotal - a.n;
          if (a.n > 0) {
            metrics.push({year,scenario,run:runId,variable:v,
              variable_value:"Continuous Mean",stratifier:s,stratifier_value:svKey,
              metric_type:"mean",n:a.n,metric_value:a.sumW>0?a.sumVW/a.sumW:0});
          }
          if (aMissing > 0) {
            metrics.push({year,scenario,run:runId,variable:v,
              variable_value:"Missing",stratifier:s,stratifier_value:svKey,
              metric_type:"share",n:aMissing,metric_value:a.nTotal>0?aMissing/a.nTotal:0});
          }
        }
      }
    }

    // Emit population-size metrics
    if (popN > 0) {
      metrics.push({year,scenario,run:runId,variable:"Population size",
        variable_value:"Continuous Mean",stratifier:"Overall",stratifier_value:"Overall",
        metric_type:"mean",n:popN,metric_value:popW});
    }
    for (const [s, sMap] of popStrat) {
      for (const [svKey, pa] of sMap) {
        metrics.push({year,scenario,run:runId,variable:"Population size",
          variable_value:"Continuous Mean",stratifier:s,stratifier_value:svKey,
          metric_type:"mean",n:pa.n,metric_value:pa.sumW});
      }
    }

    // Emit categorical metrics
    for (const [v, acc] of catAcc) {
      for (const [vvKey, oa] of acc.cats) {
        metrics.push({year,scenario,run:runId,variable:v,
          variable_value:vvKey,stratifier:"Overall",stratifier_value:"Overall",
          metric_type:"share",n:oa.n,metric_value:acc.totalW>0?oa.sumW/acc.totalW:0});
      }
      for (const [s, sMap] of acc.strat) {
        for (const [svKey, svMap] of sMap) {
          for (const [vvKey, ca] of svMap.cats) {
            metrics.push({year,scenario,run:runId,variable:v,
              variable_value:vvKey,stratifier:s,stratifier_value:svKey,
              metric_type:"share",n:ca.n,metric_value:svMap.totalW>0?ca.sumW/svMap.totalW:0});
          }
        }
      }
    }

    // Emit wage-bin metrics
    for (const [binLbl, ba] of wageBinAcc) {
      metrics.push({year,scenario,run:runId,
        variable:"Hourly earnings",variable_value:binLbl,
        stratifier:"Overall",stratifier_value:"Overall",
        metric_type:"wage_bin",n:ba.n,
        metric_value:wageTotalW>0?ba.sumW/wageTotalW:0});
    }
    if (wageMissingN > 0) {
      metrics.push({year,scenario,run:runId,
        variable:"Hourly earnings",variable_value:"Missing",
        stratifier:"Overall",stratifier_value:"Overall",
        metric_type:"wage_bin",n:wageMissingN,
        metric_value:wageTotalN>0?wageMissingN/wageTotalN:0});
    }
    for (const [s, sMap] of wageStratAcc) {
      for (const [svKey, svMap] of sMap) {
        for (const [binLbl, bsa] of svMap.bins) {
          metrics.push({year,scenario,run:runId,
            variable:"Hourly earnings",variable_value:binLbl,
            stratifier:s,stratifier_value:svKey,
            metric_type:"wage_bin",n:bsa.n,
            metric_value:svMap.totalW>0?bsa.sumW/svMap.totalW:0});
        }
      }
    }

    // Emit income-bin metrics (metric_type="income_bin") for other monetary variables
    for (const iv of incomeBinVarNames) {
      const tot     = incTotals.get(iv);
      const binMap  = incBinAcc.get(iv);
      const stratMap= incStratAcc.get(iv);
      for (const [binLbl, ba] of binMap) {
        metrics.push({year,scenario,run:runId,
          variable:iv, variable_value:binLbl,
          stratifier:"Overall", stratifier_value:"Overall",
          metric_type:"income_bin", n:ba.n,
          metric_value:tot.totalW>0?ba.sumW/tot.totalW:0});
      }
      if (tot.missingN > 0) {
        metrics.push({year,scenario,run:runId,
          variable:iv, variable_value:"Missing",
          stratifier:"Overall", stratifier_value:"Overall",
          metric_type:"income_bin", n:tot.missingN,
          metric_value:tot.totalN>0?tot.missingN/tot.totalN:0});
      }
      for (const [s, sMap] of stratMap) {
        for (const [svKey, svMap] of sMap) {
          for (const [binLbl, bsa] of svMap.bins) {
            metrics.push({year,scenario,run:runId,
              variable:iv, variable_value:binLbl,
              stratifier:s, stratifier_value:svKey,
              metric_type:"income_bin", n:bsa.n,
              metric_value:svMap.totalW>0?bsa.sumW/svMap.totalW:0});
          }
        }
      }
    }

    // ── Population pyramid bins ───────────────────────────────────────────────
    // Emit pyramid_bin rows: share of each SINGLE YEAR of age × gender out of the
    // total population (ages PYRAMID_TOP_AGE and over are grouped, e.g. "100+").
    // Shape matches the R script's pyramid chunk exactly:
    //   variable="Age", stratifier="Gender",
    //   variable_value="0", "1", … "99", "100+", stratifier_value="Male"/"Female"
    // The denominator is the total weight of BOTH genders, so all bars
    // together sum to 100% (standard pyramid convention, matches the R script).
    {
      // gender → ageBand → {sumW, n}
      const pyrAcc = { Male: new Map(), Female: new Map() };
      const pyrTot = { Male: {sumW:0,n:0}, Female: {sumW:0,n:0} };

      for (const r of yearRows) {
        const gender = r["Gender"]; // already recoded to "Male"/"Female"
        if (gender !== "Male" && gender !== "Female") continue;
        const ageBand = pyramidAge(r.AgeYears);   // single year, e.g. "34" or "90+"
        if (!ageBand) continue;
        const w = r.wgt;

        pyrTot[gender].sumW += w;
        pyrTot[gender].n++;

        let ba = pyrAcc[gender].get(ageBand);
        if (!ba) { ba = {sumW:0,n:0}; pyrAcc[gender].set(ageBand, ba); }
        ba.sumW += w; ba.n++;
      }

      // Shares are of the TOTAL population (both genders), the standard
      // pyramid convention: all bars together sum to 100%. Matches the R
      // pre-aggregation script.
      const totalW = pyrTot.Male.sumW + pyrTot.Female.sumW;
      for (const gender of ["Male","Female"]) {
        for (const [ageBand, ba] of pyrAcc[gender]) {
          metrics.push({year,scenario,run:runId,
            variable:"Age", variable_value:ageBand,
            stratifier:"Gender", stratifier_value:gender,
            metric_type:"pyramid_bin", n:ba.n,
            metric_value: totalW > 0 ? ba.sumW / totalW : 0});
        }
      }
    }
    // ── End pyramid-bin pass ──────────────────────────────────────────────────
  }

  return metrics;
}

// ─── Cross-run aggregation ────────────────────────────────────────────────────
// Uses Welford's online algorithm for mean and variance — avoids storing every
// run's metric_value in a growing array and then scanning it twice. One pass,
// O(1) extra memory per group regardless of run count.
//
// Paired delta computation (for the Δ Baseline → Scenario plot):
//   For each matched seed, the per-run mean difference (Scenario − Baseline)
//   is computed. The average of these paired differences, plus its SD and SE,
//   are attached to every Scenario row as paired_mean_delta / paired_lower_ci /
//   paired_upper_ci / paired_n_runs. This paired approach removes stochastic
//   variation that is shared between matched runs — the 95% CI is computed as
//   mean_delta ± 1.96 × SE, where SE = SD_delta / √(n_paired_runs).
/** Minimum unweighted sample required in EVERY run for an estimate to be shown.
 *  If any single run has fewer than this (including 0, i.e. the group is absent
 *  from that run), the estimate, its CI and any paired delta are all suppressed. */
export const MIN_RUN_SAMPLE = 20;

/** Create a new empty accumulator for incremental cross-run aggregation. */
export function createGroupedAccumulator() {
  return new Map();
}

/** Feed one run's metrics into an existing accumulator. Call this once per run
 *  as results arrive, then call finaliseAggregation() when all runs are done.
 *  This avoids ever holding all runs' raw metrics in memory simultaneously. */
export function accumulateRunMetrics(grouped, runMetrics) {
  for (const d of runMetrics) {
    const key = `${d.year}|${d.scenario}|${d.variable}|${d.variable_value}|${d.stratifier}|${d.stratifier_value}|${d.metric_type}`;
    let g = grouped.get(key);
    if (!g) {
      g = {
        year: d.year, scenario: d.scenario, variable: d.variable,
        variable_value: d.variable_value, stratifier: d.stratifier,
        stratifier_value: d.stratifier_value, metric_type: d.metric_type,
        count:0, mean:0, M2:0, totalN:0, minN:Infinity,
        runVals: new Map(),
      };
      grouped.set(key, g);
    }
    g.count++;
    const dv = d.metric_value - g.mean;
    g.mean += dv / g.count;
    g.M2   += dv * (d.metric_value - g.mean);
    g.totalN += d.n;
    if (d.n < g.minN) g.minN = d.n;
    if (d.run != null) g.runVals.set(String(d.run), d.metric_value);
  }
  // runMetrics falls out of scope here — GC eligible immediately
}

/** Finalise an incremental accumulator into output rows. */
export function finaliseAggregation(grouped) {
  // Build nonKey lookups for paired delta
  const baseVals = new Map();
  const scenVals = new Map();

  for (const [key, g] of grouped) {
    const p = key.split("|");
    const scen   = p[1];
    const nonKey = `${p[0]}|${p[2]}|${p[3]}|${p[4]}|${p[5]}|${p[6]}`;
    if (scen === "baseline") {
      baseVals.set(nonKey, g.runVals);
    } else {
      let sm = scenVals.get(nonKey);
      if (!sm) { sm = new Map(); scenVals.set(nonKey, sm); }
      sm.set(scen, g.runVals);
    }
  }

  // Number of runs per scenario (the "Overall" rows exist in every run, so the
  // largest per-group run count equals the total runs for that scenario).
  // A group seen in fewer runs had a sample of 0 in at least one run.
  const runsPerScenario = new Map();
  for (const g of grouped.values()) {
    if (g.count > (runsPerScenario.get(g.scenario) ?? 0)) runsPerScenario.set(g.scenario, g.count);
  }
  const baseOk = new Map();
  for (const g of grouped.values()) {
    if (g.scenario !== "baseline") continue;
    const nonKey = `${g.year}|${g.variable}|${g.variable_value}|${g.stratifier}|${g.stratifier_value}|${g.metric_type}`;
    baseOk.set(nonKey, g.minN >= MIN_RUN_SAMPLE && g.count >= runsPerScenario.get("baseline"));
  }

  // The first simulated year is the starting population, before the model has
  // run a step (and before any policy starts), so it is left out of the output.
  // The R pre-aggregation script drops it too.
  let firstYear = Infinity;
  for (const g of grouped.values()) { const y = +g.year; if (y < firstYear) firstYear = y; }

  const finalRows = [];
  for (const [key, g] of grouped) {
    const { year, scenario, variable, variable_value, stratifier,
            stratifier_value, metric_type, count, mean, M2, totalN, minN, runVals } = g;
    if (+year === firstYear) { g.runVals = null; continue; }

    const n_runs       = count;
    const variance     = n_runs > 1 ? M2 / (n_runs - 1) : 0;
    const sd_value     = Math.sqrt(variance);
    const se_value     = n_runs > 0 ? sd_value / Math.sqrt(n_runs) : 0;
    const total_sample = totalN;
    const min_sample   = isFinite(minN) ? minN : 0;
    const mean_sample  = n_runs > 0 ? total_sample / n_runs : 0;

    let mean_value = mean;
    // A 95% CI needs at least 2 runs: with 1 run the SD is undefined, so the
    // interval is left blank (NaN) rather than drawn as a zero-width band.
    let lower_ci   = n_runs >= 2 ? mean_value - 1.96 * se_value : NaN;
    let upper_ci   = n_runs >= 2 ? mean_value + 1.96 * se_value : NaN;
    // Suppress if ANY single run had fewer than MIN_RUN_SAMPLE observations
    // behind this estimate (per-run minimum, not the pooled total).
    // A group missing from some runs had 0 observations in those runs.
    const suppressed = min_sample < MIN_RUN_SAMPLE || n_runs < (runsPerScenario.get(scenario) ?? 0);
    if (suppressed) { mean_value = NaN; lower_ci = NaN; upper_ci = NaN; }

    let paired_mean_delta = NaN, paired_lower_ci = NaN, paired_upper_ci = NaN, paired_n_runs = 0;
    if (scenario !== "baseline") {
      const p = key.split("|");
      const nonKey = `${p[0]}|${p[2]}|${p[3]}|${p[4]}|${p[5]}|${p[6]}`;
      const bVals  = baseVals.get(nonKey);
      // Also suppress the paired delta if either side fails the per-run threshold
      const baseSuppressed = !baseOk.get(nonKey);
      if (!suppressed && !baseSuppressed && bVals && runVals && runVals.size > 0) {
        let pCount = 0, pMean = 0, pM2 = 0;
        for (const [seed, sVal] of runVals) {
          const bVal = bVals.get(seed);
          if (bVal == null || isNaN(sVal) || isNaN(bVal)) continue;
          const diff = sVal - bVal;
          pCount++;
          const pd = diff - pMean;
          pMean += pd / pCount;
          pM2   += pd * (diff - pMean);
        }
        if (pCount > 0) {
          paired_n_runs = pCount;
          const pSd = pCount > 1 ? Math.sqrt(pM2 / (pCount - 1)) : 0;
          const pSe = pSd / Math.sqrt(pCount);
          paired_mean_delta = pMean;
          // Same rule for the paired delta: no interval from a single matched pair.
          paired_lower_ci   = pCount >= 2 ? pMean - 1.96 * pSe : NaN;
          paired_upper_ci   = pCount >= 2 ? pMean + 1.96 * pSe : NaN;
        }
      }
    }

    g.runVals = null; // release memory

    finalRows.push({
      year: +year, scenario: scenario.toLowerCase(),
      module: MODULE_MAP[variable] || "Other",
      variable, variable_value, stratifier, stratifier_value, metric_type,
      n_runs, total_sample, min_sample, mean_sample,
      mean_value, sd_value, lower_ci, upper_ci,
      paired_mean_delta, paired_lower_ci, paired_upper_ci, paired_n_runs,
    });
  }
  return finalRows;
}