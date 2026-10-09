/** Aggregate-source format, missing-value and configuration-label regressions. */
import { normaliseAggregateRows, comparisonLabel, sourceText } from "./aggregateDataSource";

const row = (changes = {}) => ({
  year: 2020, scenario: "baseline", module: "Health",
  variable: "Mental Component Summary (MCS)", variable_value: "Mean",
  stratifier: "Overall", stratifier_value: "Overall", metric_type: "mean",
  n_runs: 3, total_sample: 300, min_sample: 100, mean_sample: 100,
  mean_value: 40, sd_value: 2, lower_ci: 38, upper_ci: 42,
  ...changes,
});

test("copies chart-ready means and shares without modifying the source or recalculating values", () => {
  const input = [Object.freeze(row()), Object.freeze(row({ scenario: "scenario", metric_type: "share", mean_value: 0.5 }))];
  Object.freeze(input);
  const result = normaliseAggregateRows(input);
  expect(result).toEqual(input);
  expect(result).not.toBe(input);
  expect(result[0]).not.toBe(input[0]);
});

test("JSON nulls and native NaNs remain unavailable, while genuine zeroes stay zero", () => {
  const result = normaliseAggregateRows([row({ mean_value: null, lower_ci: null, upper_ci: NaN, sd_value: 0 })])[0];
  expect(result.mean_value).toBeNaN();
  expect(result.lower_ci).toBeNaN();
  expect(result.upper_ci).toBeNaN();
  expect(result.sd_value).toBe(0);
});

test("missing optional diagnostics remain unavailable rather than invented", () => {
  const input = row();
  delete input.mean_sample;
  delete input.sd_value;
  const result = normaliseAggregateRows([input])[0];
  expect(result.mean_sample).toBeNaN();
  expect(result.sd_value).toBeNaN();
});

test("accepts an empty loading/unavailable result without substituting another dataset", () => {
  expect(normaliseAggregateRows([])).toEqual([]);
});

test.each([null, {}, "csv,text", [null], [row({ person_id: 123 })], [row({ input_path: "/private/input" })]])(
  "rejects a malformed collection or non-aggregate fields: %p", input => {
    expect(() => normaliseAggregateRows(input)).toThrow(TypeError);
  }
);

test.each([
  { year: "2020" }, { year: NaN }, { year: Infinity },
  { mean_value: "40" }, { lower_ci: Infinity }, { n_runs: true },
  { scenario: "invalid\nscenario" }, { metric_type: "person" },
  { variable: { name: "Health" } },
])("rejects unsupported row types or roles: %p", changes => {
  expect(() => normaliseAggregateRows([row(changes)])).toThrow(TypeError);
});

test("configuration names decorate display roles without renaming aggregate scenario IDs", () => {
  const names = { baseline: "High Savings", scenario: "Low Savings" };
  expect(comparisonLabel("baseline", names)).toBe("Baseline — High Savings");
  expect(comparisonLabel("scenario", names)).toBe("Scenario — Low Savings");
  expect(normaliseAggregateRows([row()])[0].scenario).toBe("baseline");
});

test("missing, blank or non-text names use the original Baseline/Scenario labels", () => {
  expect(comparisonLabel("baseline")).toBe("Baseline");
  expect(comparisonLabel("scenario", { scenario: "  " })).toBe("Scenario");
  expect(comparisonLabel("baseline", { baseline: {} })).toBe("Baseline");
  expect(sourceText({ text: "not a string" }, "Connected results")).toBe("Connected results");
});
