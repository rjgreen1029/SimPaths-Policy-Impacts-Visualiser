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

import * as d3 from "d3";

// ─── Binning helpers ──────────────────────────────────────────────────────────
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
export const SOCIAL_CARE_MAP     = {"false":"Does not need social care","0":"Does not need social care","true":"Needs social care","1":"Needs social care"};
export const PROV_SOCIAL_CARE_MAP= {"false":"Does not provide social care","0":"Does not provide social care","true":"Provides social care","1":"Provides social care"};
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
  "demNChild":"Number of children",
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
  "healthWbScore0to36":"Subjective wellbeing (GHQ)","careNeedFlag":"Need of social care",
};

export const MODULE_MAP = {
  "Highest Level of Education":"Demographics","Age":"Demographics","Gender":"Demographics",
  "Ethnicity":"Demographics","Partnership status":"Demographics","Number of children":"Demographics",
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
  "Subjective wellbeing (GHQ)":"Health","Need of social care":"Health",
  "Provided social care":"Health",
};

export const NUMERIC_VARS = new Set([
  "Capital Income","Equivalised yearly disposable income","Gross personal employment income",
  "Gross private pension income","Personal private pension income","Hourly earnings",
  "Amount of benefits received per month",
  "Mental Component Summary (MCS)","Physical Component Summary (PCS)",
  "Psychological distress score","Life Satisfaction Score","Subjective wellbeing (GHQ)","Hours worked",
]);

export const STRATIFIERS = ["Age","Gender","Disability Status","Region","Ethnicity","Income Quintile","Household Type","Number of children"];
export const STRAT_ONLY   = new Set(["Age","Gender","Region"]);

export const ALL_DISPLAY_VARS = [
  ...new Set(Object.values(COLUMN_MAP).filter(v=>!v.startsWith("_")))
].filter(v=>!STRAT_ONLY.has(v));

// ─── Fast inline validity check ───────────────────────────────────────────────
// Replaces the previous isValid() which called String() on every value.
// The hot path (non-null, non-empty string from a CSV cell) exits after
// one null check + a length check — no string allocation needed.
function notMissing(val) {
  if (val == null) return false;
  if (val === "") return false;
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
    d3.csvParse(benefitText, parseRow);
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
const PERSON_ONLY_KEYS = new Set(["yBenUCReceivedFlag","demNChild","demAge","demMaleFlag","demEthnC6","healthDsblLongtermFlag","demPartnerStatus","labC4","labHrsWorkWeek","labWageFullTimeHrly","labWageHrly","healthPsyDstrssFlag","healthPsyDstrss0to12","healthMentalMcs","healthSelfRated","healthPhysicalPcs","demLifeSatScore0to10","healthWbScore0to36","careNeedFlag","eduHighestC4","careProvidedFlag","yBenUCReceivedFlag"]);

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

  const rows = [];
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
        // Split by detected delimiter — handles comma, semicolon, or tab
        const rawCells = line.split(delim);
        const cells = rawCells.map(c => c.trim());

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

        const row = { Year: +yr, wgt };

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
            val = (bv !== undefined && bv !== "") ? bv : cellVal;
          }
          if (val !== undefined && val !== "") row[disp] = val;
        }

        // Also pull benefit-only columns that aren't in the person file at all
        // (Income Quintile, Equivalised income, Benefit amount, Region live on
        // the benefit-unit row and may have no person-side slot at all).
        if (bRow) {
          for (const [rawKey, disp] of colMapEntries) {
            if (row[disp] === undefined) {
              const bv = bRow[rawKey];
              if (bv !== undefined && bv !== "") row[disp] = bv;
            }
          }
        }

        // ── Recode / bin ────────────────────────────────────────────────────
        if (row["Age"]          != null) row["Age"]          = binAge(row["Age"]);
        if (row["Number of children"] != null) row["Number of children"] = binChildren(row["Number of children"]);
        if (row["Region"]       != null) row["Region"]       = REGION_MAP[String(row["Region"])] ?? row["Region"];
        if (row["Disability Status"] != null) row["Disability Status"] = DISABILITY_MAP[String(row["Disability Status"]).toLowerCase()] ?? row["Disability Status"];
        if (row["Financial distress flag"] != null) row["Financial distress flag"] = FINANCIAL_MAP[String(row["Financial distress flag"]).toLowerCase()] ?? row["Financial distress flag"];
        if (row["Need of social care"] != null) row["Need of social care"] = SOCIAL_CARE_MAP[String(row["Need of social care"]).toLowerCase()] ?? row["Need of social care"];
        if (row["Provided social care"] != null) row["Provided social care"] = PROV_SOCIAL_CARE_MAP[String(row["Provided social care"]).toLowerCase()] ?? row["Provided social care"];
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

// ─── Public entry point ───────────────────────────────────────────────────────
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
    // Emit pyramid_bin rows: share of each age band within each gender.
    // Shape matches the R script's pyramid chunk exactly:
    //   variable="Age", stratifier="Gender",
    //   variable_value=age band, stratifier_value="Male"/"Female"
    // The denominator is the total weight within each gender separately,
    // so Male bars and Female bars each sum to 100%.
    {
      // gender → ageBand → {sumW, n}
      const pyrAcc = { Male: new Map(), Female: new Map() };
      const pyrTot = { Male: {sumW:0,n:0}, Female: {sumW:0,n:0} };

      for (const r of yearRows) {
        const gender = r["Gender"]; // already recoded to "Male"/"Female"
        if (gender !== "Male" && gender !== "Female") continue;
        const ageBand = r["Age"];   // already binned by binAge()
        if (!ageBand) continue;
        const w = r.wgt;

        pyrTot[gender].sumW += w;
        pyrTot[gender].n++;

        let ba = pyrAcc[gender].get(ageBand);
        if (!ba) { ba = {sumW:0,n:0}; pyrAcc[gender].set(ageBand, ba); }
        ba.sumW += w; ba.n++;
      }

      for (const gender of ["Male","Female"]) {
        const tot = pyrTot[gender];
        for (const [ageBand, ba] of pyrAcc[gender]) {
          metrics.push({year,scenario,run:runId,
            variable:"Age", variable_value:ageBand,
            stratifier:"Gender", stratifier_value:gender,
            metric_type:"pyramid_bin", n:ba.n,
            metric_value: tot.sumW > 0 ? ba.sumW / tot.sumW : 0});
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

  const finalRows = [];
  for (const [key, g] of grouped) {
    const { year, scenario, variable, variable_value, stratifier,
            stratifier_value, metric_type, count, mean, M2, totalN, minN, runVals } = g;

    const n_runs       = count;
    const variance     = n_runs > 1 ? M2 / (n_runs - 1) : 0;
    const sd_value     = Math.sqrt(variance);
    const se_value     = n_runs > 0 ? sd_value / Math.sqrt(n_runs) : 0;
    const total_sample = totalN;
    const min_sample   = isFinite(minN) ? minN : 0;
    const mean_sample  = n_runs > 0 ? total_sample / n_runs : 0;

    let mean_value = mean;
    let lower_ci   = mean_value - 1.96 * se_value;
    let upper_ci   = mean_value + 1.96 * se_value;
    if (total_sample < 20) { mean_value = NaN; lower_ci = NaN; upper_ci = NaN; }

    let paired_mean_delta = NaN, paired_lower_ci = NaN, paired_upper_ci = NaN, paired_n_runs = 0;
    if (scenario !== "baseline") {
      const p = key.split("|");
      const nonKey = `${p[0]}|${p[2]}|${p[3]}|${p[4]}|${p[5]}|${p[6]}`;
      const bVals  = baseVals.get(nonKey);
      if (bVals && runVals && runVals.size > 0) {
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
          paired_lower_ci   = pMean - 1.96 * pSe;
          paired_upper_ci   = pMean + 1.96 * pSe;
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

/** Legacy entry point — still works but loads all metrics into memory at once.
 *  Prefer the incremental createGroupedAccumulator/accumulateRunMetrics/finaliseAggregation API. */
export function performCrossRunAggregation(allRunMetrics) {
  // ── Pass 1: Welford online mean/variance per group ──────────────────────────
  // Each group entry stores only scalars — no references back into
  // allRunMetrics, no per-run value arrays. This means allRunMetrics can be
  // GC'd as soon as this loop finishes.
  //
  // For paired delta we use a second set of Welford accumulators keyed by
  // nonKey (everything except scenario) so we can compute the mean/variance
  // of (scenario_value − baseline_value) per matched seed online, without
  // ever storing all the per-run values simultaneously.
  //
  // Approach: first pass builds per-group stats + stores per-run values in a
  // compact Float64Array per group. Second pass computes paired diffs from
  // those compact arrays, then immediately discards them.

  // group key = "year|scenario|variable|variable_value|stratifier|stratifier_value|metric_type"
  const grouped = new Map();

  for (const d of allRunMetrics) {
    const key = `${d.year}|${d.scenario}|${d.variable}|${d.variable_value}|${d.stratifier}|${d.stratifier_value}|${d.metric_type}`;
    let g = grouped.get(key);
    if (!g) {
      // Store only the scalar metadata needed for the output row — no ref to d
      g = {
        year: d.year, scenario: d.scenario, variable: d.variable,
        variable_value: d.variable_value, stratifier: d.stratifier,
        stratifier_value: d.stratifier_value, metric_type: d.metric_type,
        count:0, mean:0, M2:0, totalN:0, minN:Infinity,
        // Compact seed→value map for paired delta (only 2 numbers per seed)
        runVals: new Map(), // seed → metric_value
      };
      grouped.set(key, g);
    }
    // Welford update
    g.count++;
    const dv = d.metric_value - g.mean;
    g.mean += dv / g.count;
    g.M2   += dv * (d.metric_value - g.mean);
    g.totalN += d.n;
    if (d.n < g.minN) g.minN = d.n;
    if (d.run != null) g.runVals.set(String(d.run), d.metric_value);
  }
  // allRunMetrics is no longer referenced after this point — eligible for GC

  // ── Build nonKey lookups for paired delta ────────────────────────────────────
  // nonKey = "year|variable|variable_value|stratifier|stratifier_value|metric_type"
  // baseVals: nonKey → Map<seed, value>
  // scenVals: nonKey → scenarioName → Map<seed, value>
  const baseVals = new Map();
  const scenVals = new Map(); // nonKey → Map<scenName, Map<seed, value>>

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

  // ── Pass 2: emit final rows with paired delta ────────────────────────────────
  const finalRows = [];
  for (const [key, g] of grouped) {
    const { year, scenario, variable, variable_value, stratifier,
            stratifier_value, metric_type, count, mean, M2, totalN, minN, runVals } = g;

    const n_runs       = count;
    const variance     = n_runs > 1 ? M2 / (n_runs - 1) : 0;
    const sd_value     = Math.sqrt(variance);
    const se_value     = n_runs > 0 ? sd_value / Math.sqrt(n_runs) : 0;
    const total_sample = totalN;
    const min_sample   = isFinite(minN) ? minN : 0;
    const mean_sample  = n_runs > 0 ? total_sample / n_runs : 0;

    let mean_value = mean;
    let lower_ci   = mean_value - 1.96 * se_value;
    let upper_ci   = mean_value + 1.96 * se_value;
    if (total_sample < 20) { mean_value = NaN; lower_ci = NaN; upper_ci = NaN; }

    // Paired delta — computed for every non-baseline scenario
    let paired_mean_delta = NaN, paired_lower_ci = NaN, paired_upper_ci = NaN, paired_n_runs = 0;
    if (scenario !== "baseline") {
      const p = key.split("|");
      const nonKey = `${p[0]}|${p[2]}|${p[3]}|${p[4]}|${p[5]}|${p[6]}`;
      const bVals  = baseVals.get(nonKey);
      if (bVals && runVals.size > 0) {
        // Online Welford for paired differences — no diffs array needed
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
          paired_lower_ci   = pMean - 1.96 * pSe;
          paired_upper_ci   = pMean + 1.96 * pSe;
        }
      }
    }

    // Discard runVals now — no longer needed
    g.runVals = null;

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