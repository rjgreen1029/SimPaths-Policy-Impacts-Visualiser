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
import { useState, useEffect, useMemo } from "react";

// ─── Label maps ───────────────────────────────────────────────────────────────
/**
 * Maps raw stratifier/variable VALUE codes to their human-readable display
 * labels — SCOPED per stratifier (or variable), keyed by that stratifier's
 * or variable's own name (lower-cased). This used to be one flat, unscoped
 * table shared by every stratifier — e.g. "1" always meant "North East"
 * (Region's code for it), regardless of which stratifier a "1" actually
 * came from — so a raw code from a totally different stratifier that
 * happened to also use "1" would silently get relabelled as if it were a
 * Region value too. Scoping each entry under its own stratifier/variable
 * name means a code is only ever translated using ITS OWN stratifier's
 * table, never anyone else's. Always look these up via stratLabel(key,
 * scope), never index this object directly.
 */
export const STRATIFIER_VALUE_LABELS = {
  "household type": {
    "CoupleChildren":   "Couple with children",
    "CoupleNoChildren": "Couple, no children",
    "SingleChildren":   "Single with children",
    "SingleNoChildren": "Single, no children",
    "couplechildren":   "Couple with children",
    "couplenochildren": "Couple, no children",
    "singlechildren":   "Single with children",
    "singlenochildren": "Single, no children",
  },
  "region": {
    "1":"North East","2":"North West","4":"Yorkshire and the Humber",
    "5":"East Midlands","6":"West Midlands","7":"East of England",
    "8":"London","9":"South East","10":"South West",
    "11":"Wales","12":"Scotland","13":"Northern Ireland",
    "UKC":"North East","UKD":"North West","UKE":"Yorkshire and the Humber",
    "UKF":"East Midlands","UKG":"West Midlands","UKH":"East of England",
    "UKI":"London","UKJ":"South East","UKK":"South West",
    "UKL":"Wales","UKM":"Scotland","UKN":"Northern Ireland",
  },
  "disability status": {
    "No disability": "No disability", "Has disability": "Has disability",
  },
  "financial distress flag": {
    "Not financially distressed": "Not financially distressed",
    "Financially distressed": "Financially distressed",
  },
  "need of social care": {
    "Does not need social care": "Does not need social care",
    "Needs social care": "Needs social care",
  },
};

/**
 * A tiny scope-INDEPENDENT fallback used only when a scoped lookup above
 * finds nothing for the given `scope` (or no scope was given at all) — kept
 * deliberately small and free of anything code-like (numbers, short IDs)
 * that could plausibly collide with a different stratifier's own coding.
 * Plain "TRUE"/"FALSE" strings are about as safe as a truly generic
 * fallback gets.
 */
const GENERIC_VALUE_LABELS = { "FALSE": "No", "TRUE": "Yes" };

/* ═══════════════════════════════════════════════════════════════════════════
   1. VARIABLE / STRATIFIER DEFINITIONS
   ═══════════════════════════════════════════════════════════════════════════ */

const HOUSEHOLD_TYPE_ORDER  = ["Couple with children","Couple, no children","Single with children","Single, no children","Missing"];
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
 // "number of children":         { type:"ordinal",     order:["None","1 Child","2 Children","3+ Children"] },
  "income quintile":            { type:"ordinal",     order:INCOME_QUINTILE_ORDER },
  "self-rated health":          { type:"ordinal",     order:["Excellent","VeryGood","Good","Fair","Poor"] },
  "hours worked":                             { type:"numeric" },
  "equivalised yearly disposable income":     { type:"numeric", incomeBinLabels:["£0–5k","£5–10k","£10–15k","£15–20k","£20–25k","£25–30k","£30–40k","£40–50k","£50k+"] },
  "gross personal employment income":         { type:"numeric", incomeBinLabels:["£0–500","£500–1k","£1–1.5k","£1.5–2k","£2–2.5k","£2.5–3k","£3–4k","£4–5k","£5k+"] },
  "capital income":                           { type:"numeric", incomeBinLabels:["£0–100","£100–500","£500–1k","£1–2k","£2k+"] },
  "personal private pension income":          { type:"numeric", incomeBinLabels:["£0–500","£500–1k","£1–2k","£2–5k","£5k+"] },
  "gross private pension income":             { type:"numeric", incomeBinLabels:["£0–1k","£1–2k","£2–5k","£5–10k","£10–20k","£20k+"] },
  "hourly earnings":                          { type:"numeric" },
  "amount of benefits received per month":    { type:"numeric", incomeBinLabels:["£0–100","£100–200","£200–300","£300–400","£400–500","£500–750","£750–1k","£1k+"] },
  "psychological distress score":             { type:"numeric" },
  "mental component summary (mcs)":           { type:"numeric" },
  "physical component summary (pcs)":         { type:"numeric" },
  "life satisfaction score":                  { type:"numeric" },
  "subjective wellbeing (ghq)":               { type:"numeric" },
  "ethnicity":           { type:"categorical", order:ETHNICITY_ORDER },
  "household type":      { type:"categorical", order:HOUSEHOLD_TYPE_ORDER },
  "employment status":   { type:"categorical", order:["Student","Employed or self employed","Not employed","Retired"] },
  "partnership status":  { type:"categorical", order:["Single","Partnered"] },
  "universal credit benefits flag":   { type:"categorical", order:["Benefits received","No benefits received"] },
  "financial distress flag":  { type:"categorical", order:["Financially distressed","Not financially distressed"] },
  "need of social care":      { type:"categorical", order:["Needs social care","Does not need social care"] },
 // "provided social care":     { type:"categorical", order:["Provides social care","Does not provide social care"] },
  "disability status":        { type:"categorical", order:["Has disability","No disability"] },
};

/** Same shape as VARIABLE_DEFS, but for the stratifier options. */
export const STRATIFIER_DEFS = {
  "age":                { type:"ordinal",     order:["Under 18","18-24","25-34","35-44","45-54","55-64","65+"] },
  "income quintile":    { type:"ordinal",     order:INCOME_QUINTILE_ORDER },
 // "number of children": { type:"ordinal",     order:["None","1 Child","2 Children","3+ Children"] },
  "household type":     { type:"categorical", order:HOUSEHOLD_TYPE_ORDER },
  "gender":             { type:"categorical", order:["Male","Female"] },
  "household type":     { type:"categorical", order:HOUSEHOLD_TYPE_ORDER },
  "disability status":  { type:"categorical", order:["Has disability","No disability"] },
  "ethnicity":          { type:"categorical", order:ETHNICITY_ORDER },
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
  "#ff5d51", // coral-red
  "#0ca1c4", // teal
  "#778ffb", // indigo
  "#22a87b", // green
  "#fee77e", // yellow-gold
  "#621670", // purple
  "#ff8c7d", // salmon
  "#14414e", // near-black
  "#77e4fb", // sky-blue
  "#cc2d22", // dark-red
];

// ── Sequential ramps (all start dark enough to see on white) ─────────────────
const SEQ_TEAL   = ["#8ecfda","#2ebfd8","#0ca1c4","#08829c","#074553"];
const SEQ_ORANGE = ["#ffc37d","#ffae7d","#ff9a7d","#ff5d51","#cc2d22"];
const SEQ_GREEN  = ["#8eeecb","#2ff2b1","#0bd993","#06a472","#076e4d"];
const SEQ_RED    = ["#ffb0ab","#ff5d51","#f6736a","#cc2d22","#be1b1b"];

// Number of children — None=grey, then bright blues matching dashboard teal/aqua palette
const SEQ_CHILDREN = ["#b0aaa4","#4ab8cc","#0f93a1","#055e71"];
//                    None       1 Child   2 Children  3+

// ── Diverging teal → orange: colourblind-safe, no red/green ──────────────────
// Used for income quintiles (5 stops) and deciles (10 stops).
// Poles are dashboard teal (#055e71) and coral-orange (#e8956e),
// meeting at a light warm-neutral midpoint. Safe under deuteranopia/protanopia
// since the discrimination is teal vs orange (blue vs yellow channel), not
// green vs red.
const DECILE_RAMP = [
  "#055e71", // 1  — dark teal
  "#0ca1c4", // 2
  "#4ab8cc", // 3
  "#8dcfda", // 4
  "#c8ddd8", // 5  — light neutral mid
  "#e8c9a0", // 6
  "#e8b07a", // 7
  "#e8956e", // 8
  "#c4633a", // 9
  "#9e3a1c", // 10 — dark orange-brown
];
const DIV_RED_TEAL = ["#8dcfda","#4ab8cc","#0ca1c4","#08829c","#055e71"];

// ── Education: indigo ramp ────────────────────────────────────────────────────
const INDIGO_EDU = ["#bac3ee","#4767f5","#0c2dc0"];

// ── Health: desaturated — tinted rather than traffic-light ───────────────────
// Health: teal (excellent) → orange (poor), colourblind-safe.
// No green/red so safe under deuteranopia/protanopia.
const HEALTH_DIV = ["#055e71","#0ca1c4","#7ab8b0","#ffb0ab","#ff5d51"];
//                  Excellent  VeryGood   Good      Fair     Poor

// ── Employment/Activity status — explicit per-value colours ──────────────────
// Employed=green, Not employed=red, Retired=purple, Student=indigo (edu blue)
const EMPLOYMENT_COLOURS = {
  // Display labels (from pre-agg CSV)
  "employed or self employed":  "#22a87b",
  "employed or self-employed":  "#22a87b",
  "self employed":              "#22a87b",
  "self-employed":              "#22a87b",
  "employed":                   "#22a87b",
  "not employed":               "#ff5d51",
  "not-employed":               "#ff5d51",
  "unemployed":                 "#ff5d51",
  "student":                    "#4767f5",
  "in education":               "#4767f5",
  "retired":                    "#621670",
  // Raw SimPaths Java enum values (from local upload before recode)
  "employedorselfemployed":     "#22a87b",
  "selfemployed":               "#22a87b",
  "notemployed":                "#ff5d51",
  "unemployedbenefits":         "#ff5d51",
  "student_enum":               "#4767f5",
  // Numeric codes (1-4) in case raw integers pass through
  "1":                          "#22a87b",
  "2":                          "#ff5d51",
  "3":                          "#621670",
  "4":                          "#4767f5",
};

// ── Ethnicity — explicit per-value colours ────────────────────────────────────
// White/Asian/Black/Mixed keep their natural BRAND_QUAL positions;
// Other → purple; Missing → grey
const ETHNICITY_COLOURS = {
  "white":   "#0ca1c4",  // teal   (BRAND_QUAL[1])
  "asian":   "#778ffb",  // indigo (BRAND_QUAL[2])
  "black":   "#22a87b",  // green  (BRAND_QUAL[3])
  "mixed":   "#14687c",  // teal-green
  "other":   "#621670",  // purple
  "missing": "#b0aaa4",  // grey
};

// ── Household type — purple × coral-red bivariate (Option 1) ─────────────────
// Couple axis = purple (#621670), Single axis = coral-red (#ff5d51)
// Children shifts toward the saturated/dark end of each axis.
const HOUSEHOLD_COLOURS = {
  "couple with children": "#621670",  // full purple
  "couple, no children":  "#c99dd1",  // light purple
  "couple no children":   "#c99dd1",  // alternate label
  "single with children": "#cc2d22",  // dark coral-red
  "single, no children":  "#ffb0ab",  // light coral
  "single no children":   "#ffb0ab",  // alternate label
  "missing":              "#8a8480",  // grey for null/unclassified
  "null":                 "#8a8480",
};

const RAMPS = { teal:SEQ_TEAL, orange:SEQ_ORANGE, green:SEQ_GREEN, red:SEQ_RED, blues:SEQ_TEAL,
  health:HEALTH_DIV, purple:["#d4a8de","#b362c4","#8e2098","#6e1580","#621670"],
  children:SEQ_CHILDREN };

/** Per-variable overrides for buildColourMap() */
const VARIABLE_PALETTE_REF = {
  "income quintile":    DIV_RED_TEAL,
  "income decile":      DECILE_RAMP,
  "self-rated health":  HEALTH_DIV,
  "number of children": SEQ_CHILDREN,
};

// Binary variables — distinctive coral/teal pair, both clearly visible on white
const BINARY_PAIR = ["#ff5d51","#0ca1c4"];
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

  // ── Numeric variables FIRST ───────────────────────────────────────────────
  const defCheck = getVariableDef(targetVariable) || getVariableDef(targetVariable.replace("received","recieved"));
  if (defCheck.type === "numeric") {
    ordered.forEach(v => { map[v] = "#0ca1c4"; });
    return map;
  }

  // ── Education: InEducation=warm grey, Low/Medium/High=indigo ramp ─────────
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

  // ── Ethnicity: explicit per-value map; Missing=grey, Other=purple ─────────
  if (varKey === "ethnicity") {
    ordered.forEach(v => {
      map[v] = ETHNICITY_COLOURS[normKey(v)] ?? QUAL[0];
    });
    return map;
  }

  // ── Employment / Activity status: explicit per-value map ──────────────────
  if (varKey === "employment status") {
    ordered.forEach(v => {
      map[v] = EMPLOYMENT_COLOURS[normKey(v)] ?? QUAL[0];
    });
    return map;
  }

  // ── Household type: Stevens green-blue bivariate palette ─────────────────
  if (varKey === "household type") {
    ordered.forEach(v => {
      map[v] = HOUSEHOLD_COLOURS[normKey(v)] ?? QUAL[0];
    });
    return map;
  }

  // ── Number of children: None=grey, 1/2/3+ = bright blues matching dashboard aqua/teal ─
  if (varKey === "number of children") {
    const childRamp = ["#4ab8cc","#0f93a1","#055e71"]; // bright→dark for 1, 2, 3+
    const nonNone = ordered.filter(v => normKey(v) !== "none");
    const palette = resolvePalette(childRamp, nonNone.length);
    ordered.forEach(v => {
      map[v] = normKey(v) === "none" ? "#b0aaa4" : palette[nonNone.indexOf(v)];
    });
    return map;
  }

  // ── Binary (exactly 2 values) ─────────────────────────────────────────────
  if (ordered.length === 2) {
    ordered.forEach((v,i) => { map[v] = BINARY_PAIR[i]; });
    return map;
  }

  // ── Specific palette references (number of children, self-rated health, income quintile) ──
  const ref = VARIABLE_PALETTE_REF[varKey]
    || (def.type === "ordinal"     ? SEQ_TEAL
      : def.type === "categorical" ? QUAL
      : def.type === "numeric"     ? "#0ca1c4"
      : QUAL);

  if (typeof ref === "string") { ordered.forEach(v => { map[v] = ref; }); return map; }
  if (def.type === "categorical") {
    ordered.forEach((v,i) => { map[v] = BRAND_QUAL[i % BRAND_QUAL.length]; });
    return map;
  }
  const palette = resolvePalette(ref, ordered.length);
  ordered.forEach((v,i) => { map[v] = palette[i]; });
  return map;
}

/** Muted grey used for any series that's present on a chart but not currently highlighted (see the "allLit"/highlighted logic in DashboardSection.js). Deliberately NOT brightened along with the rest of the palette — it needs to stay visually receded relative to whatever IS highlighted. */
export const GREY = "#8a8480";

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
/**
 * Returns baseline rows and a Map of scenarioName → rows for all non-baseline
 * scenarios present in parsedCache for the given variable.
 *
 * Scenario names are the raw lowercase values from the `scenario` column,
 * e.g. "scenario", "scenario_2", or whatever the R script / folder name
 * produced. The Map preserves insertion order so charts render scenarios
 * consistently.
 */
export function useAggregatedData(parsedCache, targetVariable) {
  const [baselineData, setBaselineData] = useState([]);
  const [scenarioMap,  setScenarioMap]  = useState(new Map()); // scenarioName → rows[]
  useEffect(() => {
    if (!parsedCache || !parsedCache.length) {
      setBaselineData([]); setScenarioMap(new Map()); return;
    }
    const varRows = parsedCache.filter(r => r.variable === targetVariable);
    setBaselineData(varRows.filter(r => r.scenario === "baseline"));
    // Collect all non-baseline scenario names in order of first appearance
    const names = [];
    const seen  = new Set();
    for (const r of varRows) {
      if (r.scenario !== "baseline" && !seen.has(r.scenario)) {
        names.push(r.scenario); seen.add(r.scenario);
      }
    }
    const map = new Map();
    for (const name of names) map.set(name, varRows.filter(r => r.scenario === name));
    setScenarioMap(map);
  }, [parsedCache, targetVariable]);
  // Convenience: first scenario's rows as "scenarioData" for backwards compat
  // with any code that still reads it directly.
  const scenarioData = useMemo(() => [...scenarioMap.values()][0] ?? [], [scenarioMap]);
  return { baselineData, scenarioData, scenarioMap };
}

/** Returns the sorted list of unique non-baseline scenario names across the whole parsedCache. */
export function useScenarioNames(parsedCache) {
  return useMemo(() => {
    if (!parsedCache?.length) return [];
    const names = [], seen = new Set();
    for (const r of parsedCache) {
      if (r.scenario !== "baseline" && !seen.has(r.scenario)) {
        names.push(r.scenario); seen.add(r.scenario);
      }
    }
    return names;
  }, [parsedCache]);
}

/** Human-readable label for a scenario name from the data (e.g. "scenario" → "Scenario", "scenario_education" → "Scenario: Education") */
export function scenarioLabel(name) {
  if (!name) return "";
  if (name === "scenario") return "Scenario";
  return name
    .replace(/^scenario[_-]?/i, "Scenario: ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */
/** Distinct, non-empty values of `key` across `data`, sorted. Used to discover what values a variable/stratifier actually takes in the current dataset (e.g. to feed buildColourMap or a filter list). */
export function uniqueValues(data, key) {
  return [...new Set(data.map(d => d[key]))].filter(v => v!==undefined && v!==null && v!=="").sort();
}
/**
 * Looks up a stratifier (or variable) VALUE's display label — e.g. "1"
 * under the "Region" stratifier → "North East". `scope` should be the
 * stratifier's (or variable's) own display name (e.g. "Region",
 * "Disability Status") and is REQUIRED for the lookup to use that
 * stratifier's own table — see STRATIFIER_VALUE_LABELS above for why this
 * matters: without a scope, a value can only ever match the tiny, generic
 * GENERIC_VALUE_LABELS fallback (plain "TRUE"/"FALSE"), never a
 * scope-specific code like a Region number, precisely so a code from one
 * stratifier can't accidentally get labelled using another's table. Falls
 * back to the raw key unchanged if nothing matches either table.
 */
export function stratLabel(key, scope) {
  const scoped = scope ? STRATIFIER_VALUE_LABELS[normKey(scope)]?.[key] : undefined;
  if (scoped !== undefined) return scoped;
  return GENERIC_VALUE_LABELS[key] ?? key;
}

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
  let variable=d.variable||d.Variable;
  let variable_value=d.variable_value||d.Variable_Value||d.variable_values||d.value;

  // Rename null/NA/empty variable_value to "Missing"
  if (!variable_value||variable_value==="null"||variable_value==="NA"||variable_value==="NaN") {
    variable_value="Missing";
  }

  // Recode Household Type numeric codes / raw labels to canonical display names
  if (variable==="Household Type"||variable==="household type") {
    const HH_RECODE={
      "1":"Couple with children","2":"Couple, no children",
      "3":"Single with children","4":"Single, no children",
      "couplechildren":"Couple with children","couplenochildren":"Couple, no children",
      "singlechildren":"Single with children","singlenochildren":"Single, no children",
    };
    // Strip spaces, commas, hyphens, underscores for fuzzy match
    const key=(variable_value||"").toLowerCase().replace(/[\s\-_,]/g,"");
    variable_value=HH_RECODE[key]||variable_value;
  }
  // The bundled default CSV (SimPaths_All_Aggregated_Outputs.csv) predates
  // this variable being renamed from "UC Benefits Flag" to "Universal
  // Credit Benefits Flag" everywhere else in the app (App.js, parseCore.js,
  // VARIABLE_DEFS, etc.) — its own "variable" column still says the old
  // name. Normalising it HERE, right where every row from that file enters
  // the app, means every downstream comparison (activeVariable matching in
  // useAggregatedData(), the relabelling below, VARIABLE_DEFS lookups)
  // sees the same name regardless of which one the CSV itself contains.
  // Without this, selecting "Universal Credit Benefits Flag" while using
  // the default dataset matched zero rows and just showed "No data
  // available" — a user-uploaded folder was never affected, since
  // parseCore.js's local-parsing pipeline produces the new name directly.
  if (variable==="UC Benefits Flag") variable="Universal Credit Benefits Flag";
  // Universal Credit Benefits Flag ships from the aggregation pipeline as
  // raw true/false rather than a relabeled category — every other
  // boolean-style variable (Disability Status, Financial distress,
  // Need/Provided social care) is already relabeled upstream before export,
  // so they never hit this; Universal Credit Benefits Flag is the one that
  // isn't. Relabelling it HERE, before it ever reaches stratLabel(), is
  // still worth doing even now that stratLabel() looks up per-stratifier
  // scoped tables (see STRATIFIER_VALUE_LABELS above) rather than one
  // global unscoped one — Universal Credit Benefits Flag's raw true/false
  // values aren't in that table at all (categorical booleans are handled
  // via each variable's own upstream *_MAP in parseCore.js instead), so
  // without this they'd otherwise just fall through unlabelled.
  if (variable==="Universal Credit Benefits Flag") {
    const v=String(variable_value).trim().toLowerCase();
    if (v==="true") variable_value="Benefits received";
    else if (v==="false") variable_value="No benefits received";
    else if (v===""||v==="na"||v==="nan"||v==="null"||v==="undefined") variable_value="Missing";
    // else: leave unchanged (e.g. already "Missing" from upstream)
  }
  return {
    year:             +d.Year            || +d.year,
    scenario:         (d.scenario        || d.Scenario || "baseline").toLowerCase(),
    module:           d.module           || d.Module,
    variable,
    variable_value,
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
    mean_value:         parseMaybeNaN(d.mean_value),
    sd_value:           parseMaybeNaN(d.sd_value),
    lower_ci:           parseCI(d.ci_lower ?? d.lower_ci),
    upper_ci:           parseCI(d.ci_upper ?? d.upper_ci),
    paired_mean_delta:  parseMaybeNaN(d.paired_mean_delta),
    paired_lower_ci:    parseCI(d.paired_lower_ci ?? d.paired_ci_lower),
    paired_upper_ci:    parseCI(d.paired_upper_ci ?? d.paired_ci_upper),
    paired_n_runs:      +(d.paired_n_runs ?? 0) || 0,
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