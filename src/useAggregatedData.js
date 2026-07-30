import { useState, useEffect } from "react";

// ─── Label maps ───────────────────────────────────────────────────────────────
export const STRATIFIER_VALUE_LABELS = {
  "CoupleChildren":   "Couple with children",
  "CoupleNoChildren": "Couple, no children",
  "SingleChildren":   "Single with children",
  "SingleNoChildren": "Single, no children",
  "FALSE": "No",  "TRUE":  "Yes",
  "No disability": "No disability", "Has disability": "Has disability",
  "Not financially distressed": "Not financially distressed",
  "Financially distressed": "Financially distressed",
  "Does not need social care": "Does not need social care",
  "Needs social care": "Needs social care",
  "1":"North East","2":"North West","4":"Yorkshire and the Humber",
  "5":"East Midlands","6":"West Midlands","7":"East of England",
  "8":"London","9":"South East","10":"South West",
  "11":"Wales","12":"Scotland","13":"Northern Ireland",
  "UKC":"North East","UKD":"North West","UKE":"Yorkshire and the Humber",
  "UKF":"East Midlands","UKG":"West Midlands","UKH":"East of England",
  "UKI":"London","UKJ":"South East","UKK":"South West",
  "UKL":"Wales","UKM":"Scotland","UKN":"Northern Ireland",
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. VARIABLE / STRATIFIER DEFINITIONS
   ═══════════════════════════════════════════════════════════════════════════ */

const HOUSEHOLD_TYPE_ORDER  = ["CoupleChildren","CoupleNoChildren","SingleChildren","SingleNoChildren"];
const ETHNICITY_ORDER       = ["White","Asian","Black","Mixed","Other","Missing"];
const INCOME_QUINTILE_ORDER = ["Q1","Q2","Q3","Q4","Q5"];

export const VARIABLE_DEFS = {
  "highest level of education": { type:"ordinal",     order:["InEducation","Low","Medium","High"] },
  "number of children":         { type:"ordinal",     order:["None","1 Child","2 Children","3+ Children"] },
  "income quintile":            { type:"ordinal",     order:INCOME_QUINTILE_ORDER },
  "self-rated health":          { type:"ordinal",     order:["Excellent","VeryGood","Good","Fair","Poor"] },
  "hours worked":                             { type:"numeric" },
  "equivalised yearly disposable income":     { type:"numeric" },
  "gross personal employment income":         { type:"numeric" },
  "capital income":                           { type:"numeric" },
  "amount of benefits recieved per month":    { type:"numeric" },
  "amount of benefits received per month":    { type:"numeric" },
  "psychological distress score":             { type:"numeric" },
  "mental component summary (mcs)":           { type:"numeric" },
  "physical component summary (pcs)":         { type:"numeric" },
  "life satisfaction score":                  { type:"numeric" },
  "subjective wellbeing (ghq)":               { type:"numeric" },
  "ethnicity":           { type:"categorical", order:ETHNICITY_ORDER },
  "household type":      { type:"categorical", order:HOUSEHOLD_TYPE_ORDER },
  "employment status":   { type:"categorical", order:["Employed or self employed","Not employed","Retired","Student"] },
  "partnership status":  { type:"categorical", order:["Single","Partnered"] },
  "benefits received":   { type:"categorical", order:["Benefits Received","No Benefits Received"] },
  "financial distress flag":  { type:"categorical", order:["Financially distressed","Not financially distressed"] },
  "need of social care":      { type:"categorical", order:["Needs social care","Does not need social care"] },
  "provided social care":     { type:"categorical", order:["Provides social care","Does not provide social care"] },
  "disability status":        { type:"categorical", order:["Has disability","No disability"] },
};

export const STRATIFIER_DEFS = {
  "age":             { type:"ordinal",     order:["Under 18","18-24","25-34","35-44","45-54","55-64","65+"] },
  "income quintile": { type:"ordinal",     order:INCOME_QUINTILE_ORDER },
  "gender":          { type:"categorical", order:["Male","Female"] },
  "household type":  { type:"categorical", order:HOUSEHOLD_TYPE_ORDER },
  "disability status":{ type:"categorical",order:["Has disability","No disability"] },
  "ethnicity":       { type:"categorical", order:ETHNICITY_ORDER },
  "region": { type:"categorical", order:[
    "South West","South East","London","East of England","East Midlands",
    "West Midlands","Yorkshire and the Humber","North West","North East",
    "Wales","Scotland","Northern Ireland",
  ]},
};

function normKey(s) { return (s||"").toString().toLowerCase().trim(); }
export function getVariableDef(name)   { return VARIABLE_DEFS[normKey(name)]   || { type:"categorical", order:[] }; }
export function getStratifierDef(name) {
  const k = normKey(name);
  if (!k || k==="overall") return { type:"none", order:[] };
  return STRATIFIER_DEFS[k] || { type:"categorical", order:[] };
}

export function orderValues(canonicalOrder, observedValues) {
  const obs   = Array.isArray(observedValues) ? observedValues : [];
  const canon = Array.isArray(canonicalOrder)  ? canonicalOrder  : [];
  const inCanon = canon.filter(c => obs.includes(c));
  const extras  = obs.filter(v => !canon.includes(v)).sort((a,b) => String(a).localeCompare(String(b)));
  return [...inCanon, ...extras];
}
export function orderVariableValues(targetVariable, values) {
  return orderValues(getVariableDef(targetVariable).order, values);
}
export function orderStratifierValues(stratifier, values) {
  return orderValues(getStratifierDef(stratifier).order, values);
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. SIMPLIFIED COLOUR ENGINE
   ─────────────────────────────────────────────────────────────────────────
   One rule: colour encodes variable_value, always with the same hue for
   the same category everywhere. No bivariate blending. No binary/dashed
   special-casing. Baseline vs scenario is always solid vs dashed line /
   full vs translucent bar — a separate visual channel.

   buildColourMap(targetVariable, variableValues)
     → { [variable_value]: cssColour }
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Qualitative (categorical) — CVD-friendly, all clearly visible on white ────
// (brightened slightly vs. the original palette — same hues/order, more pop)
const BRAND_QUAL = [
  "#ff867d", // coral-red
  "#0ca1c4", // teal
  "#778ffb", // indigo
  "#2ff2b1", // green
  "#fee77e", // yellow-gold
  "#9b11b5", // purple
  "#ff8c7d", // salmon
  "#14414e", // near-black
  "#77e4fb", // sky-blue
  "#e35047", // dark-red
];

// ── Sequential ramps (all start dark enough to see on white) ─────────────────
const SEQ_TEAL   = ["#8ecfda","#2ebfd8","#0ca1c4","#08829c","#074553"];
const SEQ_ORANGE = ["#ffc37d","#ffae7d","#ff9a7d","#ff867d","#e35047"];
const SEQ_GREEN  = ["#8eeecb","#2ff2b1","#0bd993","#06a472","#076e4d"];
const SEQ_RED    = ["#ff887d","#ff867d","#f6736a","#e35047","#be1b1b"];

// ── Diverging: red (poor/low) → neutral → teal (excellent/high) ──────────────
// 5-stop (Q1–Q5 or Poor–Excellent), centred on mid-grey
// Diverging red → yellow → teal — evenly spaced 5 stops
// Q1=dark-red, Q2=coral, Q3=yellow (neutral), Q4=teal, Q5=dark-teal
const DIV_RED_TEAL = ["#e85547","#f9a882","#fee77e","#2ebfd8","#08829c"];

// ── Education: indigo ramp, starting visibly dark ─────────────────────────────
// Low=mid-indigo, Medium=strong indigo, High=dark indigo  (InEducation stays grey)
const INDIGO_EDU = ["#bac3ee","#4767f5","#0c2dc0"]; // 3 stops: Low / Medium / High — spread further apart in lightness+saturation so Low/Medium are easy to tell apart

// ── Health: Poor→Excellent maps red→teal (diverging) ─────────────────────────
// Order in VARIABLE_DEFS is Excellent,VeryGood,Good,Fair,Poor so reverse for colour
// Health: Excellent=dark teal → Good=yellow → Poor=dark red
// VeryGood sits between Excellent and Good → warm green bridge
const HEALTH_DIV = ["#08829c","#0fe899","#fee77e","#ff867d","#e35047"];
//  Excellent      VeryGood      Good       Fair      Poor

const RAMPS = { teal:SEQ_TEAL, orange:SEQ_ORANGE, green:SEQ_GREEN, red:SEQ_RED, blues:SEQ_TEAL,
  health:HEALTH_DIV, purple:["#db99e3","#c94bd9","#bd0cc8","#9b07a6","#9b11b5"] };

const VARIABLE_PALETTE_REF = {
  "income quintile":   DIV_RED_TEAL,  // Q1(low)=red … Q5(high)=teal
  "self-rated health": HEALTH_DIV,    // Excellent=teal … Poor=red
  "number of children":SEQ_GREEN,
  // household type & employment status → categorical (BRAND_QUAL), handled below
};

// Binary variables — distinctive coral/teal pair, both clearly visible on white
const BINARY_PAIR = ["#ff867d","#0ca1c4"];
// Warm mid-grey for "In Education" (not cold, not too light)
const EDU_GREY = "#8a8078";

const QUAL = BRAND_QUAL;

function resolvePalette(ref, count) {
  const n = Math.max(1, count);
  const fam = Array.isArray(ref) ? ref : (RAMPS[ref] || QUAL);
  if (fam.length === n) return fam;
  if (fam.length > n) {
    if (n === 1) return [fam[Math.floor(fam.length/2)]];
    return Array.from({length:n},(_,i) => fam[Math.round(i*(fam.length-1)/(n-1))]);
  }
  return Array.from({length:n}, (_,i) => fam[i % fam.length]);
}

export function buildColourMap(targetVariable, variableValues) {
  const def = getVariableDef(targetVariable);
  const ordered = orderVariableValues(targetVariable, variableValues);
  const varKey = normKey(targetVariable);
  const map = {};

  // ── Numeric variables FIRST — always solid teal, no other path can intercept ──
  // Check both spelled and misspelled variants since parseCore uses correct spelling
  const isNumeric = def.type === "numeric"
    || varKey.includes("income") && !varKey.includes("quintile")
    || varKey.includes("hours")
    || varKey.includes("benefits received per month") // both spellings
    || varKey.includes("benefits recieved per month")
    || varKey.includes("score")
    || varKey.includes("summary")
    || varKey.includes("distress")
    || varKey.includes("wellbeing")
    || varKey.includes("satisfaction")
    || varKey.includes("pension");
  // Re-derive def using both spellings
  const defCheck = getVariableDef(targetVariable) || getVariableDef(targetVariable.replace("received","recieved"));
  if (defCheck.type === "numeric") {
    ordered.forEach(v => { map[v] = "#0ca1c4"; });
    return map;
  }

  // ── Education: InEducation=warm grey, Low/Medium/High=indigo ramp ──────────
  if (varKey === "highest level of education") {
    const ranked = ["low","medium","high"];
    const rankedVals = ordered.filter(v => ranked.includes(normKey(v)));
    const palette = resolvePalette(INDIGO_EDU, rankedVals.length);
    ordered.forEach(v => {
      const k = normKey(v);
      if (k === "ineducation" || v === "InEducation") { map[v] = EDU_GREY; }
      else { const idx = rankedVals.indexOf(v); map[v] = idx>=0 ? palette[idx] : QUAL[5]; }
    });
    return map;
  }

  // ── Binary (exactly 2 values): coral + teal, always visible on white ───────
  if (ordered.length === 2) {
    ordered.forEach((v,i) => { map[v] = BINARY_PAIR[i]; });
    return map;
  }

  // ── Household type & employment status → categorical, same colour order as ethnicity ──
  // Slice first N directly from BRAND_QUAL so colours match what ethnicity uses
  if (varKey === "household type" || varKey === "employment status") {
    ordered.forEach((v,i) => { map[v] = BRAND_QUAL[i % BRAND_QUAL.length]; });
    return map;
  }

  // ── Specific palette references ────────────────────────────────────────────
  const ref = VARIABLE_PALETTE_REF[varKey]
    || (def.type === "ordinal"    ? SEQ_TEAL
      : def.type === "categorical" ? QUAL
      : def.type === "numeric"    ? "#0ca1c4"
      : QUAL);

  if (typeof ref === "string") { ordered.forEach(v => { map[v] = ref; }); return map; }
  // For pure categorical, slice directly from QUAL so index 0=coral, 1=teal etc. (no spreading)
  if (def.type === "categorical") {
    ordered.forEach((v,i) => { map[v] = BRAND_QUAL[i % BRAND_QUAL.length]; });
    return map;
  }
  const palette = resolvePalette(ref, ordered.length);
  ordered.forEach((v,i) => { map[v] = palette[i]; });
  return map;
}

// Grey used when a series is not highlighted
export const GREY = "#b0aaa4";

/* ═══════════════════════════════════════════════════════════════════════════
   3. DATA HOOK
   ═══════════════════════════════════════════════════════════════════════════ */
export function useAggregatedData(parsedCache, targetVariable) {
  const [baselineData, setBaselineData] = useState([]);
  const [scenarioData, setScenarioData] = useState([]);
  useEffect(() => {
    if (!parsedCache || !parsedCache.length) { setBaselineData([]); setScenarioData([]); return; }
    setBaselineData(parsedCache.filter(r => r.scenario==="baseline" && r.variable===targetVariable));
    setScenarioData(parsedCache.filter(r => r.scenario==="scenario" && r.variable===targetVariable));
  }, [parsedCache, targetVariable]);
  return { baselineData, scenarioData };
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */
export function uniqueValues(data, key) {
  return [...new Set(data.map(d => d[key]))].filter(v => v!==undefined && v!==null && v!=="").sort();
}
export function stratLabel(key) { return STRATIFIER_VALUE_LABELS[key] ?? key; }

export function averageAcrossYears(rows) {
  if (!rows?.length) return [];
  const groups = new Map();
  rows.forEach(d => {
    const key = `${d.variable_value}::${d.stratifier_value}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(d);
  });
  const mean = arr => { const v=arr.filter(x=>!isNaN(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : NaN; };
  return Array.from(groups.values()).map(group => ({
    ...group[0], year:"Average",
    mean_value: mean(group.map(d=>d.mean_value)),
    lower_ci:   mean(group.map(d=>d.lower_ci)),
    upper_ci:   mean(group.map(d=>d.upper_ci)),
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. CSV PARSER (unchanged)
   ═══════════════════════════════════════════════════════════════════════════ */
export function parseCsvRow(d) {
  return {
    year:             +d.Year            || +d.year,
    scenario:         (d.scenario        || d.Scenario || "baseline").toLowerCase(),
    module:           d.module           || d.Module,
    variable:         d.variable         || d.Variable,
    variable_value:   d.variable_value   || d.Variable_Value || d.variable_values || d.value,
    stratifier:       d.stratifier       || d.Stratifier       || "Overall",
    stratifier_value: d.stratifier_value || d.Stratifier_Value || "Overall",
    metric_type:      d.metric_type      || d.Metric_Type      || "mean",
    n_runs:           +d.n_runs          || +d.N_Runs           || 1,
    total_sample:     +d.total_sample    || 0,
    min_sample:       +d.min_sample      || 0,
    mean_sample:      +d.mean_sample     || 0,
    mean_value:       parseMaybeNaN(d.mean_value),
    sd_value:         parseMaybeNaN(d.sd_value),
    lower_ci:         parseCI(d.ci_lower ?? d.lower_ci),
    upper_ci:         parseCI(d.ci_upper ?? d.upper_ci),
  };
}
function parseMaybeNaN(v) {
  if (v===undefined||v===null||v===""||v==="NaN"||v==="NA") return NaN;
  const n=+v; return isNaN(n)?NaN:n;
}
function parseCI(v) {
  if (v===undefined||v===null||v===""||v==="NaN"||v==="NA") return NaN;
  const n=+v; return isNaN(n)?NaN:n;
}