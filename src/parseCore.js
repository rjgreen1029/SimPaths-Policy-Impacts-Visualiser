/**
 * parseCore.js — Pure parsing + aggregation logic, no browser APIs.
 *
 * This is the single place that knows how to turn a pair of raw SimPaths
 * output CSVs (one "person" file, one "benefit"/benefit-unit file) for one
 * model run into the dashboard's row format. It is imported by BOTH:
 *   - localFolderParser.js's mainThreadFallback() (no-Worker path), and
 *   - parseWorker.js (the Worker path)
 * specifically so there is exactly one implementation of the join/rename/
 * aggregation logic, rather than two copies that could drift apart.
 *
 * Pipeline for one run:
 *   processRunTexts(personText, benefitText, scenarioName, runId)
 *     → join person+benefit rows on "<year>_<benefitUnitId>", rename raw
 *       columns to display names (see COLUMN_MAP)
 *     → aggregateSingleRun(...) computes, in one pass per year, weighted
 *       means (numeric variables) and weighted shares (categorical
 *       variables), both Overall and broken down by every stratifier
 *     → returns that run's metric rows
 *
 * Once every run has been processed (by however many workers/batches),
 * performCrossRunAggregation(allRunMetrics) combines them into the final
 * rows the dashboard actually renders — cross-run mean, standard error-based
 * 95% CI, with small-sample estimates suppressed (total pooled sample below
 * 10 — see performCrossRunAggregation below) rather than shown. A handful of
 * values are also relabelled for display (Gender, Provided social care, and
 * the Number of Children bins) — see the relevant lookup tables and
 * processRunTexts() below for the specifics.
 */

import * as d3 from "d3";

// ─── Binning helpers ──────────────────────────────────────────────────────────
/** Buckets a raw numeric age into the dashboard's fixed age-band labels. Returns null for non-numeric input. */
export function binAge(v) {
  const n=+v; if(isNaN(n)) return null;
  if(n<=18) return "Under 18"; if(n<=24) return "18-24"; if(n<=34) return "25-34";
  if(n<=44) return "35-44";    if(n<=54) return "45-54"; if(n<=64) return "55-64";
  return "65+";
}
/** Buckets a raw child count into the dashboard's fixed "Number of children" labels. Returns null for non-numeric input. */
export function binChildren(v) {
  const n=+v; if(isNaN(n)) return null;
  if(n<=0) return "None"; if(n<=1) return "1 Child"; if(n<=2) return "2 Children";
  if(n<=3) return "3 Children"; return "4+ Children";
}

// ─── Lookup tables ────────────────────────────────────────────────────────────
// UK region letter codes only — numeric region codes aren't handled.
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

/**
 * The single source of truth for "raw SimPaths CSV column name" → "display
 * name shown in the dashboard". Every variable/stratifier the dashboard
 * knows about must have an entry here — see processRunTexts() below for how
 * this drives which raw columns get read out of the person/benefit CSVs.
 *
 * Two choices worth noting: Region is read from a raw "region" column (not
 * "i_demRgn"), and "yBenUCReceivedFlag" is treated as its own standalone
 * "UC Benefits Flag" variable rather than being combined with a non-UC flag
 * into a broader "Benefits Received" concept.
 */
export const COLUMN_MAP = {
  "eduHighestC4":"Highest Level of Education","demAge":"Age","demMaleFlag":"Gender",
  "demEthnC6":"Ethnicity","healthDsblLongtermFlag":"Disability Status","dhhtp_c4":"Household Type",
  "yHhQuintilesMonthC5":"Income Quintile","region":"Region","demPartnerStatus":"Partnership status",
  "demNChild":"Number of children","labC4":"Employment status","labHrsWorkWeek":"Hours worked",
  "yCapitalPersMonth":"Capital Income","yDispEquivYear":"Equivalised yearly disposable income",
  "yEmpPersGrossMonth":"Gross personal employment income","yPensYear":"Gross private pension income",
  "yBenAmountMonth":"Amount of benefits received per month",
  "yBenUCReceivedFlag":"UC Benefits Flag",
  "yFinDstrssFlag":"Financial distress flag","healthPsyDstrss0to12":"Psychological distress score",
  "healthMentalMcs":"Mental Component Summary (MCS)","healthPhysicalPcs":"Physical Component Summary (PCS)",
  "healthSelfRated":"Self-Rated Health","demLifeSatScore0to10":"Life Satisfaction Score",
  "healthWbScore0to36":"Subjective wellbeing (GHQ)","careNeedFlag":"Need of social care",
  "careProvidedFlag.y":"Provided social care","careProvidedFlag":"Provided social care",
};

/** Groups every display variable into the four dashboard domains/tabs (Demographics, Activity status, Income, Health). Anything not listed here falls back to "Other". */
export const MODULE_MAP = {
  "Highest Level of Education":"Demographics","Age":"Demographics","Gender":"Demographics",
  "Ethnicity":"Demographics","Partnership status":"Demographics","Number of children":"Demographics",
  "Region":"Demographics","Household Type":"Demographics",
  "Employment status":"Activity status","Hours worked":"Activity status",
  "Capital Income":"Income","Equivalised yearly disposable income":"Income",
  "Gross personal employment income":"Income","Gross private pension income":"Income",
  "Amount of benefits received per month":"Income","UC Benefits Flag":"Income",
  "Financial distress flag":"Income","Income Quintile":"Income",
  "Disability Status":"Health","Self-Rated Health":"Health",
  "Psychological distress score":"Health","Mental Component Summary (MCS)":"Health",
  "Physical Component Summary (PCS)":"Health","Life Satisfaction Score":"Health",
  "Subjective wellbeing (GHQ)":"Health","Need of social care":"Health",
  "Provided social care":"Health",
};

/** Display variables aggregated as a weighted MEAN (metric_type:"mean"). Everything else in ALL_DISPLAY_VARS is treated as categorical and aggregated as a weighted SHARE (metric_type:"share"). */
export const NUMERIC_VARS = new Set([
  "Capital Income","Equivalised yearly disposable income","Gross personal employment income",
  "Gross private pension income","Amount of benefits received per month",
  "Mental Component Summary (MCS)","Physical Component Summary (PCS)",
  "Psychological distress score","Life Satisfaction Score","Subjective wellbeing (GHQ)","Hours worked",
]);

/** The seven variables offered as "Stratify by" options on the dashboard. */
export const STRATIFIERS = ["Age","Gender","Household Type","Disability Status","Region","Ethnicity","Income Quintile"];
/** Stratifiers that can ONLY be used to split another variable, never selected as the main variable to plot themselves (Age/Gender/Region are more useful as breakdowns than as headline outcomes here). */
export const STRAT_ONLY   = new Set(["Age","Gender","Region"]);

/** Every variable the dashboard can plot as the main outcome — every non-staging COLUMN_MAP value, minus anything in STRAT_ONLY, de-duplicated. */
export const ALL_DISPLAY_VARS = [
  ...new Set(Object.values(COLUMN_MAP).filter(v=>!v.startsWith("_")))
]
 .filter((v,i,a)=>a.indexOf(v)===i)
 .filter(v=>!STRAT_ONLY.has(v));

/** True for any value that should count as "present" — excludes null/undefined and the string forms "", "null", "undefined" that sometimes leak in from CSV exports of missing data. */
function isValid(val) {
  if (val==null) return false;
  const s=String(val);
  return s!==""&&s!=="null"&&s!=="undefined";
}

// ─── CSV parse + join (streaming, memory-lean) ────────────────────────────────
// Only columns that the join/rename step could ever read are worth keeping:
// COLUMN_MAP's raw inputs, the year/benefit-unit join keys, and the weight
// column. Filtering rows down to this set as they're parsed means a wide
// simulation CSV (which may have 10x the columns we actually use) never has
// its unused columns retained in memory.
const KEEP_KEYS = new Set([
  ...Object.keys(COLUMN_MAP),
  "time", "Time", "Year",
  "id_BenefitUnit", "idbu", "idBu",
  "wgt", "Wgt",
]);
/** A single shared, frozen empty-object stand-in for "no matching benefit row found" — avoids allocating a fresh {} per unmatched person row. */
const EMPTY_ROW = Object.freeze({});

/** Strips a raw benefit-CSV row down to only the columns we might ever read (see KEEP_KEYS), so the benefit lookup map doesn't retain a wide row's worth of unused columns per benefit unit. */
function pickRow(raw) {
  const out = {};
  for (const k in raw) {
    if (KEEP_KEYS.has(k)) out[k] = raw[k];
  }
  return out;
}

/** Reads `key` from the (already-joined) benefit row first, falling back to the person row — mirrors what `{...p, ...bRow}[key]` would give from a merged object, without ever allocating that merged object. Treats an empty-string benefit-side value the same as "not present" for fallback purposes: a column can exist in BOTH the person and benefit-unit CSVs (e.g. UC Benefits Flag, which is only meaningfully populated on the person side) with the benefit-unit copy simply blank on every row — d3.csvParse gives "" for a blank cell, not undefined, so without this the blank would win outright instead of correctly falling through to the person row's real value. */
function mget(p, bRow, key) {
  const v = bRow[key];
  return (v !== undefined && v !== "") ? v : p[key];
}

/**
 * Parses one run's person + benefit CSV text, joins them on
 * "<year>_<benefitUnitId>", renames raw columns to display names, applies
 * the derived/binned/mapped fields (age bands, child-count bands, region
 * names, Yes/No flag labels), and
 * hands the resulting rows to aggregateSingleRun().
 *
 * Both parseWorker.js and localFolderParser.js's mainThreadFallback() call
 * this directly, so there is exactly one implementation of the join/rename
 * logic regardless of which code path (Worker vs. main thread) is active.
 *
 * Memory shape: d3.csvParse's internal per-row object is only ever passed to
 * our row-accessor and never itself retained — only what the accessor
 * returns survives — so at no point do we hold an array of full-width rows
 * for either file. The benefit file only lives on as the trimmed lookup map,
 * and the person file is turned directly into the final renamed rows in one
 * pass (no separate "all person rows" array before renaming).
 *
 * @param {string} personText - raw text of the run's person-level CSV
 * @param {string} benefitText - raw text of the run's benefit-unit-level CSV
 * @param {string} scenarioName - "baseline" or "scenario"
 * @param {number} runId
 * @returns {object[]} this run's aggregated metric rows (see aggregateSingleRun)
 */
export function processRunTexts(personText, benefitText, scenarioName, runId) {
  // ── Benefit CSV → slim lookup map, keyed by "<year>_<benefitUnitId>" ────────
  const benefitMap = new Map();
  d3.csvParse(benefitText, raw => {
    const yr   = raw.time || raw.Time || raw.Year;
    const buId = raw.id_BenefitUnit || raw.idbu || raw.idBu;
    if (yr && buId) benefitMap.set(`${yr}_${buId}`, pickRow(raw));
    return null; // we only need the map; the accessor's own return value is unused
  });

  // ── Person CSV → join + rename, single streaming pass ───────────────────────
  // colIndex comes from COLUMN_MAP itself, not from whichever file's header
  // happens to be scanned — a display variable may live only on the benefit
  // file (Income Quintile, Household Type, Equivalised yearly disposable
  // income, Amount of benefits received per month), only on the person file,
  // or on both. mget() below already checks the benefit row before falling
  // back to the person row, so as long as we always ask for every raw
  // column, it doesn't matter which file actually has it.
  const colIndex = Object.entries(COLUMN_MAP);
  const runRows = [];

  d3.csvParse(personText, (p) => {
    const yr   = p.time || p.Time || p.Year;
    const buId = p.idBu || p.idbu || p.id_BenefitUnit;
    const bRow = benefitMap.get(`${yr}_${buId}`) || EMPTY_ROW;

    let wgt = +(mget(p, bRow, "wgt") || mget(p, bRow, "Wgt") || 1.0);
    if (isNaN(wgt) || wgt<=0) wgt = 1.0;

    const renamed = { Year:+yr, wgt };
    for (let j=0;j<colIndex.length;j++) {
      const val = mget(p, bRow, colIndex[j][0]);
      if (val!==undefined) renamed[colIndex[j][1]] = val;
    }

    if (renamed["Age"]!=null)               renamed["Age"]=binAge(renamed["Age"]);
    if (renamed["Number of children"]!=null) renamed["Number of children"]=binChildren(renamed["Number of children"]);
    if (renamed["Region"]!=null)             renamed["Region"]=REGION_MAP[String(renamed["Region"])]??renamed["Region"];
    if (renamed["Disability Status"]!=null)  renamed["Disability Status"]=DISABILITY_MAP[String(renamed["Disability Status"]).toLowerCase()]??renamed["Disability Status"];
    if (renamed["Financial distress flag"]!=null) renamed["Financial distress flag"]=FINANCIAL_MAP[String(renamed["Financial distress flag"]).toLowerCase()]??renamed["Financial distress flag"];
    if (renamed["Need of social care"]!=null)     renamed["Need of social care"]=SOCIAL_CARE_MAP[String(renamed["Need of social care"]).toLowerCase()]??renamed["Need of social care"];
    if (renamed["Provided social care"]!=null)    renamed["Provided social care"]=PROV_SOCIAL_CARE_MAP[String(renamed["Provided social care"]).toLowerCase()]??renamed["Provided social care"];
    if (renamed["Gender"]!=null) {
      const g=String(renamed["Gender"]).toLowerCase();
      renamed["Gender"]=(g==="1"||g==="true"||g==="male")?"Male":"Female";
    }

    runRows.push(renamed);
    return null;
  });

  if (!runRows.length) return [];
  return aggregateSingleRun(runRows, scenarioName, runId);
}

// ─── Single-pass per-run aggregation ─────────────────────────────────────────
/**
 * Aggregates one run's already-joined/renamed rows into per-year metric
 * rows: a weighted MEAN for every numeric variable, and a weighted SHARE for
 * every categorical variable — each computed both "Overall" and broken down
 * by every one of the 7 stratifiers, all in a single pass per year (rather
 * than one pass per variable×stratifier combination).
 *
 * @param {object[]} rows - this run's renamed/joined rows (output of the processRunTexts join step)
 * @param {string} scenario - "baseline" or "scenario"
 * @param {number} runId
 * @returns {object[]} one entry per (year, variable, variable_value, stratifier, stratifier_value) combination present in this run
 */
export function aggregateSingleRun(rows, scenario, runId) {
  const metrics = [];

  // Group rows by year first
  const byYear = new Map();
  for (const r of rows) {
    let b = byYear.get(r.Year);
    if (!b) { b=[]; byYear.set(r.Year,b); }
    b.push(r);
  }

  for (const [year, yearRows] of byYear) {
    // Accumulators:
    //   numAcc[varName] = {sumW,sumVW,n,nTotal, strat:{stratName:{stratVal:{sumW,sumVW,n,nTotal}}}}
    //     n/sumW/sumVW cover only valid (non-missing) values; nTotal is every
    //     row seen, valid or not — the gap between them is this variable's
    //     missingness, emitted as its own "Missing" share row below.
    //   catAcc[varName] = {totalW, cats:{varVal:{sumW,n}}, strat:{stratName:{stratVal:{totalW,cats:{varVal:{sumW,n}}}}}}
    //     A missing variable or stratifier value is recoded to the literal
    //     string "Missing" and folded in as its own category/stratum, rather
    //     than being excluded — so shares are always of the full sample
    //     (including missingness) rather than only the non-missing subset.
    const numAcc = new Map();
    const catAcc = new Map();

    for (const v of ALL_DISPLAY_VARS) {
      if (NUMERIC_VARS.has(v)) {
        numAcc.set(v, { sumW:0, sumVW:0, n:0, nTotal:0, strat:new Map() });
      } else {
        catAcc.set(v, { totalW:0, cats:new Map(), strat:new Map() });
      }
    }

    // Single pass over all rows for this year
    for (const r of yearRows) {
      const w = r.wgt;

      for (const [v, acc] of numAcc) {
        if (v===r.variable_override) continue; // skip if var is its own stratifier
        const rawV = r[v];
        const numV = isValid(rawV) ? +rawV : NaN;
        const isNumValid = !isNaN(numV);
        acc.nTotal++;
        if (isNumValid) { acc.sumW += w; acc.sumVW += numV * w; acc.n++; }
        for (const s of STRATIFIERS) {
          if (s===v) continue;
          const rawSv = r[s];
          const svKey = isValid(rawSv) ? String(rawSv) : "Missing";
          let sMap = acc.strat.get(s);
          if (!sMap) { sMap=new Map(); acc.strat.set(s,sMap); }
          let a = sMap.get(svKey);
          if (!a) { a={sumW:0,sumVW:0,n:0,nTotal:0}; sMap.set(svKey,a); }
          a.nTotal++;
          if (isNumValid) { a.sumW+=w; a.sumVW+=numV*w; a.n++; }
        }
      }

      for (const [v, acc] of catAcc) {
        const rawVv = r[v];
        const vvKey = isValid(rawVv) ? String(rawVv) : "Missing";
        acc.totalW += w;
        let oa = acc.cats.get(vvKey);
        if (!oa) { oa={sumW:0,n:0}; acc.cats.set(vvKey,oa); }
        oa.sumW+=w; oa.n++;
        for (const s of STRATIFIERS) {
          if (s===v) continue;
          const rawSv = r[s];
          const svKey = isValid(rawSv) ? String(rawSv) : "Missing";
          let sMap = acc.strat.get(s);
          if (!sMap) { sMap=new Map(); acc.strat.set(s,sMap); }
          let svMap = sMap.get(svKey);
          if (!svMap) { svMap={totalW:0,cats:new Map()}; sMap.set(svKey,svMap); }
          svMap.totalW+=w;
          let ca = svMap.cats.get(vvKey);
          if (!ca) { ca={sumW:0,n:0}; svMap.cats.set(vvKey,ca); }
          ca.sumW+=w; ca.n++;
        }
      }
    }

    // Emit numeric metrics — a "Mean" row when there's at least one valid
    // value, PLUS a "Missing" share row whenever some rows lacked a value,
    // both Overall and per stratum.
    for (const [v, acc] of numAcc) {
      const nMissing = acc.nTotal - acc.n;
      if (acc.n>0) {
        metrics.push({year,scenario,run:runId,variable:v,
          variable_value:"Mean",stratifier:"Overall",stratifier_value:"Overall",
          metric_type:"mean",n:acc.n,metric_value:acc.sumW>0?acc.sumVW/acc.sumW:0});
      }
      if (nMissing>0) {
        metrics.push({year,scenario,run:runId,variable:v,
          variable_value:"Missing",stratifier:"Overall",stratifier_value:"Overall",
          metric_type:"share",n:nMissing,metric_value:acc.nTotal>0?nMissing/acc.nTotal:0});
      }
      for (const [s, sMap] of acc.strat) {
        for (const [svKey, a] of sMap) {
          const aMissing = a.nTotal - a.n;
          if (a.n>0) {
            metrics.push({year,scenario,run:runId,variable:v,
              variable_value:"Mean",stratifier:s,stratifier_value:svKey,
              metric_type:"mean",n:a.n,metric_value:a.sumW>0?a.sumVW/a.sumW:0});
          }
          if (aMissing>0) {
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
  }

  return metrics;
}

// ─── Cross-run aggregation (unchanged logic, same output schema) ──────────────
/**
 * Combines per-run metric rows (from one or more calls to
 * aggregateSingleRun, across however many runs were processed) into the
 * final rows the dashboard renders: cross-run mean, standard deviation, and
 * a 95% CI. The CI uses the standard ERROR of the mean (SD ÷ √n_runs), not
 * the raw standard deviation across runs, and the suppression threshold is
 * the TOTAL pooled sample (summed across all runs) below 10 — not a
 * per-run minimum. Getting either of these wrong doesn't just look
 * different, it changes the actual width of the CI bands and which
 * estimates get shown vs. suppressed.
 *
 * Small-sample suppression: if the TOTAL pooled sample (summed across every
 * contributing run) for a given (year, variable, ...) combination is below
 * 10, the estimate is considered too unreliable and mean_value/sd_value/
 * lower_ci/upper_ci are all set to NaN rather than shown — see
 * DashboardSection.js's SmallSampleOverlay and the LineChart/DeltaChart
 * "densify" logic for how the UI represents these suppressed/missing points
 * (a break in the line, not a connector drawn straight through them).
 *
 * Output row shape matches the default pre-aggregated CSV exactly (see
 * useAggregatedData.js's parseCsvRow), so the rest of the app doesn't need
 * to know or care whether a row came from the bundled CSV or a user's own
 * local folder.
 *
 * @param {object[]} allRunMetrics - concatenated aggregateSingleRun() output from every processed run
 * @returns {object[]} final rows: {year, scenario, module, variable, variable_value, stratifier, stratifier_value, metric_type, n_runs, total_sample, min_sample, mean_sample, mean_value, sd_value, lower_ci, upper_ci}
 */
export function performCrossRunAggregation(allRunMetrics) {
  const grouped = new Map();
  for (const d of allRunMetrics) {
    const key=`${d.year}|${d.scenario}|${d.variable}|${d.variable_value}|${d.stratifier}|${d.stratifier_value}|${d.metric_type}`;
    let g=grouped.get(key);
    if (!g) { g={meta:d,values:[],ns:[]}; grouped.set(key,g); }
    g.values.push(d.metric_value);
    g.ns.push(d.n);
  }
  const finalRows=[];
  for (const {meta,values,ns} of grouped.values()) {
    const n_runs=values.length;
    const min_sample=Math.min(...ns);
    const total_sample=ns.reduce((a,b)=>a+b,0);
    const mean_sample=total_sample/n_runs;
    let mean_value=0;
    for (const v of values) mean_value+=v;
    mean_value/=n_runs;
    let sd2=0;
    for (const v of values) sd2+=(v-mean_value)**2;
    let sd_value=n_runs>1?Math.sqrt(sd2/(n_runs-1)):0;
    // Standard error of the mean, not the raw cross-run SD — this is what
    // the 1.96× multiplier below is meant to be applied to.
    const se_value=n_runs>0?sd_value/Math.sqrt(n_runs):0;
    let lower_ci=mean_value-1.96*se_value;
    let upper_ci=mean_value+1.96*se_value;
    if (total_sample<10) { mean_value=NaN; sd_value=NaN; upper_ci=NaN; lower_ci=NaN; }
    finalRows.push({
      year:+meta.year, scenario:meta.scenario.toLowerCase(),
      module:MODULE_MAP[meta.variable]||"Other",
      variable:meta.variable, variable_value:meta.variable_value,
      stratifier:meta.stratifier, stratifier_value:meta.stratifier_value,
      metric_type:meta.metric_type,
      n_runs,total_sample,min_sample,mean_sample,
      mean_value,sd_value,lower_ci,upper_ci,
    });
  }
  return finalRows;
}