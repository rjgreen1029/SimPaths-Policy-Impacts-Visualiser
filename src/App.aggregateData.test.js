/** Data handoff, source switching and standalone-workflow regressions for App. */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as d3 from "d3";
import App from "./App";
import DashboardSection from "./DashboardSection";
import { parseLocalFolder } from "./localFolderParser";

jest.mock("d3", () => ({ ...jest.requireActual("d3"), csv: jest.fn(), text: jest.fn() }));
jest.mock("./localFolderParser", () => ({ parseLocalFolder: jest.fn() }));
jest.mock("./DashboardSection", () => jest.fn());

const row = (changes = {}) => ({
  year: 2020, scenario: "baseline", module: "Demographics",
  variable: "Highest Level of Education", variable_value: "High",
  stratifier: "Overall", stratifier_value: "Overall", metric_type: "share",
  n_runs: 3, total_sample: 300, min_sample: 100, mean_sample: 100,
  mean_value: 0.4, sd_value: 0.01, lower_ci: 0.38, upper_ci: 0.42,
  ...changes,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const connected = (changes = {}) => ({
  key: "fictional-comparison-1", label: "Online results", rows: [row()],
  names: { baseline: "High Savings", scenario: "Low Savings" }, ...changes,
});
let defaultReply;
const savedFetch = global.fetch;

beforeEach(() => {
  defaultReply = deferred();
  // Exercise both loader forms: upstream d3.csv and PR 1's d3.text + row parser.
  const realD3 = jest.requireActual("d3");
  d3.csv.mockReset().mockImplementation((url, convert) => defaultReply.promise.then(text => realD3.csvParse(text, convert)));
  d3.text.mockReset().mockImplementation(() => defaultReply.promise);
  parseLocalFolder.mockReset();
  DashboardSection.mockClear();
  DashboardSection.mockImplementation(function MockDashboard({ parsedCache }) {
    const [initialYear] = React.useState(parsedCache[0]?.year);
    return <div data-testid="charts" data-initial-year={initialYear}>{JSON.stringify(parsedCache)}</div>;
  });
  window.showDirectoryPicker = jest.fn();
  global.fetch = jest.fn();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete window.showDirectoryPicker;
  global.fetch = savedFetch;
  jest.restoreAllMocks();
});

async function defaultReady(rows = [row()]) {
  await act(async () => { defaultReply.resolve(d3.csvFormat(rows)); });
}
function expectNoSourceRequests() {
  expect(d3.csv).not.toHaveBeenCalled();
  expect(d3.text).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(window.showDirectoryPicker).not.toHaveBeenCalled();
  expect(parseLocalFolder).not.toHaveBeenCalled();
}
function chartRows() {
  return DashboardSection.mock.calls[DashboardSection.mock.calls.length - 1][0].parsedCache;
}

test("supplied aggregates use existing charts, names, guidance and host navigation without fetching data", () => {
  render(<App dataSource={connected({ navigation: <a href="/">Return to SimPaths Online</a>, notice: "Fictional preview" })} />);
  expect(screen.getByTestId("charts")).toBeInTheDocument();
  expect(chartRows()[0].mean_value).toBe(0.4);
  expect(chartRows()[0].scenario).toBe("baseline");
  const panel = screen.getByRole("region", { name: "Displayed data source" });
  expect(within(panel).getByText("Baseline — High Savings")).toBeInTheDocument();
  expect(within(panel).getByText("Scenario — Low Savings")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Return to SimPaths Online" })).toHaveAttribute("href", "/");
  expect(screen.getByText("Fictional preview")).toBeInTheDocument();
  expect(screen.getByText("Credit & Citation")).toBeInTheDocument();
  expectNoSourceRequests();
});

test("loading and errors remain connected instead of showing bundled data or stale charts", () => {
  const { rerender } = render(<App dataSource={connected()} />);
  rerender(<App dataSource={connected({ rows: [], message: "Loading online results…" })} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading online results…");
  expect(screen.queryByTestId("charts")).not.toBeInTheDocument();
  rerender(<App dataSource={connected({ rows: [], message: "Please sign in again." })} />);
  expect(screen.getByRole("status")).toHaveTextContent("Please sign in again.");
  expect(screen.queryByText("Currently displaying: preloaded data")).not.toBeInTheDocument();
  expectNoSourceRequests();
});

test("an empty source object reserves connected mode even before rows arrive", () => {
  render(<App dataSource={{}} />);
  expect(screen.getByRole("status")).toHaveTextContent("No aggregate results are available.");
  expect(screen.queryByTestId("charts")).not.toBeInTheDocument();
  expectNoSourceRequests();
});

test("invalid aggregate data gives a local format error and no charts or default-data fallback", () => {
  const { rerender } = render(<App dataSource={connected()} />);
  rerender(<App dataSource={connected({ rows: [row({ person_id: 123 })] })} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Connected aggregate data could not be displayed.");
  expect(screen.queryByTestId("charts")).not.toBeInTheDocument();
  expectNoSourceRequests();
});

test.each([true, [], "invalid source", { rows: null }])("invalid connected sources stay unavailable without a fallback: %p", dataSource => {
  render(<App dataSource={dataSource} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Connected aggregate data could not be displayed.");
  expect(screen.queryByTestId("charts")).not.toBeInTheDocument();
  expectNoSourceRequests();
});

test("JSON suppression stays unavailable in the chart props rather than becoming zero", () => {
  render(<App dataSource={connected({ rows: [row({ mean_value: null, lower_ci: null, upper_ci: null })] })} />);
  expect(chartRows()[0].mean_value).toBeNaN();
  expect(chartRows()[0].lower_ci).toBeNaN();
});

test("host controls switch connected comparisons and their keys reset chart state", () => {
  function Host() {
    const [other, setOther] = React.useState(false);
    return <App dataSource={connected({
      key: other ? "fictional-comparison-2" : "fictional-comparison-1",
      rows: [row({ year: other ? 2021 : 2020 })],
      names: { baseline: other ? "Another Baseline" : "High Savings", scenario: "Low Savings" },
      controls: <button onClick={() => setOther(true)}>Another comparison</button>,
    })} />;
  }
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "Another comparison" }));
  expect(screen.getByTestId("charts")).toHaveAttribute("data-initial-year", "2021");
  expect(chartRows()[0].year).toBe(2021);
  expect(screen.getByRole("region", { name: "Displayed data source" })).toHaveTextContent("Baseline — Another Baseline");
  expectNoSourceRequests();
});

test("untrusted configuration names and messages display as text, with no HTML elements", () => {
  const name = '<img src="fictional" onerror="alert(1)">';
  const { container } = render(<App dataSource={connected({ names: { baseline: name }, message: "<script>fictional</script>" })} />);
  expect(screen.getByRole("region", { name: "Displayed data source" })).toHaveTextContent(`Baseline — ${name}`);
  expect(screen.getByRole("status")).toHaveTextContent("<script>fictional</script>");
  // Injected nodes need not be accessible, so inspect the actual DOM here.
  // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
  expect(container.querySelector('img[src="fictional"], script')).toBeNull();
});

test("omitting configuration names keeps the ordinary role labels", () => {
  render(<App dataSource={connected({ names: undefined })} />);
  const panel = screen.getByRole("region", { name: "Displayed data source" });
  expect(within(panel).getByText("Baseline")).toBeInTheDocument();
  expect(within(panel).getByText("Scenario")).toBeInTheDocument();
});

test("the host can hide the difference view without changing the supplied metrics", () => {
  render(<App dataSource={connected({ showDelta: false })} />);
  const props = DashboardSection.mock.calls[DashboardSection.mock.calls.length - 1][0];
  expect(props.showDelta).toBe(false);
  expect(props.parsedCache[0].mean_value).toBe(0.4);
});

test("without a source prop the default dataset still loads and local selection still works", async () => {
  render(<App />);
  await defaultReady();
  expect(d3.csv.mock.calls.length + d3.text.mock.calls.length).toBe(1);
  expect(chartRows()[0].mean_value).toBe(0.4);
  const directory = { name: "Fictional local output" };
  window.showDirectoryPicker.mockResolvedValue(directory);
  parseLocalFolder.mockResolvedValue([row({ mean_value: 0.7 })]);
  fireEvent.click(screen.getByRole("button", { name: "Visualise Locally Saved Data" }));
  await screen.findByText("Currently displaying: user uploaded data");
  expect(parseLocalFolder).toHaveBeenCalledWith(directory, expect.any(Function));
  expect(chartRows()[0].mean_value).toBe(0.7);
  expect(screen.getByText("Currently displaying: user uploaded data")).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("local selection cancelling before the initial CSV finishes does not lose that dataset", async () => {
  render(<App />);
  window.showDirectoryPicker.mockRejectedValue({ name: "AbortError" });
  fireEvent.click(screen.getByRole("button", { name: "Visualise Locally Saved Data" }));
  await defaultReady();
  expect(chartRows()[0].mean_value).toBe(0.4);
  expect(parseLocalFolder).not.toHaveBeenCalled();
});

test("resetting from local results loads the default and ignores an older unfinished local parse", async () => {
  render(<App />);
  await defaultReady();
  window.showDirectoryPicker.mockResolvedValue({});
  parseLocalFolder.mockResolvedValueOnce([row({ mean_value: 0.7 })]);
  fireEvent.click(screen.getByRole("button", { name: "Visualise Locally Saved Data" }));
  await screen.findByText("Currently displaying: user uploaded data");
  const pending = deferred();
  parseLocalFolder.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Visualise Locally Saved Data" }));
  await screen.findByRole("button", { name: "Aggregating data..." });
  defaultReply = deferred();
  fireEvent.click(screen.getByText("✕"));
  await defaultReady([row({ mean_value: 0.3 })]);
  await act(async () => { pending.resolve([row({ mean_value: 0.9 })]); });
  expect(chartRows()[0].mean_value).toBe(0.3);
  expect(screen.getByText("Currently displaying: preloaded data")).toBeInTheDocument();
});

test("a late standalone request cannot overwrite a newly connected source", async () => {
  const { rerender } = render(<App />);
  rerender(<App dataSource={connected({ rows: [row({ mean_value: 0.8 })] })} />);
  await defaultReady([row({ mean_value: 0.1 })]);
  expect(chartRows()[0].mean_value).toBe(0.8);
  expect(screen.getByRole("region", { name: "Displayed data source" })).toHaveTextContent("Online results");
});

test("local progress and failure after a source change cannot replace connected data", async () => {
  const { rerender } = render(<App />);
  await defaultReady();
  const pending = deferred();
  let progress;
  window.showDirectoryPicker.mockResolvedValue({});
  parseLocalFolder.mockImplementation((directory, notify) => { progress = notify; return pending.promise; });
  fireEvent.click(screen.getByRole("button", { name: "Visualise Locally Saved Data" }));
  await waitFor(() => expect(parseLocalFolder).toHaveBeenCalled());
  rerender(<App dataSource={connected({ rows: [row({ mean_value: 0.8 })] })} />);
  await act(async () => { progress("Old local progress"); pending.reject(new Error("Old local failure")); });
  expect(chartRows()[0].mean_value).toBe(0.8);
  expect(screen.queryByText("Old local progress")).not.toBeInTheDocument();
  expect(screen.queryByText(/Old local failure/)).not.toBeInTheDocument();
});

test("removing the optional connected prop explicitly returns to the default workflow", async () => {
  const { rerender } = render(<App dataSource={connected({ key: "standalone", rows: [row({ year: 2021 })] })} />);
  expect(screen.getByTestId("charts")).toHaveAttribute("data-initial-year", "2021");
  expectNoSourceRequests();
  rerender(<App />);
  await defaultReady();
  expect(screen.getByText("Currently displaying: preloaded data")).toBeInTheDocument();
  expect(screen.getByTestId("charts")).not.toHaveAttribute("data-initial-year", "2021");
  expect(screen.queryByRole("region", { name: "Displayed data source" })).not.toBeInTheDocument();
});
