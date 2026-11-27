/**
 * datasetExport.js — the .xlsx downloads: the full dataset (App.js) and each
 * chart's data (DashboardSection.js).
 *
 * Every download is a workbook with an "About" sheet first (what the file is,
 * what each column means, why some cells are blank) and a "Data" sheet.
 * Estimates based on fewer than 20 people in a model run are left blank, along
 * with their interval, difference and sample size, so small groups can't be
 * read off the file. module, total_sample, min_sample and paired_n_runs are
 * not included.
 */
import { buildXlsx, STYLE } from "./xlsxWriter";
import { VARIABLE_DESCRIPTIONS, STRATIFIER_DESCRIPTIONS, BENEFIT_UNIT_NOTES, BENEFIT_UNIT_DEFINITION } from "./variableInfo";

export const MIN_SAMPLE_SHOWN = 20;

const PROPORTIONS = "Proportions are fractions from 0 to 1 (multiply by 100 for %).";
const METRIC_TYPES = {
  mean: "average value, in the variable's own units",
  share: "proportion of people in the group with this variable_value",
  income_bin: "proportion of people in each income band",
  wage_bin: "proportion of people in each hourly-wage band",
  pyramid_bin: "proportion of the whole population at each single year of age, by gender",
};
/** metric_type's description, listing only the types in the file. */
function metricText(c) {
  const types = [...c.metricTypes];
  const parts = types.map(t => `${t} = ${METRIC_TYPES[t] || t}.`);
  return parts.join(" ") + (types.some(t => t !== "mean") ? ` ${PROPORTIONS}` : "");
}

/** Columns for estimates (levels). [name, description, value(row, labelOf)] */
export const LEVEL_COLUMNS = [
  ["year", c => `Simulated calendar year.${c.hasAverage ? " \"Average\" = averaged across all years shown." : ""}`, r => r.year],
  ["scenario", "Baseline (no policy change) or the name of the policy scenario.", (r, labelOf) => labelOf(r)],
  ["variable", "The outcome being measured.", r => r.variable],
  ["variable_value", c => `The category of the variable (e.g. a group, an income band, or a single year of age).${c.hasContinuous ? " \"Continuous Mean\" marks the average of a numeric variable." : ""}${c.hasMissing ? " \"Missing\" is the share of people with no recorded value (coded −9 in SimPaths)." : ""}`, r => r.variable_value],
  ["stratifier", "What the population is split by (e.g. Age, Gender, Region), or \"Overall\" for everyone.", r => r.stratifier],
  ["stratifier_value", "The group within the stratifier (e.g. 25-34, Female, Wales).", r => r.stratifier_value],
  ["metric_type", c => metricText(c), r => r.metric_type],
  ["n_runs", "Number of model runs the estimate is averaged over.", r => r.n_runs],
  ["mean_sample", "Average number of people behind the estimate in each run (for a share, the people in that category).", r => r.mean_sample],
  ["mean_value", "The estimate: the average across runs. Means are in the variable's own units; proportions are fractions from 0 to 1.", r => r.mean_value],
  ["sd_value", "Standard deviation of the estimate across runs.", r => r.sd_value],
  ["ci_lower", "Lower end of the 95% interval: mean_value − 1.96 × sd_value / √n_runs. It reflects variation between model runs only.", r => r.lower_ci],
  ["ci_upper", "Upper end of the 95% interval: mean_value + 1.96 × sd_value / √n_runs.", r => r.upper_ci],
  ["paired_mean_delta", "Scenario minus Baseline, averaged over runs matched by their seed. Scenario rows only.", r => r.paired_mean_delta],
  ["paired_lower_ci", "Lower end of the 95% interval for that difference.", r => r.paired_lower_ci],
  ["paired_upper_ci", "Upper end of the 95% interval for that difference.", r => r.paired_upper_ci],
];
const LEVEL_HIDDEN = new Set(["mean_sample", "mean_value", "sd_value", "ci_lower", "ci_upper", "paired_mean_delta", "paired_lower_ci", "paired_upper_ci"]);
export const LEVEL_WIDTHS = [7, 22, 34, 22, 16, 22, 12, 8, 12, 14, 14, 14, 14, 18, 16, 16];

/** Columns for the Baseline → Scenario difference chart. */
export const DELTA_COLUMNS = [
  ["year", "Simulated calendar year.", r => r.year],
  ["scenario", "The policy scenario compared with the Baseline.", (r, labelOf) => labelOf(r)],
  ["variable", "The outcome being measured.", r => r.variable],
  ["variable_value", c => `The category of the variable.${c.hasContinuous ? " \"Continuous Mean\" marks the average of a numeric variable." : ""}`, r => r.variable_value],
  ["stratifier", "What the population is split by, or \"Overall\" for everyone.", r => r.stratifier],
  ["stratifier_value", "The group within the stratifier.", r => r.stratifier_value],
  ["metric_type", c => metricText(c), r => r.metric_type],
  ["baseline_mean_sample", "Average number of people behind the Baseline estimate in each run.", r => r.base_mean_sample],
  ["scenario_mean_sample", "Average number of people behind the Scenario estimate in each run.", r => r.scen_mean_sample],
  ["difference", "Scenario minus Baseline, averaged over runs matched by their seed. For proportions this is in fractions from 0 to 1 (multiply by 100 for percentage points).", r => r.mean_value],
  ["ci_lower", "Lower end of the 95% interval for the difference: difference − 1.96 × SD / √(matched runs).", r => r.lower_ci],
  ["ci_upper", "Upper end of the 95% interval for the difference.", r => r.upper_ci],
];
const DELTA_HIDDEN = new Set(["baseline_mean_sample", "scenario_mean_sample", "difference", "ci_lower", "ci_upper"]);
export const DELTA_WIDTHS = [7, 22, 34, 22, 16, 22, 12, 14, 14, 14, 14, 14];

const num = v => (v == null || v === "" ? NaN : Number(v));
const isHiddenLevel = r => {
  const m = num(r.mean_value), min = num(r.min_sample);
  return !isFinite(m) || (min > 0 && min < MIN_SAMPLE_SHOWN);
};

/** A cell value: numbers stay numbers, blanks become null, the rest text. */
function cellValue(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const t = String(v);
  const n = Number(t);
  return t.trim() !== "" && isFinite(n) && /^-?[\d.]+(e-?\d+)?$/i.test(t.trim()) ? n : t;
}

/** Header + rows for the Data sheet, with suppressed estimates blanked. */
export function dataRows(rows, labelOf, { isDelta = false } = {}) {
  const cols = isDelta ? DELTA_COLUMNS : LEVEL_COLUMNS;
  const hiddenCols = isDelta ? DELTA_HIDDEN : LEVEL_HIDDEN;
  const out = [cols.map(c => c[0])];
  for (const r of rows) {
    const hidden = isDelta ? !isFinite(num(r.mean_value)) : isHiddenLevel(r);
    out.push(cols.map(([name, , get]) => (hidden && hiddenCols.has(name) ? null : cellValue(get(r, labelOf)))));
  }
  return out;
}

/** Lower-case lookup in a description table (names differ in case). */
const lookup = (table, name) => {
  const key = Object.keys(table).find(k => k.toLowerCase() === String(name).toLowerCase());
  return key ? table[key] : undefined;
};
const isBenefitUnit = name => !!lookup(BENEFIT_UNIT_NOTES, name) || /benefit unit/i.test(lookup(VARIABLE_DESCRIPTIONS, name) || "");

/** What is in the rows, so the About sheet only describes what is there. */
function contents(rows, isDelta) {
  const c = { variables: [], stratifiers: [], metricTypes: new Set(), hasAverage: false, hasContinuous: false, hasMissing: false,
    hidden: false, baseline: false, fewRuns: false };
  const vars = new Set(), strats = new Set();
  for (const r of rows) {
    if (r.variable && !vars.has(r.variable)) { vars.add(r.variable); c.variables.push(r.variable); }
    if (r.stratifier && r.stratifier !== "Overall" && !strats.has(r.stratifier)) { strats.add(r.stratifier); c.stratifiers.push(r.stratifier); }
    if (r.metric_type) c.metricTypes.add(r.metric_type);
    if (String(r.year) === "Average") c.hasAverage = true;
    if (r.variable_value === "Continuous Mean") c.hasContinuous = true;
    if (r.variable_value === "Missing") c.hasMissing = true;
    const hidden = isDelta ? !isFinite(num(r.mean_value)) : isHiddenLevel(r);
    if (hidden) c.hidden = true;
    if (!isDelta && String(r.scenarioName || r.scenario).toLowerCase() === "baseline") c.baseline = true;
    if (!hidden && (isDelta ? !isFinite(num(r.lower_ci)) : num(r.n_runs) < 2)) c.fewRuns = true;
  }
  return c;
}

/** Rows for the "About" sheet, describing only what is in `rows`. */
export function aboutRows({ title, info = [], notes = [], isDelta = false, rows = [] }) {
  const B = v => ({ v, s: STYLE.bold }), W = v => ({ v, s: STYLE.wrap }), BW = v => ({ v, s: STYLE.boldWrap });
  const c = contents(rows, isDelta);
  const cols = isDelta ? DELTA_COLUMNS : LEVEL_COLUMNS;
  const describe = name => {
    const text = lookup(VARIABLE_DESCRIPTIONS, name) || lookup(STRATIFIER_DESCRIPTIONS, name) || "";
    const note = lookup(BENEFIT_UNIT_NOTES, name);
    return [text, note].filter(Boolean).join(" ");
  };
  const anyBenefitUnit = [...c.variables, ...c.stratifiers].some(isBenefitUnit);

  const blanks = [];
  if (c.hidden) blanks.push(isDelta
    ? ["Suppressed estimates", "The difference is only calculated when both the Baseline and the Scenario estimate have at least 20 people behind them in every model run. Otherwise the sample sizes, the difference and its interval are left blank."]
    : ["Suppressed estimates", "Where fewer than 20 people were behind an estimate in at least one model run (or the group did not appear in a run), mean_sample, mean_value, sd_value, the 95% interval and the paired difference are left blank. This protects small groups and avoids reporting unreliable estimates."]);
  if (c.baseline) blanks.push(["Baseline rows", "The paired_ columns are blank on Baseline rows: the difference is only calculated for scenarios, as Scenario minus Baseline."]);
  if (c.fewRuns) blanks.push(isDelta
    ? ["Too few runs", "The interval needs at least 2 runs matched by seed; with fewer, ci_lower and ci_upper are blank."]
    : ["Too few runs", "Intervals need at least 2 runs. ci_lower and ci_upper are blank with fewer than 2 runs, and the paired_ columns are blank when fewer than 2 scenario runs could be matched to a Baseline run by seed."]);
  if (!blanks.length) blanks.push(["None", "Every estimate in this file is shown."]);

  return [
    [{ v: title, s: STYLE.title }],
    [B("Downloaded"), W(new Date().toISOString().slice(0, 10))],
    ...info.map(([k, v]) => [B(k), W(v)]),
    [],
    [B("About this file")],
    ...notes.map(n => [W(""), W(n)]),
    [W(""), W("The first simulated year is not included: it is the starting population, before the model has run and before any policy starts.")],
    [],
    [B(c.variables.length === 1 ? "Variable" : "Variables")],
    ...c.variables.map(v => [W(v), W(describe(v))]),
    ...(c.stratifiers.length ? [[], [B("Population split by")], ...c.stratifiers.map(v => [W(v), W(describe(v))])] : []),
    ...(anyBenefitUnit ? [[], [W("Benefit unit"), W(`${BENEFIT_UNIT_DEFINITION} Some variables here are measured for the benefit unit, and every person in a benefit unit takes its value, so their results count people, not benefit units.`)]] : []),
    [],
    [B("Columns")],
    [BW("Column"), BW("What it means")],
    ...cols.map(([name, d]) => [W(name), W(typeof d === "function" ? d(c) : d)]),
    [],
    [B("Why some cells are blank")],
    ...blanks.map(([k, d]) => [W(k), W(d)]),
  ];
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Builds and downloads an .xlsx: "About" sheet, then "Data".
 * @param {object[]} rows - estimate rows (or difference rows when isDelta)
 * @param {(row: object) => string} labelOf - display name of a row's scenario
 * @param {{filename: string, title: string, info?: string[][], notes?: string[], isDelta?: boolean}} opts
 */
export async function downloadWorkbook(rows, labelOf, { filename, title, info, notes, isDelta = false }) {
  const data = dataRows(rows, labelOf, { isDelta });
  const blob = await buildXlsx([
    { name: "About", rows: aboutRows({ title, info, notes, isDelta, rows }), widths: [34, 110] },
    { name: "Data", rows: [data[0].map(h => ({ v: h, s: STYLE.bold })), ...data.slice(1)], freezeHeader: true,
      widths: isDelta ? DELTA_WIDTHS : LEVEL_WIDTHS },
  ]);
  saveBlob(blob, filename);
}
