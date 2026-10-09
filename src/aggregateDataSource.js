/**
 * Chart-ready aggregate rows and display labels for an optional connected source.
 * This validates presentation data; access control and disclosure checks belong
 * to the service supplying it, before anything is sent to the browser.
 */
import { createContext, useContext, useCallback } from "react";
import { scenarioLabel } from "./useAggregatedData";

export const ComparisonNamesContext = createContext({});

/** Labels are scoped to one Visualiser instance, never global mutable state. */
export function useComparisonLabel() {
  const names = useContext(ComparisonNamesContext);
  return useCallback(role => {
    const label = role === "baseline" ? "Baseline" : scenarioLabel(role);
    const name = sourceText(names?.[role]);
    return name ? `${label} — ${name}` : label;
  }, [names]);
}

const TEXT_FIELDS = [
  "scenario", "module", "variable", "variable_value", "stratifier",
  "stratifier_value", "metric_type",
];
const NUMBER_FIELDS = [
  "n_runs", "total_sample", "min_sample", "mean_sample", "mean_value",
  "sd_value", "lower_ci", "upper_ci",
  "paired_mean_delta", "paired_lower_ci", "paired_upper_ci", "paired_n_runs",
];
const FIELDS = new Set(["year", ...TEXT_FIELDS, ...NUMBER_FIELDS]);

/** Copy the aggregate row shape without recalculating or changing suppression. */
export function normaliseAggregateRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Expected an array of aggregate rows.");
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).some(key => !FIELDS.has(key))) {
      throw new TypeError("Expected chart-ready aggregate rows only.");
    }
    if (!Number.isFinite(row.year)) throw new TypeError("Expected a numeric simulation year.");
    const result = { year: row.year };
    for (const field of TEXT_FIELDS) {
      if (typeof row[field] !== "string") throw new TypeError("Expected aggregate row labels.");
      result[field] = row[field];
    }
    if (!result.scenario || /[\u0000-\u001f]/.test(result.scenario) ||
        !['mean', 'share', 'wage_bin', 'income_bin'].includes(result.metric_type)) {
      throw new TypeError("Expected Baseline/Scenario aggregate metrics.");
    }
    for (const field of NUMBER_FIELDS) {
      if (field.startsWith("paired_") && !Object.prototype.hasOwnProperty.call(row, field)) continue;
      const value = row[field];
      // JSON cannot represent NaN. Null/missing metrics retain the existing
      // chart convention for unavailable or suppressed values, rather than 0.
      if (value == null) result[field] = NaN;
      else if (typeof value === "number" && (Number.isFinite(value) || Number.isNaN(value))) {
        result[field] = value;
      } else throw new TypeError("Expected numeric aggregate metrics.");
    }
    return result;
  });
}

/** Metadata is plain display text, never markup or a replacement scenario ID. */
export function sourceText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function comparisonLabel(role, names) {
  const label = role === "baseline" ? "Baseline" : scenarioLabel(role);
  const name = sourceText(names?.[role]);
  return name ? `${label} — ${name}` : label;
}
