// parseCore.js — pure parsing + aggregation logic, no browser APIs.
// Imported by localFolderParser.js (main thread fallback) and parseWorker.js (worker),
// so the CSV→row join logic lives in exactly one place.

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
  if(n<=3) return "3 Children"; return "4+ Children";
}

// ─── Lookup tables ────────────────────────────────────────────────────────────
export const REGION_MAP = {
  "1":"North East","2":"North West","4":"Yorkshire and the Humber",
  "5":"East Midlands","6":"West Midlands","7":"East of England",
  "8":"London","9":"South East","10":"South West",
  "11":"Wales","12":"Scotland","13":"Northern Ireland",
  "UKC":"North East","UKD":"North West","UKE":"Yorkshire and the Humber",
  "UKF":"East Midlands","UKG":"West Midlands","UKH":"East of England",
  "UKI":"London","UKJ":"South East","UKK":"South West",
  "UKL":"Wales","UKM":"Scotland","UKN":"Northern Ireland",
};
export const DISABILITY_MAP      = {"false":"No disability","0":"No disability","true":"Has disability","1":"Has disability"};
export const FINANCIAL_MAP       = {"false":"Not financially distressed","0":"Not financially distressed","true":"Financially distressed","1":"Financially distressed"};
export const SOCIAL_CARE_MAP     = {"false":"Does not need social care","0":"Does not need social care","true":"Needs social care","1":"Needs social care"};
export const PROV_SOCIAL_CARE_MAP= {"false":"Does not provide social care","0":"Does not provide social care","true":"Provides social care","1":"Provides social care"};

export const COLUMN_MAP = {
  "eduHighestC4":"Highest Level of Education","demAge":"Age","demMaleFlag":"Gender",
  "demEthnC6":"Ethnicity","healthDsblLongtermFlag":"Disability Status","dhhtp_c4":"Household Type",
  "yHhQuintilesMonthC5":"Income Quintile","i_demRgn":"Region","demPartnerStatus":"Partnership status",
  "demNChild":"Number of children","labC4":"Employment status","labHrsWorkWeek":"Hours worked",
  "yCapitalPersMonth":"Capital Income","yDispEquivYear":"Equivalised yearly disposable income",
  "yEmpPersGrossMonth":"Gross personal employment income","yPensYear":"Gross private pension income",
  "yBenAmountMonth":"Amount of benefits received per month",
  "yBenNonUCReceivedFlag":"_NonUCFlag","yBenUCReceivedFlag":"_UCFlag",
  "yFinDstrssFlag":"Financial distress flag","healthPsyDstrss0to12":"Psychological distress score",
  "healthMentalMcs":"Mental Component Summary (MCS)","healthPhysicalPcs":"Physical Component Summary (PCS)",
  "healthSelfRated":"Self-Rated Health","demLifeSatScore0to10":"Life Satisfaction Score",
  "healthWbScore0to36":"Subjective wellbeing (GHQ)","careNeedFlag":"Need of social care",
  "careProvidedFlag.y":"Provided social care","careProvidedFlag":"Provided social care",
};

export const MODULE_MAP = {
  "Highest Level of Education":"Demographics","Age":"Demographics","Gender":"Demographics",
  "Ethnicity":"Demographics","Partnership status":"Demographics","Number of children":"Demographics",
  "Region":"Demographics","Household Type":"Demographics",
  "Employment status":"Activity status","Hours worked":"Activity status",
  "Capital Income":"Income","Equivalised yearly disposable income":"Income",
  "Gross personal employment income":"Income","Gross private pension income":"Income",
  "Amount of benefits received per month":"Income","Benefits Received":"Income",
  "Financial distress flag":"Income","Income Quintile":"Income",
  "Disability Status":"Health","Self-Rated Health":"Health",
  "Psychological distress score":"Health","Mental Component Summary (MCS)":"Health",
  "Physical Component Summary (PCS)":"Health","Life Satisfaction Score":"Health",
  "Subjective wellbeing (GHQ)":"Health","Need of social care":"Health",
  "Provided social care":"Health",
};

export const NUMERIC_VARS = new Set([
  "Capital Income","Equivalised yearly disposable income","Gross personal employment income",
  "Gross private pension income","Amount of benefits received per month",
  "Mental Component Summary (MCS)","Physical Component Summary (PCS)",
  "Psychological distress score","Life Satisfaction Score","Subjective wellbeing (GHQ)","Hours worked",
]);

export const STRATIFIERS = ["Age","Gender","Household Type","Disability Status","Region","Ethnicity","Income Quintile"];
export const STRAT_ONLY   = new Set(["Age","Gender","Region"]);

export const ALL_DISPLAY_VARS = [
  ...new Set(Object.values(COLUMN_MAP).filter(v=>!v.startsWith("_")))
].concat(["Benefits Received"])
 .filter((v,i,a)=>a.indexOf(v)===i)
 .filter(v=>!STRAT_ONLY.has(v));

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
const EMPTY_ROW = Object.freeze({});

function pickRow(raw) {
  const out = {};
  for (const k in raw) {
    if (KEEP_KEYS.has(k)) out[k] = raw[k];
  }
  return out;
}

// Mirrors what `{...p, ...bRow}[key]` would read from the old merged object,
// without ever allocating the merged object.
function mget(p, bRow, key) {
  const v = bRow[key];
  return v !== undefined ? v : p[key];
}

// Parses one run's person + benefit CSV text and returns that run's metric
// rows. Both the worker and the no-Worker main-thread fallback call this, so
// there's a single implementation of the join/rename logic.
//
// Memory shape: d3.csvParse's internal per-row object is only ever passed to
// our row-accessor and never itself retained — only what the accessor
// returns survives — so at no point do we hold an array of full-width rows
// for either file. The benefit file only lives on as the trimmed lookup map,
// and the person file is turned directly into the final renamed rows in one
// pass (no separate "all person rows" array before renaming).
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
  let colIndex = null, stagingCols = null;
  const runRows = [];

  d3.csvParse(personText, (p, _i, columns) => {
    if (colIndex === null) {
      colIndex = []; stagingCols = [];
      for (const h of columns) {
        const display = COLUMN_MAP[h];
        if (!display) continue;
        (display.startsWith("_") ? stagingCols : colIndex).push([h, display]);
      }
    }

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

    let nonUC, uc;
    for (const [rawCol,stagingKey] of stagingCols) {
      if (stagingKey==="_NonUCFlag") nonUC = mget(p, bRow, rawCol);
      if (stagingKey==="_UCFlag")    uc    = mget(p, bRow, rawCol);
    }
    if (nonUC!==undefined||uc!==undefined) {
      const a=String(nonUC??"").toLowerCase(), b_=String(uc??"").toLowerCase();
      renamed["Benefits Received"]=(a==="true"||a==="1"||b_==="true"||b_==="1")?"Benefits Received":"No Benefits Received";
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
// One loop per year: simultaneously accumulates all variables × all stratifiers.
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
    // Accumulators: numAcc[varName] = {sumW,sumVW,n, strat:{stratName:{stratVal:{sumW,sumVW,n}}}}
    //               catAcc[varName] = {totalW, cats:{varVal:{sumW,n}}, strat:{stratName:{stratVal:{varVal:{sumW,n}}}}}
    const numAcc = new Map();
    const catAcc = new Map();

    for (const v of ALL_DISPLAY_VARS) {
      if (NUMERIC_VARS.has(v)) {
        numAcc.set(v, { sumW:0, sumVW:0, n:0, strat:new Map() });
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
        if (!isValid(rawV)) continue;
        const numV = +rawV;
        if (isNaN(numV)) continue;
        acc.sumW  += w;
        acc.sumVW += numV * w;
        acc.n++;
        for (const s of STRATIFIERS) {
          if (s===v) continue;
          const sv = r[s];
          if (!isValid(sv)) continue;
          const svKey = String(sv);
          let sMap = acc.strat.get(s);
          if (!sMap) { sMap=new Map(); acc.strat.set(s,sMap); }
          let a = sMap.get(svKey);
          if (!a) { a={sumW:0,sumVW:0,n:0}; sMap.set(svKey,a); }
          a.sumW+=w; a.sumVW+=numV*w; a.n++;
        }
      }

      for (const [v, acc] of catAcc) {
        const vv = r[v];
        if (!isValid(vv)) continue;
        const vvKey = String(vv);
        acc.totalW += w;
        let oa = acc.cats.get(vvKey);
        if (!oa) { oa={sumW:0,n:0}; acc.cats.set(vvKey,oa); }
        oa.sumW+=w; oa.n++;
        for (const s of STRATIFIERS) {
          if (s===v) continue;
          const sv = r[s];
          if (!isValid(sv)) continue;
          const svKey = String(sv);
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

    // Emit numeric metrics
    for (const [v, acc] of numAcc) {
      if (acc.n>0) {
        metrics.push({year,scenario,run:runId,variable:v,
          variable_value:"Mean",stratifier:"Overall",stratifier_value:"Overall",
          metric_type:"mean",n:acc.n,metric_value:acc.sumW>0?acc.sumVW/acc.sumW:0});
      }
      for (const [s, sMap] of acc.strat) {
        for (const [svKey, a] of sMap) {
          metrics.push({year,scenario,run:runId,variable:v,
            variable_value:"Mean",stratifier:s,stratifier_value:svKey,
            metric_type:"mean",n:a.n,metric_value:a.sumW>0?a.sumVW/a.sumW:0});
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
    const sd_value=n_runs>1?Math.sqrt(sd2/(n_runs-1)):0;
    let lower_ci=mean_value-1.96*sd_value;
    let upper_ci=mean_value+1.96*sd_value;
    if (min_sample<100) { mean_value=NaN; upper_ci=NaN; lower_ci=NaN; }
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