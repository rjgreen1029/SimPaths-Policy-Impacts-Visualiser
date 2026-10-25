/* Verify that chart tooltip labels stay literal text and cannot create active HTML.
 */
import { setTooltipContent } from "./tooltipContent.js";

test("preserves the bold title and separate value, sample and year lines", () => {
  const target = document.createElement("div");
  setTooltipContent(target, { title:"MCS", lines:["Baseline: 45.00", "", null, "Sample: 20", "Year: 2020"] });
  expect(target.querySelector("strong").textContent).toBe("MCS");
  expect(target.querySelectorAll("br")).toHaveLength(3);
  expect(target.textContent).toBe("MCSBaseline: 45.00Sample: 20Year: 2020");
});

test("HTML and event handlers in labels are displayed literally", () => {
  const target = document.createElement("div");
  const title = '<img src="https://example.invalid/track" onerror="alert(1)">';
  const line = '</strong><svg onload="alert(2)"><script>alert(3)</script>';
  setTooltipContent(target, { title, lines:[line] });
  expect(target.querySelector("strong").textContent).toBe(title);
  expect(target.textContent).toBe(title + line);
  expect(target.querySelector("img,svg,script,a")).toBeNull();
  expect(target.querySelectorAll("*")).toHaveLength(2);
  expect(target.querySelector("strong").attributes).toHaveLength(0);
});

test("angle brackets, quotes and ampersands are not interpreted as markup", () => {
  const target = document.createElement("div");
  setTooltipContent(target, { title:'Income < £25 & "other"', lines:["Literal &lt;br&gt;", 0] });
  expect(target.querySelector("strong").textContent).toBe('Income < £25 & "other"');
  expect(target.textContent).toContain("Literal &lt;br&gt;0");
});

test("a new tooltip completely replaces the previous content", () => {
  const target = document.createElement("div");
  setTooltipContent(target, { title:"Previous", lines:["Old sample", "Old year"] });
  setTooltipContent(target, { title:"Current", lines:["New value"] });
  expect(target.textContent).toBe("CurrentNew value");
  expect(target.querySelectorAll("strong")).toHaveLength(1);
  expect(target.querySelectorAll("br")).toHaveLength(1);
});
