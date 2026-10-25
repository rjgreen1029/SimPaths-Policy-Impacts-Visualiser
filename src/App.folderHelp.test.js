/* (C) Copyright 2026, by Ross Richardson
 * Verify folder guidance is available in the shared introduction and cancel keeps data.
 * @author ross richardson
 */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as d3 from "d3";
import App from "./App";

jest.mock("d3", () => ({ ...jest.requireActual("d3"), text: jest.fn() }));
jest.mock("./DashboardSection", () => () => <div data-testid="charts" />);

beforeEach(() => d3.text.mockImplementation(() => new Promise(() => {})));
afterEach(() => { delete window.showDirectoryPicker; jest.restoreAllMocks(); });

test("folder help sits after the layout explanation in Getting Started, before selection instructions", () => {
  render(<App />);
  const gettingStarted = screen.getByRole("heading", { name: "Getting Started" }).parentElement;
  const help = within(gettingStarted).getByRole("button", { name: "View folder structure" });
  expect(help.closest("p").textContent).toMatch(/runs from your model output\. View folder structure Use/);
  expect(help.closest("p").textContent).toMatch(/View folder structure Use "Visualise/);
  expect(screen.getAllByRole("button", { name: "View folder structure" })).toHaveLength(1);
  const connect = screen.getByRole("heading", { name: "Connect Data" }).parentElement.parentElement;
  expect(within(connect).queryByRole("button", { name: "View folder structure" })).toBeNull();
  fireEvent.focus(help);
  expect(within(gettingStarted).getByRole("tooltip")).toHaveTextContent("Baseline/");
});

test("cancelling folder selection retains the current page and its source controls", async () => {
  window.showDirectoryPicker = jest.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
  jest.spyOn(console, "error").mockImplementation(() => {});
  render(<App />);
  const select = screen.getByRole("button", { name: /^Visualise (Your Own|Locally Saved) Data$/ });
  fireEvent.click(select);
  await waitFor(() => expect(window.showDirectoryPicker).toHaveBeenCalledTimes(1));
  expect(select).toBeEnabled();
  expect(screen.getByRole("button", { name: "View folder structure" })).toBeInTheDocument();
  expect(screen.queryByText(/selection cancelled|Aggregation Error/i)).toBeNull();
});
