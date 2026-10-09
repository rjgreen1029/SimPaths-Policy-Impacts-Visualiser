/**
 * DashboardSection.js — All chart rendering (D3, raw SVG) and the dashboard's
 * data-view controls (chart type, stratify-by, view/layout, highlighting,
 * filters, export). Everything the person sees below the intro card in
 * App.js comes from this file.
 *
 * Rough map of what's in here, top to bottom:
 *   - Layout / colour / font constants shared by every chart
 *   - Small stateless helpers (label formatting, y-domain calc, hatch
 *     patterns for Scenario bars, the shared floating tooltip singleton,
 *     CSV/PNG export)
 *   - Chart components: LineChart, StackedBarChart, GroupedBarChart,
 *     DeltaChart — each owns its own D3 rendering via a ref + useEffect
 *   - Layout wrappers: PanelChart/SmallMultiplesPanel (small-multiples grid),
 *     CrossSectionPanel, DeltaSection
 *   - DashboardSection (default export) — the top-level orchestrator. Owns
 *     all UI state (which chart type/tab/stratifier/filters are active) and
 *     decides which chart component(s) to render based on that state.
 *
 * Data flow: DashboardSection receives `parsedCache` (the full dataset) and
 * `targetVariable` (current selection) as props from App.js, filters them
 * via useAggregatedData() (see useAggregatedData.js) into baseline/scenario
 * rows for just that variable, and passes those down to whichever chart
 * component is currently relevant.
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import * as d3 from "d3";
import { setTooltipContent } from "./tooltipContent.js";
import {
  useAggregatedData, useScenarioNames, scenarioLabel,
  uniqueValues, stratLabel, averageAcrossYears,
  buildColourMap, orderVariableValues, orderStratifierValues, GREY,
  getStratifierDef, getVariableDef,
} from "./useAggregatedData";
import { WAGE_BINS } from "./parseCore";

// ─── Layout ───────────────────────────────────────────────────────────────────
// Both bumped up a bit from their original 380/200 — with few strata (e.g. a
// 2-value stratifier like Disability Status), panels/charts end up quite
// wide relative to their height, which read as visually "squished" on the
// y-axis. A modest height increase gives more vertical room across the
// board without making the common (many-strata, narrower panel) case
// unnecessarily tall.
const CHART_H    = 410;  // full-size chart height (Overall view, stratified-combined)
const CHART_H_SM = 230;  // small-multiple panel height
const MAX_W      = 480;  // wide enough to use most of the container
const PANEL_MIN_W= 280;
const M     = { top:24, right:24, bottom:70, left:92 }; // extra bottom for key; left is generous since the y-axis title's own space now grows with the actual tick-label width (see applyYAxis)
const M_SM  = { top:12, right:10, bottom:46, left:72 };

// ─── Colours / fonts ──────────────────────────────────────────────────────────
const TEAL    = "#14687c";
const BG_CARD = "#fbf8f2"; // slightly lighter than before
const TEXT_D  = "#1e293b";
const TEXT_M  = "#475569";
const TEXT_S  = "#64748b";
const PUB_FONT= "'Work Sans', Arial, sans-serif";
const FONT_SZ = "12.5px"; // single source of truth for all chart text
// Distinct stroke-dasharray patterns for Scenario 1, 2, 3, 4 …
// Baseline is always solid (no entry needed). Patterns chosen to be
// distinguishable at small sizes and in greyscale.
// Scenario 1 = dotted (2,2), Scenario 2 = dashed (6,4), further scenarios use longer patterns
const SCENARIO_DASHES = ["2,2", "6,4", "8,3,2,3", "4,2,1,2"];

// Colours used for numeric variables (single line per scenario).
// Baseline = dashboard teal; scenarios = coral/orange shades.
const NUMERIC_BASE_COLOUR   = "#586369";
const NUMERIC_SCEN_COLOURS  = ["#0f93a1", "#0f93a1", "#0f93a1", "#0f93a1"];

// Dot symbols for categorical stratifiers (d3 symbol path generators).
// 12 distinct shapes — Region has 12 values, and with only 6 shapes (the
// previous array) symIdx=si%SYMBOLS.length wrapped around twice, so half
// the regions silently duplicated another region's shape.
const SYMBOLS = [
  d3.symbolCircle, d3.symbolSquare, d3.symbolDiamond, d3.symbolTriangle,
  d3.symbolCross, d3.symbolStar, d3.symbolWye, d3.symbolX,
  d3.symbolPlus, d3.symbolAsterisk, d3.symbolDiamond2, d3.symbolSquare2,
];
// Ordinal stratifiers get increasing stroke widths. 7 levels — Age has 7
// bands (Under 18 … 65+) and Income Quintile has 5 (Q1–Q5); with only 4
// levels (the previous array) the modulo wrap meant the LAST band/quintile
// in each case looped back to the THINNEST width instead of continuing to
// thicken, breaking the intended thin→thick progression (Q5 ended up as
// thin as Q1; Age's widths repeated partway through instead of increasing
// monotonically, which is what made it look "out of order" even though the
// underlying stratum ordering itself was always correct).
const ORDINAL_WIDTHS = [1.5, 2.25, 3, 3.75, 4.5, 5.25, 6];

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Inserts a space before each internal capital letter — e.g. "CoupleChildren" → "Couple Children" — for display when a raw code doesn't have a friendlier label in STRATIFIER_VALUE_LABELS. */
function addSpaces(str){
  if (!str) return str;
  return str.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g,"$1 $2").trim();
}
/** Formats a value for display: percentage (1dp) for categorical/share metrics, plain 2dp number otherwise. Missing/NaN → em-dash. */
function fmt(v,isCat){
  if (v==null||isNaN(v)) return "—";
  return isCat?`${(v*100).toFixed(1)}%`:d3.format(",.2f")(v);
}
/** Same as fmt() but for a Baseline→Scenario delta value: always shows an explicit +/- sign, and categorical deltas are shown in percentage points ("pp") rather than a bare percentage. Uses the same decimal precision as fmt() (1dp for percentages, 2dp for plain numbers) so a value reads identically whether it's shown as a level or a delta. */
function fmtDelta(v,isCat){
  if (v==null||isNaN(v)) return "—";
  const s=v>=0?"+":"";
  return isCat?`${s}${(v*100).toFixed(1)} pp`:`${s}${d3.format(",.2f")(v)}`;
}
/** Formats a row's sample-size info for a tooltip, e.g. "Sample: 1,234 (12 runs)" — pooled total_sample across every contributing run, plus how many runs contributed. Returns "" (nothing to append) if the row has no usable sample info. */
/** Formats a row's sample-size info for a tooltip, e.g. "Sample: 103 (avg across 12 runs)" — the average per-run sample size for that specific variable/stratifier/baseline-or-scenario slice, not the pooled total across runs. Returns "" if the row has no usable sample info. */
const fmt1dp = n => n?.toLocaleString(undefined,{maximumFractionDigits:1}) ?? "";
function fmtSample(row){
  if (!row||row.mean_sample==null||isNaN(row.mean_sample)) return "";
  const n=row.n_runs;
  return `\nSample: ${fmt1dp(row.mean_sample)}${n!=null?` (avg across ${n} run${n===1?"":"s"})`:""}`;
}
/** Delta-specific variant of fmtSample() — shows paired run count when a paired
 *  delta is available, otherwise both sides' avg sample size. */
function fmtDeltaSample(row){
  if (!row) return "";
  if (row.paired_n_runs>0){
    const extra=row.base_mean_sample!=null&&row.scen_mean_sample!=null
      ?` · Sample: B ${fmt1dp(row.base_mean_sample)} / S ${fmt1dp(row.scen_mean_sample)}`:"";
    return `\nPaired runs: ${row.paired_n_runs}${extra}`;
  }
  if (row.base_mean_sample==null||row.scen_mean_sample==null) return "";
  return `\nSample: Baseline ${Math.round(row.base_mean_sample).toLocaleString()} · Scenario ${Math.round(row.scen_mean_sample).toLocaleString()}`;
}
/**
 * Formats a numeric variable's missingness for a data point's tooltip, e.g.
 * "Missing: 12.3% (avg 45 missing per run, across 5 runs)". `mrow` is the
 * matching row from missingLookup (see DashboardSection) — a
 * variable_value:"Missing" share row for this exact scenario/year/
 * stratifier/stratifier-value combination, if one exists. Returns "" (append
 * nothing) when there's no missingness row, or it rounds to 0%, so tooltips
 * for fully-complete points stay uncluttered.
 */
function fmtMissing(mrow){
  if (!mrow||isNaN(mrow.mean_value)||mrow.mean_value<=0) return "";
  const pct=(mrow.mean_value*100).toFixed(1);
  if (pct==="0.0") return "";
  const avgN=mrow.mean_sample!=null&&!isNaN(mrow.mean_sample)?Math.round(mrow.mean_sample):null;
  const n=mrow.n_runs;
  return `\nMissing: ${pct}%`+(avgN!=null?` (avg ${avgN.toLocaleString()} missing${n!=null?` per run, across ${n} run${n===1?"":"s"}`:""})`:"");
}
/** d3.extent() over a list of years, but guards the two degenerate cases: no years at all (→ [0,1]) and a single distinct year (→ that year ±1, so the axis isn't zero-width). */
function safeYearDomain(yrs){
  const [y0,y1]=d3.extent(yrs);
  if (y0===undefined) return [0,1];
  if (y0===y1) return [y0-1,y1+1];
  return [y0,y1];
}
/** Computes a y-axis domain from a set of rows, padded so data + CI bands sit
 * comfortably inside the chart. The ceiling is snapped up to the next round
 * d3-tick boundary so the evenly-spaced ticks d3 generates always reach near
 * the top of the data — without needing to add an extra out-of-domain tick
 * (which was the cause of uneven gridline spacing). */
function buildYDomain(data,isCat){
  const v=data.filter(d=>!isNaN(d.mean_value));
  if (!v.length) return [0,1];
  // Use upper_ci as the high-water mark if available — ensures CI bands
  // are never clipped by the domain.
  const hi=d3.max(v,d=>isNaN(d.upper_ci)?d.mean_value:Math.max(d.mean_value,d.upper_ci))||1;
  const lo=d3.min(v,d=>isNaN(d.lower_ci)?d.mean_value:Math.min(d.mean_value,d.lower_ci))||0;
  const pad=(hi-lo)*0.12||0.05;
  const yLo=Math.max(0, lo-pad);
  const yHi=isCat?Math.min(1,hi+pad):hi+pad;
  return [yLo,yHi];
}
/** Turns an arbitrary label into a filesystem-safe filename fragment (used for CSV/PNG download filenames). */
function slugify(s){ return String(s||"").replace(/\W+/g,"_").toLowerCase(); }

/**
 * Draws a diagonal hatch pattern clipped to a rectangle — this is how
 * Scenario bars are visually distinguished from solid Baseline bars (the
 * "full vs. hatched fill" half of the solid/dashed Baseline/Scenario visual
 * convention used throughout the dashboard). Builds a fresh inline SVG
 * clipPath per call (in a lazily-created <defs>) rather than url(#pattern),
 * so the hatching survives being serialised into a standalone PNG export.
 *
 * @param {d3.Selection} svgSel - the root <svg> selection (for the defs/clipPath)
 * @param {d3.Selection} g - the group to draw the hatch lines into
 * @param {number} x,y,w,h - the rectangle to hatch (bar bounds)
 * @param {string} colour
 * @param {number} [opacity]
 * @param {number} [spacing] - gap between hatch lines in px
 */
// Monotonically incrementing counter for hatch clipPath ids — guarantees no
// two segments ever collide onto the same id (an earlier version hashed the
// rounded x/y/w coordinates into a shared, bounded id space instead; two
// different segments could round to the same hash, and the "reuse if
// exists" check would then silently reuse the FIRST segment's clip
// rectangle for the SECOND segment too — visually, one segment's hatch
// rendering at another segment's position, and the second segment left
// with no hatch of its own).
let hatchClipCounter=0;
function drawDotPattern(svgSel,g,x,y,w,h,colour,opacity=0.4,spacing=6){
  if (w<=0||h<=0) return;
  const clipId=`dc_${++hatchClipCounter}`;
  let defsEl=svgSel.select("defs");
  if (defsEl.empty()) defsEl=svgSel.insert("defs","g");
  defsEl.append("clipPath").attr("id",clipId)
    .append("rect").attr("x",x).attr("y",y).attr("width",w).attr("height",h);
  const dg=g.append("g").attr("clip-path",`url(#${clipId})`).style("pointer-events","none");
  for (let row=y+spacing/2; row<y+h+spacing; row+=spacing){
    for (let col=x+spacing/2; col<x+w+spacing; col+=spacing){
      dg.append("circle").attr("cx",col).attr("cy",row).attr("r",1.2)
        .attr("fill",colour).attr("opacity",opacity);
    }
  }
}

function drawHatchClipped(svgSel,g,x,y,w,h,colour,opacity=0.4,spacing=6,angle=45){
  if (w<=0||h<=0) return;
  const clipId=`hc_${++hatchClipCounter}`;
  let defsEl=svgSel.select("defs");
  if (defsEl.empty()) defsEl=svgSel.insert("defs","g");
  defsEl.append("clipPath").attr("id",clipId)
    .append("rect").attr("x",x).attr("y",y).attr("width",w).attr("height",h);
  const hg=g.append("g").attr("clip-path",`url(#${clipId})`).style("pointer-events","none");
  // angle=45 → top-left to bottom-right; angle=135 → top-right to bottom-left
  const dir = angle===135 ? 1 : -1;
  for (let offset=-(h+spacing); offset<w+h+spacing; offset+=spacing){
    hg.append("line")
      .attr("x1",x+offset).attr("y1",y)
      .attr("x2",x+offset+dir*h).attr("y2",y+h)
      .attr("stroke",colour).attr("stroke-width",1.4).attr("opacity",opacity);
  }
}

// Draw a symbol at (cx,cy)
/** Appends one D3 symbol shape (circle/square/diamond/etc.) at (cx,cy) — used for stratifier markers on line charts when the stratifier is categorical (so each stratum gets a distinct shape, not just a colour). */
function appendSymbol(g, symbolType, cx, cy, size, fill, opacity){
  const symPath = d3.symbol().type(symbolType).size(size)();
  g.append("path").attr("d",symPath).attr("transform",`translate(${cx},${cy})`)
    .attr("fill",fill).attr("opacity",opacity);
}

/* ─────────────────────────────────────────────────────────────────────────────
   PUBLICATION PNG — the "↓ PNG" export button rebuilds a standalone, clean
   copy of the chart (title + legend baked in as real SVG text, not screenshot)
   rather than exporting the live interactive chart element directly.
─────────────────────────────────────────────────────────────────────────────── */
/**
 * Rough greedy word-wrap: breaks `text` into lines that approximately fit
 * within `maxWidth` px, assuming each character is about `avgCharW` px wide
 * (there's no DOM text measurement available/needed here — this is a
 * visual safety net against titles running off the edge of a PNG export,
 * not pixel-perfect typesetting, so an approximate average is fine). Never
 * drops a word — if a single word alone is wider than `maxWidth`, it's
 * still placed on its own line rather than being cut. Caps out at
 * `maxLines`, appending anything past that point onto the final line
 * uncut, which is only reached by extremely long titles.
 */
function wrapText(text,maxWidth,avgCharW,maxLines=3){
  const words=String(text||"").split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines=[];
  let cur=words[0];
  for (let i=1;i<words.length;i++){
    const w=words[i];
    const trial=`${cur} ${w}`;
    if (trial.length*avgCharW>maxWidth && lines.length<maxLines-1){
      lines.push(cur);
      cur=w;
    } else {
      cur=trial;
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * Clones a live chart's <svg> element into a new, self-contained "publication"
 * SVG: white background, a title, and the variable/stratifier legends drawn
 * as real text (not just visible on hover like the live tooltip). Elements
 * tagged with the "pub-skip" class (e.g. click-hit-areas, in-chart controls)
 * are stripped from the clone since they have no meaning in a static export.
 *
 * @param {SVGSVGElement} chartSvgEl - the live chart's root <svg> DOM node
 * @param {object} opts
 * @param {string} opts.title
 * @param {{label,color}[]} opts.legendEntries - variable-value legend entries
 * @param {{label,symPath,sw}[]} [opts.stratLegendEntries] - stratifier legend entries, if stratified
 * @param {boolean} opts.showBaseline
 * @param {boolean} opts.showScenario
 * @param {Set<string>} opts.highlighted - currently-highlighted values, to fade non-highlighted legend rows
 * @param {string} [opts.varScope] - the target variable's display name, used to scope stratLabel() lookups for `legendEntries` (variable-value labels)
 * @param {string} [opts.stratScope] - the active stratifier's display name, used to scope stratLabel() lookups for `stratLegendEntries` (stratifier-value labels)
 * @returns {SVGSVGElement|null} the new standalone SVG, or null if chartSvgEl was falsy
 */
function buildPublicationSvg(chartSvgEl,{title,legendEntries,stratLegendEntries,showBaseline,showScenario,highlighted,varScope,stratScope}){
  if (!chartSvgEl) return null;
  const cW=chartSvgEl.width.baseVal.value||500;
  const cH=chartSvgEl.height.baseVal.value||420;
  const PAD_S=12;
  // tW only depends on cW/PAD_S, so it's safe (and necessary) to compute
  // this early — both the title wrap and the legend column count below need
  // it, and tH (which also needs PAD_T/PAD_B, computed after those) isn't
  // ready yet at this point.
  const tW=cW+PAD_S*2;
  // Title text wraps onto multiple lines when it's wider than the chart —
  // this matters a lot for per-panel PNG exports specifically, where the
  // chart itself can be under 300px wide but the title (variable name +
  // stratum value + stratifier name) easily isn't. Previously this was a
  // single fixed-height, un-wrapped, centred line, which for a narrow panel
  // and a long title ran off both edges of the exported image. 7.5px/char
  // is a rough estimate for this 14px bold sans-serif font.
  const titleLines=wrapText(title,tW-16,7.5,3);
  const TITLE_LINE_H=18;
  const PAD_T=24+titleLines.length*TITLE_LINE_H+8;

  // Measure legend entries to avoid overlap
  const allVarEntries=legendEntries||[];
  const allStratEntries=stratLegendEntries||[];
  // Column count is capped both by a flat max of 4 AND by how many
  // (at-least-130px-wide) columns can actually fit within tW — on a narrow
  // per-panel export, a flat cap of 4 alone could still produce columns too
  // narrow for their own entries, pushing text past the right edge.
  const legendCols=Math.max(1,Math.min(4,Math.max(1,allVarEntries.length),Math.floor(tW/130)));
  const legendRows=Math.ceil(allVarEntries.length/legendCols);
  const stratRows=allStratEntries.length>0?Math.ceil(allStratEntries.length/legendCols)+1:0;
  const bsRows=(showBaseline||showScenario)?1:0;
  const PAD_B=(legendRows+stratRows+bsRows)*22+32;

  const tH=cH+PAD_T+PAD_B;
  const ns="http://www.w3.org/2000/svg";
  const svg=document.createElementNS(ns,"svg");
  svg.setAttribute("xmlns",ns); svg.setAttribute("width",String(tW)); svg.setAttribute("height",String(tH));
  svg.setAttribute("font-family",PUB_FONT); svg.setAttribute("font-size","12");

  // White bg
  const bg=document.createElementNS(ns,"rect"); bg.setAttribute("width",String(tW)); bg.setAttribute("height",String(tH)); bg.setAttribute("fill","#ffffff"); svg.appendChild(bg);

  // Title — one <text> per wrapped line, stacked with TITLE_LINE_H spacing
  titleLines.forEach((line,i)=>{
    const tt=document.createElementNS(ns,"text"); tt.setAttribute("x",String(tW/2)); tt.setAttribute("y",String(24+i*TITLE_LINE_H)); tt.setAttribute("text-anchor","middle"); tt.setAttribute("font-size","14"); tt.setAttribute("font-weight","700"); tt.setAttribute("fill",TEXT_D); tt.setAttribute("font-family",PUB_FONT); tt.textContent=line; svg.appendChild(tt);
  });

  // Chart clone — strip pub-skip, patch fonts
  const cg=document.createElementNS(ns,"g"); cg.setAttribute("transform",`translate(${PAD_S},${PAD_T})`);
  Array.from(chartSvgEl.childNodes).forEach(node=>{
    const cl=node.cloneNode(true);
    if (cl.querySelectorAll) cl.querySelectorAll(".pub-skip").forEach(e=>e.remove());
    cg.appendChild(cl);
  });
  cg.querySelectorAll("text").forEach(t=>{t.setAttribute("font-family",PUB_FONT);t.setAttribute("font-size","12");});
  svg.appendChild(cg);

  const allLit=!highlighted||highlighted.size===0;
  const colW=Math.max(130,Math.floor(tW/legendCols));
  let curY=PAD_T+cH+18;

  // Variable legend
  if (allVarEntries.length){
    const lbl=document.createElementNS(ns,"text"); lbl.setAttribute("x",String(PAD_S)); lbl.setAttribute("y",String(curY+10)); lbl.setAttribute("font-size","11"); lbl.setAttribute("fill",TEXT_S); lbl.setAttribute("font-family",PUB_FONT); lbl.setAttribute("font-weight","600"); lbl.textContent="Groups:"; svg.appendChild(lbl);
    curY+=18;
    allVarEntries.forEach(({label,color},i)=>{
      const col=i%legendCols, row=Math.floor(i/legendCols);
      const lx=PAD_S+col*colW, ly=curY+row*22;
      const isLit=allLit||highlighted.has(label), fc=isLit?color:GREY;
      const sw=document.createElementNS(ns,"rect"); sw.setAttribute("x",String(lx)); sw.setAttribute("y",String(ly)); sw.setAttribute("width","11"); sw.setAttribute("height","11"); sw.setAttribute("rx","2"); sw.setAttribute("fill",fc); svg.appendChild(sw);
      const lt=document.createElementNS(ns,"text"); lt.setAttribute("x",String(lx+15)); lt.setAttribute("y",String(ly+10)); lt.setAttribute("font-size","12"); lt.setAttribute("fill",isLit?TEXT_D:"#94a3b8"); lt.setAttribute("font-family",PUB_FONT); lt.textContent=addSpaces(stratLabel(label,varScope)); svg.appendChild(lt);
    });
    curY+=legendRows*22+4;
  }

  // Stratifier legend
  if (allStratEntries.length){
    const lbl=document.createElementNS(ns,"text"); lbl.setAttribute("x",String(PAD_S)); lbl.setAttribute("y",String(curY+10)); lbl.setAttribute("font-size","11"); lbl.setAttribute("fill",TEXT_S); lbl.setAttribute("font-family",PUB_FONT); lbl.setAttribute("font-weight","600"); lbl.textContent="Stratifier:"; svg.appendChild(lbl);
    curY+=18;
    allStratEntries.forEach(({label,symPath,sw:strokeW},i)=>{
      const col=i%legendCols, row=Math.floor(i/legendCols);
      const lx=PAD_S+col*colW, ly=curY+row*22+5;
      const isLit=allLit||highlighted.has(label);
      if (symPath){
        // Symbol marker
        const p=document.createElementNS(ns,"path"); p.setAttribute("d",symPath); p.setAttribute("transform",`translate(${lx+5},${ly})`); p.setAttribute("fill",isLit?TEXT_M:GREY); p.setAttribute("opacity",isLit?"1":"0.4"); svg.appendChild(p);
      } else {
        // Line width marker
        const l=document.createElementNS(ns,"line"); l.setAttribute("x1",String(lx)); l.setAttribute("x2",String(lx+16)); l.setAttribute("y1",String(ly)); l.setAttribute("y2",String(ly)); l.setAttribute("stroke",isLit?TEXT_M:GREY); l.setAttribute("stroke-width",String(strokeW||2)); svg.appendChild(l);
      }
      const lt=document.createElementNS(ns,"text"); lt.setAttribute("x",String(lx+20)); lt.setAttribute("y",String(ly+4)); lt.setAttribute("font-size","12"); lt.setAttribute("fill",isLit?TEXT_D:"#94a3b8"); lt.setAttribute("font-family",PUB_FONT); lt.textContent=addSpaces(stratLabel(label,stratScope)); svg.appendChild(lt);
    });
    curY+=Math.ceil(allStratEntries.length/legendCols)*22+4;
  }

  // Baseline/scenario key
  if (showBaseline||showScenario){
    let kx=PAD_S; curY+=4;
    if (showBaseline){
      const l=document.createElementNS(ns,"line"); l.setAttribute("x1",String(kx)); l.setAttribute("x2",String(kx+20)); l.setAttribute("y1",String(curY+5)); l.setAttribute("y2",String(curY+5)); l.setAttribute("stroke",TEXT_M); l.setAttribute("stroke-width","2"); svg.appendChild(l);
      const t=document.createElementNS(ns,"text"); t.setAttribute("x",String(kx+24)); t.setAttribute("y",String(curY+9)); t.setAttribute("font-size","12"); t.setAttribute("fill",TEXT_M); t.setAttribute("font-family",PUB_FONT); t.textContent="Baseline"; svg.appendChild(t); kx+=95;
    }
    if (showScenario){
      const l=document.createElementNS(ns,"line"); l.setAttribute("x1",String(kx)); l.setAttribute("x2",String(kx+20)); l.setAttribute("y1",String(curY+5)); l.setAttribute("y2",String(curY+5)); l.setAttribute("stroke",TEXT_M); l.setAttribute("stroke-width","2"); l.setAttribute("stroke-dasharray","5,3"); svg.appendChild(l);
      const t=document.createElementNS(ns,"text"); t.setAttribute("x",String(kx+24)); t.setAttribute("y",String(curY+9)); t.setAttribute("font-size","12"); t.setAttribute("fill",TEXT_M); t.setAttribute("font-family",PUB_FONT); t.textContent="Scenario (dashed / hatched)"; svg.appendChild(t);
    }
  }
  return svg;
}

/**
 * Rasterizes the standalone publication SVG (from buildPublicationSvg) to a
 * 2x-scaled PNG and triggers a browser download. Draws the SVG into an
 * Image via a base64 data URI (avoids canvas tainting/CORS issues that a
 * blob URL can hit), then onto a white-backed <canvas>. Falls back to
 * downloading the raw SVG file directly if PNG rasterization fails for any
 * reason (e.g. a browser that taints the canvas anyway).
 *
 * @param {SVGSVGElement} svgEl - the live chart's <svg> element
 * @param {string} filename
 * @param {object} pubProps - forwarded to buildPublicationSvg (title/legend/etc.)
 */
function downloadPublicationPng(svgEl,filename,pubProps){
  if (!svgEl) return;
  const pub=buildPublicationSvg(svgEl,pubProps); if (!pub) return;
  const w=+pub.getAttribute("width")||600, h=+pub.getAttribute("height")||600;
  // Inline the SVG as a data URI so canvas can draw it without CORS issues
  const svgStr=new XMLSerializer().serializeToString(pub);
  const b64=btoa(unescape(encodeURIComponent(svgStr)));
  const dataUrl=`data:image/svg+xml;base64,${b64}`;
  const img=new Image();
  img.onload=()=>{
    const c=document.createElement("canvas"); c.width=w*2; c.height=h*2;
    const ctx=c.getContext("2d");
    ctx.fillStyle="#ffffff"; ctx.fillRect(0,0,c.width,c.height);
    ctx.scale(2,2); ctx.drawImage(img,0,0);
    try {
      const a=document.createElement("a"); a.href=c.toDataURL("image/png"); a.download=filename; a.click();
    } catch(e) {
      // Fallback: download the SVG directly
      const a=document.createElement("a"); a.href=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`; a.download=filename.replace(".png",".svg"); a.click();
    }
  };
  img.onerror=()=>{
    // Direct SVG fallback
    const a=document.createElement("a"); a.href=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`; a.download=filename.replace(".png",".svg"); a.click();
  };
  img.src=dataUrl;
}

/**
 * Small reusable "↓ PNG" button — wraps downloadPublicationPng() with a
 * chart's svgRef/filename/legend props. `small` shrinks it for use inside
 * small-multiple panels.
 *
 * Two ways to point it at an <svg>:
 *   - svgRef alone: a normal React ref whose `.current` IS the <svg> element
 *     (used by the single, top-level charts — lineRef, barRef, etc.)
 *   - svgRef + svgKey: svgRef is a ref to a lookup object (e.g. a
 *     `{[stratumValue]: svgElement}` map), and svgKey is which entry to use.
 *     This is what small-multiple panels pass, since they share ONE ref
 *     object across many panels rather than one ref per panel. Critically,
 *     the lookup happens INSIDE the click handler (at click time), not at
 *     render time — reading `svgRef.current[svgKey]` while building this
 *     button's props would capture whatever was in the map at that render,
 *     which on a panel's first paint is `undefined` (the ref callback that
 *     populates the map hasn't run yet), permanently baking in a broken
 *     button until some unrelated re-render happened to refresh it.
 */
function DownloadBtn({svgRef,svgKey,filename,pubProps,small=false}){
  return <button onClick={()=>{
      const svgEl = svgKey!=null ? svgRef?.current?.[svgKey] : svgRef?.current;
      downloadPublicationPng(svgEl,filename,pubProps||{});
    }}
    title="Download publication-ready PNG"
    style={{fontSize:small?10:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:small?"1px 6px":"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ PNG</button>;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
// A single shared floating tooltip <div> (not one per chart) — every chart
// calls showTT/moveTT/hideTT on hover rather than rendering its own tooltip
// element, since only one can ever be visible at a time anyway.
/** Lazily creates (once) and returns the shared tooltip DOM node, appended directly to <body> so it isn't clipped by any chart's overflow/positioning. */
function getTooltip(){
  let el=document.getElementById("smpaths-tt");
  if (!el){ el=document.createElement("div"); el.id="smpaths-tt"; Object.assign(el.style,{position:"fixed",pointerEvents:"none",zIndex:9999,background:"rgba(15,23,42,0.93)",color:"#f8fafc",padding:"9px 13px",borderRadius:"8px",fontSize:"13px",lineHeight:"1.65",maxWidth:"240px",boxShadow:"0 4px 20px rgba(0,0,0,0.3)",opacity:0,transition:"opacity 0.1s ease",fontFamily:"system-ui,sans-serif"}); document.body.appendChild(el); }
  return el;
}
/** Sets the tooltip's HTML content and fades it in, positioned at the given mouse event's location. */
function showTT(content,e){const t=getTooltip();setTooltipContent(t,content);t.style.opacity=1;moveTT(e);}
/** Repositions the tooltip to follow the mouse, flipping to the left of the cursor if it would otherwise overflow the right edge of the viewport. */
function moveTT(e){const t=getTooltip();const w=t.offsetWidth||220;t.style.left=(e.clientX+14+w>window.innerWidth?e.clientX-w-14:e.clientX+14)+"px";t.style.top=(e.clientY-20)+"px";}
/** Fades the tooltip out (on mouseout). */
function hideTT(){const t=document.getElementById("smpaths-tt");if(t)t.style.opacity=0;}

// Friendlier column headers for the three sample-size fields, applied when
// downloading a CSV from the dashboard.
const CSV_HEADER_RENAMES={total_sample:"Total Sample: Across Runs",min_sample:"Minimum Sample: Across Runs",mean_sample:"Average Sample: Across Runs"};

/**
 * Sorts CSV rows for download in a consistent, human-readable order:
 *   1. year ascending
 *   2. scenario (baseline rows before scenario/delta rows, alphabetically within each)
 *   3. variable (alphabetically)
 *   4. variable_value ascending — ONLY for categorical variables (isContinuous skips this)
 *   5. stratifier_level ascending (if present)
 *
 * @param {object[]} data - array of data rows
 * @param {boolean} isContinuous - true for numeric/mean variables; skips variable_value sort
 * @returns {object[]} new sorted array (original is not mutated)
 */
function sortCsvRows(data, isContinuous=false){
  if (!data?.length) return data;
  // Determine the scenario value that should sort first (the baseline).
  // We look for a row whose scenario string contains "baseline" (case-insensitive);
  // if none found we fall back to alphabetic ordering.
  const scenarioValues=[...new Set(data.map(d=>d.scenario).filter(Boolean))];
  const baselineScen=scenarioValues.find(s=>/baseline/i.test(s))||null;

  return [...data].sort((a,b)=>{
    // 1. year
    const ya=Number(a.year)||0, yb=Number(b.year)||0;
    if (ya!==yb) return ya-yb;

    // 2. scenario — baseline first, then everything else alphabetically
    const sa=String(a.scenario??""), sb=String(b.scenario??"");
    const aIsBase=baselineScen?sa===baselineScen:false;
    const bIsBase=baselineScen?sb===baselineScen:false;
    if (aIsBase!==bIsBase) return aIsBase?-1:1;
    if (sa!==sb) return sa.localeCompare(sb);

    // 3. variable
    const va=String(a.variable??""), vb=String(b.variable??"");
    if (va!==vb) return va.localeCompare(vb);

    // 4. variable_value — categorical only; education values use a fixed ordinal
    //    order (InEducation → Low → Medium → High) instead of alphabetic.
    if (!isContinuous){
      const vva=String(a.variable_value??""), vvb=String(b.variable_value??"");
      if (vva!==vvb){
        const varName=String(a.variable??b.variable??"").toLowerCase();
        if (/education/.test(varName)){
          const EDU_ORDER=["ineducation","low","medium","high"];
          const ai=EDU_ORDER.indexOf(vva.toLowerCase());
          const bi=EDU_ORDER.indexOf(vvb.toLowerCase());
          if (ai!==-1||bi!==-1) return (ai===-1?999:ai)-(bi===-1?999:bi);
        }
        return vva.localeCompare(vvb);
      }
    }

    // 5. stratifier_level — education uses a fixed ordinal order; everything
    //    else falls back to alphabetic. Match on the stratifier field
    //    case-insensitively so "Education", "education", etc. all work.
    const sla=String(a.stratifier_value??""), slb=String(b.stratifier_value??"");
    if (sla!==slb){
      const stratName=String(a.stratifier??b.stratifier??"").toLowerCase();
      if (/education/.test(stratName)){
        const EDU_ORDER=["ineducation","low","medium","high"];
        const ai=EDU_ORDER.indexOf(sla.toLowerCase());
        const bi=EDU_ORDER.indexOf(slb.toLowerCase());
        // known values sort by position; unknowns fall to the end alphabetically
        if (ai!==-1||bi!==-1) return (ai===-1?999:ai)-(bi===-1?999:bi);
      }
      return sla.localeCompare(slb);
    }

    return 0;
  });
}

/**
 * Serialises `data` to CSV and triggers a browser download.
 * Column order follows the first row's key order; the three sample-size fields
 * are relabelled via CSV_HEADER_RENAMES for readability.
 *
 * @param {object[]} data - rows to export
 * @param {string} filename
 * @param {object} [opts]
 * @param {boolean} [opts.isDelta=false] - if true, overwrites every row's `scenario` field with "delta"
 * @param {boolean} [opts.isContinuous=false] - if true, skips variable_value in the sort order
 */
function exportCsv(data, filename, {isDelta=false, isContinuous=false}={}){
  if (!data?.length) return;
  // Optionally stamp scenario="delta" before sorting
  const rows = isDelta ? data.map(d=>({...d, scenario:"delta"})) : data;
  const sorted = sortCsvRows(rows, isContinuous);
  const keys=Object.keys(sorted[0]);
  const header=keys.map(k=>CSV_HEADER_RENAMES[k]||k);
  const csvRows=[header.join(","),...sorted.map(d=>keys.map(k=>JSON.stringify(d[k]??"")).join(","))];
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csvRows.join("\n")],{type:"text/csv"})); a.download=filename; a.click(); URL.revokeObjectURL(a.href);
}

/** Placeholder shown instead of a chart/panel when its underlying sample is too small to display reliably (see parseCore.js's min_sample<100 suppression rule). */
function SmallSampleOverlay(){
  return <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(239,236,228,0.85)",borderRadius:8,zIndex:5,padding:16,textAlign:"center"}}>
    <p style={{margin:0,fontSize:12,color:TEXT_M,fontStyle:"italic"}}>Sample too small — suppressed.</p>
  </div>;
}

/**
 * Renders one row of clickable legend swatches (used for both the main
 * variable-value legend and, when stratified, a second row for stratifier
 * values). Clicking an entry toggles it in/out of the `highlighted` set,
 * which fades every non-matching series across all charts on the page.
 *
 * @param {string} [label] - row label, e.g. "Groups:" or "Stratifier:"
 * @param {{label,color,symIdx,sw}[]} entries
 * @param {Set<string>} highlighted
 * @param {(label:string)=>void} onToggle
 * @param {boolean} [showSymbols] - draw each entry's D3 symbol shape instead of a plain colour swatch (used for stratifier legends)
 * @param {object} [stratDef] - stratifier definition, currently unused inside but kept for future symbol-shape lookups
 * @param {string} [scope] - the stratifier/variable display name these entries' values belong to, passed through to stratLabel() so the right per-stratifier label table is consulted (see STRATIFIER_VALUE_LABELS)
 */
function LegendRow({label,entries,highlighted,onToggle,showSymbols=false,stratDef=null,vertical=false,scope}){
  if (!entries?.length) return null;
  const allLit=highlighted.size===0;
  return (
    <div style={{marginBottom:4}}>
      {label&&<span style={{fontSize:12,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",marginRight:10}}>{label}</span>}
      <div style={{display:"flex",flexDirection:vertical?"column":"row",flexWrap:"wrap",gap:"6px 10px"}}>
        {entries.map(({label:lbl,color,symIdx,sw},i)=>{
          const isH=highlighted.has(lbl), active=allLit||isH;
          const swatchColour=color||TEXT_M;
          return (
            <button key={lbl} onClick={()=>onToggle(lbl)} title={addSpaces(stratLabel(lbl,scope))} style={{
              display:"flex",alignItems:"center",gap:7,cursor:"pointer",padding:"7px 13px",borderRadius:20,
              border:`1.5px solid ${isH?swatchColour:"#ddd8ce"}`,
              background:isH?`${swatchColour}18`:"#fff",
              transition:"all 0.15s",flexShrink:0,maxWidth:180,
            }}>
              {showSymbols&&symIdx!==undefined
                /* Categorical stratifier (e.g. Region): show a short line with the
                   shape centred on it — matches exactly what the combined line chart draws */
                ? <svg width="28" height="14" style={{flexShrink:0}}>
                    <line x1="0" y1="7" x2="28" y2="7" stroke={active?TEXT_M:GREY} strokeWidth="1.8" opacity={active?1:0.4}/>
                    <path d={d3.symbol().type(SYMBOLS[symIdx%SYMBOLS.length]).size(52)()} transform="translate(14,7)" fill={active?TEXT_M:GREY} opacity={active?1:0.4}/>
                  </svg>
                : sw!==undefined
                  ? <svg width="22" height="12" style={{flexShrink:0}}><line x1="0" y1="6" x2="22" y2="6" stroke={active?TEXT_M:GREY} strokeWidth={sw} opacity={active?1:0.4}/></svg>
                  : <span style={{width:13,height:13,borderRadius:4,background:active?color:GREY,flexShrink:0,display:"inline-block",transition:"background 0.15s"}}/>
              }
              <span style={{fontSize:14,color:active?TEXT_D:TEXT_S,fontWeight:active?600:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",minWidth:0}}>{addSpaces(stratLabel(lbl,scope))}</span>
            </button>
          );
        })}
        {highlighted.size>0&&<button onClick={()=>onToggle(null)} style={{fontSize:13,fontWeight:600,color:TEAL,background:"none",border:"none",cursor:"pointer",padding:"7px 10px",textDecoration:"underline",whiteSpace:"nowrap",flexShrink:0}}>Clear all</button>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   AXES
─────────────────────────────────────────────────────────────────────────────── */
/** Draws the shared time (year) x-axis: gridline-free tick marks, thinning to ~6 ticks for wide year ranges (rather than one tick per year), plus an "Year" axis label (omitted for small-multiple panels). */
function applyTimeXAxis(g,xScale,iH,small,allYears){
  const xTicks=allYears.length<=8?allYears:d3.ticks(allYears[0],allYears[allYears.length-1],6).filter(t=>t%1===0);
  g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xScale).tickValues(xTicks).tickFormat(d3.format("d")).tickSize(3))
    .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#e2ddd5");});
  g.append("text").attr("x",xScale.range()[1]/2).attr("y",iH+(small?32:44)).attr("text-anchor","middle").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text("Year");
}
/**
 * Builds a y-axis label that names BOTH the variable being plotted and
 * which metric the axis shows — e.g. "Equivalised Yearly Disposable Income
 * (Mean value)" for a numeric variable, or "Highest Level Of Education
 * (Share of sample, %)" for a categorical one. Deliberately a single,
 * flat parenthetical (not "(Share (%))" nested inside another) even when
 * the variable's own name already contains parentheses (e.g. "Mental
 * Component Summary (MCS)") — this function only ever appends ONE more
 * paren group after whatever `varLabel` already is, never nests one inside
 * another. Falls back to just the metric name if no variable label is
 * available (e.g. a chart rendered before the variable is known).
 *
 * @param {string} varLabel - the variable's display name (already addSpaces()'d)
 * @param {boolean} isCat - true for categorical/share metrics, false for numeric means
 * @param {boolean} [isDelta] - true for the Δ Baseline → Scenario chart's axis, which shows a difference rather than a level
 */
// Variables whose y-axis label should include an IHS transformation note.
// These must match the addSpaces()-processed form of the variable name exactly
// as it appears in the data (i.e. after addSpaces() title-cases each word).
const IHS_VARS = new Set([
  "Gross Personal Employment Income",
  "Gross Private Pension Income",
]);
function yAxisLabel(varLabel,isCat,isDelta=false){
  const metric = isDelta
    ? (isCat?"Δ percentage points":"Δ Average value")
    : (isCat?"Share of sample, %":"Average value");
  const ihsSuffix = (!isCat && IHS_VARS.has(varLabel)) ? ", Inverse Hyperbolic Sine Transformed" : "";
  return varLabel ? `${varLabel} (${metric}${ihsSuffix})` : metric;
}
/**
 * Splits a y-axis label built by yAxisLabel() into [variablePart,
 * metricPart] — everything before the FINAL "(...)" group, and that group
 * itself — so applyYAxis can draw the label as two shorter stacked lines
 * instead of one long rotated one. A single long rotated line for a
 * variable like "Equivalised Yearly Disposable Income (Mean value)" can
 * easily run taller than the chart itself, which is what was clipping/
 * overlapping text in PNG exports (the live chart's SVG has
 * `overflow:visible` so it's merely ugly there, but the exported
 * publication SVG doesn't, so it actually gets cut off). Handles a
 * variable name that already ends in its own "(...)" (e.g. "Mental
 * Component Summary (MCS)") correctly — it splits before the metric's
 * parens specifically, not the variable's own. Returns null if the label
 * doesn't end in a "(...)" group at all (e.g. no variable name was
 * available), in which case it's short enough to stay on one line.
 */
function splitAxisLabel(lbl) {
  const m = /^(.*)\s(\([^()]*\))$/.exec(lbl||"");
  return m ? [m[1], m[2]] : null;
}
/**
 * Draws the shared value y-axis: dashed horizontal gridlines, percentage
 * formatting for categorical/share charts vs. plain numbers otherwise,
 * plus an axis label (omitted for small-multiple panels, or overridden via
 * `yLabelText`). Tick precision matches fmt() exactly (1dp for
 * percentages, 2dp for plain numbers) so a value reads identically whether
 * it's read off the axis or a tooltip.
 *
 * The axis title is positioned dynamically, based on the ACTUAL rendered
 * width of the tick labels (via getBBox(), measured right after the axis
 * itself is drawn) — not a fixed guessed offset. Tick label width varies a
 * lot with the data ("0.0%" vs "123,456.78"), so a fixed offset either
 * overlapped wide numbers or wasted space on narrow ones; measuring the
 * real thing guarantees the title clears the numbers regardless of how
 * they happen to format. The title itself is drawn as up to two stacked
 * lines — see splitAxisLabel() above for why — with the (usually shorter)
 * metric line closest to the axis and the variable name further out.
 */
function applyYAxis(g,yScale,iW,iH,isCat,small,yLabelText){
  // Let d3.ticks() pick evenly-spaced round values within the domain.
  // Previously an extra tick was appended at lastTick+step when the domain
  // ceiling wasn't a round multiple — that tick landed above the scale
  // domain and d3 rendered it at a clipped position, creating visually
  // uneven spacing between the top two gridlines. Simply using d3's own
  // ticks (which are always within the domain) keeps spacing consistent.
  const [domLo,domHi]=yScale.domain();
  const yTicks=d3.ticks(domLo,domHi,5);
  const axisG=g.append("g").call(d3.axisLeft(yScale).tickValues(yTicks).tickFormat(v=>isCat?`${(v*100).toFixed(1)}%`:small?d3.format("~s")(v):d3.format(",.2f")(v)).tickSize(-iW))
    .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#f0ece4").style("stroke-dasharray","3,3");});
  if (small) {
    // Panel charts: same label as the combined plot, split across two lines
    // at a smaller font size. yLabelText already contains the full label.
    const lbl = yLabelText || yAxisLabel(null, isCat);
    const split = splitAxisLabel(lbl);
    const SMALL_GAP = 10;
    const txt = g.append("text").attr("transform","rotate(-90)").attr("x",-iH/2).attr("y",-58)
      .attr("text-anchor","middle").style("font-size","9px").style("fill",TEXT_M).style("font-family",PUB_FONT);
    if (split) {
      txt.append("tspan").attr("x",-iH/2).attr("dy",0).text(split[0]);
      txt.append("tspan").attr("x",-iH/2).attr("dy",SMALL_GAP).text(split[1]);
    } else {
      txt.text(lbl);
    }
  } else {
    let maxTickW=0;
    axisG.selectAll("text").each(function(){
      let bw=0;
      try { bw=this.getBBox().width; } catch(e) { bw=(this.textContent||"").length*6.2; }
      if (bw>maxTickW) maxTickW=bw;
    });
    const lbl=yLabelText||yAxisLabel(null,isCat);
    const split=splitAxisLabel(lbl);
    const GAP=17;
    const LINE_GAP=13;
    const nearOffset=-(maxTickW+GAP);
    const farOffset=split?nearOffset-LINE_GAP:nearOffset;
    const txt=g.append("text").attr("transform","rotate(-90)").attr("x",-iH/2).attr("y",farOffset).attr("text-anchor","middle").style("font-size","12px").style("fill",TEXT_D).style("font-family",PUB_FONT);
    if (split){
      txt.append("tspan").attr("x",-iH/2).attr("dy",0).text(split[0]);
      txt.append("tspan").attr("x",-iH/2).attr("dy",LINE_GAP).text(split[1]);
    } else {
      txt.text(lbl);
    }
  }
}

/** Draws the small "— Baseline / ┄ Scenario" key at the bottom of a line/delta chart's plot area, explaining the solid-vs-dashed visual convention. Tagged "pub-skip" since the PNG export builds its own, more detailed legend instead of duplicating this compact in-chart one. */
// scenarios = [{name, dash, label, colour?}] for each enabled scenario, or boolean (legacy)
function drawBSKey(g,iW,iH,showBaseline,scenarios,baseColour=TEXT_M){
  const scenList=Array.isArray(scenarios)?scenarios:(scenarios?[{dash:"6,4",label:"Scenario",colour:TEXT_M}]:[]);
  if (!showBaseline&&!scenList.length) return;
  const skip=g.append("g").attr("class","pub-skip");
  // Fixed at iH+52 for all chart types — keeps legend on the same y-line
  // regardless of chart height differences between line and bar charts.
  let kx=4, ky=iH+52;
  if (showBaseline){
    skip.append("line").attr("x1",kx).attr("x2",kx+16).attr("y1",ky).attr("y2",ky).attr("stroke",baseColour).attr("stroke-width",2);
    skip.append("text").attr("x",kx+20).attr("y",ky+4).style("font-size","11px").style("fill",TEXT_M).style("font-family",PUB_FONT).text("Baseline");
    kx+=80;
  }
  scenList.forEach(({dash,label,colour=TEXT_M})=>{
    skip.append("line").attr("x1",kx).attr("x2",kx+16).attr("y1",ky).attr("y2",ky).attr("stroke",colour).attr("stroke-width",2).attr("stroke-dasharray",dash);
    skip.append("text").attr("x",kx+20).attr("y",ky+4).style("font-size","11px").style("fill",TEXT_M).style("font-family",PUB_FONT).text(label);
    kx+=Math.max(80, label.length*7+28);
  });
}

/* ═════════════════════════════════════════════════════════════════════════════
   LINE CHART
   Combined stratified mode: colour=varVal, symbol OR width cue=stratVal.
═════════════════════════════════════════════════════════════════════════════ */
/**
 * The dashboard's main time-series chart. Used both full-size (Overall view,
 * and the stratified "Combined" layout) and shrunk down (`small=true`, via
 * PanelChart) for small-multiple panels — the same component, not two
 * separate implementations, so behaviour stays identical at both sizes.
 *
 * Rendering happens imperatively via D3 inside a useEffect keyed on the full
 * prop list, rebuilding the SVG from scratch on every relevant change (rather
 * than a React-driven incremental D3 update) — simpler to reason about at
 * this chart's complexity, at the cost of a full redraw per change.
 *
 * Draw order (see the three labelled "Layer" passes inside the effect): all
 * CI ribbons first (both Baseline and Scenario), then all trajectory lines,
 * then all dots + invisible hit-areas last — so CI shading never visually
 * sits on top of a line, and hit-areas are always reachable for tooltips
 * regardless of what's drawn under them.
 *
 * Missing years: if a series has no row at all for some year (as opposed to
 * a row present with a suppressed/NaN value), an explicit NaN placeholder is
 * synthesised for that year (see the `densify` helper inside) so d3's
 * `.defined()` breaks the line there rather than drawing a straight
 * connector across the gap. This requires knowing the FULL set of years that
 * are real for this variable — see `allYears` below: when this chart is one
 * panel of a small-multiples grid, `baseData`/`scenData` are already scoped
 * to a single stratum, and that stratum alone might have zero rows (not
 * just suppressed ones) for some year that other strata do have data for.
 * Deriving the year list from just this panel's own data would silently
 * drop that year from the x-axis entirely (losing its tick label too, not
 * just breaking the line) — so callers should pass the dataset's global,
 * variable-wide year list explicitly rather than relying on the fallback.
 *
 * @param {object} props
 * @param {React.RefObject<SVGSVGElement>} props.svgRef
 * @param {object[]} props.baseData - Baseline rows for the current variable (+ stratifier, if any)
 * @param {object[]} props.scenData - Scenario rows, same shape
 * @param {Object<string,string>} props.colourMap - value → colour (see buildColourMap)
 * @param {Set<string>} props.highlighted - currently-highlighted variable/stratifier values
 * @param {boolean} props.isCategorical
 * @param {[number,number]} props.yDomain
 * @param {string[]} props.varValues - this variable's possible values, in display order
 * @param {Set<string>} props.enabledVarVals - which values are toggled on (via filters)
 * @param {boolean} props.showBaseline
 * @param {boolean} props.showScenario
 * @param {number} props.width
 * @param {boolean} [props.small] - render at small-multiple panel size
 * @param {(year:number)=>void} [props.onYearClick] - pins a year for the cross-section view
 * @param {number|null} [props.selectedYear] - currently-pinned year, drawn as a vertical indicator
 * @param {boolean} [props.isStratified]
 * @param {string[]} [props.stratValues] - stratifier's possible values, if stratified
 * @param {Set<string>} [props.enabledStrats] - which stratum values are toggled on
 * @param {string} [props.viewBy] - active stratifier name
 * @param {boolean} [props.showCI] - whether to draw the 95% CI ribbons (small toggle button in the controls row)
 * @param {Map<string,object>} [props.missingLookup] - for numeric variables, maps "scenario|year|stratifier_value" to that point's "Missing" share row, so its % missing (and missing sample size) can be appended to the tooltip instead of ever being plotted as its own series
 * @param {string} [props.missingStratValue] - overrides which stratifier_value to use when looking up missingness — needed for small-multiple panels, where each panel's own series report sv:null internally (see buildSeriesList's `small` branch) even though the panel itself represents one specific stratum
 * @param {number[]} [props.allYears] - the FULL year range for this variable, across every stratum — pass this explicitly (from the top-level DashboardSection) rather than relying on the local fallback whenever baseData/scenData might be scoped to a single stratum (i.e. always, for small-multiple panels)
 * @param {string} [props.varLabel] - the target variable's display name (already addSpaces()'d) — used to scope stratLabel() lookups for variable-value labels, and to build the y-axis label ("{varLabel} (Mean value)" / "{varLabel} (Share of sample, %)")
 */
function LineChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,yDomain,varValues,enabledVarVals,showBaseline,showScenario,
    width,small,onYearClick,selectedYear,
    isStratified=false,stratValues=[],enabledStrats=new Set(),viewBy="",showCI=true,allYears:allYearsProp,missingLookup=null,missingStratValue,varLabel="",
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  // If scenarioMap provided, build ordered list of [name, rows, dashPattern] for enabled scenarios
  // Falls back to single scenData for backwards compat
  const mar=small?M_SM:M;
  const H=small?CHART_H_SM:CHART_H;
  const W=small?width:Math.min(width,MAX_W);
  const allLit=highlighted.size===0;
  const stratDef=useMemo(()=>getStratifierDef(viewBy),[viewBy]);
  const isCatStrat=stratDef?.type==="categorical";

  useEffect(()=>{
    const svg=d3.select(svgRef.current); svg.selectAll("*").remove();
    const iW=W-mar.left-mar.right, iH=H-mar.top-mar.bottom;
    if (iW<10) return;
    svg.attr("width",W).attr("height",H);
    const g=svg.append("g").attr("transform",`translate(${mar.left},${mar.top})`);

    // Prefer the caller-supplied global year list (see allYears prop above);
    // only fall back to deriving it from this instance's own baseData/scenData
    // when no explicit list was passed in.
    const allYears=allYearsProp&&allYearsProp.length?allYearsProp:[...new Set([...baseData,...scenData].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b);
    const xScale=d3.scaleLinear().domain(safeYearDomain(allYears)).range([0,iW]);
    const yScale=d3.scaleLinear().domain(yDomain).range([iH,0]).clamp(false);
    applyTimeXAxis(g,xScale,iH,small,allYears);
    applyYAxis(g,yScale,iW,iH,isCategorical,small,yAxisLabel(varLabel,isCategorical));

    // Year-selection indicator (pub-skip so stripped in export) — shown at
    // small size too now, so a clicked panel visibly shows which year it's
    // currently pinned to (each panel tracks its own selectedYear).
    if (selectedYear){
      const skip=g.append("g").attr("class","pub-skip");
      const sx=xScale(selectedYear);
      skip.append("rect").attr("x",sx-12).attr("y",0).attr("width",24).attr("height",iH).attr("fill",TEAL).attr("opacity",0.08).attr("rx",2).style("pointer-events","none");
      skip.append("line").attr("x1",sx).attr("x2",sx).attr("y1",0).attr("y2",iH).attr("stroke",TEAL).attr("stroke-width",1.5).attr("stroke-dasharray","4,3").style("pointer-events","none");
    }

    const lineFn=d3.line().defined(d=>!isNaN(d.mean_value)).x(d=>xScale(d.year)).y(d=>yScale(d.mean_value)).curve(d3.curveMonotoneX);

    // If a series has no row at all for some year in allYears (as opposed to a row
    // with a suppressed/NaN value), d3.line() has nothing to mark that x-position
    // as "undefined" and will draw a straight connector bridging the gap. Filling
    // in an explicit NaN point for every missing year makes .defined() break the
    // line there too, so it stops before the gap and resumes after it instead of
    // running straight through.
    const densify=(pts)=>{
      const byYear=new Map(pts.map(d=>[d.year,d]));
      return allYears.map(yr=>byYear.get(yr)||{year:yr,mean_value:NaN,lower_ci:NaN,upper_ci:NaN});
    };

    // scenarioIdx: -1 = baseline, 0+ = scenario index (used to pick numeric colour)
    const buildSeriesList=(rows,scenarioIdx=-1)=>{
      const numColour=scenarioIdx<0
        ? NUMERIC_BASE_COLOUR
        : NUMERIC_SCEN_COLOURS[scenarioIdx%NUMERIC_SCEN_COLOURS.length];
      const resolveColour=(vv)=>isCategorical?(colourMap[vv]||GREY):numColour;
      if (!isStratified||small){
        const grouped=d3.group(rows,d=>d.variable_value);
        return Array.from(grouped.entries()).map(([vv,pts])=>({
          key:`vv:${vv}`,vv,sv:null,pts:densify(pts),colour:resolveColour(vv),
          symIdx:undefined,strokeW:2.5,
          isLit:allLit||highlighted.has(vv),
          label:addSpaces(stratLabel(vv,varLabel)),
        }));
      }
      const series=[];
      stratValues.forEach((sv,si)=>{
        if (!enabledStrats.has(sv)) return;
        varValues.forEach(vv=>{
          if (!enabledVarVals.has(vv)) return;
          const pts=rows.filter(d=>d.stratifier_value===sv&&d.variable_value===vv);
          if (!pts.length) return;
          const hV=highlighted.has(vv), hS=highlighted.has(sv);
          const hasVarH=[...highlighted].some(h=>varValues.includes(h));
          const hasStratH=[...highlighted].some(h=>stratValues.includes(h));
          const isLit=allLit
            ||(hasVarH&&hasStratH&&hV&&hS)
            ||(hasVarH&&!hasStratH&&hV)
            ||(!hasVarH&&hasStratH&&hS);
          const symIdx=isCatStrat?si%SYMBOLS.length:undefined;
          const strokeW=isCatStrat?2:ORDINAL_WIDTHS[si%ORDINAL_WIDTHS.length];
          series.push({key:`${sv}::${vv}`,vv,sv,pts:densify(pts),colour:resolveColour(vv),symIdx,strokeW,isLit,label:`${addSpaces(stratLabel(vv,varLabel))} — ${addSpaces(stratLabel(sv,viewBy))}`});
        });
      });
      return series;
    };

    // dash is a strokeDasharray string ("none" for baseline, "6,4" / "2,2" etc. for scenarios)
    const drawRibbon=(s,dash)=>{
      const {vv,pts,colour,isLit}=s;
      if (!enabledVarVals.has(vv)||!isLit) return;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      if (!sorted.some(d=>!isNaN(d.lower_ci))) return;
      const area=d3.area().defined(d=>!isNaN(d.lower_ci)&&!isNaN(d.upper_ci)).x(d=>xScale(d.year)).y0(d=>yScale(d.lower_ci)).y1(d=>yScale(d.upper_ci)).curve(d3.curveMonotoneX);
      const band=g.append("path").datum(sorted).attr("d",area).attr("fill",colour).attr("opacity",0.13).style("pointer-events","none");
      if (dash&&dash!=="none") band.attr("stroke",colour).attr("stroke-width",1).attr("stroke-dasharray",dash).attr("stroke-opacity",0.55);
    };

    const drawLine=(s,dash)=>{
      const {vv,pts,colour,isLit,strokeW}=s;
      if (!enabledVarVals.has(vv)) return;
      const fc=isLit?colour:GREY;
      const opacity=isLit?1:0.18;
      const sw=isLit?strokeW:(small?0.7:1);
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      if (!sorted.length) return;
      g.append("path").datum(sorted).attr("d",lineFn).attr("fill","none").attr("stroke",fc)
        .attr("stroke-width",sw).attr("stroke-dasharray",(dash&&dash!=="none")?dash:"none").attr("opacity",opacity).style("pointer-events","none");
    };

    const drawDots=(s,scenLabel)=>{
      const {vv,sv,pts,colour,symIdx,isLit,label}=s;
      if (!enabledVarVals.has(vv)) return;
      const fc=isLit?colour:GREY;
      const opacity=isLit?1:0.18;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      // For numeric variables, resolve this series' stratifier value once
      // (same for every point in the series) rather than recomputing per
      // point. missingStratValue overrides sv for panels, where sv is
      // always null internally even though the panel represents one
      // specific stratum — see the prop's JSDoc above.
      // Map display label back to the raw scenario key for missingLookup
      const scenarioKey=scenLabel==="Baseline"?"baseline":(scenData?.length?scenData[0]?.scenario:"scenario");
      const stratValKey=missingStratValue??sv??"Overall";
      // Always draw dots + always add an invisible hit area so tooltips work
      // regardless of opacity, size, or baseline vs scenario
      sorted.filter(d=>!isNaN(d.mean_value)).forEach(d=>{
        const cx=xScale(d.year), cy=yScale(d.mean_value);
        const mrow=missingLookup?missingLookup.get(`${scenarioKey}|${d.year}|${stratValKey}`):null;
        const ttContent={title:`${label}`,lines:[`\n${scenLabel}: ${fmt(d.mean_value,isCategorical)}`+(!isNaN(d.lower_ci)?`\n95% CI: [${fmt(d.lower_ci,isCategorical)}, ${fmt(d.upper_ci,isCategorical)}]`:"")+fmtSample(d)+fmtMissing(mrow)+`\nYear: ${d.year}${onYearClick?" · click to filter a cross-section":""}`]};
        const dotR=small?(isLit?2.5:1.5):(isLit?3.5:2);
        // Only draw visible markers on combined/stratified-categorical plots
        // (where symIdx is set). Plain line charts get no visible dots —
        // the invisible hit area below still handles tooltips and year-click.
        if (symIdx!==undefined&&!small){
          const symPath=d3.symbol().type(SYMBOLS[symIdx]).size(isLit?52:28)();
          g.append("path").attr("d",symPath).attr("transform",`translate(${cx},${cy})`)
            .attr("fill",fc).attr("opacity",opacity).style("pointer-events","none");
        }
        // Invisible hit area — always present regardless of whether a visible
        // dot is drawn, so tooltips and year-click always work.
        g.append("circle").attr("cx",cx).attr("cy",cy).attr("r",Math.max(8,dotR+5))
          .attr("fill","transparent")
          .style("cursor",onYearClick?"pointer":"default")
          .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT)
          .on("click",()=>{if(onYearClick) onYearClick(d.year);});
      });
    };

    const byLitOrder=(a,b)=>(a.isLit?1:-1);
    const baseSeries=showBaseline?buildSeriesList(baseData,-1):[];

    // Build one series list per enabled scenario, with its dash pattern and colour index
    const scenSeriesList = (scenarioMap && scenarioMap.size > 0)
      ? allScenarioNames
          .filter(n=>enabledScenarios?.has(n))
          .map((name)=>{const gi=allScenarioNames.indexOf(name);return({
            name, dash:SCENARIO_DASHES[gi%SCENARIO_DASHES.length],
            series:buildSeriesList(scenarioMap.get(name)??[],gi),
            label:scenarioLabel(name),
          });})
      : (showScenario ? [{name:"scenario",dash:SCENARIO_DASHES[0],series:buildSeriesList(scenData,0),label:"Scenario"}] : []);

    if (onYearClick){
      allYears.forEach(yr=>{
        g.append("rect").attr("x",xScale(yr)-10).attr("y",0).attr("width",20).attr("height",iH)
          .attr("fill","transparent").style("cursor","pointer")
          .style("pointer-events","all")
          .on("click",()=>onYearClick(yr));
      });
    }

    // Draw dim series first, lit series last so highlighted series sit on top.
    // Within each pass: ribbon immediately before its own line so every line
    // always renders above every CI ribbon (including those of other scenarios).
    const allSeriesEntries=[
      ...baseSeries.map(s=>({s,dash:"none",label:"Baseline"})),
      ...scenSeriesList.flatMap(({series,dash,label})=>series.map(s=>({s,dash,label}))),
    ];
    // Ribbons for dim series first
    if (showCI&&!small){
      allSeriesEntries.filter(({s})=>!s.isLit).forEach(({s,dash})=>drawRibbon(s,dash));
    }
    // Lines for dim series
    allSeriesEntries.filter(({s})=>!s.isLit).forEach(({s,dash})=>drawLine(s,dash));
    // Ribbons for lit series
    if (showCI&&!small){
      allSeriesEntries.filter(({s})=>s.isLit).forEach(({s,dash})=>drawRibbon(s,dash));
    }
    // Lines for lit series — always on top of all ribbons
    allSeriesEntries.filter(({s})=>s.isLit).forEach(({s,dash})=>drawLine(s,dash));
    // Dots + hit areas topmost
    allSeriesEntries.forEach(({s,label})=>drawDots(s,label));

    if (!small) drawBSKey(g,iW,iH,showBaseline,
      scenSeriesList.map(({name,dash,label})=>{const gi=allScenarioNames.indexOf(name);return{name,dash,label,colour:isCategorical?TEXT_M:NUMERIC_SCEN_COLOURS[gi%NUMERIC_SCEN_COLOURS.length]};}),
      isCategorical?TEXT_M:NUMERIC_BASE_COLOUR);

  },[baseData,scenData,colourMap,highlighted,yDomain,W,H,isCategorical,enabledVarVals,small,selectedYear,onYearClick,showBaseline,showScenario,isStratified,stratValues,enabledStrats,varValues,isCatStrat,showCI,varLabel,viewBy,scenarioMap,enabledScenarios,allScenarioNames]);

  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   STACKED BAR CHART
   Scenario: slightly transparent solid fill + hatch overlay + border
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Stacked composition-over-time chart for categorical variables (each
 * year's stack of segments sums to 100%). Baseline is a solid-filled stack;
 * Scenario is the same stack drawn with reduced opacity plus a diagonal
 * hatch overlay (via drawHatchClipped) — the "full vs. hatched fill" half
 * of the dashboard's Baseline/Scenario visual convention, since a stacked
 * bar chart has no natural "dashed line" equivalent.
 *
 * Not used for numeric variables — those get a solid teal LineChart instead
 * (a stacked bar of a single numeric mean wouldn't mean anything).
 *
 * @param {object} props - see LineChart's JSDoc for shared prop meanings (svgRef, baseData, scenData, colourMap, highlighted, isCategorical, varValues, enabledVarVals, showBaseline, showScenario, width, small)
 * @param {string} [props.patId] - unique id fragment for this chart's hatch-pattern clipPath ids, so multiple stacked bar charts on the page (e.g. small multiples) don't collide
 * @param {number[]} [props.allYears] - global year range across every stratum — see LineChart's JSDoc for why this matters for small-multiple panels specifically
 * @param {string} [props.varLabel] - the target variable's display name — see LineChart's JSDoc for how this feeds stratLabel() scoping and the y-axis label
 */
function StackedBarChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,varValues,enabledVarVals,showBaseline,showScenario,width,small,patId="",allYears:allYearsProp,varLabel="",
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  const mar=small?M_SM:M;
  const H=small?CHART_H_SM:CHART_H;
  const W=small?width:width;  // match LineChart — no MAX_W cap
  const allLit=highlighted.size===0;

  useEffect(()=>{
    const svg=d3.select(svgRef.current); svg.selectAll("*").remove();
    const iW=W-mar.left-mar.right, iH=H-mar.top-mar.bottom;
    if (iW<10) return;
    svg.attr("width",W).attr("height",H);
    const g=svg.append("g").attr("transform",`translate(${mar.left},${mar.top})`);
    const filteredVV=varValues.filter(v=>enabledVarVals.has(v));
    if (!filteredVV.length) return;
    // Build ordered list of enabled scenarios with their hatch angle
    const scenEntries = scenarioMap && scenarioMap.size > 0
      ? allScenarioNames.filter(n=>enabledScenarios?.has(n)).map((name)=>{const gi=allScenarioNames.indexOf(name);return({
          name, label:scenarioLabel(name), rows:scenarioMap.get(name)??[],
          hatchAngle:45, fillStyle:gi===0?"dot":"hatch", gi,
          scenColour:isCategorical?null:NUMERIC_SCEN_COLOURS[gi%NUMERIC_SCEN_COLOURS.length],
        });})
      : (showScenario?[{name:"scenario",label:"Scenario",rows:scenData,hatchAngle:45,fillStyle:"dot",gi:0,scenColour:isCategorical?null:NUMERIC_SCEN_COLOURS[0]}]:[]);
    const innerKeys=[]; if (showBaseline) innerKeys.push("baseline");
    scenEntries.forEach(({name})=>innerKeys.push(name));
    if (!innerKeys.length) return;
    const allYears=allYearsProp&&allYearsProp.length?allYearsProp:[...new Set([...baseData,...scenData].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b);
    const buildStack=(rows)=>allYears.map(yr=>{
      // Filter to Overall rows only — strat-specific rows (from other views)
      // can co-exist in the same data array and would inflate the shares if
      // included here.
      const yearRows=rows.filter(d=>d.year===yr&&filteredVV.includes(d.variable_value)&&d.stratifier_value==="Overall");
      let acc=0;
      return filteredVV.map(vv=>{
        const r=yearRows.find(d=>d.variable_value===vv);
        const val=r&&!isNaN(r.mean_value)?r.mean_value:0;
        const seg={year:yr,vv,val,y0:acc,y1:acc+val,row:r}; acc+=val; return seg;
      });
    });
    const baseStack=buildStack(baseData);
    const yScale=d3.scaleLinear().domain([0,1]).range([iH,0]).clamp(false);
    const xOuter=d3.scaleBand().domain(allYears.map(String)).range([0,iW]).paddingInner(0.2).paddingOuter(0.1);
    const xInner=d3.scaleBand().domain(innerKeys).range([0,xOuter.bandwidth()]).paddingInner(0.06);
    g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xOuter).tickFormat(d3.format("d")).tickSize(3))
      .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#e2ddd5");});
    if (!small) g.append("text").attr("x",iW/2).attr("y",iH+44).attr("text-anchor","middle").style("font-size",FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text("Year");
    applyYAxis(g,yScale,iW,iH,true,small,yAxisLabel(varLabel,true));

    const drawStack=(stack,key,isBase,scenLbl="Scenario",hatchAngle=45,fillStyle="hatch",scenColour=null)=>{
      stack.forEach(yearSegs=>{
        const yr=yearSegs[0]?.year, ox=xOuter(String(yr));
        if (ox===undefined) return;
        const bx=xInner(key), bw=xInner.bandwidth();
        yearSegs.forEach(seg=>{
          if (!seg.val) return;
          const isLit=allLit||highlighted.has(seg.vv);
          const colour=scenColour||(colourMap[seg.vv]||GREY);
          const baseC=isBase?(isCategorical?(colourMap[seg.vv]||GREY):NUMERIC_BASE_COLOUR):colour;
          const fc=isLit?baseC:GREY;
          const barY=yScale(seg.y1), barH=Math.abs(yScale(seg.y0)-yScale(seg.y1));
          const bh=Math.max(0.5,barH);
          const ttContent={title:`${addSpaces(stratLabel(seg.vv,varLabel))}`,lines:[`\n${isBase?"Baseline":scenLbl}: ${fmt(seg.val,true)}`+(seg.row&&!isNaN(seg.row.lower_ci)?`\n95% CI: [${fmt(seg.row.lower_ci,true)}, ${fmt(seg.row.upper_ci,true)}]`:"")+fmtSample(seg.row)+`\nYear: ${yr}`]};
          if (isBase){
            g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",bh)
              .attr("fill",fc).attr("opacity",isLit?0.88:0.18)
              .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
          } else {
            g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",bh)
              .attr("fill",fc).attr("opacity",isLit?0.32:0.07);
            if (fillStyle==="dot") drawDotPattern(svg,g,ox+bx,barY,bw,bh,fc,isLit?0.7:0.15,5);
            else drawHatchClipped(svg,g,ox+bx,barY,bw,bh,fc,isLit?0.55:0.1,4,hatchAngle);
            g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",bh)
              .attr("fill","none").attr("stroke",fc).attr("stroke-width",1).attr("opacity",isLit?0.65:0.12)
              .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
          }
        });
      });
    };
    if (showBaseline) drawStack(baseStack,"baseline",true);
    scenEntries.forEach(({name,label,rows,hatchAngle,fillStyle,scenColour})=>{
      const stack=buildStack(rows);
      drawStack(stack,name,false,label,hatchAngle,fillStyle,scenColour);
      // Tooltip overlay pass
      stack.forEach(yearSegs=>{
        const yr=yearSegs[0]?.year, ox=xOuter(String(yr));
        if (ox===undefined) return;
        const bx=xInner(name), bw=xInner.bandwidth();
        yearSegs.forEach(seg=>{
          if (!seg.val) return;
          const isLit=allLit||highlighted.has(seg.vv);
          const colour=colourMap[seg.vv]||GREY, fc=isLit?colour:GREY;
          const barY=yScale(seg.y1), barH=Math.abs(yScale(seg.y0)-yScale(seg.y1));
          const ttContent={title:`${addSpaces(stratLabel(seg.vv,varLabel))}`,lines:[`\n${label}: ${fmt(seg.val,true)}`+(seg.row&&!isNaN(seg.row.lower_ci)?`\n95% CI: [${fmt(seg.row.lower_ci,true)}, ${fmt(seg.row.upper_ci,true)}]`:"")+fmtSample(seg.row)+`\nYear: ${yr}`]};
          g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",Math.max(0.5,barH))
            .attr("fill","transparent")
            .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        });
      });
    });
    if (!small) drawBSKey(g,iW,iH,showBaseline,scenEntries.map(({name,label})=>({name,dash:"none",label})));
  },[baseData,scenData,colourMap,highlighted,W,H,varValues,enabledVarVals,small,showBaseline,showScenario,patId,varLabel,scenarioMap,enabledScenarios,allScenarioNames]);
  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   GROUPED BAR CHART — cross-section
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Baseline-vs-Scenario comparison at a single point in time (either one
 * pinned year, or averaged across all years — see CrossSectionPanel/
 * averageAcrossYears). One group of bars per variable value, with a
 * Baseline bar and a Scenario bar side-by-side in each group, plus
 * error-bar whiskers showing the 95% CI — this is also where the 95% CI
 * first appears in a bar-chart tooltip (see the ttHtml construction
 * inside), which StackedBarChart's tooltips were later brought in line
 * with.
 *
 * When `isStratified`, this becomes a "combined" cross-section instead —
 * everything in ONE bar chart rather than split into separate per-stratum
 * panels. (A per-stratum panel grid still exists, but only for each
 * individual small-multiples LINE panel's own click-to-drill-down
 * cross-section — see CrossSectionBarPanel and SmallMultiplesPanel — since
 * there each panel already represents a single stratum on its own.
 * CrossSectionPanel below, which backs the Overall/Combined layouts, uses
 * this combined mode instead.) The x-axis groups by STRATUM first (so
 * reading left-to-right compares strata, matching the combined LINE
 * chart's own "one chart, everything overlaid" spirit), and within each
 * stratum's cluster, bars are further grouped by variable_value (colour)
 * and Baseline/Scenario (solid vs hatched), same visual conventions as the
 * non-stratified case just one level deeper.
 *
 * @param {object} props - see LineChart/StackedBarChart JSDoc for shared prop meanings
 * @param {[number,number]} props.yDomain
 * @param {number|"Average"} [props.year] - which year's cross-section to show
 * @param {string} [props.patId] - unique hatch-pattern id fragment, as in StackedBarChart
 * @param {object} [props.missingBase] - for numeric variables, this cross-section's Baseline "Missing" row (if any), appended to every Baseline bar's tooltip (non-stratified only)
 * @param {object} [props.missingScen] - same, for Scenario (non-stratified only)
 * @param {string} [props.varLabel] - the target variable's display name — see LineChart's JSDoc for how this feeds stratLabel() scoping and the y-axis label
 * @param {boolean} [props.isStratified] - renders the "combined" (stratum-grouped) layout described above instead of the plain variable-value-only one
 * @param {string[]} [props.stratValues] - stratifier's possible values, if stratified
 * @param {Set<string>} [props.enabledStrats] - which stratum values are toggled on (Filter Stratifiers)
 * @param {string} [props.viewBy] - active stratifier's display name, for stratLabel() scoping
 */
function GroupedBarChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,yDomain,varValues,enabledVarVals,showBaseline,showScenario,width,small,year,patId="",missingBase=null,missingScen=null,varLabel="",
    isStratified=false,stratValues=[],enabledStrats=new Set(),viewBy="",
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  const mar=small?M_SM:M;

  // ── Dynamic label geometry ─────────────────────────────────────────────────
  // Use the full available width so bars have room and labels don't crowd.
  const W = small ? width : width;

  // Estimate band width after allocating margins and d3 band padding.
  // xOuter uses paddingInner 0.28 (non-stratified) or 0.35 (stratified),
  // so multiply by (1 - padding) to get the actual bandwidth available
  // for labels — this is what prevents labels overrunning adjacent bars.
  const estIW = Math.max(60, W - mar.left - mar.right);
  const nVV = Math.max(1, varValues.filter(v=>enabledVarVals.has(v)).length);
  const nSV = Math.max(1, stratValues.filter(v=>enabledStrats.has(v)).length);
  const nGroups = isStratified ? nSV : nVV;
  const paddingFactor = isStratified ? (1 - 0.35) : (1 - 0.28);
  // estBandW = the width of one outer band (one label slot)
  const estBandW = (estIW / nGroups) * paddingFactor;

  // Font: clamp 8–11px based on band width
  const labelFontSz = Math.min(11, Math.max(8, Math.floor(estBandW * 0.22)));
  // Characters per line: band width / approx px-per-char
  const maxCharsPerLine = Math.max(4, Math.floor(estBandW / (labelFontSz * 0.62)));

  // Compute the worst-case number of label lines across all visible values
  const wrapCount = (label) => {
    const words = label.split(" ");
    let lines = 0, cur = "";
    for (const w of words) {
      if (cur && (cur + " " + w).length > maxCharsPerLine) { lines++; cur = w; }
      else { cur = cur ? cur + " " + w : w; }
    }
    return lines + 1;
  };
  const maxLines = small ? 1 : Math.max(1, ...( isStratified
    ? stratValues.filter(v=>enabledStrats.has(v)).map(v=>wrapCount(addSpaces(stratLabel(v,viewBy))))
    : varValues.filter(v=>enabledVarVals.has(v)).map(v=>wrapCount(addSpaces(stratLabel(v,varValues[0]||""))))
  ));
  // Bottom margin: must fit the BSKey legend (at iH+52) plus x-axis labels below it.
  // Keep iH the same as LineChart (CHART_H - mar.top - mar.bottom = 316) so the
  // BSKey legend sits on the same y-line across both chart types.
  // Labels sit below the legend, so extra lines grow the total SVG height downward.
  const lineHeightPx = labelFontSz * 1.35;
  // Base bottom = same as M.bottom (70) so iH matches LineChart; add extra per label line beyond 1.
  const extraLabelPx = small ? 0 : Math.max(0, (maxLines - 1) * lineHeightPx);
  const bottomMargin = small ? 46 : mar.bottom + extraLabelPx;
  const MB = { ...mar, bottom: bottomMargin };
  const H = small ? CHART_H_SM : CHART_H + extraLabelPx;
  const allLit=highlighted.size===0;
  useEffect(()=>{
    const svg=d3.select(svgRef.current); svg.selectAll("*").remove();
    const iW=W-MB.left-MB.right, iH=H-MB.top-MB.bottom;
    if (iW<10) return;
    svg.attr("width",W).attr("height",H);
    const g=svg.append("g").attr("transform",`translate(${MB.left},${MB.top})`);
    const filteredVV=varValues.filter(v=>enabledVarVals.has(v));
    if (!filteredVV.length) return;
    // Build ordered list of enabled scenarios with their data and hatch angle
    const scenEntries = scenarioMap && scenarioMap.size > 0
      ? allScenarioNames.filter(n=>enabledScenarios?.has(n)).map((name)=>{const gi=allScenarioNames.indexOf(name);return({
          name, label:scenarioLabel(name), rows:scenarioMap.get(name)??[],
          hatchAngle:45, fillStyle:gi===0?"dot":"hatch", gi,
          scenColour:isCategorical?null:NUMERIC_SCEN_COLOURS[gi%NUMERIC_SCEN_COLOURS.length],
        });})
      : (showScenario?[{name:"scenario",label:"Scenario",rows:scenData,hatchAngle:45,fillStyle:"dot",gi:0,scenColour:isCategorical?null:NUMERIC_SCEN_COLOURS[0]}]:[]);
    const innerKeys=[]; if (showBaseline) innerKeys.push("baseline");
    scenEntries.forEach(({name})=>innerKeys.push(name));
    if (!innerKeys.length) return;

    // ── Stratified ("combined") layout — everything in one chart ───────────
    if (isStratified) {
      const filteredSV=stratValues.filter(sv=>enabledStrats.has(sv));
      if (!filteredSV.length) return;
      const xOuter=d3.scaleBand().domain(filteredSV).range([0,iW]).paddingInner(0.35).paddingOuter(0.1);
      const xMid=d3.scaleBand().domain(filteredVV).range([0,xOuter.bandwidth()]).paddingInner(0.15);
      const xInner=d3.scaleBand().domain(innerKeys).range([0,xMid.bandwidth()]).paddingInner(0.08);
      const yScale=d3.scaleLinear().domain(yDomain).range([iH,0]).clamp(false);
      g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xOuter).tickFormat(()=>"").tickSize(3))
        .call(ax=>{ax.select(".domain").remove();ax.selectAll(".tick line").style("stroke","#e2ddd5");});
      // One (up-to-2-line) label per stratum, same wrap approach as the non-stratified x labels below
      filteredSV.forEach(sv=>{
        const fullLabel=addSpaces(stratLabel(sv,viewBy));
        const cx=(xOuter(sv)||0)+xOuter.bandwidth()/2;
        const words=fullLabel.split(" "); const mid=Math.ceil(words.length/2);
        const line1=words.slice(0,mid).join(" "), line2=words.slice(mid).join(" ");
        const lbl=g.append("text").attr("text-anchor","middle")
          .attr("x",cx).attr("y",iH+14)
          .style("font-size",`${labelFontSz}px`).style("fill",TEXT_S).style("font-family",PUB_FONT);
        lbl.append("tspan").attr("x",cx).attr("dy","0").text(line1);
        if (line2) lbl.append("tspan").attr("x",cx).attr("dy","1.2em").text(line2);
      });
      applyYAxis(g,yScale,iW,iH,isCategorical,small,yAxisLabel(varLabel,isCategorical));
      const y0=yScale(Math.max(0,yDomain[0]>0?yDomain[0]:0));
      const getRow=(rows,sv,vv)=>{const r=rows.find(d=>d.stratifier_value===sv&&d.variable_value===vv);return r&&!isNaN(r.mean_value)?r:null;};


      filteredSV.forEach(sv=>{
        const ox=xOuter(sv)||0;
        filteredVV.forEach(vv=>{
          const colour=colourMap[vv]||GREY;
          const isLit=allLit||highlighted.has(vv)||highlighted.has(sv);
          const fc=isLit?colour:GREY;
          const mx=xMid(vv)||0, bw=xInner.bandwidth();
          const drawBar=(rows,key,isBase,lbl="Scenario",hatchAngle=45,fillStyle="hatch",scenColour=null)=>{
            const row=rows.find(d=>d.stratifier_value===sv&&d.variable_value===vv);
            if (!row||isNaN(row.mean_value)) return;
            const bx=xInner(key), barY=yScale(row.mean_value), barH=Math.abs(y0-barY);
            const barColour=isBase?(isCategorical?fc:(isLit?NUMERIC_BASE_COLOUR:GREY)):(scenColour&&isLit?scenColour:fc);
            const ttContent={title:`${addSpaces(stratLabel(vv,varLabel))} — ${addSpaces(stratLabel(sv,viewBy))}`,lines:[`\n${lbl}: ${fmt(row.mean_value,isCategorical)}`+(!isNaN(row.lower_ci)?`\n95% CI: [${fmt(row.lower_ci,isCategorical)}, ${fmt(row.upper_ci,isCategorical)}]`:"")+fmtSample(row)+(year?`\nYear: ${year}`:"")]};
            const gx=ox+mx+bx;
            if (isBase){
              g.append("rect").attr("x",gx).attr("y",Math.min(y0,barY)).attr("width",bw).attr("height",Math.max(1,barH)).attr("fill",barColour).attr("opacity",isLit?0.85:0.18).attr("rx",2).on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
            } else {
              const _gy=Math.min(y0,barY), _gh=Math.max(1,barH);
              g.append("rect").attr("x",gx).attr("y",_gy).attr("width",bw).attr("height",_gh).attr("fill",barColour).attr("opacity",isLit?0.32:0.07).attr("rx",2);
              if (fillStyle==="dot") drawDotPattern(svg,g,gx,_gy,bw,_gh,barColour,isLit?0.7:0.15,5);
              else drawHatchClipped(svg,g,gx,_gy,bw,_gh,barColour,isLit?0.55:0.1,4,hatchAngle);
              g.append("rect").attr("x",gx).attr("y",_gy).attr("width",bw).attr("height",_gh).attr("fill","none").attr("stroke",barColour).attr("stroke-width",1.5).attr("opacity",isLit?0.9:0.2).attr("rx",2)
                .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
            }
            if (!isNaN(row.lower_ci)&&!isNaN(row.upper_ci)&&isLit){
              const ciColour=d3.color(barColour).darker(0.8).toString();
              const cx=gx+bw/2;
              g.append("line").attr("x1",cx).attr("x2",cx).attr("y1",yScale(row.lower_ci)).attr("y2",yScale(row.upper_ci)).attr("stroke",ciColour).attr("stroke-width",1.5).attr("opacity",0.85);
              [yScale(row.upper_ci),yScale(row.lower_ci)].forEach(ty=>{g.append("line").attr("x1",cx-3).attr("x2",cx+3).attr("y1",ty).attr("y2",ty).attr("stroke",ciColour).attr("stroke-width",1.5).attr("opacity",0.85);});
            }
          };
          if (showBaseline) drawBar(baseData,"baseline",true,"Baseline",0,"hatch",null);
          scenEntries.forEach(({name,label,rows,hatchAngle,fillStyle,scenColour})=>drawBar(rows,name,false,label,hatchAngle,fillStyle,scenColour));
        });
      });
      // Scenario tooltip overlays
      scenEntries.forEach(({name,label,rows})=>{
        filteredSV.forEach(sv=>{
          const ox=xOuter(sv)||0;
          filteredVV.forEach(vv=>{
            const mx=xMid(vv)||0, bx=xInner(name), bw=xInner.bandwidth();
            if (bx===undefined) return;
            const sRow=rows.find(d=>d.stratifier_value===sv&&d.variable_value===vv);
            if (!sRow||isNaN(sRow.mean_value)) return;
            const barY=yScale(sRow.mean_value), y0loc=yScale(Math.max(0,yDomain[0]>0?yDomain[0]:0));
            const barH=Math.abs(y0loc-barY);
            const ttContent={title:`${addSpaces(stratLabel(vv,varLabel))} — ${addSpaces(stratLabel(sv,viewBy))}`,lines:[`\n${label}: ${fmt(sRow.mean_value,isCategorical)}`+(!isNaN(sRow.lower_ci)?`\n95% CI: [${fmt(sRow.lower_ci,isCategorical)}, ${fmt(sRow.upper_ci,isCategorical)}]`:"")+fmtSample(sRow)+(year?`\nYear: ${year}`:"")]};
            g.append("rect").attr("x",ox+mx+bx).attr("y",Math.min(y0loc,barY)).attr("width",bw).attr("height",Math.max(1,barH))
              .attr("fill","transparent")
              .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
          });
        });
      });
      if (!small) drawBSKey(g,iW,iH,showBaseline,scenEntries.map(({name,label,gi})=>({name,dash:SCENARIO_DASHES[Math.max(gi,0)%SCENARIO_DASHES.length],label})));
      return;
    }

    // ── Non-stratified layout — one group of bars per variable value ───────
    const xOuter=d3.scaleBand().domain(filteredVV).range([0,iW]).paddingInner(0.28).paddingOuter(0.1);
    const xInner=d3.scaleBand().domain(innerKeys).range([0,xOuter.bandwidth()]).paddingInner(0.08);
    const yScale=d3.scaleLinear().domain(yDomain).range([iH,0]).clamp(false);
    g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xOuter).tickFormat(()=>"").tickSize(3))
      .call(ax=>{ax.select(".domain").remove();ax.selectAll(".tick line").style("stroke","#e2ddd5");});
    // X-axis labels: always horizontal, wrapped across as many lines as needed.
    // Split into ~maxChars-per-line chunks at word boundaries so long category
    // names (e.g. Household Type) never overlap with each other or the legend.
    xOuter.domain().forEach(vv=>{
      const fullLabel=addSpaces(stratLabel(vv,varLabel));
      const cx=(xOuter(vv)||0)+xOuter.bandwidth()/2;
      const words=fullLabel.split(" ");
      const lines=[]; let cur="";
      for (const w of words){
        if (cur&&(cur+" "+w).length>maxCharsPerLine){ lines.push(cur); cur=w; }
        else { cur=cur?cur+" "+w:w; }
      }
      if (cur) lines.push(cur);
      const lbl=g.append("text").attr("text-anchor","middle")
        .attr("x",cx).attr("y",iH+14)
        .style("font-size",`${labelFontSz}px`).style("fill",TEXT_S).style("font-family",PUB_FONT);
      lines.forEach((line,i)=>{
        lbl.append("tspan").attr("x",cx).attr("dy",i===0?"0":"1.15em").text(line);
      });
    });
    applyYAxis(g,yScale,iW,iH,isCategorical,small,yAxisLabel(varLabel,isCategorical));
    const y0=yScale(Math.max(0,yDomain[0]>0?yDomain[0]:0));
    const getRow=(rows,vv)=>{const r=rows.find(d=>d.variable_value===vv);return r&&!isNaN(r.mean_value)?r:null;};
    filteredVV.forEach(vv=>{
      const colour=colourMap[vv]||GREY, isLit=allLit||highlighted.has(vv), fc=isLit?colour:GREY;
      const ox=xOuter(vv), bw=xInner.bandwidth();
      const drawBar=(rows,key,isBase,lbl="Scenario",hatchAngle=45,fillStyle="hatch",scenColour=null)=>{
        const row=getRow(rows,vv); if (!row) return;
        const bx=xInner(key), barY=yScale(row.mean_value), barH=Math.abs(y0-barY);
        const barColour=isBase?(isCategorical?fc:(isLit?NUMERIC_BASE_COLOUR:GREY)):(scenColour&&isLit?scenColour:fc);
        const ttContent={title:`${addSpaces(stratLabel(vv,varLabel))}`,lines:[`\n${lbl}: ${fmt(row.mean_value,isCategorical)}`+(!isNaN(row.lower_ci)?`\n95% CI: [${fmt(row.lower_ci,isCategorical)}, ${fmt(row.upper_ci,isCategorical)}]`:"")+fmtSample(row)+fmtMissing(isBase?missingBase:null)+(year?`\nYear: ${year}`:"")]};
        if (isBase){
          g.append("rect").attr("x",ox+bx).attr("y",Math.min(y0,barY)).attr("width",bw).attr("height",Math.max(1,barH)).attr("fill",barColour).attr("opacity",isLit?0.85:0.18).attr("rx",2).on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        } else {
          const _gx=ox+bx, _gy=Math.min(y0,barY), _gh=Math.max(1,barH);
          g.append("rect").attr("x",_gx).attr("y",_gy).attr("width",bw).attr("height",_gh).attr("fill",barColour).attr("opacity",isLit?0.32:0.07).attr("rx",2);
          if (fillStyle==="dot") drawDotPattern(svg,g,_gx,_gy,bw,_gh,barColour,isLit?0.7:0.15,5);
          else drawHatchClipped(svg,g,_gx,_gy,bw,_gh,barColour,isLit?0.55:0.1,4,hatchAngle);
          g.append("rect").attr("x",_gx).attr("y",_gy).attr("width",bw).attr("height",_gh).attr("fill","none").attr("stroke",barColour).attr("stroke-width",1.5).attr("opacity",isLit?0.9:0.2).attr("rx",2)
            .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        }
        if (!isNaN(row.lower_ci)&&!isNaN(row.upper_ci)&&isLit){
          const ciColour=d3.color(barColour).darker(0.8).toString();
          const cx=ox+bx+bw/2;
          g.append("line").attr("x1",cx).attr("x2",cx).attr("y1",yScale(row.lower_ci)).attr("y2",yScale(row.upper_ci)).attr("stroke",ciColour).attr("stroke-width",1.5).attr("opacity",0.85);
          [yScale(row.upper_ci),yScale(row.lower_ci)].forEach(ty=>{g.append("line").attr("x1",cx-3).attr("x2",cx+3).attr("y1",ty).attr("y2",ty).attr("stroke",ciColour).attr("stroke-width",1.5).attr("opacity",0.85);});
        }
      };
      if (showBaseline) drawBar(baseData,"baseline",true,"Baseline",0,"hatch",null);
      scenEntries.forEach(({name,label,rows,hatchAngle,fillStyle,scenColour})=>drawBar(rows,name,false,label,hatchAngle,fillStyle,scenColour));
    });
    // Scenario tooltip overlays
    scenEntries.forEach(({name,label,rows})=>{
      filteredVV.forEach(vv=>{
        const ox=xOuter(vv), bw=xInner.bandwidth();
        const bx=xInner(name);
        if (bx===undefined) return;
        const sRow=rows.find(d=>d.variable_value===vv);
        if (!sRow||isNaN(sRow.mean_value)) return;
        const barY=yScale(sRow.mean_value), y0loc=yScale(Math.max(0,yDomain[0]>0?yDomain[0]:0));
        const barH=Math.abs(y0loc-barY);
        const ttContent={title:`${addSpaces(stratLabel(vv,varLabel))}`,lines:[`\n${label}: ${fmt(sRow.mean_value,isCategorical)}`+(!isNaN(sRow.lower_ci)?`\n95% CI: [${fmt(sRow.lower_ci,isCategorical)}, ${fmt(sRow.upper_ci,isCategorical)}]`:"")+fmtSample(sRow)+(year?`\nYear: ${year}`:"")]};
        g.append("rect").attr("x",ox+bx).attr("y",Math.min(y0loc,barY)).attr("width",bw).attr("height",Math.max(1,barH))
          .attr("fill","transparent")
          .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
      });
    });
    if (!small) drawBSKey(g,iW,iH,showBaseline,scenEntries.map(({name,label},i)=>({name,dash:SCENARIO_DASHES[i%SCENARIO_DASHES.length],label})));
  },[baseData,scenData,colourMap,highlighted,yDomain,W,H,isCategorical,varValues,enabledVarVals,small,year,patId,showBaseline,showScenario,missingBase,missingScen,varLabel,isStratified,stratValues,enabledStrats,viewBy,scenarioMap,enabledScenarios,allScenarioNames,labelFontSz,maxCharsPerLine]);
  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   DELTA CHART
═════════════════════════════════════════════════════════════════════════════ */
/**
 * The Δ Baseline → Scenario line chart: plots (Scenario − Baseline) over
 * time directly, rather than making the reader compare two separate lines
 * themselves. Zero is "no effect"; consistently above/below zero means the
 * Scenario increases/decreases that outcome relative to Baseline.
 *
 * Shares the LineChart's colour=variable_value, symbol/width=stratifier_value
 * convention when stratified, and the same "densify missing years so the
 * line breaks rather than bridges a gap" + "CI ribbons drawn behind all
 * lines" approach — see LineChart's JSDoc for the fuller explanation of both.
 *
 * @param {object} props
 * @param {object[]} props.deltaData - pre-computed delta rows (Scenario minus Baseline), not raw baseline/scenario rows
 * @param {string} [props.varLabel] - the target variable's display name — see LineChart's JSDoc for how this feeds stratLabel() scoping and the y-axis label
 * @param {object} ...rest - see LineChart's JSDoc for the remaining shared props (colourMap, highlighted, isCategorical, varValues, enabledVarVals, stratValues, enabledStrats, viewBy, width)
 */
function DeltaChart({svgRef,deltaData,colourMap,highlighted,isCategorical,
    varValues,enabledVarVals,stratValues=[],enabledStrats=new Set(),viewBy="",width,varLabel="",allScenarioNames=[],
    onYearClick,selectedYear}){
  const H=CHART_H, W=Math.min(width,MAX_W);
  const allLit=highlighted.size===0;
  const isStratified=viewBy!=="Overall"&&stratValues.length>0;
  const stratDef=useMemo(()=>getStratifierDef(viewBy),[viewBy]);
  const isCatStrat=stratDef?.type==="categorical";

  useEffect(()=>{
    const svg=d3.select(svgRef.current); svg.selectAll("*").remove();
    const iW=W-M.left-M.right, iH=H-M.top-M.bottom;
    if (iW<10||!deltaData?.length) return;
    svg.attr("width",W).attr("height",H);
    const g=svg.append("g").attr("transform",`translate(${M.left},${M.top})`);
    // "raw" = every row in scope regardless of whether the delta is valid —
    // this is what allYears must be built from, so a year isn't dropped from
    // the x-axis entirely just because EVERY series happens to be suppressed
    // that year (which "filtered" alone can't tell apart from "this year
    // never existed"). "filtered" (valid-only) is still what feeds the
    // y-domain and each series' own points — densify() below re-inserts a
    // NaN placeholder for any year a given series is missing from filtered,
    // using allYears as the source of truth for which years are real.
    const raw=deltaData.filter(d=>enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):true));
    if (!raw.length) return;
    const filtered=raw.filter(d=>!isNaN(d.mean_value));
    const allYears=[...new Set(raw.map(d=>d.year))].sort((a,b)=>a-b);
    const vals=filtered.flatMap(d=>[isNaN(d.lower_ci)?d.mean_value:d.lower_ci,isNaN(d.upper_ci)?d.mean_value:d.upper_ci]).filter(v=>!isNaN(v));
    const dataMin=d3.min(vals)??0;
    const dataMax=d3.max(vals)??0.1;
    const pad=Math.max(Math.abs(dataMax-dataMin)*0.12, Math.abs(dataMax)*0.05, 1e-6);
    // Always include zero so the reference line is visible
    const yLo=Math.min(dataMin-pad, 0);
    const yHi=Math.max(dataMax+pad, 0);
    const xScale=d3.scaleLinear().domain(safeYearDomain(allYears)).range([0,iW]);
    const yScale=d3.scaleLinear().domain([yLo,yHi]).range([iH,0]).clamp(false);
    applyTimeXAxis(g,xScale,iH,false,allYears);
    applyYAxis(g,yScale,iW,iH,isCategorical,false,yAxisLabel(varLabel,isCategorical,true));
    g.append("line").attr("x1",0).attr("x2",iW).attr("y1",yScale(0)).attr("y2",yScale(0)).attr("stroke","#64748b").attr("stroke-width",1).attr("stroke-dasharray","4,3");

    // Selected year indicator
    if (selectedYear) {
      const sx=xScale(selectedYear);
      g.append("line").attr("x1",sx).attr("x2",sx).attr("y1",0).attr("y2",iH)
        .attr("stroke",TEAL).attr("stroke-width",1.5).attr("stroke-dasharray","3,3").attr("opacity",0.7).style("pointer-events","none");
      g.append("circle").attr("cx",sx).attr("cy",0).attr("r",4).attr("fill",TEAL).attr("opacity",0.8).style("pointer-events","none");
    }
    // Invisible click zones per year
    if (onYearClick) {
      allYears.forEach(yr=>{
        g.append("rect").attr("x",xScale(yr)-10).attr("y",0).attr("width",20).attr("height",iH)
          .attr("fill","transparent").style("cursor","pointer")
          .on("click",()=>onYearClick(yr===selectedYear?null:yr));
      });
    }
    const lineFn=d3.line().defined(d=>!isNaN(d.mean_value)).x(d=>xScale(d.year)).y(d=>yScale(d.mean_value)).curve(d3.curveMonotoneX);

    // Same reasoning as LineChart: fill any year missing from a series with an
    // explicit NaN point so .defined() breaks the line there instead of a
    // straight connector bridging across the gap.
    const densify=(pts)=>{
      const byYear=new Map(pts.map(d=>[d.year,d]));
      return allYears.map(yr=>byYear.get(yr)||{year:yr,mean_value:NaN,lower_ci:NaN,upper_ci:NaN});
    };

    // Get distinct scenario names present in the data (preserving order)
    const scenarioNames=[...new Set(deltaData.map(d=>d.scenarioName).filter(Boolean))];
    // If no scenarioName tags (single-scenario legacy path), treat all as one unnamed scenario
    const useScenDash=scenarioNames.length>1;

    // Build series: one set per scenario, within each scenario strat×var or just varVal
    const series=[];
    const buildForScen=(scenRows,scenIdx)=>{
      const filtScen=scenRows.filter(d=>!isNaN(d.mean_value));
      const dash=useScenDash?SCENARIO_DASHES[scenIdx%SCENARIO_DASHES.length]:"none";
      // Use the global allScenarioNames order for colour index so colours
      // match the line chart and toggle buttons exactly.
      const sName=scenarioNames[scenIdx];
      const globalIdx=allScenarioNames.indexOf(sName);
      const colourIdx=globalIdx>=0?globalIdx:scenIdx;
      const scenColour=isCategorical?null:NUMERIC_SCEN_COLOURS[colourIdx%NUMERIC_SCEN_COLOURS.length];
      const resolveColour=(vv)=>scenColour||(colourMap[vv]||GREY);
      if (isStratified){
        stratValues.forEach((sv,si)=>{
          if (!enabledStrats.has(sv)) return;
          varValues.forEach(vv=>{
            if (!enabledVarVals.has(vv)) return;
            const pts=filtScen.filter(d=>d.stratifier_value===sv&&d.variable_value===vv);
            if (!pts.length) return;
            const hV=highlighted.has(vv), hS=highlighted.has(sv);
            const hasVarH=[...highlighted].some(h=>varValues.includes(h));
            const hasStratH=[...highlighted].some(h=>stratValues.includes(h));
            const isLit=allLit||(hasVarH&&hasStratH&&hV&&hS)||(hasVarH&&!hasStratH&&hV)||(!hasVarH&&hasStratH&&hS);
            const symIdx=isCatStrat?si%SYMBOLS.length:undefined;
            const strokeW=isCatStrat?2:ORDINAL_WIDTHS[si%ORDINAL_WIDTHS.length];
            const scenLabel=scenarioNames[scenIdx]?` (${scenarioLabel(scenarioNames[scenIdx])})`:""
            series.push({vv,sv,pts:densify(pts),isLit,colour:resolveColour(vv),symIdx,strokeW,dash,label:`${addSpaces(stratLabel(vv,varLabel))} — ${addSpaces(stratLabel(sv,viewBy))}${scenLabel}`});
          });
        });
      } else {
        const grouped=d3.group(filtScen,d=>d.variable_value);
        grouped.forEach((pts,vv)=>{
          if (!enabledVarVals.has(vv)) return;
          const isLit=allLit||highlighted.has(vv);
          const scenLbl=scenarioNames[scenIdx]?` (${scenarioLabel(scenarioNames[scenIdx])})`:""
          series.push({vv,sv:null,pts:densify(pts),isLit,colour:resolveColour(vv),symIdx:undefined,strokeW:2.5,dash,label:`${addSpaces(stratLabel(vv,varLabel))}${scenLbl}`});
        });
      }
    };

    if (scenarioNames.length>0){
      scenarioNames.forEach((sName,si)=>{
        buildForScen(filtered.filter(d=>d.scenarioName===sName),si);
      });
    } else {
      buildForScen(filtered,0);
    }

    // CI bands first — dashed outline for scenarios to match line style
    series.forEach(({pts,isLit,colour,vv,dash})=>{
      const fc=isLit?colour:GREY;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      if (sorted.some(d=>!isNaN(d.lower_ci)&&!isNaN(d.upper_ci))){
        const area=d3.area().defined(d=>!isNaN(d.lower_ci)&&!isNaN(d.upper_ci)).x(d=>xScale(d.year)).y0(d=>yScale(d.lower_ci)).y1(d=>yScale(d.upper_ci)).curve(d3.curveMonotoneX);
        const band=g.append("path").datum(sorted).attr("d",area).attr("fill",fc).attr("opacity",isLit?0.11:0.04).style("pointer-events","none");
        if (dash&&dash!=="none") band.attr("stroke",fc).attr("stroke-width",0.8).attr("stroke-dasharray",dash).attr("stroke-opacity",0.4);
      }
    });
    // Lines + dots
    [...series].sort((a,b)=>a.isLit?1:-1).forEach(({pts,isLit,colour,symIdx,strokeW,dash,label})=>{
      const fc=isLit?colour:GREY, opacity=isLit?1:0.18;
      const sw=isLit?strokeW:0.8;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      g.append("path").datum(sorted).attr("d",lineFn).attr("fill","none").attr("stroke",fc).attr("stroke-width",sw)
        .attr("stroke-dasharray",(dash&&dash!=="none")?dash:"none")
        .attr("opacity",opacity).style("pointer-events","none");
      sorted.filter(d=>!isNaN(d.mean_value)).forEach(d=>{
        const cx=xScale(d.year), cy=yScale(d.mean_value);
        const ttContent={title:`${label}`,lines:[`\nΔ: ${fmtDelta(d.mean_value,isCategorical)}`+(!isNaN(d.lower_ci)?`\n95% UI: [${fmtDelta(d.lower_ci,isCategorical)}, ${fmtDelta(d.upper_ci,isCategorical)}]`:"")+fmtDeltaSample(d)+`\nYear: ${d.year}`]};
        if (symIdx!==undefined){
          const sp=d3.symbol().type(SYMBOLS[symIdx]).size(isLit?48:24)();
          g.append("path").attr("d",sp).attr("transform",`translate(${cx},${cy})`).attr("fill",fc).attr("opacity",opacity).style("pointer-events","none");
        }
        // Invisible hit area for tooltips
        g.append("circle").attr("cx",cx).attr("cy",cy).attr("r",8).attr("fill","transparent")
          .on("mouseover",e=>showTT(ttContent,e)).on("mousemove",moveTT).on("mouseout",hideTT);
      });
    });

    // In-chart legend for multiple scenarios
    if (useScenDash){
      const legY=iH+52, legX=4;
      const skip=g.append("g").attr("class","pub-skip");
      let kx=legX;
      scenarioNames.forEach((sName)=>{
        const gi=allScenarioNames.indexOf(sName); const ci=gi>=0?gi:0;
        const dash=SCENARIO_DASHES[ci%SCENARIO_DASHES.length];
        const lbl=scenarioLabel(sName);
        const c=isCategorical?TEXT_M:NUMERIC_SCEN_COLOURS[ci%NUMERIC_SCEN_COLOURS.length];
        skip.append("line").attr("x1",kx).attr("x2",kx+16).attr("y1",legY).attr("y2",legY)
          .attr("stroke",c).attr("stroke-width",2).attr("stroke-dasharray",dash);
        skip.append("text").attr("x",kx+20).attr("y",legY+4)
          .style("font-size","11px").style("fill",TEXT_M).style("font-family",PUB_FONT).text(lbl);
        kx+=Math.max(90,lbl.length*7+28);
      });
    }
  },[deltaData,colourMap,highlighted,isCategorical,varValues,enabledVarVals,stratValues,enabledStrats,viewBy,isStratified,isCatStrat,W,varLabel,onYearClick,selectedYear]);
  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   PANEL CHART wrapper
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Thin wrapper that forces `small:true` sizing and picks StackedBarChart vs.
 * LineChart based on `chartType` — this is what each cell of the
 * small-multiples grid actually renders. `allYears` is the global year range
 * (see LineChart's JSDoc) — required here specifically since each panel's
 * own baseData/scenData is already scoped to a single stratum.
 * `missingLookup`/`stratValue` (numeric variables only) let each panel's
 * LineChart report the right stratum's missingness in its tooltips despite
 * its own series reporting sv:null internally. `onYearClick`/`selectedYear`
 * are forwarded straight through to LineChart (StackedBarChart ignores
 * them, since a stacked-over-years chart has no single-point-in-time
 * "click a year" interaction) — this is what lets each line panel pin its
 * own year independently, for its own cross-section (see SmallMultiplesPanel).
 * `varLabel`/`viewBy` are forwarded too, for stratLabel() scoping and the
 * y-axis label (see LineChart's JSDoc) — harmless even though small-panel
 * axis labels aren't actually drawn, since it keeps tooltip/legend text
 * correctly scoped either way.
 */
function PanelChart({baseData,scenData,colourMap,highlighted,isCategorical,yDomain,
    varValues,enabledVarVals,showBaseline,showScenario,width,chartType,panelId,allYears,missingLookup,stratValue,onYearClick,selectedYear,varLabel="",viewBy="",
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  const svgRef=useRef();
  const scenProps={scenarioMap,enabledScenarios,allScenarioNames};
  const props={svgRef,baseData,scenData,colourMap,highlighted,isCategorical,varValues,enabledVarVals,showBaseline,showScenario,width,small:true,allYears,varLabel,...scenProps};
  if (chartType==="bar") return <StackedBarChart {...props} patId={panelId}/>;
  return <LineChart {...props} yDomain={yDomain} missingLookup={missingLookup} missingStratValue={stratValue} onYearClick={onYearClick} selectedYear={selectedYear} viewBy={viewBy}/>;
}

function CrossSectionBarPanel({baseData,scenData,colourMap,highlighted,isCategorical,yDomain,
    varValues,enabledVarVals,showBaseline,showScenario,width,year,patId,varLabel="",
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  const svgRef=useRef();
  return <GroupedBarChart svgRef={svgRef} baseData={baseData} scenData={scenData} colourMap={colourMap}
    highlighted={highlighted} isCategorical={isCategorical} yDomain={yDomain} varValues={varValues}
    enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
    width={width} small year={year} patId={patId} varLabel={varLabel}
    scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   SMALL MULTIPLES PANEL — per-panel and download-all
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Lays out one PanelChart per enabled stratum value in a responsive grid
 * (column count adapts to available width via PANEL_MIN_W), each in its own
 * card with its own download buttons, plus "download all panels" PNG/CSV
 * buttons at the top. A stratum whose data is entirely suppressed (every
 * point NaN) renders SmallSampleOverlay instead of an empty/broken chart.
 *
 * @param {object[]} props.allBaseData,props.allScenData - the FULL unfiltered baseline/scenario rows (not just enabled values), used only for the "download all" CSV export so it isn't scoped to the visible panels alone
 * @param {(stratValue:string)=>object} props.pubPropsFactory - builds the buildPublicationSvg() props for one panel's PNG export, given its stratum value
 * @param {string} [props.viewBy] - the active stratifier's display name — used to scope stratLabel() lookups for each panel's stratum-value label (see STRATIFIER_VALUE_LABELS)
 */
function SmallMultiplesPanel({baseData,scenData,stratValues,colourMap,highlighted,
    isCategorical,varValues,enabledVarVals,enabledStrats,showBaseline,showScenario,
    chartType,width,pubPropsFactory,targetVariable,allBaseData,allScenData,missingLookup,viewBy="",
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  const varLabel=addSpaces(targetVariable||"");
  // Which year is pinned in EACH panel's own line chart, keyed by stratum
  // value — deliberately separate from the page-level `selectedYear` used by
  // the Overall/Combined views, so clicking a point in one panel only
  // affects that panel's own cross-section, never any other panel's. Only
  // meaningful for chartType==="line" (a stacked-bar-over-years panel has no
  // "click a single point" interaction).
  const [panelYears,setPanelYears]=useState({});
  // Scale columns and panel width to the number of VISIBLE panels so that
  // filtering strata out makes the remaining panels grow to fill the space.
  // Cap panel width at 520px so a single panel doesn't become enormous.
  const PANEL_MAX_W = 520;
  const visible = stratValues.filter(sv => enabledStrats.has(sv));
  const nVisible = Math.max(1, visible.length);
  const cols = Math.max(1, Math.min(nVisible, Math.floor(width / PANEL_MIN_W)));
  const rawPanelW = Math.floor((width - (cols - 1) * 12) / cols);
  const panelW = Math.min(rawPanelW, PANEL_MAX_W);
  // Shared y-axis across every visible panel — restricted to enabled
  // variable values AND enabled strata (i.e. only the panels/series actually
  // being drawn), so toggling a Filter Variables or Filter Stratifiers chip
  // on/off shrinks or grows this axis instead of leaving it sized for data
  // that's no longer shown anywhere in the grid.
  const allScenRows=useMemo(()=>scenarioMap?[...scenarioMap.values()].flat():scenData,[scenarioMap,scenData]);
  const yDomain=useMemo(
    ()=>buildYDomain([...baseData,...allScenRows].filter(d=>enabledVarVals.has(d.variable_value)&&enabledStrats.has(d.stratifier_value)),isCategorical),
    [baseData,allScenRows,isCategorical,enabledVarVals,enabledStrats]
  );
  // Global year range across ALL strata and scenarios combined.
  const allYears=useMemo(()=>[...new Set([...baseData,...allScenRows].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b),[baseData,allScenRows]);
  const panelSvgRefs=useRef({});

  const handleDownloadAll=useCallback(()=>{
    const slug=slugify(targetVariable||"chart");
    visible.forEach((sv,i)=>{
      setTimeout(()=>{
        const svgEl=panelSvgRefs.current[sv];
        if (svgEl) downloadPublicationPng(svgEl,`${slug}_${slugify(stratLabel(sv,viewBy))}.png`,pubPropsFactory(sv));
      },i*350);
    });
  },[visible,targetVariable,pubPropsFactory,viewBy]);

  const handleDownloadAllCsv=useCallback(()=>{
    const slug=slugify(targetVariable||"chart");
    const allData=[...allBaseData,...allScenData].filter(d=>enabledStrats.has(d.stratifier_value)&&enabledVarVals.has(d.variable_value));
    exportCsv(allData,`${slug}_all_panels.csv`,{isContinuous:!isCategorical});
  },[allBaseData,allScenData,enabledStrats,enabledVarVals,targetVariable]);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginBottom:8,alignItems:"center"}}>
        <span style={{fontSize:11,color:TEXT_S}}>All panels:</span>
        <button onClick={handleDownloadAll} style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ PNG ×{visible.length}</button>
        <button onClick={handleDownloadAllCsv} style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV (all)</button>
      </div>
      {/* Shared y-domain for cross-section bar charts — computed across ALL
          visible strata and ALL pinned years so panels can be compared directly. */}
      {(() => {
        const csFilter=rows=>rows.filter(d=>enabledVarVals.has(d.variable_value));
        const allCsRows=visible.flatMap(sv=>{
          const bR=baseData.filter(d=>d.stratifier_value===sv);
          const sR=scenData.filter(d=>d.stratifier_value===sv);
          const panelScenMap=scenarioMap?new Map([...scenarioMap].map(([name,rows])=>[name,rows.filter(d=>d.stratifier_value===sv)])):null;
          const selYear=panelYears[sv]??null;
          if (!selYear) return [];
          const csBase=csFilter(bR).filter(d=>d.year===selYear);
          const csScenMap=panelScenMap?new Map([...panelScenMap].map(([n,r])=>[n,csFilter(r).filter(d=>d.year===selYear)])):null;
          const csAllScen=csScenMap?[...csScenMap.values()].flat():csFilter(sR).filter(d=>d.year===selYear);
          return [...csBase,...csAllScen];
        });
        const sharedCsYDomain=allCsRows.length>0?buildYDomain(allCsRows,isCategorical):[0,1];

      return (
      <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
        {visible.map(sv=>{
          const bR=baseData.filter(d=>d.stratifier_value===sv);
          const sR=scenData.filter(d=>d.stratifier_value===sv);
          const panelScenMap=scenarioMap?new Map([...scenarioMap].map(([name,rows])=>[name,rows.filter(d=>d.stratifier_value===sv)])):null;
          const allSvRows=[bR,...(panelScenMap?[...panelScenMap.values()]:[sR]).map(r=>r)].flat();
          const suppressed=allSvRows.every(d=>isNaN(d.mean_value));
          const afterRender=(el)=>{if (el){const s=el.querySelector("svg");if(s)panelSvgRefs.current[sv]=s;}};
          const isLine=chartType==="line";
          const selYear=panelYears[sv]??null;
          const onPanelYearClick=isLine?(yr=>setPanelYears(prev=>({...prev,[sv]:prev[sv]===yr?null:yr}))):undefined;
          const csFilter=rows=>rows.filter(d=>enabledVarVals.has(d.variable_value));
          const csBase=isLine&&selYear!=null?csFilter(bR).filter(d=>d.year===selYear):[];
          const csScen=isLine&&selYear!=null?csFilter(sR).filter(d=>d.year===selYear):[];
          const csScenMap=isLine&&selYear!=null&&panelScenMap?new Map([...panelScenMap].map(([n,r])=>[n,csFilter(r).filter(d=>d.year===selYear)])):null;
          const csAllScen=csScenMap?[...csScenMap.values()].flat():csScen;
          return (
            <div key={sv} ref={afterRender} style={{width:panelW,background:BG_CARD,borderRadius:10,padding:"10px 12px",border:"1px solid #f0ece4",position:"relative",flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <p style={{margin:0,fontSize:12,fontWeight:600,color:TEXT_D}}>{addSpaces(stratLabel(sv,viewBy))}</p>
                {!suppressed&&(
                  <div style={{display:"flex",gap:4}}>
                    <DownloadBtn small svgRef={panelSvgRefs} svgKey={sv} filename={`${slugify(targetVariable||"chart")}_${slugify(stratLabel(sv,viewBy))}.png`} pubProps={pubPropsFactory(sv)}/>
                    <button onClick={()=>exportCsv([...bR,...sR].filter(d=>enabledVarVals.has(d.variable_value)),`${slugify(targetVariable||"chart")}_${slugify(stratLabel(sv,viewBy))}.csv`,{isContinuous:!isCategorical})}
                      style={{fontSize:10,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:4,padding:"1px 6px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                  </div>
                )}
              </div>
              {suppressed?<SmallSampleOverlay/>:
                <PanelChart baseData={bR} scenData={sR} colourMap={colourMap} highlighted={highlighted}
                  isCategorical={isCategorical} yDomain={yDomain} varValues={varValues}
                  enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
                  width={panelW-24} chartType={chartType} panelId={`p_${slugify(sv)}`} allYears={allYears}
                  missingLookup={missingLookup} stratValue={sv}
                  onYearClick={onPanelYearClick} selectedYear={selYear} varLabel={varLabel} viewBy={viewBy}
                  scenarioMap={panelScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
              }
              {/* This panel's own year breakdown — only appears once a point
                  on the line above has actually been clicked, and only for
                  THIS panel; every other panel is untouched. */}
              {isLine&&!suppressed&&selYear!=null&&(csBase.some(d=>!isNaN(d.mean_value))||csScen.some(d=>!isNaN(d.mean_value)))&&(
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #e9e4da"}}>
                  <div style={{marginBottom:2}}>
                    <span style={{fontSize:10,fontWeight:600,color:TEXT_S}}>
                      Year {selYear}
                      <button onClick={()=>setPanelYears(prev=>({...prev,[sv]:null}))} style={{fontSize:10,color:TEAL,background:"none",border:"none",cursor:"pointer",textDecoration:"underline",marginLeft:4,padding:0}}>clear</button>
                    </span>
                  </div>
                  <CrossSectionBarPanel baseData={csBase} scenData={csScen} colourMap={colourMap} highlighted={highlighted}
                    isCategorical={isCategorical} yDomain={sharedCsYDomain} varValues={varValues}
                    enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
                    width={panelW-24} year={selYear} patId={`pcs_${slugify(sv)}`} varLabel={varLabel}
                    scenarioMap={csScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
                </div>
              )}
            </div>
          );
        })}
      </div>
      );})()}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   CROSS-SECTION PANEL — with download buttons
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Wraps GroupedBarChart with its own filtering (by pinned year, or averaged
 * across all years) and download controls — this is what actually renders
 * for the "Cross-section" tab. When stratified, renders one GroupedBarChart
 * per enabled stratum value instead of a single chart, similar in spirit to
 * SmallMultiplesPanel but for the grouped-bar comparison rather than lines.
 *
 * @param {number|null} props.year - the pinned year (from clicking a point on the line chart), used unless isAverage
 * @param {boolean} props.isAverage - true when showing the "averaged across all years" cross-section instead of one specific year
 */
function CrossSectionPanel({baseData,scenData,colourMap,highlighted,isCategorical,
    varValues,enabledVarVals,enabledStrats,viewBy,showBaseline,showScenario,
    width,year,isAverage,pubPropsFactory,targetVariable,
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[]}){
  const svgRef=useRef();
  const isStratified=viewBy!=="Overall";
  const varLabel=addSpaces(targetVariable||"");
  // baseData/scenData here are the FULL per-variable dataset — every
  // stratifier's rows mixed together (see callers) — not just viewBy's, so
  // the `d.stratifier===viewBy` check is required whenever stratified.
  // Without it, a stratified cross-section could silently pick up another
  // stratifier's rows too, whenever that stratifier happens to share a
  // stratifier_value string with the one actually selected (e.g. "Missing",
  // which every stratifier can produce).
  const filterYear=useCallback(rows=>rows.filter(d=>
    (isAverage||d.year===year)&&enabledVarVals.has(d.variable_value)&&(!isStratified||d.stratifier===viewBy)
  ),[year,isAverage,enabledVarVals,isStratified,viewBy]);
  const filtB=useMemo(()=>filterYear(baseData),[baseData,filterYear]);
  const filtS=useMemo(()=>filterYear(scenData),[scenData,filterYear]);
  // Build filtered scenarioMap for cross-section
  const filtScenMap=useMemo(()=>{
    if (!scenarioMap) return null;
    const m=new Map();
    for (const [name,rows] of scenarioMap) m.set(name,filterYear(rows));
    return m;
  },[scenarioMap,filterYear]);
  // Averaging (when isAverage) happens BEFORE the enabledStrats filter is
  // applied below — averageAcrossYears already groups by stratifier_value,
  // so a currently-disabled stratum's years never bleed into an enabled
  // stratum's average — and filtering enabledStrats afterwards keeps both
  // branches (pinned year vs. averaged) the same shape.
  const bRows=useMemo(()=>{
    const rows=isAverage?averageAcrossYears(filtB):filtB;
    return rows.filter(d=>isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall");
  },[filtB,isAverage,isStratified,enabledStrats]);
  const sRows=useMemo(()=>{
    const rows=isAverage?averageAcrossYears(filtS):filtS;
    return rows.filter(d=>isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall");
  },[filtS,isAverage,isStratified,enabledStrats]);
  // Processed scenarioMap for rendering — same averaging/filtering as sRows
  const processedScenMap=useMemo(()=>{
    if (!filtScenMap) return null;
    const m=new Map();
    for (const [name,rows] of filtScenMap) {
      const processed=isAverage?averageAcrossYears(rows):rows;
      m.set(name,processed.filter(d=>isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall"));
    }
    return m;
  },[filtScenMap,isAverage,isStratified,enabledStrats]);
  // All scenario rows combined for yDomain calculation
  const allScenRows=useMemo(()=>processedScenMap?[...processedScenMap.values()].flat():sRows,[processedScenMap,sRows]);

  // For numeric variables, the Overall cross-section (GroupedBarChart, below)
  // gets one Baseline and one Scenario "Missing" row for its tooltips —
  // pulled straight from the FULL, unfiltered baseData/scenData props (not
  // filtB/filtS/bRows/sRows, which already exclude "Missing" via
  // enabledVarVals) since it isn't itself a bar to plot, just supplementary
  // context for the real bars. Categorical variables keep "Missing" as one
  // of their normal, already-plotted categories, so this only applies when
  // !isCategorical. Stratified small-multiples (StackedBarChart, via
  // PanelChart) don't use this — see the Δ Baseline → Scenario tooltips,
  // which also intentionally don't show missingness.
  const missingBase=useMemo(()=>{
    if (isCategorical||isStratified) return null;
    const rows=baseData.filter(d=>d.variable_value==="Missing"&&d.stratifier_value==="Overall");
    if (!rows.length) return null;
    return isAverage?(averageAcrossYears(rows)[0]||null):(rows.find(d=>d.year===year)||null);
  },[baseData,isCategorical,isStratified,isAverage,year]);
  const missingScen=useMemo(()=>{
    if (isCategorical||isStratified) return null;
    const rows=scenData.filter(d=>d.variable_value==="Missing"&&d.stratifier_value==="Overall");
    if (!rows.length) return null;
    return isAverage?(averageAcrossYears(rows)[0]||null):(rows.find(d=>d.year===year)||null);
  },[scenData,isCategorical,isStratified,isAverage,year]);

  // Stratified: ONE combined GroupedBarChart — grouped first by stratum,
  // then by variable value within each stratum — rather than a separate
  // small chart per stratum. This is what makes the "combined" cross-section
  // actually match the combined LINE chart's own "everything in one chart"
  // approach (a grid of per-stratum panels is what the SEPARATE small-
  // multiples/"Panels" layout is for instead — see SmallMultiplesPanel).
  // Shown whether a specific year is pinned OR averaged across all years.
  if (isStratified){
    const stratVals=[...new Set([...bRows,...allScenRows].map(d=>d.stratifier_value))].filter(sv=>enabledStrats.has(sv));
    const yDomain=buildYDomain([...bRows,...allScenRows],isCategorical);
    const yrTag=isAverage?"avg":year;
    if (!stratVals.length) return <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic",margin:0}}>No data{isAverage?"":` for year ${year}`}.</p>;
    return (
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        <GroupedBarChart svgRef={svgRef} baseData={bRows} scenData={sRows} colourMap={colourMap}
          highlighted={highlighted} isCategorical={isCategorical} yDomain={yDomain}
          varValues={varValues} enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
          width={width} year={isAverage?"average":year} patId={`cs_${yrTag}`} varLabel={varLabel}
          isStratified stratValues={stratVals} enabledStrats={enabledStrats} viewBy={viewBy}
          scenarioMap={processedScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
        <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
          <DownloadBtn svgRef={svgRef} filename={`cross_section_${yrTag}.png`} pubProps={pubPropsFactory(null)}/>
          <button onClick={()=>exportCsv([...bRows,...sRows],`cross_section_${yrTag}.csv`,{isContinuous:!isCategorical})}
            style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer"}}>↓ CSV</button>
        </div>
      </div>
    );
  }

  const yDomain=buildYDomain([...bRows,...allScenRows],isCategorical);
  if (!bRows.length&&!allScenRows.length) return <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic",margin:0}}>No data.</p>;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      <GroupedBarChart svgRef={svgRef} baseData={bRows} scenData={sRows} colourMap={colourMap}
        highlighted={highlighted} isCategorical={isCategorical} yDomain={yDomain}
        varValues={varValues} enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
        width={width} year={isAverage?"average":year} patId={`cs_${year}_${isAverage}`}
        missingBase={missingBase} missingScen={missingScen} varLabel={varLabel}
        scenarioMap={processedScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
        <DownloadBtn svgRef={svgRef} filename={`cross_section_${year||"avg"}.png`} pubProps={pubPropsFactory(null)}/>
        <button onClick={()=>exportCsv([...bRows,...sRows],`cross_section_${year||"avg"}.csv`,{isContinuous:!isCategorical})}
          style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer"}}>↓ CSV</button>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   POPULATION PYRAMID
   Renders a classic mirrored horizontal bar chart: Female bars extend left,
   Male bars extend right, with age bands on the y-axis.  Data comes from the
   existing aggregated rows where variable="Age" and stratifier="Gender" —
   those rows are already produced by parseCore's aggregateSingleRun for every
   run, so no new pipeline work is needed here.

   Props:
     baselineData / scenarioData — full filtered dataset for targetVariable="Age"
       (i.e. all rows where variable==="Age", any stratifier).  The pyramid
       itself only uses the rows where stratifier==="Gender".
     year          — the pinned year (number) or null (→ average across years)
     showBaseline / showScenario — which series to draw
     width         — available container width
═════════════════════════════════════════════════════════════════════════════ */
const AGE_ORDER = ["Under 18","18-24","25-34","35-44","45-54","55-64","65+"];

function PopulationPyramid({ baselineData, scenarioData, year, showBaseline, showScenario, width=600, svgRef: externalRef,
    scenarioMap=null, enabledScenarios=null, allScenarioNames=[] }) {
  const internalRef = useRef();
  const svgRef = externalRef || internalRef;

  // pyramid_bin rows: variable="Age", stratifier="Gender",
  // variable_value=age band, stratifier_value="Male"/"Female".
  // No further filtering by stratifier needed — baselineData/scenarioData
  // are already pre-filtered to metric_type="pyramid_bin" by the parent.
  const slice = useCallback((data) => {
    if (year === null) return averageAcrossYears(data);
    return data.filter(d => d.year === year);
  }, [year]);

  const baseRows = useMemo(() => slice(baselineData), [baselineData, slice]);
  const scenEntries = useMemo(() => {
    if (scenarioMap && scenarioMap.size > 0 && allScenarioNames.length > 0) {
      return allScenarioNames.filter(n => enabledScenarios?.has(n)).map(name => {
        const gi = allScenarioNames.indexOf(name);
        return { name, label: scenarioLabel(name), rows: slice(scenarioMap.get(name) ?? []), fillStyle: gi === 0 ? "hatch" : "dot", gi };
      });
    }
    return showScenario ? [{ name:"scenario", label:"Scenario", rows: slice(scenarioData), fillStyle:"dot", gi:0 }] : [];
  }, [scenarioMap, enabledScenarios, allScenarioNames, scenarioData, showScenario, slice]);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    const hasBase = showBaseline && baseRows.some(d => !isNaN(d.mean_value));
    const hasScenAny = scenEntries.some(e => e.rows.some(d => !isNaN(d.mean_value)));
    if (!hasBase && !hasScenAny) return;

    const MP = { top:20, right:20, bottom:40, left:20 };
    const H  = 320;
    const iW = Math.max(200, width - MP.left - MP.right);
    const iH = H - MP.top - MP.bottom;

    svg.attr("width", width).attr("height", H);
    const root = svg.append("g").attr("transform", `translate(${MP.left},${MP.top})`);

    // Build lookup: gender → ageBand → mean_value
    // variable_value = age band, stratifier_value = "Male"/"Female"
    const build = (rows) => {
      const m = {};
      for (const r of rows) {
        if (isNaN(r.mean_value)) continue;
        const g = r.stratifier_value; // "Male" or "Female"
        const a = r.variable_value;   // age band e.g. "25-34"
        if (!m[g]) m[g] = {};
        m[g][a] = r.mean_value;
      }
      return m;
    };
    const buildCounts = (rows) => {
      const m = {};
      for (const r of rows) {
        if (isNaN(r.mean_value)) continue;
        if (!m[r.stratifier_value]) m[r.stratifier_value] = {};
        m[r.stratifier_value][r.variable_value] = r.mean_sample ?? r.n_runs ?? null;
      }
      return m;
    };

    const baseLookup  = hasBase ? build(baseRows) : {};
    const scenLookups = scenEntries.map(e => ({ ...e, lookup: build(e.rows), counts: buildCounts(e.rows) }));

    const cx = iW / 2;
    const halfW = cx - 40;

    // Max share across ALL years and series so the x-axis stays fixed
    // as the user scrubs through years — use the full unsliced data props.
    const isPyramidR = r => r.metric_type==="pyramid_bin"||(r.variable==="Age"&&r.stratifier==="Gender");
    const allRows = [...baselineData, ...scenEntries.flatMap(e=>
      (scenarioMap?.get(e.name) ?? []).filter(isPyramidR)
    )];
    const maxShare = d3.max(allRows, d => isNaN(d.mean_value)?0:d.mean_value) || 0.15;
    const xScale = d3.scaleLinear().domain([0, maxShare * 1.12]).range([0, halfW]);

    const yScale = d3.scaleBand().domain(AGE_ORDER).range([0, iH]).padding(0.18);
    const bh = yScale.bandwidth();

    // Divide bandwidth among baseline + N scenarios
    const totalSeries = (hasBase ? 1 : 0) + scenLookups.length;
    const barSlotH = totalSeries > 1 ? bh * 0.96 / totalSeries : bh * 0.88;
    const gap = totalSeries > 1 ? bh * 0.04 : 0;

    const baseCounts  = hasBase ? buildCounts(baseRows) : {};

    const femColour = "#ff6e51";
    const malColour = TEAL;

    const drawSide = (lookup, countLookup, slotIndex, isScenario, label, fillStyle, gi) => {
      const offY   = slotIndex * (barSlotH + gap);
      const opacity = isScenario ? 0.75 : 0.88;
      const scenCol = isScenario ? NUMERIC_SCEN_COLOURS[gi % NUMERIC_SCEN_COLOURS.length] : null;

      for (const ageBand of AGE_ORDER) {
        const y0 = yScale(ageBand);
        if (y0 == null) continue;

        const fVal = lookup["Female"]?.[ageBand] ?? 0;
        const fPx  = xScale(fVal);
        const fX   = cx - 40 - fPx;
        const fN   = countLookup["Female"]?.[ageBand];
        const mVal = lookup["Male"]?.[ageBand] ?? 0;
        const mPx  = xScale(mVal);
        const mX   = cx + 40;
        const mN   = countLookup["Male"]?.[ageBand];
        const barY = y0 + offY;

        // Female bars use femColour, male bars use malColour.
        // Scenarios: use NUMERIC_SCEN_COLOURS tinted bar with hatch/dot fill pattern.
        if (isScenario) {
          [[fPx, fX, femColour], [mPx, mX, malColour]].forEach(([px, bx, col]) => {
            if (px <= 0) return;
            root.append("rect").attr("x",bx).attr("y",barY).attr("width",px).attr("height",barSlotH)
              .attr("fill",col).attr("opacity",0.18);
            if (fillStyle === "dot") drawDotPattern(svg, root, bx, barY, px, barSlotH, col, 0.65, 5);
            else drawHatchClipped(svg, root, bx, barY, px, barSlotH, col, 0.55, 4);
            root.append("rect").attr("x",bx).attr("y",barY).attr("width",px).attr("height",barSlotH)
              .attr("fill","none").attr("stroke",col).attr("stroke-width",1.2).attr("opacity",opacity);
          });
        } else {
          if (fPx > 0) root.append("rect").attr("x",fX).attr("y",barY).attr("width",fPx).attr("height",barSlotH).attr("fill",femColour).attr("opacity",opacity).attr("rx",2);
          if (mPx > 0) root.append("rect").attr("x",mX).attr("y",barY).attr("width",mPx).attr("height",barSlotH).attr("fill",malColour).attr("opacity",opacity).attr("rx",2);
        }

        if (fPx > 0) {
          const fStr = fN != null ? `\nn = ${fN.toLocaleString(undefined,{maximumFractionDigits:1})}` : "";
          root.append("rect").attr("x",fX).attr("y",barY).attr("width",fPx).attr("height",barSlotH)
            .attr("fill","transparent").style("cursor","default")
            .on("mouseover", e => showTT({title:`${ageBand}`,lines:[` — Female\n${label}: ${(fVal*100).toFixed(1)}%${fStr}`]}, e))
            .on("mousemove", moveTT).on("mouseout", hideTT);
        }
        if (mPx > 0) {
          const mStr = mN != null ? `\nn = ${mN.toLocaleString(undefined,{maximumFractionDigits:1})}` : "";
          root.append("rect").attr("x",mX).attr("y",barY).attr("width",mPx).attr("height",barSlotH)
            .attr("fill","transparent").style("cursor","default")
            .on("mouseover", e => showTT({title:`${ageBand}`,lines:[` — Male\n${label}: ${(mVal*100).toFixed(1)}%${mStr}`]}, e))
            .on("mousemove", moveTT).on("mouseout", hideTT);
        }
      }
    };

    let slotIdx = 0;
    if (hasBase) { drawSide(baseLookup, baseCounts, slotIdx++, false, "Baseline", "solid", -1); }
    scenLookups.forEach(({ lookup, counts, label, fillStyle, gi }) => {
      drawSide(lookup, counts, slotIdx++, true, label, fillStyle, gi);
    });

    // Age-band labels in centre gap
    for (const ageBand of AGE_ORDER) {
      const y0 = yScale(ageBand);
      root.append("text")
        .attr("x", cx).attr("y", y0 + bh / 2).attr("dy","0.35em")
        .attr("text-anchor","middle").attr("font-size","11px")
        .attr("fill",TEXT_M).attr("font-family",PUB_FONT)
        .text(ageBand);
    }

    // X-axis tick labels (percentage) — left side (Female) and right side (Male)
    const tickVals = xScale.ticks(4);
    const axisG = root.append("g").attr("transform",`translate(0,${iH})`);
    // Left ticks (Female side — values read outward from centre)
    for (const t of tickVals) {
      if (t === 0) continue;
      const px = xScale(t);
      axisG.append("text").attr("x", cx - 40 - px).attr("y", 14)
        .attr("text-anchor","middle").attr("font-size","10px").attr("fill",TEXT_S).attr("font-family",PUB_FONT)
        .text(`${(t*100).toFixed(0)}%`);
    }
    // Right ticks (Male side)
    for (const t of tickVals) {
      if (t === 0) continue;
      const px = xScale(t);
      axisG.append("text").attr("x", cx + 40 + px).attr("y", 14)
        .attr("text-anchor","middle").attr("font-size","10px").attr("fill",TEXT_S).attr("font-family",PUB_FONT)
        .text(`${(t*100).toFixed(0)}%`);
    }

    // Column labels: "← Female" and "Male →"
    root.append("text").attr("x", cx - 40 - halfW / 2).attr("y", -6)
      .attr("text-anchor","middle").attr("font-size","12px").attr("font-weight","700")
      .attr("fill","#ff6e51").attr("font-family",PUB_FONT).text("← Female");
    root.append("text").attr("x", cx + 40 + halfW / 2).attr("y", -6)
      .attr("text-anchor","middle").attr("font-size","12px").attr("font-weight","700")
      .attr("fill",TEAL).attr("font-family",PUB_FONT).text("Male →");

    // Centre divider line removed — age labels in the gap provide sufficient separation

  }, [baseRows, baselineData, scenEntries, showBaseline, showScenario, width, year, scenarioMap]);

  // Hatch swatch helper — renders a small rectangle filled with diagonal
  // lines matching the actual drawHatchClipped visual used in the chart.
  const HatchSwatch = ({ colour }) => (
    <svg width="22" height="13" style={{flexShrink:0}}>
      <defs>
        <pattern id={`hp_${colour.replace("#","")}`} x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke={colour} strokeWidth="1.4" opacity="0.55"/>
        </pattern>
      </defs>
      <rect x="0" y="0" width="22" height="13" fill={`url(#hp_${colour.replace("#","")})`}/>
      <rect x="0" y="0" width="22" height="13" fill="none" stroke={colour} strokeWidth="1.2"/>
    </svg>
  );

  const showBothLegend = showBaseline && scenEntries.length > 0;
  // Legend is split into two groups matching other plot legends:
  //   Left group: colour = gender (solid swatch, colour only)
  //   Right group: fill style = Baseline (solid) vs Scenario (hatched)
  return (
    <div>
      <div style={{display:"flex",gap:20,marginBottom:6,flexWrap:"wrap",alignItems:"center"}}>
        {/* Gender colour key */}
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{width:22,height:13,background:TEAL,display:"inline-block",borderRadius:2,opacity:0.88}}/>
            <span style={{fontSize:12,color:TEXT_S,fontWeight:500}}>Male</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{width:22,height:13,background:"#ff6e51",display:"inline-block",borderRadius:2,opacity:0.88}}/>
            <span style={{fontSize:12,color:TEXT_S,fontWeight:500}}>Female</span>
          </div>
        </div>
        {/* Baseline / Scenario fill-style key — only when both are shown.
            Uses solid vs hatched swatch matching the line-type convention
            used in all other chart legends. */}
        {showBothLegend && (
          <div style={{display:"flex",gap:12,alignItems:"center",borderLeft:"1px solid #e2ddd5",paddingLeft:16,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{width:22,height:13,background:TEXT_M,display:"inline-block",borderRadius:2,opacity:0.88}}/>
              <span style={{fontSize:12,color:TEXT_S,fontWeight:500}}>Baseline</span>
            </div>
            {scenEntries.map(({name, label, fillStyle, gi}) => (
              <div key={name} style={{display:"flex",alignItems:"center",gap:5}}>
                {fillStyle==="dot"
                  ? <svg width="22" height="13" style={{flexShrink:0}}>
                      <rect x="0" y="0" width="22" height="13" fill="none" stroke={TEXT_M} strokeWidth="1.2"/>
                      {[4,10,16].map(cx=>[3,9].map(cy=><circle key={`${cx}${cy}`} cx={cx} cy={cy} r="1.2" fill={TEXT_M} opacity="0.65"/>))}
                    </svg>
                  : <HatchSwatch colour={TEXT_M}/>}
                <span style={{fontSize:12,color:TEXT_S,fontWeight:500}}>{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <svg ref={svgRef}/>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   WAGE DISTRIBUTION CHART
   Renders the binned hourly-earnings distribution as a grouped bar chart.
   One group per wage bin on the x-axis; bars per scenario (baseline = solid,
   scenario = hatched).  An optional "all years" small-multiples mode renders
   one mini histogram per year instead.

   Data: rows with metric_type="wage_bin" and variable="Hourly earnings" that
   were emitted by the new wage-bin accumulator pass in parseCore.js.

   Props:
     baselineData / scenarioData — pre-filtered to variable="Hourly earnings"
     year            — number | null (null = show all years as small multiples)
     showAllYears    — boolean; if true, renders small multiples instead of a
                       single-year histogram
     showBaseline / showScenario
     viewBy          — current stratifier ("Overall" or a stratifier name)
     enabledStrats   — Set of enabled stratifier values
     width           — container width
═════════════════════════════════════════════════════════════════════════════ */
const WAGE_BIN_LABELS = WAGE_BINS.map(b => b[2]); // ["£0–5", "£5–10", …]

function WageDistributionChart({ baselineData, scenarioData, year, showAllYears,
    showBaseline, showScenario, viewBy, enabledStrats, width=600, svgRef: externalRef,
    scenarioMap=null, enabledScenarios=null, allScenarioNames=[] }) {

  const internalRef = useRef();
  const svgRef = externalRef || internalRef;
  const isStratified = viewBy !== "Overall";

  // Extract wage_bin rows and (if stratified) filter to enabled strata
  const wageBinRows = useCallback((data, scenario) => {
    let rows = data.filter(d => d.metric_type === "wage_bin" && d.variable === "Hourly earnings");
    if (isStratified) {
      rows = rows.filter(d => d.stratifier === viewBy && enabledStrats.has(d.stratifier_value));
    } else {
      rows = rows.filter(d => d.stratifier === "Overall");
    }
    return rows;
  }, [isStratified, viewBy, enabledStrats]);

  const baseWage = useMemo(() => wageBinRows(baselineData), [baselineData, wageBinRows]);
  // Build one wage dataset per enabled scenario
  const enabledScenEntries = useMemo(() => {
    if (scenarioMap && scenarioMap.size > 0 && allScenarioNames.length > 0) {
      return allScenarioNames
        .filter(n => enabledScenarios?.has(n))
        .map((name) => {const gi=allScenarioNames.indexOf(name);return({
          name, label: scenarioLabel(name),
          rows: wageBinRows(scenarioMap.get(name) ?? []),
          fillStyle: gi === 0 ? "hatch" : "dot",
          colour: NUMERIC_SCEN_COLOURS[gi % NUMERIC_SCEN_COLOURS.length],
        });});
    }
    return showScenario ? [{
      name: "scenario", label: "Scenario",
      rows: wageBinRows(scenarioData),
      fillStyle: "hatch",
      colour: NUMERIC_SCEN_COLOURS[0],
    }] : [];
  }, [scenarioMap, enabledScenarios, allScenarioNames, scenarioData, wageBinRows, showScenario]);
  // Combined scen rows for backwards-compat usages (allYears, stratVals etc.)
  const scenWage = useMemo(() => enabledScenEntries.flatMap(e => e.rows), [enabledScenEntries]);

  // All years present in either dataset (sorted)
  const allYears = useMemo(() => {
    const ys = new Set([...baseWage, ...scenWage].map(d => d.year));
    return [...ys].sort((a,b)=>a-b);
  }, [baseWage, scenWage]);

  // Build lookup: year → stratVal → binLabel → row (stores mean_value, lower_ci, upper_ci)
  const buildLookup = useCallback((rows) => {
    const m = new Map();
    for (const r of rows) {
      const svKey = isStratified ? r.stratifier_value : "Overall";
      if (!m.has(r.year)) m.set(r.year, new Map());
      if (!m.get(r.year).has(svKey)) m.get(r.year).set(svKey, new Map());
      m.get(r.year).get(svKey).set(r.variable_value, r);
    }
    return m;
  }, [isStratified]);

  const baseLU = useMemo(() => buildLookup(baseWage), [baseWage, buildLookup]);
  // Per-scenario lookups
  const scenLUs = useMemo(() => enabledScenEntries.map(e => buildLookup(e.rows)), [enabledScenEntries, buildLookup]);
  // Keep scenLU for backwards-compat
  const scenLU = useMemo(() => scenLUs[0] ?? new Map(), [scenLUs]);

  // Build a synthetic "Average" year entry by averaging mean_value across
  // all years for each (stratVal, binLabel) combination.
  const buildAvgLookup = useCallback((rows) => {
    // Accumulate: stratVal → binLabel → { sum, count, loSum, hiSum }
    const acc = new Map();
    for (const r of rows) {
      if (isNaN(r.mean_value)) continue;
      const sv  = isStratified ? r.stratifier_value : "Overall";
      const bin = r.variable_value;
      if (!acc.has(sv)) acc.set(sv, new Map());
      const bMap = acc.get(sv);
      if (!bMap.has(bin)) bMap.set(bin, { sum: 0, count: 0, loSum: 0, hiSum: 0, n_runs: r.n_runs });
      const entry = bMap.get(bin);
      entry.sum   += r.mean_value;
      entry.count += 1;
      if (!isNaN(r.lower_ci)) entry.loSum += r.lower_ci;
      if (!isNaN(r.upper_ci)) entry.hiSum += r.upper_ci;
    }
    // Convert to the same shape buildLookup produces, keyed under "Average"
    const avgMap = new Map();
    for (const [sv, bMap] of acc) {
      if (!avgMap.has("Average")) avgMap.set("Average", new Map());
      const svMap = avgMap.get("Average");
      const out   = new Map();
      for (const [bin, { sum, count, loSum, hiSum, n_runs }] of bMap) {
        out.set(bin, count > 0 ? {
          mean_value: sum / count,
          lower_ci:   count > 0 ? loSum / count : NaN,
          upper_ci:   count > 0 ? hiSum / count : NaN,
          n_runs,
        } : { mean_value: NaN, lower_ci: NaN, upper_ci: NaN });
      }
      svMap.set(sv, out);
    }
    return avgMap;
  }, [isStratified]);

  const baseAvgLU = useMemo(() => buildAvgLookup(baseWage), [baseWage, buildAvgLookup]);
  const scenAvgLUs = useMemo(() => enabledScenEntries.map(e => buildAvgLookup(e.rows)), [enabledScenEntries, buildAvgLookup]);
  const scenAvgLU  = useMemo(() => scenAvgLUs[0] ?? new Map(), [scenAvgLUs]);

  // Strata to show
  const stratVals = useMemo(() => {
    if (!isStratified) return ["Overall"];
    const sv = new Set([...baseWage,...scenWage].map(d=>d.stratifier_value));
    return [...sv].filter(s => enabledStrats.has(s));
  }, [isStratified, baseWage, scenWage, enabledStrats]);

  // Colour per stratum (reuse the teal palette)
  const stratColours = useMemo(() => {
    const palette = [TEAL,"#e67e22","#27ae60","#8e44ad","#c0392b","#2980b9","#16a085","#d35400"];
    const m = {};
    stratVals.forEach((sv,i) => m[sv] = palette[i % palette.length]);
    return m;
  }, [stratVals]);

  // Draw a single histogram panel into `g` for a given year + size.
  // yr="Average" uses the pre-averaged lookup (baseAvgLU/scenAvgLU).
  const drawHistogram = useCallback((svgSel, g, yr, panelW, panelH, small=false) => {
    const bins = WAGE_BIN_LABELS;
    const margin = small ? {l:32,r:4,t:14,b:28} : {l:48,r:8,t:8,b:36};
    const iW = panelW - margin.l - margin.r;
    const iH = panelH - margin.t - margin.b;
    if (iW <= 0 || iH <= 0) return;

    const isAvg = yr === "Average";
    const pg = g.append("g").attr("transform",`translate(${margin.l},${margin.t})`);

    // Collect all values for y-scale
    const allVals = [];
    const scenarios = [];
    if (showBaseline) scenarios.push({ lk: isAvg ? baseAvgLU : baseLU, isScen:false, label:"Baseline", fillStyle:"solid", colour:NUMERIC_BASE_COLOUR });
    enabledScenEntries.forEach((e, i) => {
      const gi = allScenarioNames.indexOf(e.name);
      scenarios.push({ lk: isAvg ? scenAvgLUs[i] : scenLUs[i], isScen:true, label:e.label, fillStyle:e.fillStyle, colour:NUMERIC_SCEN_COLOURS[gi>=0?gi:i] });
    });

    for (const { lk } of scenarios) {
      const yMap = lk.get(yr);
      if (!yMap) continue;
      for (const sv of stratVals) {
        const binMap = yMap.get(sv);
        if (!binMap) continue;
        for (const bl of bins) { const r = binMap.get(bl); if (r != null) { const v = typeof r==="object"?r.mean_value:r; if (!isNaN(v)) allVals.push(v); } }
      }
    }
    const maxVal = d3.max(allVals) || 0.01;

    // X: bin positions
    const xBin   = d3.scaleBand().domain(bins).range([0,iW]).padding(0.12);
    const yScale  = d3.scaleLinear().domain([0, maxVal * 1.12]).range([iH,0]);

    // Y-axis
    const yTicks = small ? 3 : 5;
    pg.append("g").call(
      d3.axisLeft(yScale).ticks(yTicks).tickFormat(v=>`${(v*100).toFixed(0)}%`).tickSize(2)
    ).call(ax=>{
      ax.select(".domain").remove();
      ax.selectAll("text").style("font-size", small?"8px":"10px").style("fill",TEXT_S).style("font-family",PUB_FONT);
      ax.selectAll(".tick line").style("stroke","#e2ddd5");
    });

    // Gridlines
    pg.append("g").call(d3.axisLeft(yScale).ticks(yTicks).tickSize(-iW).tickFormat(""))
      .call(ax=>{ ax.select(".domain").remove(); ax.selectAll("line").style("stroke","#ece8e0").style("stroke-dasharray","3,3"); });

    // Bars — one group per bin, one bar per (scenario × stratum)
    const groupCount = scenarios.length * stratVals.length;
    const xGroup = d3.scaleBand().domain(d3.range(groupCount)).range([0, xBin.bandwidth()]).padding(0.06);
    const bw = xGroup.bandwidth();

    let groupIdx = 0;
    for (const { lk, isScen, label:scenLbl, fillStyle, colour:scenarioColour } of scenarios) {
      for (const sv of stratVals) {
        const colour   = isStratified ? (stratColours[sv] || TEAL) : scenarioColour;
        const stratTip = sv === "Overall" ? "" : `\n${sv}`;
        const gIdx     = groupIdx++;
        const yMap = lk.get(yr);
        if (!yMap) continue;
        const binMap = yMap.get(sv);
        if (!binMap) continue;

        for (const bl of bins) {
          const row = binMap.get(bl);
          if (row == null) continue;
          const v = typeof row === "object" ? row.mean_value : row;
          if (isNaN(v)) continue;
          const bx = xBin(bl);
          const gx = xGroup(gIdx);
          const by = yScale(v);
          const bh = iH - by;
          if (bh <= 0) continue;

          const ttContent={title:`${bl}`,lines:[`${stratTip}\n${scenLbl}: ${(v*100).toFixed(1)}%`]};

          if (isScen) {
            pg.append("rect").attr("x",bx+gx).attr("y",by).attr("width",bw).attr("height",bh)
              .attr("fill",colour).attr("opacity",0.15);
            if (fillStyle==="dot") drawDotPattern(svgSel,pg,bx+gx,by,bw,bh,colour,0.75,5);
            else drawHatchClipped(svgSel,pg,bx+gx,by,bw,bh,colour,0.7,4);
            pg.append("rect").attr("x",bx+gx).attr("y",by).attr("width",bw).attr("height",bh)
              .attr("fill","none").attr("stroke",colour).attr("stroke-width",1).attr("opacity",0.7);
          } else {
            pg.append("rect").attr("x",bx+gx).attr("y",by).attr("width",bw).attr("height",bh)
              .attr("fill",colour).attr("opacity",0.82).attr("rx",1.5);
          }

          if (!small) {
            pg.append("rect").attr("x",bx+gx).attr("y",by).attr("width",bw).attr("height",bh)
              .attr("fill","transparent").style("cursor","default")
              .on("mouseover", e => showTT(ttContent, e))
              .on("mousemove", moveTT)
              .on("mouseout",  hideTT);
          }
        }
      }
    }

    // X axis: bin labels — rotate on small panels
    pg.append("g").attr("transform",`translate(0,${iH})`).call(
      d3.axisBottom(xBin).tickSize(2)
    ).call(ax=>{
      ax.select(".domain").remove();
      ax.selectAll("text")
        .style("font-size", small?"7.5px":"10px").style("fill",TEXT_S).style("font-family",PUB_FONT)
        .attr("transform","rotate(-35)").attr("text-anchor","end").attr("dy","0.8em").attr("dx","-0.3em");
      ax.selectAll(".tick line").style("stroke","#e2ddd5");
    });

    // Year label for small-multiples panels
    if (small) {
      pg.append("text").attr("x",iW/2).attr("y",-4)
        .attr("text-anchor","middle").attr("font-size","10px").attr("font-weight","700")
        .attr("fill",TEXT_D).attr("font-family",PUB_FONT).text(yr);
    }
  }, [baseLU, scenLUs, baseAvgLU, scenAvgLUs, showBaseline, showScenario, stratVals, stratColours, enabledScenEntries]);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const hasAny = (showBaseline && baseWage.length > 0) || (showScenario && scenWage.length > 0);
    if (!hasAny) return;

    if (showAllYears) {
      // Small-multiples: one mini histogram per year
      const nYears = allYears.length;
      const cols   = Math.min(nYears, Math.max(2, Math.floor(width / 190)));
      const rows   = Math.ceil(nYears / cols);
      const cellW  = Math.floor(width / cols);
      const cellH  = 160;
      const totalH = rows * cellH;
      svg.attr("width", width).attr("height", totalH);
      allYears.forEach((yr, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const g = svg.append("g").attr("transform",`translate(${col*cellW},${row*cellH})`);
        drawHistogram(svg, g, yr, cellW, cellH, true);
      });
    } else {
      // Single histogram: use the selected year or the cross-year average.
      const H = 300;
      svg.attr("width", width).attr("height", H);
      const g = svg.append("g");
      const targetYear = year ?? "Average";
      drawHistogram(svg, g, targetYear, width, H, false);
    }
  }, [showAllYears, allYears, year, width, drawHistogram, baseWage, scenWage, showBaseline, showScenario]);

  // Legend
  const showBoth = showBaseline && showScenario;
  return (
    <div>
      <div style={{display:"flex",gap:12,marginBottom:6,flexWrap:"wrap",alignItems:"center"}}>
        {stratVals.map(sv=>(
          <div key={sv} style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{width:14,height:14,background:stratColours[sv]||TEAL,display:"inline-block",borderRadius:2,opacity:0.82}}/>
            <span style={{fontSize:12,color:TEXT_S}}>{sv==="Overall"?"":sv}</span>
          </div>
        ))}
        {showBoth && (
          <>
            <span style={{fontSize:11,color:TEXT_S}}>— solid = Baseline</span>
            <span style={{fontSize:11,color:TEXT_S}}>— hatched = Scenario</span>
          </>
        )}
      </div>
      <svg ref={svgRef}/>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   DELTA SECTION
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Wraps DeltaChart with its own baseline/scenario row-pairing (computing
 * Scenario − Baseline per matching year/variable_value/stratifier_value
 * combination), legend, and download controls — renders for the "Δ
 * Baseline → Scenario" tab.
 */
// Small info icon with tooltip for the CI methodology explanation
function CiInfoTooltip(){
  const [show,setShow]=useState(false);
  const text="Baseline and Scenario runs are matched by random seed. For each matched pair, the run-level difference (Scenario − Baseline mean) is computed. The average of these paired differences is plotted, with a 95% uncertainty interval calculated as mean_delta ± 1.96 × SE, where SE = SD of paired differences / √(number of matched runs). This paired approach cancels stochastic variation shared between matched runs, so only the policy effect remains.";
  return (
    <span style={{position:"relative",display:"inline-flex",alignItems:"center",marginLeft:6}}>
      <span
        onMouseEnter={()=>setShow(true)}
        onMouseLeave={()=>setShow(false)}
        style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
          width:16,height:16,borderRadius:"50%",border:`1px solid ${TEXT_S}`,
          fontSize:10,fontWeight:700,color:TEXT_S,cursor:"help",lineHeight:1,flexShrink:0}}>
        ?
      </span>
      {show&&(
        <span style={{position:"absolute",bottom:"calc(100% + 6px)",left:"50%",transform:"translateX(-50%)",
          background:"#1e293b",color:"#fff",fontSize:12,lineHeight:1.55,padding:"10px 13px",borderRadius:7,
          whiteSpace:"normal",width:300,zIndex:9999,boxShadow:"0 4px 16px rgba(0,0,0,0.22)"}}>
          {text}
        </span>
      )}
    </span>
  );
}

// Helper: compute delta rows for one scenario vs baseline
function computeDeltaRows(filtB, filtScen, scenarioName) {
  const bMap=new Map();
  filtB.forEach(d=>bMap.set(`${d.year}||${d.variable_value}||${d.stratifier_value}`,d));
  const sMap=new Map();
  filtScen.forEach(d=>sMap.set(`${d.year}||${d.variable_value}||${d.stratifier_value}`,d));
  const allKeys=new Set([...bMap.keys(),...sMap.keys()]);
  return Array.from(allKeys).map(key=>{
    const b=bMap.get(key), s=sMap.get(key);
    const meta=s||b;
    let mean_value,lower_ci,upper_ci,paired_n_runs=0;
    const pairedRow=(s&&!isNaN(s.paired_mean_delta))?s:(b&&!isNaN(b.paired_mean_delta))?b:null;
    if (pairedRow){
      mean_value=pairedRow.paired_mean_delta;
      lower_ci=isNaN(pairedRow.paired_lower_ci)?NaN:pairedRow.paired_lower_ci;
      upper_ci=isNaN(pairedRow.paired_upper_ci)?NaN:pairedRow.paired_upper_ci;
      paired_n_runs=pairedRow.paired_n_runs??0;
    } else { mean_value=NaN; lower_ci=NaN; upper_ci=NaN; }
    return {...meta,mean_value,lower_ci,upper_ci,paired_n_runs,scenarioName,
      base_mean_sample:b?.mean_sample,base_n_runs:b?.n_runs,
      scen_mean_sample:s?.mean_sample,scen_n_runs:s?.n_runs};
  });
}

function DeltaSection({baseData,scenData,colourMap,highlighted,isCategorical,
    varValues,enabledVarVals,enabledStrats,viewBy,width,legendEntries,stratValues=[],stratLegendEntries=[],
    scenarioMap=null,enabledScenarios=null,allScenarioNames=[],onYearClick,selectedYear}){
  const svgRef=useRef();
  const isStratified=viewBy!=="Overall";

  const filtB=useMemo(()=>baseData.filter(d=>
    enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall")
  ),[baseData,enabledVarVals,enabledStrats,isStratified]);

  // Combine delta rows from all enabled scenarios into one array, each tagged with scenarioName
  const deltaData=useMemo(()=>{
    const enabledNames=scenarioMap
      ? allScenarioNames.filter(n=>enabledScenarios?.has(n))
      : ["scenario"]; // colours use allScenarioNames.indexOf so stable across toggles
    const allRows=[];
    for (const name of enabledNames){
      const rows=scenarioMap?scenarioMap.get(name)??[]:scenData;
      const filtScen=rows.filter(d=>
        enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall")
      );
      const deltaRows=computeDeltaRows(filtB,filtScen,name);
      for (const r of deltaRows) allRows.push(r);
    }
    return allRows;
  },[filtB,scenData,scenarioMap,enabledScenarios,allScenarioNames,enabledVarVals,enabledStrats,isStratified]);

  const hasDelta=deltaData.some(d=>!isNaN(d.mean_value));
  const varLabel=addSpaces(filtB[0]?.variable||"");

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:6,margin:"0 0 8px",flexWrap:"wrap"}}>
        <p style={{margin:0,fontSize:13,color:TEXT_M,fontStyle:"italic"}}>
          Scenario minus Baseline. Positive = scenario is higher. 95% uncertainty intervals use paired run differences (matched by seed).
        </p>
        <CiInfoTooltip/>
      </div>
      {hasDelta?(
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <DeltaChart svgRef={svgRef} deltaData={deltaData} colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical} varValues={varValues} enabledVarVals={enabledVarVals} stratValues={stratValues} enabledStrats={enabledStrats} viewBy={viewBy} width={width} varLabel={varLabel} allScenarioNames={allScenarioNames} onYearClick={onYearClick} selectedYear={selectedYear}/>
          <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
            <DownloadBtn svgRef={svgRef} filename="delta.png" pubProps={{title:`Δ Baseline → Scenario: ${varLabel}`,legendEntries,stratLegendEntries,showBaseline:false,showScenario:false,highlighted,varScope:varLabel,stratScope:viewBy}}/>
            <button onClick={()=>exportCsv(deltaData,`${slugify(varLabel)}_delta.csv`,{isDelta:true,isContinuous:!isCategorical})}
              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
          </div>
        </div>
      ):(
        <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic"}}>
          {filtB.length
            ? "No delta data available — check that Baseline and Scenario have matching years and seeds."
            : "No baseline data for this variable."}
        </p>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   MAIN DashboardSection
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Top-level orchestrator for everything below the intro card. Owns all UI
 * state — which stratifier/chart type/tab/layout is active, which values
 * are filtered in, which are highlighted, whether CI bands are shown — and
 * decides, based on that state, which chart component(s) from above to
 * actually render (LineChart directly, or via SmallMultiplesPanel;
 * StackedBarChart directly or via panels; CrossSectionPanel; DeltaSection).
 *
 * Receives the full dataset + current variable selection from App.js via
 * props, and does its own filtering down to just that variable's rows via
 * useAggregatedData() — App.js itself never touches chart-level data shape.
 *
 * Key state:
 *   - viewBy: current stratifier ("Overall" = not stratified)
 *   - chartType: "line" | "bar"
 *   - displayMode: "panels" (small multiples) | "combined" (one chart)
 *   - activeTab: "timeseries" | "crosssection" | "delta"
 *   - selectedYear: year pinned via clicking a line-chart point, drives the cross-section tab
 *   - enabledStrats / enabledVarVals: which values are currently toggled on via filters
 *   - highlighted: values currently spotlighted via clicking a legend entry
 *   - dataView: "both" | "baseline" | "scenario" — which series to actually draw
 *   - showCI: whether the 95% CI ribbons are shown on line charts
 *
 * Most of this state resets to its default whenever `targetVariable` changes
 * (see the useEffect keyed on it below), so switching variables doesn't
 * carry over filters/highlights that may no longer make sense for the new
 * variable's set of values.
 *
 * @param {object[]} parsedCache - full dataset (all variables/scenarios), from App.js
 * @param {string} targetVariable - currently-selected variable to visualise
 */
/**
 * Baseline toggle + one toggle button per scenario. Baseline is always the
 * first chip; scenarios follow in the order they appear in allScenarioNames.
 * Each scenario's button uses the matching SCENARIO_DASHES pattern as a
 * visual cue so the button matches what's drawn on the chart.
 */
function ScenarioToggles({showBaseline,setShowBaseline,allScenarioNames,enabledScenarios,setEnabledScenarios,isCategorical=true}){
  const togScen=name=>setEnabledScenarios(prev=>{
    const n=new Set(prev);
    n.has(name)?n.delete(name):n.add(name);
    return n;
  });
  const btn=(active,label,onClick,dash,colour)=>{
    // For numeric variables each series has its own colour; for categorical use teal
    const c=isCategorical?TEAL:colour;
    return(<button key={label} onClick={onClick} style={{
      display:"inline-flex",alignItems:"center",gap:6,
      padding:"7px 13px",borderRadius:18,fontSize:13,fontWeight:active?600:500,cursor:"pointer",
      border:`1.5px solid ${active?c:"#ddd8ce"}`,
      background:active?`${c}18`:"transparent",color:active?c:TEXT_S,transition:"all 0.15s",
    }}>
      {dash
        ? <svg width="18" height="9" style={{flexShrink:0}}><line x1="0" y1="4" x2="18" y2="4" stroke={active?c:TEXT_S} strokeWidth="2" strokeDasharray={dash}/></svg>
        : <svg width="18" height="9" style={{flexShrink:0}}><line x1="0" y1="4" x2="18" y2="4" stroke={active?c:TEXT_S} strokeWidth="2.5"/></svg>}
      {label}
    </button>);
  };
  return(<div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
    {btn(showBaseline,"Baseline",()=>setShowBaseline(v=>!v),null,NUMERIC_BASE_COLOUR)}
    {allScenarioNames.map((name,i)=>btn(
      enabledScenarios.has(name),
      scenarioLabel(name),
      ()=>togScen(name),
      SCENARIO_DASHES[i%SCENARIO_DASHES.length],
      NUMERIC_SCEN_COLOURS[i%NUMERIC_SCEN_COLOURS.length]
    ))}
  </div>);
}

export default function DashboardSection({parsedCache,targetVariable}){
  const {baselineData,scenarioData,scenarioMap}=useAggregatedData(parsedCache,targetVariable);
  const allScenarioNames=useScenarioNames(parsedCache);

  // Pyramid rows use metric_type="pyramid_bin" (variable="Age",
  // stratifier="Gender") — filter specifically on that type so regular Age
  // share rows don't bleed through, and so this works identically from the
  // pre-aggregated CSV (where pyramid_bin rows are emitted by the R script)
  // and from a local upload (where parseCore now emits them too).
  const isPyramidRow = r =>
    r.metric_type==="pyramid_bin" ||
    (r.variable==="Age" && r.stratifier==="Gender" && (r.metric_type==="share"||r.metric_type==="mean"));
  const pyramidBaseData=useMemo(()=>
    parsedCache.filter(r=>r.scenario==="baseline"&&isPyramidRow(r)),
  [parsedCache]);
  const [viewBy,        setViewBy]        =useState("Overall");
  const [chartType,     setChartType]     =useState("line");
  const [displayMode,   setDisplayMode]   =useState("panels");
  const [activeTab,     setActiveTab]     =useState("timeseries");
  const [selectedYear,  setSelectedYear]  =useState(null);
  const [deltaYear,     setDeltaYear]     =useState(null); // year pinned on the delta chart
  const [enabledStrats, setEnabledStrats] =useState(new Set());
  const [enabledVarVals,setEnabledVarVals]=useState(new Set());
  const [highlighted,   setHighlighted]   =useState(new Set());
  const [showBaseline,  setShowBaseline]  =useState(true);
  const [enabledScenarios,setEnabledScenarios]=useState(new Set()); // scenario names currently shown
  const [showCI,        setShowCI]        =useState(true);

  const pyramidScenData=useMemo(()=>{
    const firstEnabled=[...enabledScenarios][0]??allScenarioNames[0];
    if (!firstEnabled) return [];
    return parsedCache.filter(r=>r.scenario===firstEnabled&&isPyramidRow(r));
  },[parsedCache,enabledScenarios,allScenarioNames]);

  // scenarioMap filtered to pyramid rows — for multi-scenario pyramid
  const pyramidScenMap=useMemo(()=>{
    if (!allScenarioNames.length) return null;
    const m=new Map();
    for (const name of allScenarioNames) {
      const rows=parsedCache.filter(r=>r.scenario===name&&isPyramidRow(r));
      if (rows.length) m.set(name,rows);
    }
    return m.size>0?m:null;
  },[parsedCache,allScenarioNames]);
  // Wage distribution chart: toggle between single-year histogram and all-years small multiples
  const [showWageDist,     setShowWageDist]     =useState(false);
  const [showAllYearsDist, setShowAllYearsDist] =useState(false);

  const lineRef=useRef(), barRef=useRef(), wageDistRef=useRef(), pyramidRef=useRef(), deltaCsRef=useRef();
  const containerRef=useRef();
  const [width,setWidth]=useState(900);

  useEffect(()=>{
    if (!containerRef.current) return;
    const ro=new ResizeObserver(e=>{if(e[0]) setWidth(e[0].contentRect.width);});
    ro.observe(containerRef.current); return ()=>ro.disconnect();
  },[]);

  // Sidebar chips are now allowed to grow to fit their full text (no
  // truncation), so its rendered width varies with content rather than
  // being a fixed constant — measuring it directly (same ResizeObserver
  // pattern as the outer container above) is what lets the chart area
  // reliably avoid overlapping it, instead of guessing a width that could
  // be wrong for a long label.
  const sidebarRef=useRef();
  const [sidebarWidth,setSidebarWidth]=useState(190);
  useEffect(()=>{
    if (!sidebarRef.current) return;
    const ro=new ResizeObserver(e=>{if(e[0]) setSidebarWidth(e[0].contentRect.width);});
    ro.observe(sidebarRef.current); return ()=>ro.disconnect();
  },[]);

  useEffect(()=>{
    setViewBy("Overall");setChartType("line");setDisplayMode("panels");
    setActiveTab("timeseries");setSelectedYear(null);
    setEnabledStrats(new Set());setEnabledVarVals(new Set());setHighlighted(new Set());setShowCI(true);
    setShowWageDist(false);setShowAllYearsDist(false);
  },[targetVariable]);

  // Exclude special metric_type rows (wage_bin, pyramid_bin) from the normal
  // chart pipeline — they are consumed by their own dedicated chart components
  // and must not bleed into varValues, isCategorical, yDomain etc.
  // All scenario rows flattened — used for deriving varValues, isCategorical etc.
  const allScenarioRows=useMemo(()=>[...scenarioMap.values()].flat(),[scenarioMap]);
  // For charts that still take a single scenData prop, use the first ENABLED scenario
  const activeScenarioData=useMemo(()=>{
    for (const name of allScenarioNames) {
      if (enabledScenarios.has(name)) return scenarioMap.get(name)??[];
    }
    return scenarioData; // fallback to first scenario
  },[allScenarioNames,enabledScenarios,scenarioMap,scenarioData]);
  const combined     =useMemo(()=>
    [...baselineData,...allScenarioRows].filter(d=>
      d.metric_type!=="wage_bin"&&d.metric_type!=="pyramid_bin"&&d.metric_type!=="income_bin"&&
      !(d.variable==="Age"&&d.stratifier==="Gender")),
  [baselineData,allScenarioRows]);
  // Uses the variable's own canonical type (numeric vs. categorical/ordinal)
  // rather than sniffing metric_type off the data rows — a numeric variable
  // with any missing values also carries "Missing" share rows (see
  // parseCore.js), which are metric_type:"share" too, so sniffing alone
  // would misdetect an otherwise-numeric variable as categorical the moment
  // it has any missingness at all. Falls back to sniffing only if the
  // variable has no canonical definition on file.
  const isCategorical=useMemo(()=>{
    const def=getVariableDef(targetVariable);
    if (def.type==="numeric") return false;
    if (def.type==="categorical"||def.type==="ordinal") return true;
    return combined.some(d=>d.metric_type==="share"&&d.variable_value!=="Missing");
  },[combined,targetVariable]);

  // Special-case flags that unlock extra chart types
  const isHourlyEarnings  = targetVariable === "Hourly earnings";
  // "Population Pyramid" is a sentinel variable name — it is listed in
  // DOMAIN_SECTIONS under Demographics in App.js but is NOT a real aggregated
  // variable in the dataset.  When selected, DashboardSection renders the
  // pyramid as a self-contained module instead of the normal chart stack.
  const isPyramidModule   = targetVariable === "Population Pyramid";
  // Legacy flag kept for the ⊿ Pyramid tab button on the Age variable itself.
  const isPyramidVar      = targetVariable === "Age";
  // "Missing" isn't a real value of a numeric variable — it's metadata about
  // how much data is missing at each point — so it's excluded from the
  // plottable value list for numeric variables (categorical variables DO
  // keep "Missing" as a real, plottable category — see parseCore.js's
  // missing-value handling).
  const varValues    =useMemo(()=>{
    const vals=uniqueValues(combined,"variable_value");
    // Variables where "Missing" is a meaningful real category (not just suppressed data)
    // and should be kept in varValues and shown on charts.
    const MISSING_IS_MEANINGFUL = new Set(["Household Type","Number of children"]);
    const keepMissing = isCategorical && MISSING_IS_MEANINGFUL.has(targetVariable) && vals.includes("Missing");
    return orderVariableValues(targetVariable, keepMissing ? vals : vals.filter(v=>v!=="Missing"));
  },[combined,targetVariable,isCategorical]);
  // Lookup for numeric variables' missingness, keyed by scenario/year/
  // stratifier-value — used to append "X% missing" to a data point's
  // tooltip instead of ever plotting "Missing" as its own series. Keyed by
  // stratifier_value alone (not also stratifier name) since any single
  // chart render is always scoped to one active stratifier at a time.
  const missingLookup=useMemo(()=>{
    if (isCategorical) return null;
    const m=new Map();
    combined.forEach(d=>{ if (d.variable_value==="Missing") m.set(`${d.scenario}|${d.year}|${d.stratifier_value}`,d); });
    return m;
  },[combined,isCategorical]);
  const stratValues  =useMemo(()=>orderStratifierValues(viewBy,uniqueValues(combined.filter(d=>d.stratifier===viewBy),"stratifier_value").filter(v=>v!=="Missing")),[combined,viewBy]);
  const colourMap    =useMemo(()=>buildColourMap(targetVariable,varValues),[targetVariable,varValues]);
  const allYears     =useMemo(()=>{
    const src=isPyramidModule?pyramidBaseData:combined;
    return [...new Set(src.map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b);
  },[combined,isPyramidModule,pyramidBaseData]);
  const stratDef     =useMemo(()=>getStratifierDef(viewBy),[viewBy]);
  const isCatStrat   =stratDef?.type==="categorical";

  useEffect(()=>setEnabledStrats(new Set(stratValues)),[stratValues]);
  useEffect(()=>setEnabledVarVals(new Set(varValues)),[varValues]);
  useEffect(()=>setEnabledScenarios(new Set(allScenarioNames)),[allScenarioNames]);

  // scenarioMap filtered to current stratifier — used by LineChart in combined mode
  // Must be at top level (not inside JSX) to satisfy hooks rules
  const filteredScenMap=useMemo(()=>{
    if (!scenarioMap) return null;
    const strat=viewBy!=="Overall";
    const m=new Map();
    for (const [name,rows] of scenarioMap) {
      m.set(name,rows.filter(d=>strat?d.stratifier===viewBy:d.stratifier==="Overall"));
    }
    return m;
  },[scenarioMap,viewBy]);
  // selectedYear===null => "average" (default). Set by clicking a point; reset by clicking Avg.

  const isStratified=viewBy!=="Overall";
  const baseTime=useMemo(()=>baselineData.filter(d=>isStratified?d.stratifier===viewBy:d.stratifier==="Overall"),[baselineData,viewBy,isStratified]);
  const scenTime=useMemo(()=>activeScenarioData.filter(d=>isStratified?d.stratifier===viewBy:d.stratifier==="Overall"),[activeScenarioData,viewBy,isStratified]);
  // yDomain spans baseline + ALL scenario data so the axis doesn't jump between scenarios
  const allScenTime=useMemo(()=>allScenarioRows.filter(d=>isStratified?d.stratifier===viewBy:d.stratifier==="Overall"),[allScenarioRows,viewBy,isStratified]);
  const yDomain =useMemo(()=>buildYDomain([...baseTime,...allScenTime],isCategorical),[baseTime,allScenTime,isCategorical]);

  const showScenario=enabledScenarios.size>0;
  const showCrossSection=chartType==="line";

  const legendEntries=useMemo(()=>varValues.map(vv=>({label:vv,color:colourMap[vv]||GREY})),[varValues,colourMap]);

  // Stratifier legend entries for combined view (shape or width cue) — also
  // populated on the Δ Baseline → Scenario tab, which always overlays every
  // enabled stratum on one chart (like "combined") regardless of whatever
  // displayMode was last selected on the Time Series tab, so the delta plot
  // gets its own working stratifier legend/highlight controls too.
  const stratLegendEntries=useMemo(()=>{
    if (!isStratified||!(displayMode==="combined"||activeTab==="delta")) return [];
    return stratValues.filter(sv=>enabledStrats.has(sv)).map((sv,i)=>{
      if (isCatStrat){
        return {label:sv,color:TEXT_M,symIdx:i,symPath:d3.symbol().type(SYMBOLS[i%SYMBOLS.length]).size(52)()};
      } else {
        return {label:sv,color:TEXT_M,sw:ORDINAL_WIDTHS[i%ORDINAL_WIDTHS.length]};
      }
    });
  },[isStratified,displayMode,activeTab,stratValues,enabledStrats,isCatStrat]);

  const varLabel=addSpaces(targetVariable||"");

  const pubPropsFactory=useCallback((sv)=>({
    title:`${varLabel}${sv?` — ${addSpaces(stratLabel(sv,viewBy))}`:""} (${viewBy!=="Overall"?viewBy:"Overall"})`,
    legendEntries, stratLegendEntries:[], showBaseline, showScenario, highlighted,
    varScope:targetVariable, stratScope:viewBy,
  }),[varLabel,legendEntries,showBaseline,showScenario,highlighted,viewBy,targetVariable]);

  const pubProps=useCallback((title)=>({title,legendEntries,stratLegendEntries,showBaseline,showScenario,highlighted,varScope:targetVariable,stratScope:viewBy}),[legendEntries,stratLegendEntries,showBaseline,showScenario,highlighted,targetVariable,viewBy]);

  const onHighlight=useCallback(val=>{
    if (!val){setHighlighted(new Set());return;}
    setHighlighted(prev=>{const n=new Set(prev);n.has(val)?n.delete(val):n.add(val);return n;});
  },[]);
  const onToggleStrat =useCallback(sv=>setEnabledStrats(p=>{const n=new Set(p);n.has(sv)?n.delete(sv):n.add(sv);return n;}),[]);
  const onToggleVarVal=useCallback(vv=>setEnabledVarVals(p=>{const n=new Set(p);n.has(vv)?n.delete(vv):n.add(vv);return n;}),[]);
  const onYearClick   =useCallback(yr=>setSelectedYear(yr),[]);

  const hasBase=baseTime.some(d=>!isNaN(d.mean_value));
  const hasScen=scenTime.some(d=>!isNaN(d.mean_value));

  // Also filtered by enabledVarVals (not just enabledStrats) — this is what
  // combinedYDomain is built from, so turning a variable value on/off (e.g.
  // removing whichever series currently holds the max) now actually shrinks
  // or grows the y-axis instead of leaving it sized for values that are no
  // longer shown. LineChart itself already re-filters by enabledVarVals at
  // draw time, so passing the already-filtered arrays down as baseData/
  // scenData too is a no-op for rendering — it's the y-domain calculation
  // that actually needed this.
  const combinedBaseTime=useMemo(()=>baseTime.filter(d=>(!isStratified||enabledStrats.has(d.stratifier_value))&&enabledVarVals.has(d.variable_value)),[baseTime,isStratified,enabledStrats,enabledVarVals]);
  const combinedScenTime=useMemo(()=>scenTime.filter(d=>(!isStratified||enabledStrats.has(d.stratifier_value))&&enabledVarVals.has(d.variable_value)),[scenTime,isStratified,enabledStrats,enabledVarVals]);
  // combinedYDomain must span ALL enabled scenarios so values from Scenario 2
  // are never clipped when Scenario 1 has a narrower range.
  const combinedAllScenTime=useMemo(()=>allScenTime.filter(d=>(!isStratified||enabledStrats.has(d.stratifier_value))&&enabledVarVals.has(d.variable_value)),[allScenTime,isStratified,enabledStrats,enabledVarVals]);
  const combinedYDomain =useMemo(()=>buildYDomain([...combinedBaseTime,...combinedAllScenTime],isCategorical),[combinedBaseTime,combinedAllScenTime,isCategorical]);

  // Style helpers — a single flat toolbar rather than boxed cards: inline
  // labels next to each control, thin dividers between logical groups,
  // moderate (not oversized) touch targets.
  const controlLabel={fontSize:12,fontWeight:700,color:TEAL,textTransform:"uppercase",letterSpacing:"0.04em",whiteSpace:"nowrap"};
  const segGroup={display:"flex",gap:2,background:"#eae6de",borderRadius:8,padding:3};
  const togBtn=active=>({padding:"8px 16px",borderRadius:6,fontSize:13.5,fontWeight:600,cursor:"pointer",border:"none",background:active?"#fff":"transparent",color:active?TEAL:TEXT_S,boxShadow:active?"0 1px 2px rgba(0,0,0,0.08)":"none",transition:"all 0.15s"});
  // dvBtn removed — replaced by ScenarioToggles component

  const crossTitle=selectedYear===null?"Average across all years":`Year ${selectedYear}`;

  // Left-sidebar (Filter Variables / Stratifiers / Highlight) visibility —
  // same conditions each section already used individually, just checked
  // up front so we know whether to reserve sidebar width for the charts.
  const showFilterVars  =isCategorical&&varValues.length>1;
  const showStratFilters=isStratified&&stratValues.length>0;
  // Highlight only makes sense when there's more than one thing to pick
  // between. A numeric variable has exactly one series ("Mean") unless it's
  // stratified — in which case stratLegendEntries (one per stratum line) is
  // what makes highlighting worthwhile, not legendEntries.
  const showHighlight   =!isHourlyEarnings&&!(activeTab==="timeseries"&&chartType==="bar")&&(legendEntries.length>1||stratLegendEntries.length>0);
  const hasSidebar       =showFilterVars||showStratFilters||showHighlight;
  // Below this container width, the sidebar can't sit beside the chart
  // without squeezing it unusably narrow — collapse it to a full-width row
  // ABOVE the chart instead (same content, different layout direction).
  // Uses `width` (the actual measured container width from the
  // ResizeObserver) as a general narrow-viewport check, PLUS a check
  // against the sidebar's own actual measured width (sidebarWidth, from the
  // ResizeObserver above) — chips now grow to fit their full text rather
  // than truncating, so a single long label can make the sidebar wider
  // than expected; if that ever leaves less than 240px for the chart, stack
  // instead of letting the two visually collide.
  const stackSidebar=hasSidebar&&(width<640||(width-sidebarWidth-20)<240);
  // Charts size themselves off this instead of the raw container width
  // whenever the sidebar is actually taking up horizontal space beside them.
  const chartAreaWidth=hasSidebar&&!stackSidebar?Math.max(240,width-sidebarWidth-20):width;

  return (
    <div ref={containerRef} style={{width:"100%",maxWidth:"100%",overflowX:"hidden"}}>

      {/* ════════════════════════════════════════════════════════════════════════
          POPULATION PYRAMID — standalone module, shown instead of the normal
          chart stack when the user selects "Population Pyramid" from the
          Demographics sidebar section.  Uses pyramidBaseData / pyramidScenData
          (always the Age-variable rows from parsedCache) rather than
          baselineData / scenarioData, which are empty for this sentinel variable.
      ════════════════════════════════════════════════════════════════════════ */}
      {isPyramidModule&&(
        <div>
          {/* View controls — Baseline toggle + per-scenario toggles */}
          <div style={{marginBottom:14,display:"flex",flexDirection:"column",gap:10,paddingBottom:10,borderBottom:"1px solid #e2ddd5"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={controlLabel}>View</span>
              <ScenarioToggles showBaseline={showBaseline} setShowBaseline={setShowBaseline}
                allScenarioNames={allScenarioNames} enabledScenarios={enabledScenarios} setEnabledScenarios={setEnabledScenarios} isCategorical={isCategorical}/>
            </div>
          </div>

          {/* Year picker */}
          <div style={{marginBottom:14,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{...controlLabel,marginRight:4}}>Year</span>
            <button
              onClick={()=>setSelectedYear(null)}
              style={{padding:"5px 12px",borderRadius:5,fontSize:12,cursor:"pointer",
                border:selectedYear===null?`1px solid ${TEAL}`:"1px solid #ddd8ce",
                background:selectedYear===null?`${TEAL}18`:"#eae6de",
                color:selectedYear===null?TEAL:TEXT_S,fontWeight:selectedYear===null?700:500}}>
              Avg
            </button>
            {allYears.map(yr=>(
              <button key={yr} onClick={()=>setSelectedYear(yr)}
                style={{padding:"5px 12px",borderRadius:5,fontSize:12,cursor:"pointer",
                  border:selectedYear===yr?`1px solid ${TEAL}`:"1px solid #ddd8ce",
                  background:selectedYear===yr?`${TEAL}18`:"#eae6de",
                  color:selectedYear===yr?TEAL:TEXT_S,fontWeight:selectedYear===yr?700:500}}>
                {yr}
              </button>
            ))}
          </div>

          <p style={{margin:"0 0 12px",fontSize:13,color:TEXT_M,fontStyle:"italic"}}>
            Age structure of the simulated population, split by gender.
            {selectedYear===null?" Showing average across all years.":" Year "+selectedYear+"."}
          </p>

          <PopulationPyramid
            baselineData={pyramidBaseData}
            scenarioData={pyramidScenData}
            year={selectedYear}
            showBaseline={showBaseline}
            showScenario={showScenario}
            width={width}
            svgRef={pyramidRef}
            scenarioMap={pyramidScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}
          />
          <div style={{display:"flex",gap:4,justifyContent:"flex-end",marginTop:4}}>
            <DownloadBtn
              svgRef={pyramidRef}
              filename={`population_pyramid${selectedYear?`_${selectedYear}`:"_average"}.png`}
              pubProps={{
                title:`Population Pyramid — Age Structure by Gender${selectedYear?` (${selectedYear})`:" (Average)"}`,
                legendEntries:[],stratLegendEntries:[],
                showBaseline,showScenario,highlighted:new Set(),
                varScope:"Age",stratScope:"Gender",
              }}
            />
            <button
              onClick={()=>{
                const src = [
                  ...(showBaseline?pyramidBaseData:[]),
                  ...(showScenario?pyramidScenData:[]),
                ].filter(d=>selectedYear===null||d.year===selectedYear);
                exportCsv(src,"population_pyramid"+(selectedYear?`_${selectedYear}`:"_average")+".csv",{isContinuous:false});
              }}
              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>
              ↓ CSV
            </button>
          </div>
        </div>
      )}

      {/* ── All normal chart controls + content — hidden when pyramid module is active ── */}
      {!isPyramidModule&&<>

      {/* ── Controls + filters + legend — flat toolbar, no boxes ── */}
      <div style={{marginBottom:14,display:"flex",flexDirection:"column",gap:10,paddingBottom:10,borderBottom:"1px solid #e2ddd5"}}>

        {/* Row 1: Stratify by, on its own — keeps the second row free for
            Chart type / View / Layout / CI / Compare to stay on one line */}
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={controlLabel}>Stratify by</span>
          <select value={viewBy} onChange={e=>{setViewBy(e.target.value);setHighlighted(new Set());}}
            style={{padding:"8px 12px",borderRadius:7,border:"1px solid #ddd8ce",fontSize:14,color:TEXT_D,background:"#eae6de",height:38,boxSizing:"border-box",cursor:"pointer",fontWeight:500}}>
            {["Overall","Age","Gender","Disability Status","Region","Ethnicity","Income Quintile","Household Type"].map(o=><option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        {/* Row 2: everything else — inline labels, thin dividers between
            logical groups, no boxed cards */}
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",rowGap:8}}>

          <span style={controlLabel}>Chart type</span>
          <div style={segGroup}>
            <button style={togBtn(chartType==="line"&&activeTab==="timeseries"&&!showWageDist)} onClick={()=>{setChartType("line");setActiveTab("timeseries");setShowWageDist(false);}}>〜 Line</button>
            {isCategorical&&<button style={togBtn(chartType==="bar"&&activeTab==="timeseries"&&!showWageDist)} onClick={()=>{setChartType("bar");setActiveTab("timeseries");setShowWageDist(false);}}>▦ Stacked</button>}
            {isPyramidVar&&<button style={togBtn(activeTab==="pyramid")} onClick={()=>{setActiveTab("pyramid");setShowWageDist(false);}}>⊿ Pyramid</button>}
            <button style={togBtn(activeTab==="delta")} onClick={()=>{setActiveTab("delta");setShowWageDist(false);}}>Δ Baseline → Scenario</button>
          </div>

          <span style={controlLabel}>View</span>
          <ScenarioToggles showBaseline={showBaseline} setShowBaseline={setShowBaseline}
            allScenarioNames={allScenarioNames} enabledScenarios={enabledScenarios} setEnabledScenarios={setEnabledScenarios} isCategorical={isCategorical}/>

          {/* Layout — only when stratified + line + time series */}
          {activeTab==="timeseries"&&isStratified&&chartType==="line"&&!showWageDist&&(
            <>
              <span style={controlLabel}>Layout</span>
              <div style={segGroup}>
                <button style={togBtn(displayMode==="panels")}   onClick={()=>setDisplayMode("panels")}>⊞ Panels</button>
                <button style={togBtn(displayMode==="combined")} onClick={()=>setDisplayMode("combined")}>⊡ Combined</button>
              </div>
            </>
          )}

          {/* CI band toggle — small, only relevant for the full-size line chart (not small-multiple panels) */}
          {activeTab==="timeseries"&&chartType==="line"&&!showWageDist&&!(isStratified&&displayMode==="panels")&&(
            <button onClick={()=>setShowCI(v=>!v)} title="Toggle 95% uncertainty interval bands"
              style={{padding:"7px 12px",borderRadius:6,fontSize:12.5,fontWeight:600,cursor:"pointer",lineHeight:1.6,
                border:showCI?`1px solid ${TEAL}`:"1px solid #ddd8ce",background:showCI?`${TEAL}18`:"#eae6de",color:showCI?TEAL:TEXT_S}}>
              {showCI?"▮ 95% CI":"▯ 95% CI"}
            </button>
          )}
        </div>

        {/* Row 3 — "View data as" for Hourly Earnings only.
            Sits below the main toolbar on its own line so it's visually
            distinct from Chart type and doesn't crowd the row. */}
        {isHourlyEarnings&&activeTab!=="delta"&&(
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",rowGap:8}}>
            <span style={controlLabel}>View data as</span>
            <div style={segGroup}>
              <button
                style={togBtn(!showWageDist)}
                onClick={()=>{setShowWageDist(false);}}>
                Continuous average
              </button>
              <button
                style={togBtn(showWageDist)}
                onClick={()=>{setShowWageDist(true);}}>
                Binned distribution
              </button>
            </div>
            {/* All years / single year sub-toggle — only when distribution is active */}
            {showWageDist&&(
              <>
                <span style={{...controlLabel,color:TEXT_S}}>across</span>
                <div style={segGroup}>
                  <button style={togBtn(!showAllYearsDist)} onClick={()=>setShowAllYearsDist(false)}>Selected year</button>
                  <button style={togBtn(showAllYearsDist)}  onClick={()=>setShowAllYearsDist(true)}>All years</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Sidebar (Filter Variables / Stratifiers / Highlight) + chart content ── */}
      <div style={{display:"flex",flexDirection:stackSidebar?"column":"row",gap:20,alignItems:stackSidebar?"stretch":"flex-start"}}>

        {hasSidebar&&(
          <div ref={sidebarRef} style={{
            width:stackSidebar?"100%":"auto",flexShrink:0,
            display:"flex",flexDirection:stackSidebar?"row":"column",
            flexWrap:stackSidebar?"wrap":"nowrap",gap:stackSidebar?"14px 28px":18,
          }}>

            {showFilterVars&&(
              <div style={{display:"flex",flexDirection:"column",gap:8,...(stackSidebar?{flex:"1 1 220px",minWidth:200}:{})}}>
                <span style={controlLabel}>Filter Variables</span>
                <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                  {varValues.map(vv=>{
                    const isOn=enabledVarVals.has(vv);
                    const c=colourMap[vv]||TEAL;
                    return (
                      <button key={vv} onClick={()=>onToggleVarVal(vv)} title={addSpaces(stratLabel(vv,targetVariable))} style={{
                        display:"flex",alignItems:"center",gap:7,cursor:"pointer",padding:"7px 12px",borderRadius:18,
                        width:"auto",maxWidth:160,boxSizing:"border-box",
                        border:`1.5px solid ${isOn?c:"#ddd8ce"}`,background:isOn?`${c}18`:"transparent",transition:"all 0.15s",
                      }}>
                        <span style={{width:9,height:9,borderRadius:"50%",background:isOn?c:"#c7c1b6",flexShrink:0}}/>
                        <span style={{fontSize:13,fontWeight:isOn?600:500,color:isOn?TEXT_D:TEXT_S,textAlign:"left",whiteSpace:"normal",wordBreak:"break-word",minWidth:0}}>{addSpaces(stratLabel(vv,targetVariable))}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{display:"flex",gap:10}}>
                  <button onClick={()=>setEnabledVarVals(new Set(varValues))} style={{fontSize:12,fontWeight:600,color:TEAL,background:"none",border:"none",cursor:"pointer",padding:0,textDecoration:"underline"}}>All</button>
                  <button onClick={()=>setEnabledVarVals(new Set())} style={{fontSize:12,fontWeight:600,color:TEXT_S,background:"none",border:"none",cursor:"pointer",padding:0,textDecoration:"underline"}}>None</button>
                </div>
              </div>
            )}

            {/* Filter Stratifiers sits above Highlight — for combined/delta
                views this is the control that determines which strata are
                even present to highlight, so it reads more naturally first. */}
            {showStratFilters&&(
              <div style={{display:"flex",flexDirection:"column",gap:8,...(stackSidebar?{flex:"1 1 220px",minWidth:200}:{})}}>
                <span style={controlLabel}>Filter Stratifiers</span>
                <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                  {stratValues.map(sv=>{
                    const isOn=enabledStrats.has(sv);
                    return (
                      <button key={sv} onClick={()=>onToggleStrat(sv)} title={addSpaces(stratLabel(sv,viewBy))} style={{
                        display:"flex",alignItems:"center",gap:7,cursor:"pointer",padding:"7px 12px",borderRadius:18,
                        width:"auto",maxWidth:160,boxSizing:"border-box",
                        border:`1.5px solid ${isOn?TEAL:"#ddd8ce"}`,background:isOn?`${TEAL}18`:"transparent",transition:"all 0.15s",
                      }}>
                        <span style={{fontSize:13,fontWeight:isOn?600:500,color:isOn?TEXT_D:TEXT_S,textAlign:"left",whiteSpace:"normal",wordBreak:"break-word",minWidth:0}}>{addSpaces(stratLabel(sv,viewBy))}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{display:"flex",gap:10}}>
                  <button onClick={()=>setEnabledStrats(new Set(stratValues))} style={{fontSize:12,fontWeight:600,color:TEAL,background:"none",border:"none",cursor:"pointer",padding:0,textDecoration:"underline"}}>All</button>
                  <button onClick={()=>setEnabledStrats(new Set())} style={{fontSize:12,fontWeight:600,color:TEXT_S,background:"none",border:"none",cursor:"pointer",padding:0,textDecoration:"underline"}}>None</button>
                </div>
              </div>
            )}

            {showHighlight&&(
              <div style={{display:"flex",flexDirection:"column",gap:8,...(stackSidebar?{flex:"1 1 220px",minWidth:200}:{})}}>
                <span style={controlLabel}>
                  {highlighted.size>0?"Highlighting:":"Highlight variables"}
                </span>
                {legendEntries.length>1&&(
                  <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                    <LegendRow label={null} entries={legendEntries} highlighted={highlighted} onToggle={onHighlight} vertical={!stackSidebar} scope={targetVariable}/>
                  </div>
                )}
                {stratLegendEntries.length>0&&(
                  <>
                    {/* Skip this second header when it's the ONLY thing in
                        the panel (numeric variables, where the row above is
                        skipped) — "Highlight variables" above already says
                        what this is; the extra "Highlight Stratifiers" label
                        only adds useful context when it's disambiguating
                        against the variable-value row shown alongside it. */}
                    {legendEntries.length>1&&<span style={{...controlLabel,marginTop:4,paddingTop:8,borderTop:"1px solid #e2ddd5"}}>Highlight Stratifiers</span>}
                    <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                      <LegendRow label={null} entries={stratLegendEntries} highlighted={highlighted} onToggle={onHighlight} showSymbols={isCatStrat} vertical={!stackSidebar} scope={viewBy}/>
                    </div>
                  </>
                )}
                {(showBaseline||showScenario)&&(
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:4,paddingTop:8,borderTop:"1px solid #e2ddd5"}}>
                    {showBaseline&&(
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <svg width="20" height="9"><line x1="0" y1="4" x2="20" y2="4" stroke={isCategorical?TEXT_M:NUMERIC_BASE_COLOUR} strokeWidth="2.5"/></svg>
                        <span style={{fontSize:12.5,color:TEXT_S,fontWeight:500}}>Baseline</span>
                      </div>
                    )}
                    {allScenarioNames.filter(n=>enabledScenarios.has(n)).map((name)=>{const gi=allScenarioNames.indexOf(name);
                      const lineColour=isCategorical?TEXT_M:NUMERIC_SCEN_COLOURS[gi%NUMERIC_SCEN_COLOURS.length];
                      return(
                        <div key={name} style={{display:"flex",alignItems:"center",gap:6}}>
                          <svg width="20" height="9"><line x1="0" y1="4" x2="20" y2="4" stroke={lineColour} strokeWidth="2.5" strokeDasharray={SCENARIO_DASHES[gi%SCENARIO_DASHES.length]}/></svg>
                          <span style={{fontSize:12.5,color:TEXT_S,fontWeight:500}}>{scenarioLabel(name)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{flex:1,minWidth:0}}>

      {/* ════════ TIME SERIES ════════ */}
      {activeTab==="timeseries"&&!showWageDist&&(
        !hasBase&&!hasScen
          ?<p style={{fontSize:13,color:TEXT_S,fontStyle:"italic"}}>No data available.</p>
          :<div>
            {/* ── LINE MODE ── */}
            {chartType==="line"&&(()=>{
              // Overall view: side-by-side [line chart | cross-section bar]
              // Stratified panels: stacked (panels take full width)
              // Stratified combined: full-width line, cross-section below
              const isOverall=!isStratified;
              const isPanels=isStratified&&displayMode==="panels";
              // Below this width, a side-by-side split leaves neither chart
              // usably wide — stack them full-width instead (flexWrap below
              // then does the actual stacking; this just decides whether to
              // even attempt a 62/38 split in the first place).
              const stackOverallLayout=isOverall&&chartAreaWidth<600;
              // Widths for side-by-side (overall only)
              const lineW   = isOverall ? (stackOverallLayout?chartAreaWidth:Math.round(chartAreaWidth*0.62)) : chartAreaWidth;
              const crossW  = isOverall ? (stackOverallLayout?chartAreaWidth:Math.max(200, chartAreaWidth - lineW - 20)) : chartAreaWidth;

              const crossSectionTitle=selectedYear===null
                ?<span>Average across all years <span style={{fontSize:11,color:TEXT_S,fontWeight:400}}>(click a point to pin a year)</span></span>
                :<span>Year {selectedYear} <button onClick={()=>setSelectedYear(null)} style={{fontSize:11,color:TEAL,background:"none",border:"none",cursor:"pointer",textDecoration:"underline",marginLeft:4,padding:0}}>reset to avg</button></span>;

              const lineChart=(
                <LineChart svgRef={lineRef} baseData={combinedBaseTime} scenData={combinedScenTime}
                  colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                  yDomain={combinedYDomain} varValues={varValues} enabledVarVals={enabledVarVals}
                  showBaseline={showBaseline} showScenario={showScenario}
                  width={isOverall?lineW:chartAreaWidth} onYearClick={onYearClick} selectedYear={selectedYear}
                  isStratified={isStratified} stratValues={stratValues} enabledStrats={enabledStrats} viewBy={viewBy}
                  showCI={showCI} allYears={allYears} missingLookup={missingLookup} varLabel={varLabel}
                  scenarioMap={filteredScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
              );

              const crossSection=(
                <CrossSectionPanel baseData={baselineData} scenData={scenarioData}
                  colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                  varValues={varValues} enabledVarVals={enabledVarVals}
                  enabledStrats={enabledStrats} viewBy={viewBy}
                  showBaseline={showBaseline} showScenario={showScenario}
                  width={isOverall?crossW:chartAreaWidth} year={selectedYear} isAverage={selectedYear===null}
                  pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}
                  scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
              );

              return (
                <div>
                  {isPanels
                    ?<>
                      <p style={{margin:"0 0 10px",fontSize:12.5,color:TEXT_S,fontStyle:"italic"}}>Click a year on any panel to see a cross-section view for that stratum.</p>
                      <SmallMultiplesPanel baseData={baseTime} scenData={scenTime} stratValues={stratValues}
                        colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                        varValues={varValues} enabledVarVals={enabledVarVals} enabledStrats={enabledStrats}
                        showBaseline={showBaseline} showScenario={showScenario} chartType="line" width={chartAreaWidth}
                        pubPropsFactory={pubPropsFactory} targetVariable={targetVariable} viewBy={viewBy}
                        allBaseData={baseTime} allScenData={scenTime} missingLookup={missingLookup}
                        scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
                    </>
                    /* Overall or combined-stratified */
                    :<div>
                      {isOverall
                        /* Side-by-side: line left (with its own buttons below), cross-section right (with its own buttons) — stacks full-width on narrow screens instead */
                        ?<div style={{display:"flex",gap:20,alignItems:"flex-start",flexWrap:"wrap"}}>
                          {/* Line chart + its download buttons flush below.
                              The invisible spacer matches the cross-section title row height
                              so both SVGs share the same top edge. */}
                          <div style={{flexShrink:0,display:"flex",flexDirection:"column",gap:4,width:stackOverallLayout?"100%":"auto"}}>
                            <div style={{marginBottom:6,visibility:"hidden",fontSize:12,fontWeight:700}}>&nbsp;</div>
                            {lineChart}
                            <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                              <DownloadBtn svgRef={lineRef} filename="time_series.png" pubProps={pubProps(`${varLabel} over time`)}/>
                              <button onClick={()=>exportCsv([...baseTime,...scenTime].filter(d=>enabledVarVals.has(d.variable_value)),`${slugify(varLabel)}_time_series.csv`,{isContinuous:!isCategorical})}
                                style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                            </div>
                          </div>
                          {/* Cross-section with its own title + buttons handled inside CrossSectionPanel */}
                          <div style={{flexShrink:0,flexGrow:1,minWidth:0,width:stackOverallLayout?"100%":"auto"}}>
                            <div style={{marginBottom:6}}>
                              <span style={{fontSize:12,fontWeight:700,color:TEXT_D}}>{crossSectionTitle}</span>
                            </div>
                            {crossSection}
                          </div>
                        </div>
                        /* Stratified combined — line + buttons below, then the
                           cross-section (one bar panel per enabled stratum) —
                           clicking a point on the line above pins a year here
                           exactly like the Overall view does, via the same
                           onYearClick/selectedYear passed into lineChart. */
                        :<div style={{display:"flex",flexDirection:"column",gap:4}}>
                          {lineChart}
                          <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                            <DownloadBtn svgRef={lineRef} filename="time_series.png" pubProps={pubProps(`${varLabel} over time by ${viewBy}`)}/>
                            <button onClick={()=>exportCsv([...baseTime,...scenTime].filter(d=>enabledStrats.has(d.stratifier_value)&&enabledVarVals.has(d.variable_value)),`${slugify(varLabel)}_time_series.csv`,{isContinuous:!isCategorical})}
                              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                          </div>
                          <div style={{marginTop:12}}>
                            <div style={{marginBottom:6}}>
                              <span style={{fontSize:12,fontWeight:700,color:TEXT_D}}>{crossSectionTitle}</span>
                            </div>
                            {crossSection}
                          </div>
                        </div>
                      }
                    </div>
                  }
                </div>
              );
            })()}

            {/* ── STACKED BAR MODE ── */}
            {chartType==="bar"&&(
              <div style={{marginBottom:4}}>
                {isStratified
                  ?<SmallMultiplesPanel baseData={baseTime} scenData={scenTime} stratValues={stratValues}
                      colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                      varValues={varValues} enabledVarVals={enabledVarVals} enabledStrats={enabledStrats}
                      showBaseline={showBaseline} showScenario={showScenario} chartType="bar" width={chartAreaWidth}
                      pubPropsFactory={pubPropsFactory} targetVariable={targetVariable} viewBy={viewBy}
                      allBaseData={baseTime} allScenData={scenTime}
                      scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
                  :<div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <StackedBarChart svgRef={barRef} baseData={baseTime} scenData={scenTime}
                      colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                      varValues={varValues} enabledVarVals={enabledVarVals}
                      showBaseline={showBaseline} showScenario={showScenario}
                      width={chartAreaWidth} patId="ts" allYears={allYears} varLabel={varLabel}
                      scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
                    <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                      <DownloadBtn svgRef={barRef} filename="stacked_bar.png" pubProps={pubProps(`${varLabel} by year — stacked`)}/>
                      <button onClick={()=>exportCsv([...baseTime,...scenTime].filter(d=>enabledVarVals.has(d.variable_value)),`${slugify(varLabel)}_stacked.csv`,{isContinuous:!isCategorical})}
                        style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                    </div>
                  </div>
                }
              </div>
            )}
          </div>
      )}

      {/* ════════ DELTA ════════
          All enabled scenarios vs Baseline on a single chart. */}
      {activeTab==="delta"&&(
        enabledScenarios.size===0
          ? <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic"}}>No scenarios enabled — use the View toggles above to enable a scenario.</p>
          : <div style={{display:"flex",flexDirection:"column",gap:20}}>
              <DeltaSection baseData={baselineData} scenData={scenarioData}
                colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                varValues={varValues} enabledVarVals={enabledVarVals}
                enabledStrats={enabledStrats} viewBy={viewBy} width={chartAreaWidth}
                legendEntries={legendEntries} stratValues={stratValues} stratLegendEntries={stratLegendEntries}
                scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}
                onYearClick={yr=>setDeltaYear(prev=>prev===yr?null:yr)} selectedYear={deltaYear}/>
              {deltaYear&&(
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                    <span style={{fontSize:13,fontWeight:700,color:TEAL}}>Means — Year {deltaYear}</span>
                    <button onClick={()=>setDeltaYear(null)}
                      style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>✕ Clear</button>
                  </div>
                  <GroupedBarChart
                    svgRef={deltaCsRef}
                    baseData={baseTime.filter(d=>d.year===deltaYear)}
                    scenData={scenTime.filter(d=>d.year===deltaYear)}
                    colourMap={colourMap} highlighted={highlighted}
                    isCategorical={isCategorical} yDomain={combinedYDomain}
                    varValues={varValues} enabledVarVals={enabledVarVals}
                    showBaseline={showBaseline} showScenario={showScenario}
                    width={chartAreaWidth} year={deltaYear} varLabel={varLabel}
                    isStratified={false}
                    scenarioMap={scenarioMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}/>
                </div>
              )}
            </div>
      )}

      {/* ════════ POPULATION PYRAMID ════════
          Only rendered when targetVariable==="Age" and the Pyramid tab is active.
          Uses Gender-stratified Age rows that are already in the aggregated data —
          no new pipeline work needed. */}
      {activeTab==="pyramid"&&isPyramidVar&&(
        <div>
          <p style={{margin:"0 0 10px",fontSize:13,color:TEXT_M,fontStyle:"italic"}}>
            Age structure of the population, split by gender.
            {selectedYear===null
              ? " Showing average across all years — click a year on the time series to pin one."
              : ` Year ${selectedYear}.`}
          </p>
          <PopulationPyramid
            baselineData={pyramidBaseData}
            scenarioData={pyramidScenData}
            year={selectedYear}
            showBaseline={showBaseline}
            showScenario={showScenario}
            width={chartAreaWidth}
            svgRef={pyramidRef}
            scenarioMap={pyramidScenMap} enabledScenarios={enabledScenarios} allScenarioNames={allScenarioNames}
          />
          <div style={{display:"flex",gap:4,justifyContent:"flex-end",marginTop:4}}>
            <DownloadBtn
              svgRef={pyramidRef}
              filename={`population_pyramid${selectedYear?`_${selectedYear}`:"_average"}.png`}
              pubProps={{
                title:`Population Pyramid — Age Structure by Gender${selectedYear?` (${selectedYear})`:" (Average)"}`,
                legendEntries:[],stratLegendEntries:[],
                showBaseline,showScenario,highlighted:new Set(),
                varScope:"Age",stratScope:"Gender",
              }}
            />
            <button
              onClick={()=>{
                const pyrRows=[...(showBaseline?pyramidBaseData:[]),...(showScenario?pyramidScenData:[])]
                  .filter(d=>selectedYear===null||d.year===selectedYear);
                exportCsv(pyrRows,"population_pyramid"+(selectedYear?`_${selectedYear}`:"_average")+".csv",{isContinuous:false});
              }}
              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>
              ↓ CSV
            </button>
          </div>
          {/* Year selector — same year-click mechanic as the line chart; give the
              user a small row of year buttons to drive the pyramid without needing
              the line chart to be visible at the same time. */}
          <div style={{marginTop:10,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:12,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em"}}>Year</span>
            <button
              onClick={()=>setSelectedYear(null)}
              style={{padding:"5px 10px",borderRadius:5,fontSize:12,cursor:"pointer",
                border:selectedYear===null?`1px solid ${TEAL}`:"1px solid #ddd8ce",
                background:selectedYear===null?`${TEAL}18`:"#eae6de",
                color:selectedYear===null?TEAL:TEXT_S,fontWeight:selectedYear===null?700:500}}>
              Avg
            </button>
            {allYears.map(yr=>(
              <button key={yr}
                onClick={()=>setSelectedYear(yr)}
                style={{padding:"5px 10px",borderRadius:5,fontSize:12,cursor:"pointer",
                  border:selectedYear===yr?`1px solid ${TEAL}`:"1px solid #ddd8ce",
                  background:selectedYear===yr?`${TEAL}18`:"#eae6de",
                  color:selectedYear===yr?TEAL:TEXT_S,fontWeight:selectedYear===yr?700:500}}>
                {yr}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ════════ WAGE DISTRIBUTION ════════
          Replaces the normal time-series/cross-section chart area when
          "Binned distribution" is selected in the View data as row.
          The time-series block below is hidden while this is showing. */}
      {isHourlyEarnings&&showWageDist&&activeTab!=="delta"&&(
        <div>
          <p style={{margin:"0 0 10px",fontSize:13,color:TEXT_M,fontStyle:"italic"}}>
            {showAllYearsDist
              ? "Weighted share of workers in each hourly-earnings band, all years."
              : selectedYear
                ? `Weighted share of workers in each hourly-earnings band, ${selectedYear}.`
                : "Weighted share of workers in each hourly-earnings band, averaged across all years."}
          </p>
          <WageDistributionChart
            baselineData={baselineData}
            scenarioData={scenarioData}
            year={selectedYear}
            showAllYears={showAllYearsDist}
            showBaseline={showBaseline}
            showScenario={showScenario}
            viewBy={viewBy}
            enabledStrats={enabledStrats}
            width={chartAreaWidth}
            svgRef={wageDistRef}
            scenarioMap={scenarioMap}
            enabledScenarios={enabledScenarios}
            allScenarioNames={allScenarioNames}
          />
          {/* Download buttons */}
          <div style={{display:"flex",gap:4,justifyContent:"flex-end",marginTop:4}}>
            <DownloadBtn
              svgRef={wageDistRef}
              filename={`hourly_earnings_distribution${selectedYear?`_${selectedYear}`:showAllYearsDist?"_all_years":"_average"}.png`}
              pubProps={{
                title:`Hourly Earnings — Binned Distribution${selectedYear?` (${selectedYear})`:showAllYearsDist?" (All years)":" (Average)"}`,
                legendEntries:[],stratLegendEntries:[],
                showBaseline,showScenario,highlighted:new Set(),
                varScope:"Hourly earnings",stratScope:viewBy,
              }}
            />
            <button
              onClick={()=>{
                // Build exportable rows from the wage_bin rows for the current view
                const wbRows = [
                  ...(showBaseline ? baselineData : []),
                  ...(showScenario ? scenarioData  : []),
                ].filter(d =>
                  d.metric_type === "wage_bin" &&
                  d.variable    === "Hourly earnings" &&
                  d.variable_value !== "Missing" &&
                  (viewBy === "Overall"
                    ? d.stratifier === "Overall"
                    : d.stratifier === viewBy && enabledStrats.has(d.stratifier_value)) &&
                  (showAllYearsDist || selectedYear === null || d.year === selectedYear)
                );
                exportCsv(wbRows,
                  `hourly_earnings_distribution${selectedYear?`_${selectedYear}`:showAllYearsDist?"_all_years":"_average"}.csv`,
                  { isContinuous: false });
              }}
              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>
              ↓ CSV
            </button>
          </div>
          {/* Year picker — shown only in single-year mode.
              null = Average (the default), a number = that specific year. */}
          {!showAllYearsDist&&(
            <div style={{marginTop:10,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:12,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em"}}>Year</span>
              <button onClick={()=>setSelectedYear(null)}
                style={{padding:"5px 10px",borderRadius:5,fontSize:12,cursor:"pointer",
                  border:selectedYear===null?`1px solid ${TEAL}`:"1px solid #ddd8ce",
                  background:selectedYear===null?`${TEAL}18`:"#eae6de",
                  color:selectedYear===null?TEAL:TEXT_S,fontWeight:selectedYear===null?700:500}}>
                Average
              </button>
              {allYears.map(yr=>(
                <button key={yr} onClick={()=>setSelectedYear(yr)}
                  style={{padding:"5px 10px",borderRadius:5,fontSize:12,cursor:"pointer",
                    border:selectedYear===yr?`1px solid ${TEAL}`:"1px solid #ddd8ce",
                    background:selectedYear===yr?`${TEAL}18`:"#eae6de",
                    color:selectedYear===yr?TEAL:TEXT_S,fontWeight:selectedYear===yr?700:500}}>
                  {yr}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

        </div>
      </div>

      {/* closes {!isPyramidModule&&<> above */}
      </>}

    </div>
  );
}
