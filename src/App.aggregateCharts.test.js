/** Real D3 chart rendering from connected aggregates, with fictional data only. */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as d3 from "d3";
import App from "./App";
import DashboardSection from "./DashboardSection";

jest.mock("d3", () => ({ ...jest.requireActual("d3"), csv: jest.fn(), text: jest.fn() }));
jest.mock("./localFolderParser", () => ({ parseLocalFolder: jest.fn() }));

function fictionalRows() {
  const rows = [];
  for (const year of [2020, 2021]) for (const scenario of ["baseline", "scenario"]) {
    for (const variable_value of ["High", "Medium"]) {
      const high = (scenario === "baseline" ? 0.4 : 0.55) + (year - 2020) * 0.02;
      const mean_value = variable_value === "High" ? high : 1 - high;
      rows.push({
        year, scenario, module: "Demographics", variable: "Highest Level of Education",
        variable_value, stratifier: "Overall", stratifier_value: "Overall", metric_type: "share",
        n_runs: 3, total_sample: 300, min_sample: 100, mean_sample: 100,
        mean_value, sd_value: 0.01, lower_ci: mean_value - 0.02, upper_ci: mean_value + 0.02,
      });
    }
  }
  return rows;
}
const source = (rows, key = "fictional-1") => ({
  rows, key, label: "Online results", names: { baseline: "High Savings", scenario: "Low Savings" },
});
function linePaths(container) {
  return Array.from(container.querySelectorAll('svg path[fill="none"][stroke]'))
    .map(path => path.getAttribute("d")).filter(Boolean).sort();
}
const previousObserver = global.ResizeObserver;
const previousBBox = SVGElement.prototype.getBBox;

beforeAll(() => {
  global.ResizeObserver = class {
    constructor(notify) { this.notify = notify; }
    observe() { this.notify([{ contentRect: { width: 960, height: 600 } }]); }
    disconnect() {}
  };
  SVGElement.prototype.getBBox = function () {
    return { x: 0, y: 0, width: (this.textContent || "").length * 7, height: 14 };
  };
});
afterAll(() => {
  global.ResizeObserver = previousObserver;
  if (previousBBox) SVGElement.prototype.getBBox = previousBBox;
  else delete SVGElement.prototype.getBBox;
});

test("connected rows produce the same plotted values as direct use of the maintained charts", async () => {
  const rows = fictionalRows();
  const { container: connectedContainer } = render(<App dataSource={source(rows)} />);
  await waitFor(() => expect(linePaths(connectedContainer)).toHaveLength(4));
  const { container: directContainer } = render(<DashboardSection parsedCache={rows} targetVariable="Highest Level of Education" />);
  await waitFor(() => expect(linePaths(directContainer)).toHaveLength(4));
  expect(linePaths(connectedContainer)).toEqual(linePaths(directContainer));
  expect(within(connectedContainer).getByRole("region", { name: "Displayed data source" })).toHaveTextContent("Baseline — High Savings");
  expect(d3.csv).not.toHaveBeenCalled();
  expect(d3.text).not.toHaveBeenCalled();
});

test("clearing connected rows removes real charts immediately instead of retaining the previous comparison", async () => {
  const { container, rerender } = render(<App dataSource={source(fictionalRows())} />);
  await waitFor(() => expect(linePaths(container)).toHaveLength(4));
  rerender(<App dataSource={{ ...source([]), message: "Sign in to view these results." }} />);
  // Upstream D3 SVGs have no accessible role; verify physical removal.
  // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
  expect(container.querySelector("svg")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Sign in to view these results.");
  expect(d3.csv).not.toHaveBeenCalled();
  expect(d3.text).not.toHaveBeenCalled();
});

test("a new comparison identity resets real chart filters while preserving canonical roles", async () => {
  const rows = fictionalRows();
  const { container, rerender } = render(<App dataSource={source(rows)} />);
  await waitFor(() => expect(linePaths(container)).toHaveLength(4));
  fireEvent.click(screen.getByRole("button", { name: "Scenario — Low Savings", exact: true }));
  await waitFor(() => expect(linePaths(container)).toHaveLength(2));
  rerender(<App dataSource={source(rows.map(row => ({ ...row, year: row.year + 2 })), "fictional-2")} />);
  await waitFor(() => expect(linePaths(container)).toHaveLength(4));
  expect(rows[0].scenario).toBe("baseline");
});

test("JSON-null estimates are not plotted as zero-valued observations", async () => {
  const rows = fictionalRows().map(row => ({ ...row, mean_value: null, lower_ci: null, upper_ci: null }));
  const { container } = render(<App dataSource={source(rows)} />);
  expect(await screen.findByRole("button", { name: "Scenario — Low Savings", exact: true })).toBeInTheDocument();
  expect(linePaths(container)).toHaveLength(0);
  expect(rows[0].mean_value).toBeNull();
});

test("the host can remove an active difference view and return to the unchanged level charts", async () => {
  const rows = fictionalRows();
  const { container, rerender } = render(<App dataSource={source(rows)} />);
  fireEvent.click(screen.getByRole("button", { name: "Δ Baseline → Scenario" }));
  expect(screen.getByText(/Scenario minus Baseline\. Positive = scenario is higher\./)).toBeInTheDocument();
  rerender(<App dataSource={{ ...source(rows), showDelta: false }} />);
  expect(screen.queryByRole("button", { name: "Δ Baseline → Scenario" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Scenario minus Baseline\. Positive = scenario is higher\./)).not.toBeInTheDocument();
  await waitFor(() => expect(linePaths(container)).toHaveLength(4));
});
