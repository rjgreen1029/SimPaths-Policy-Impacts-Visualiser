/* (C) Copyright 2026, by Ross Richardson
 * Check shared folder-help accessibility, dismissal and viewport positioning.
 * @author ross richardson
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import FolderStructureHelp from "./FolderStructureHelp";

afterEach(() => jest.restoreAllMocks());

test("pointer, keyboard and touch use the same help without navigating", () => {
  render(<><FolderStructureHelp /><button>Other control</button></>);
  const button = screen.getByRole("button", { name: "View folder structure" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.mouseEnter(button.parentElement);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Your Data Folder/");
  expect(button).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
  fireEvent.mouseLeave(button.parentElement);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(button);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Other control" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(button);
  fireEvent.blur(button, { relatedTarget: screen.getByRole("button", { name: "Other control" }) });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("tooltip follows its link and stays within either viewport edge after resize", () => {
  let left = 8;
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return this.classList.contains("folder-structure-help")
      ? { left, width: 120 } : { width: 260 };
  });
  try {
    render(<FolderStructureHelp />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").style.left).toBe("8px");
    left = 190;
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("tooltip").style.left).toBe("-146px");
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }
});

test("multiple helpers have independent accessible tooltip identities", () => {
  render(<><FolderStructureHelp /><FolderStructureHelp /></>);
  for (const button of screen.getAllByRole("button")) fireEvent.focus(button);
  const tips = screen.getAllByRole("tooltip");
  expect(new Set(tips.map(tip => tip.id)).size).toBe(2);
});
