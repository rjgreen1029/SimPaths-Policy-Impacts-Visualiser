/**
 * useAggregatedData.js — Variable/stratifier metadata, the colour engine,
 * the default-CSV row parser, and a couple of small data hooks/utilities.
 *
 * This file is organised into five numbered sections (search for the
 * "═══" banners below):
 *   1. VARIABLE / STRATIFIER DEFINITIONS — display ordering + type (ordinal/
 *      categorical/numeric) for every variable and stratifier, plus helpers
 *      to look them up and sort observed values into a sensible order.
 *   2. COLOUR ENGINE — buildColourMap(targetVariable, variableValues) is the
 *      single entry point every chart in DashboardSection.js calls to get a
 *      {variable_value: cssColour} map. One rule: colour always encodes
 *      variable_value the same way everywhere a value appears; Baseline vs.
 *      Scenario is a completely separate visual channel (solid/dashed lines,
 *      full/translucent bars) handled in DashboardSection.js, not here.
 *   3. DATA HOOK — useAggregatedData() filters the full parsed dataset down
 *      to the currently-selected variable's Baseline/Scenario rows.
 *   4. UTILITIES — small helpers used across the dashboard (unique values,
 *      stratifier value display labels, averaging rows across years).
 *   5. CSV PARSER — parseCsvRow() turns one row of the default pre-aggregated
 *      CSV into the same row shape parseCore.js's performCrossRunAggregation()
 *      produces for user-uploaded data, so the rest of the app is agnostic
 *      to which source the data came from.
 */
import { useState, useEffect } from "react";

// ─── Label maps ───────────────────────────────────────────────────────────────
/** Maps raw stratifier VALUE codes (household type codes, boolean strings, region codes) to their human-readable display labels. Falls back to the raw key itself if not listed (see stratLabel() below). */
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

/**
 * Metadata for every variable the dashboard can plot as the main outcome:
 * its `type` ("ordinal" | "categorical" | "numeric") and, for
 * ordinal/categorical variables, the canonical display `order` for its
 * values. Keyed by lower-cased variable name — always look these up via
 * getVariableDef() rather than indexing this object directly, since that
 * handles the lower-casing and the "no definition found" fallback.
 *
 * Two near-duplicate keys ("amount of benefits recieved/received per
 * month") exist to tolerate a spelling variant that has shown up in some
 * simulation output column naming — see buildColourMap()'s isNumeric check
 * below for the same tolerance applied there.
 */
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
  "uc benefits flag":   { type:"categorical", order:["Receives benefits","Does not receive benefits"] },
  "financial distress flag":  { type:"categorical", order:["Financially distressed","Not financially distressed"] },
  "need of social care":      { type:"categorical", order:["Needs social care","Does not need social care"] },
  "provided social care":     { type:"categorical", order:["Provides social care","Does not provide social care"] },
  "disability status":        { type:"categorical", order:["Has disability","No disability"] },
};

/** Same shape as VARIABLE_DEFS, but for the 7 "Stratify by" options rather than main-outcome variables. */
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

/** Lower-cases + trims for use as a VARIABLE_DEFS/STRATIFIER_DEFS lookup key. */
function normKey(s) { return (s||"").toString().toLowerCase().trim(); }
/** Looks up a variable's definition by name (case/whitespace-insensitive). Falls back to `{type:"categorical", order:[]}` for anything not in VARIABLE_DEFS, so callers never need a null-check. */
export function getVariableDef(name)   { return VARIABLE_DEFS[normKey(name)]   || { type:"categorical", order:[] }; }
/** Same as getVariableDef() but for stratifiers, with a special-cased `{type:"none"}` for "Overall"/empty (i.e. "not stratified"). */
export function getStratifierDef(name) {
  const k = normKey(name);
  if (!k || k==="overall") return { type:"none", order:[] };
  return STRATIFIER_DEFS[k] || { type:"categorical", order:[] };
}

/**
 * Orders a list of observed values: canonical-order values first (in the
 * order given by `canonicalOrder`), then any values not in the canonical
 * list appended alphabetically at the end. This means a variable can gain
 * an unexpected new category in the data (e.g. from a differently-coded
 * upload) without silently disappearing from the chart — it just sorts to
 * the back rather than breaking the ordering of the known values.
 */
export function orderValues(canonicalOrder, observedValues) {
  const obs   = Array.isArray(observedValues) ? observedValues : [];
  const canon = Array.isArray(canonicalOrder)  ? canonicalOrder  : [];
  const inCanon = canon.filter(c => obs.includes(c));
  const extras  = obs.filter(v => !canon.includes(v)).sort((a,b) => String(a).localeCompare(String(b)));
  return [...inCanon, ...extras];
}
/** orderValues() using a main variable's own canonical order (from VARIABLE_DEFS). */
export function orderVariableValues(targetVariable, values) {
  return orderValues(getVariableDef(targetVariable).order, values);
}
/** orderValues() using a stratifier's own canonical order (from STRATIFIER_DEFS). */
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
/** 10-colour categorical palette. Sliced in this fixed order everywhere a categorical variable needs colours, so e.g. Household Type and Employment Status (which share the same slicing logic) stay visually consistent with each other. */
const BRAND_QUAL = [
  "#ff867d", // coral-red
  "#0ca1c4", // teal
  "#778ffb", // indigo
  "#22a87b", // green
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
/** Income Quintile's colour ramp: Q1 (lowest) = red, Q5 (highest) = teal. Deliberately darkened/more-saturated vs. a naive brightened palette — the lighter stops (Q2/Q3) were previously too low-contrast against the cream page background. */
const DIV_RED_TEAL = ["#d82413","#ed540c","#d8a90e","#1b9bb1","#055e71"];

// ── Education: indigo ramp, starting visibly dark ─────────────────────────────
// Low=mid-indigo, Medium=strong indigo, High=dark indigo  (InEducation stays grey)
const INDIGO_EDU = ["#bac3ee","#4767f5","#0c2dc0"]; // 3 stops: Low / Medium / High — spread further apart in lightness+saturation so Low/Medium are easy to tell apart

// ── Health: Poor→Excellent maps red→teal (diverging) ─────────────────────────
// Order in VARIABLE_DEFS is Excellent,VeryGood,Good,Fair,Poor so reverse for colour
// Health: Excellent=dark teal → Good=yellow → Poor=dark red
// VeryGood sits between Excellent and Good → warm green bridge
/** Defined but currently unused directly for Self-Rated Health — see VARIABLE_PALETTE_REF below, which reuses the (reversed) Income Quintile ramp for that variable instead. Kept here in case that choice is reverted. */
const HEALTH_DIV = ["#08829c","#0fe899","#fee77e","#ff867d","#e35047"];
//  Excellent      VeryGood      Good       Fair      Poor

const RAMPS = { teal:SEQ_TEAL, orange:SEQ_ORANGE, green:SEQ_GREEN, red:SEQ_RED, blues:SEQ_TEAL,
  health:HEALTH_DIV, purple:["#db99e3","#c94bd9","#bd0cc8","#9b07a6","#9b11b5"] };

/** Per-variable overrides for buildColourMap() — anything not listed here falls back to the generic type-based default (SEQ_TEAL for ordinal, BRAND_QUAL for categorical, solid teal for numeric). */
const VARIABLE_PALETTE_REF = {
  "income quintile":   DIV_RED_TEAL,  // Q1(low)=red … Q5(high)=teal
  "self-rated health": [...DIV_RED_TEAL].reverse(),    // Excellent=teal … Poor=red
  "number of children":SEQ_GREEN,
  // household type & employment status → categorical (BRAND_QUAL), handled below
};

// Binary variables — distinctive coral/teal pair, both clearly visible on white
const BINARY_PAIR = ["#ff867d","#0ca1c4"];
// Warm mid-grey for "In Education" (not cold, not too light)
const EDU_GREY = "#8a8078";

const QUAL = BRAND_QUAL;

/**
 * Adapts a colour family (array) to exactly `count` colours: samples evenly
 * across the family if it has more stops than needed, cycles through it
 * (repeating) if it has fewer. `ref` may also be a RAMPS key string, which
 * gets resolved to its array first.
 */
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

/**
 * Builds a {variable_value: cssColour} map for one variable's observed
 * values. This is the single entry point every chart in DashboardSection.js
 * uses for colour — call it once per variable and reuse the returned map so
 * a given value always renders the same colour across every chart type
 * (line, bar, legend) on the page.
 *
 * Resolution order (first match wins):
 *   1. Numeric variables → solid teal (checked first, via both the formal
 *      type AND a keyword-based fallback, so a numeric variable missing
 *      from VARIABLE_DEFS — e.g. a misspelled column — still renders sanely
 *      rather than falling through to a categorical palette).
 *   2. "Highest Level of Education" → special-cased: InEducation gets a
 *      warm grey, Low/Medium/High get the INDIGO_EDU ramp.
 *   3. Exactly 2 observed values → BINARY_PAIR (coral/teal).
 *   4. "Household Type" / "Employment Status" → sliced directly from
 *      BRAND_QUAL (kept as its own branch so these two match the colour
 *      order used elsewhere for the same underlying category set).
 *   5. VARIABLE_PALETTE_REF lookup, else a generic default based on
 *      def.type (SEQ_TEAL for ordinal, BRAND_QUAL for categorical, solid
 *      teal for numeric).
 *
 * @param {string} targetVariable
 * @param {string[]} variableValues - observed values for this variable
 * @returns {Object<string,string>} value → CSS colour
 */
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

/** Muted grey used for any series that's present on a chart but not currently highlighted (see the "allLit"/highlighted logic in DashboardSection.js). Deliberately NOT brightened along with the rest of the palette — it needs to stay visually receded relative to whatever IS highlighted. */
export const GREY = "#b0aaa4";

/* ═══════════════════════════════════════════════════════════════════════════
   3. DATA HOOK
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * Filters the full parsed dataset (`parsedCache` — either the default CSV
 * or a user's uploaded folder, already normalised to the same row shape) down
 * to just the currently-selected variable's Baseline and Scenario rows.
 *
 * @param {object[]} parsedCache - full dataset, all variables/scenarios mixed together
 * @param {string} targetVariable - the variable currently selected in the sidebar
 * @returns {{baselineData: object[], scenarioData: object[]}}
 */
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
/** Distinct, non-empty values of `key` across `data`, sorted. Used to discover what values a variable/stratifier actually takes in the current dataset (e.g. to feed buildColourMap or a filter list). */
export function uniqueValues(data, key) {
  return [...new Set(data.map(d => d[key]))].filter(v => v!==undefined && v!==null && v!=="").sort();
}
/** Looks up a stratifier VALUE's display label (e.g. "CoupleChildren" → "Couple with children"); falls back to the raw key unchanged if not in STRATIFIER_VALUE_LABELS. */
export function stratLabel(key) { return STRATIFIER_VALUE_LABELS[key] ?? key; }

/**
 * Collapses a set of per-year rows into a single "Average" row per
 * (variable_value, stratifier_value) combination, by averaging mean_value/
 * lower_ci/upper_ci across years. Used for the cross-section view's
 * "averaged across all years" option (as opposed to pinning one specific
 * year). NaN entries (suppressed/missing years) are excluded from the
 * average rather than treated as zero.
 *
 * @param {object[]} rows
 * @returns {object[]} one row per (variable_value, stratifier_value), with year:"Average"
 */
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
/**
 * d3.csv row-accessor for the default pre-aggregated CSV
 * (SimPaths_All_Aggregated_Outputs.csv). Produces exactly the same row
 * shape as parseCore.js's performCrossRunAggregation(), which is what lets
 * the rest of the app treat the default dataset and a user's own uploaded
 * folder identically. Tolerates a couple of alternate column-name casings
 * (Year/year, Scenario/scenario, ci_lower/lower_ci, etc.) since the exact
 * casing used by whoever last exported the CSV can vary.
 */
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
    // Tolerates both the original snake_case column names and the
    // friendlier "Total Sample: Across Runs" / etc. headers — works with
    // either version of the CSV.
    total_sample:     +(d.total_sample   ?? d["Total Sample: Across Runs"])   || 0,
    min_sample:       +(d.min_sample     ?? d["Minimum Sample: Across Runs"]) || 0,
    mean_sample:      +(d.mean_sample    ?? d["Average Sample: Across Runs"]) || 0,
    mean_value:       parseMaybeNaN(d.mean_value),
    sd_value:         parseMaybeNaN(d.sd_value),
    lower_ci:         parseCI(d.ci_lower ?? d.lower_ci),
    upper_ci:         parseCI(d.ci_upper ?? d.upper_ci),
  };
}
/** Parses a numeric field that may legitimately be missing/suppressed (empty string, "NaN", "NA") — returns NaN rather than 0 for those, so suppressed estimates aren't mistaken for a real zero value downstream. */
function parseMaybeNaN(v) {
  if (v===undefined||v===null||v===""||v==="NaN"||v==="NA") return NaN;
  const n=+v; return isNaN(n)?NaN:n;
}
/** Same missing-value handling as parseMaybeNaN(), kept as a separate named function for the two CI columns for readability at the call site. */
function parseCI(v) {
  if (v===undefined||v===null||v===""||v==="NaN"||v==="NA") return NaN;
  const n=+v; return isNaN(n)?NaN:n;
}