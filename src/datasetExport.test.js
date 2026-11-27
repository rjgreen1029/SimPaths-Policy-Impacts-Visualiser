/** The .xlsx downloads: columns, blanking of small samples, and the About sheet. */
import { dataRows, aboutRows, LEVEL_COLUMNS, DELTA_COLUMNS, downloadWorkbook } from "./datasetExport";
import { buildXlsx } from "./xlsxWriter";
import { TextEncoder } from "util";

// Browsers have TextEncoder; the Jest (jsdom) environment does not.
if (typeof global.TextEncoder === "undefined") global.TextEncoder = TextEncoder;

const base = {
  year: 2030, scenario: "baseline", module: "Health", variable: "Disability Status",
  variable_value: "Has disability", stratifier: "Region", stratifier_value: "Wales", metric_type: "share",
  n_runs: 5, total_sample: 500, min_sample: 90, mean_sample: 100, mean_value: 0.2, sd_value: 0.01,
  lower_ci: 0.19, upper_ci: 0.21, paired_mean_delta: NaN, paired_lower_ci: NaN, paired_upper_ci: NaN, paired_n_runs: 0,
};
const label = r => ({ baseline: "Baseline", s1: "Increased Education" }[r.scenario]);
const asObjects = t => t.slice(1).map(r => Object.fromEntries(t[0].map((h, i) => [h, r[i]])));

test("drops module, total_sample, min_sample and paired_n_runs", () => {
  const header = dataRows([base], label)[0];
  for (const gone of ["module", "total_sample", "min_sample", "paired_n_runs"]) expect(header).not.toContain(gone);
  expect(header).toEqual(LEVEL_COLUMNS.map(c => c[0]));
});

test("shows scenarios by name and keeps numbers as numbers", () => {
  const [row] = asObjects(dataRows([base, { ...base, scenario: "s1", paired_mean_delta: 0.01 }], label));
  expect(row.scenario).toBe("Baseline");
  expect(row.mean_value).toBe(0.2);
  expect(row.ci_lower).toBe(0.19);
  expect(row.paired_mean_delta).toBeNull();
});

test("blanks estimates with fewer than 20 people in a run, but keeps the row", () => {
  const rows = asObjects(dataRows([{ ...base, min_sample: 12 }, { ...base, mean_value: NaN }], label));
  for (const r of rows) {
    expect(r.variable_value).toBe("Has disability");
    for (const c of ["mean_sample", "mean_value", "sd_value", "ci_lower", "ci_upper", "paired_mean_delta"]) expect(r[c]).toBeNull();
  }
});

test("difference downloads have their own columns and blank suppressed differences", () => {
  const delta = { ...base, scenario: "s1", scenarioName: "s1", mean_value: 0.01, lower_ci: 0, upper_ci: 0.02, base_mean_sample: 100, scen_mean_sample: 98 };
  const t = dataRows([delta, { ...delta, mean_value: NaN }], r => label({ scenario: r.scenarioName }), { isDelta: true });
  expect(t[0]).toEqual(DELTA_COLUMNS.map(c => c[0]));
  const [shown, hidden] = asObjects(t);
  expect(shown).toMatchObject({ scenario: "Increased Education", difference: 0.01, baseline_mean_sample: 100 });
  expect(hidden.difference).toBeNull();
  expect(hidden.baseline_mean_sample).toBeNull();
});

const aboutText = opts => aboutRows({ title: "T", ...opts }).flat().map(c => (c && typeof c === "object" ? c.v : c)).join("\n");

test("About sheet explains every column and the variables in the file, and nothing else", () => {
  const text = aboutText({ rows: [base, { ...base, min_sample: 12 }] });
  for (const [name] of LEVEL_COLUMNS) expect(text).toContain(name);
  expect(text).toMatch(/limiting long-term illness or disability/);   // Disability Status
  expect(text).toMatch(/UK nation, or region of England/);            // split by Region
  expect(text).not.toMatch(/Mental Component Summary/);
  expect(text).not.toMatch(/pyramid_bin|income_bin/);
  expect(text).not.toMatch(/Benefit unit/);
  expect(text).toMatch(/fewer than 20 people/);
  expect(text).toMatch(/first simulated year is not included/);
});

test("About sheet adds the benefit-unit note only for benefit-unit variables, and only the blank reasons that apply", () => {
  const quintile = { ...base, variable: "Income Quintile", variable_value: "1", stratifier: "Overall", stratifier_value: "Overall", scenario: "s1" };
  const text = aboutText({ rows: [quintile] });
  expect(text).toMatch(/not 20% each/);
  expect(text).toMatch(/Benefit unit/);
  expect(text).not.toMatch(/Population split by/);
  expect(text).not.toMatch(/fewer than 20 people|Baseline rows/);
  expect(text).toMatch(/Every estimate in this file is shown/);
});

test("builds an .xlsx and downloads it under the given name", async () => {
  const sheets = [];
  const real = await buildXlsx([{ name: "About", rows: [["x"]] }, { name: "Data", rows: [["a", 1]] }]);
  expect(real.type).toMatch(/spreadsheetml/);
  expect(real.size).toBeGreaterThan(500);
  global.URL.createObjectURL = jest.fn(() => "blob:x"); global.URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { sheets.push(this.download); });
  await downloadWorkbook([base], label, { filename: "f.xlsx", title: "T" });
  expect(sheets).toEqual(["f.xlsx"]);
});
