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
import {
  useAggregatedData, uniqueValues, stratLabel, averageAcrossYears,
  buildColourMap, orderVariableValues, orderStratifierValues, GREY,
  getStratifierDef, getVariableDef,
} from "./useAggregatedData";

// ─── Layout ───────────────────────────────────────────────────────────────────
const CHART_H    = 380;  // full-size chart height (Overall view, stratified-combined)
const CHART_H_SM = 200;  // small-multiple panel height
const MAX_W      = 480;  // wide enough to use most of the container
const PANEL_MIN_W= 280;
const M     = { top:24, right:24, bottom:70, left:72 }; // extra bottom for key
const M_SM  = { top:12, right:10, bottom:40, left:50 };

// ─── Colours / fonts ──────────────────────────────────────────────────────────
const TEAL    = "#14687c";
const BG_CARD = "#fbf8f2"; // slightly lighter than before
const TEXT_D  = "#1e293b";
const TEXT_M  = "#475569";
const TEXT_S  = "#64748b";
const PUB_FONT= "'Work Sans', Arial, sans-serif";
const FONT_SZ = "12px"; // single source of truth for all chart text

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
const ORDINAL_WIDTHS = [1, 1.75, 2.5, 3.25, 4, 4.75, 5.5];

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
function fmtSample(row){
  if (!row||row.mean_sample==null||isNaN(row.mean_sample)) return "";
  const n=row.n_runs;
  return `<br/>Sample: ${Math.round(row.mean_sample).toLocaleString()}${n!=null?` (avg across ${n} run${n===1?"":"s"})`:""}`;
}
/** Delta-specific variant of fmtSample() — a Δ figure is a difference of two independent samples, so shows both sides' average per-run sample size rather than a single number. */
function fmtDeltaSample(row){
  if (!row||row.base_mean_sample==null||row.scen_mean_sample==null) return "";
  return `<br/>Sample: Baseline ${Math.round(row.base_mean_sample).toLocaleString()} · Scenario ${Math.round(row.scen_mean_sample).toLocaleString()}`;
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
  return `<br/>Missing: ${pct}%`+(avgN!=null?` (avg ${avgN.toLocaleString()} missing${n!=null?` per run, across ${n} run${n===1?"":"s"}`:""})`:"");
}
/** d3.extent() over a list of years, but guards the two degenerate cases: no years at all (→ [0,1]) and a single distinct year (→ that year ±1, so the axis isn't zero-width). */
function safeYearDomain(yrs){
  const [y0,y1]=d3.extent(yrs);
  if (y0===undefined) return [0,1];
  if (y0===y1) return [y0-1,y1+1];
  return [y0,y1];
}
/** Computes a y-axis domain from a set of rows, padding by 10% above/below the range spanned by each point's CI (or its mean_value alone, for rows without a CI). Categorical/share axes are clamped to a max of 1 (100%) plus padding. */
function buildYDomain(data,isCat){
  const v=data.filter(d=>!isNaN(d.mean_value));
  if (!v.length) return [0,1];
  const hi=d3.max(v,d=>isNaN(d.upper_ci)?d.mean_value:d.upper_ci)||1;
  const lo=d3.min(v,d=>isNaN(d.lower_ci)?d.mean_value:d.lower_ci)||0;
  const pad=(hi-lo)*0.1||0.05;
  return [Math.min(lo-pad,0),isCat?Math.min(1,hi+pad):hi+pad];
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
function drawHatchClipped(svgSel,g,x,y,w,h,colour,opacity=0.4,spacing=6){
  if (w<=0||h<=0) return;
  const clipId=`hc_${++hatchClipCounter}`;
  let defsEl=svgSel.select("defs");
  if (defsEl.empty()) defsEl=svgSel.insert("defs","g");
  defsEl.append("clipPath").attr("id",clipId)
    .append("rect").attr("x",x).attr("y",y).attr("width",w).attr("height",h);
  const hg=g.append("g").attr("clip-path",`url(#${clipId})`).style("pointer-events","none");
  for (let offset=-(h+spacing); offset<w+h+spacing; offset+=spacing){
    hg.append("line")
      .attr("x1",x+offset).attr("y1",y)
      .attr("x2",x+offset-h).attr("y2",y+h)
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
 * @returns {SVGSVGElement|null} the new standalone SVG, or null if chartSvgEl was falsy
 */
function buildPublicationSvg(chartSvgEl,{title,legendEntries,stratLegendEntries,showBaseline,showScenario,highlighted}){
  if (!chartSvgEl) return null;
  const cW=chartSvgEl.width.baseVal.value||500;
  const cH=chartSvgEl.height.baseVal.value||420;
  const PAD_T=52, PAD_S=12;

  // Measure legend entries to avoid overlap
  const allVarEntries=legendEntries||[];
  const allStratEntries=stratLegendEntries||[];
  // Use 4 cols max, each col ~150px
  const legendCols=Math.min(4,Math.max(1,allVarEntries.length));
  const legendRows=Math.ceil(allVarEntries.length/legendCols);
  const stratRows=allStratEntries.length>0?Math.ceil(allStratEntries.length/legendCols)+1:0;
  const bsRows=(showBaseline||showScenario)?1:0;
  const PAD_B=(legendRows+stratRows+bsRows)*22+32;

  const tW=cW+PAD_S*2, tH=cH+PAD_T+PAD_B;
  const ns="http://www.w3.org/2000/svg";
  const svg=document.createElementNS(ns,"svg");
  svg.setAttribute("xmlns",ns); svg.setAttribute("width",String(tW)); svg.setAttribute("height",String(tH));
  svg.setAttribute("font-family",PUB_FONT); svg.setAttribute("font-size","12");

  // White bg
  const bg=document.createElementNS(ns,"rect"); bg.setAttribute("width",String(tW)); bg.setAttribute("height",String(tH)); bg.setAttribute("fill","#ffffff"); svg.appendChild(bg);

  // Title
  const tt=document.createElementNS(ns,"text"); tt.setAttribute("x",String(tW/2)); tt.setAttribute("y","32"); tt.setAttribute("text-anchor","middle"); tt.setAttribute("font-size","14"); tt.setAttribute("font-weight","700"); tt.setAttribute("fill",TEXT_D); tt.setAttribute("font-family",PUB_FONT); tt.textContent=title||""; svg.appendChild(tt);

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
      const lt=document.createElementNS(ns,"text"); lt.setAttribute("x",String(lx+15)); lt.setAttribute("y",String(ly+10)); lt.setAttribute("font-size","12"); lt.setAttribute("fill",isLit?TEXT_D:"#94a3b8"); lt.setAttribute("font-family",PUB_FONT); lt.textContent=addSpaces(stratLabel(label)); svg.appendChild(lt);
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
      const lt=document.createElementNS(ns,"text"); lt.setAttribute("x",String(lx+20)); lt.setAttribute("y",String(ly+4)); lt.setAttribute("font-size","12"); lt.setAttribute("fill",isLit?TEXT_D:"#94a3b8"); lt.setAttribute("font-family",PUB_FONT); lt.textContent=addSpaces(stratLabel(label)); svg.appendChild(lt);
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

/** Small reusable "↓ PNG" button — wraps downloadPublicationPng() with a chart's svgRef/filename/legend props. `small` shrinks it for use inside small-multiple panels. */
function DownloadBtn({svgRef,filename,pubProps,small=false}){
  return <button onClick={()=>downloadPublicationPng(svgRef?.current,filename,pubProps||{})}
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
function showTT(html,e){const t=getTooltip();t.innerHTML=html;t.style.opacity=1;moveTT(e);}
/** Repositions the tooltip to follow the mouse, flipping to the left of the cursor if it would otherwise overflow the right edge of the viewport. */
function moveTT(e){const t=getTooltip();const w=t.offsetWidth||220;t.style.left=(e.clientX+14+w>window.innerWidth?e.clientX-w-14:e.clientX+14)+"px";t.style.top=(e.clientY-20)+"px";}
/** Fades the tooltip out (on mouseout). */
function hideTT(){const t=document.getElementById("smpaths-tt");if(t)t.style.opacity=0;}

// Friendlier column headers for the three sample-size fields, applied when
// downloading a CSV from the dashboard.
const CSV_HEADER_RENAMES={total_sample:"Total Sample: Across Runs",min_sample:"Minimum Sample: Across Runs",mean_sample:"Average Sample: Across Runs"};

/** Serialises `data` (an array of flat objects) to CSV and triggers a browser download — used by every chart's "↓ CSV" button. Column order follows the first row's key order; the three sample-size fields are relabelled via CSV_HEADER_RENAMES for readability. */
function exportCsv(data,filename){
  if (!data?.length) return;
  const keys=Object.keys(data[0]);
  const header=keys.map(k=>CSV_HEADER_RENAMES[k]||k);
  const rows=[header.join(","),...data.map(d=>keys.map(k=>JSON.stringify(d[k]??"")).join(","))];
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([rows.join("\n")],{type:"text/csv"})); a.download=filename; a.click(); URL.revokeObjectURL(a.href);
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
 */
function LegendRow({label,entries,highlighted,onToggle,showSymbols=false,stratDef=null}){
  if (!entries?.length) return null;
  const allLit=highlighted.size===0;
  return (
    <div style={{marginBottom:4}}>
      {label&&<span style={{fontSize:12,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",marginRight:10}}>{label}</span>}
      <div style={{display:"flex",flexWrap:"wrap",gap:"6px 10px"}}>
        {entries.map(({label:lbl,color,symIdx,sw},i)=>{
          const isH=highlighted.has(lbl), active=allLit||isH;
          const swatchColour=color||TEXT_M;
          return (
            <button key={lbl} onClick={()=>onToggle(lbl)} style={{
              display:"flex",alignItems:"center",gap:7,cursor:"pointer",padding:"7px 13px",borderRadius:20,
              border:`1.5px solid ${isH?swatchColour:"#ddd8ce"}`,
              background:isH?`${swatchColour}18`:"#fff",
              transition:"all 0.15s",flexShrink:0,
            }}>
              {showSymbols&&symIdx!==undefined
                ? <svg width="14" height="14"><path d={d3.symbol().type(SYMBOLS[symIdx%SYMBOLS.length]).size(64)()} transform="translate(7,7)" fill={active?TEXT_M:GREY} opacity={active?1:0.4}/></svg>
                : sw!==undefined
                  ? <svg width="22" height="12"><line x1="0" y1="6" x2="22" y2="6" stroke={active?TEXT_M:GREY} strokeWidth={sw} opacity={active?1:0.4}/></svg>
                  : <span style={{width:13,height:13,borderRadius:4,background:active?color:GREY,flexShrink:0,display:"inline-block",transition:"background 0.15s"}}/>
              }
              <span style={{fontSize:14,color:active?TEXT_D:TEXT_S,fontWeight:active?600:500,whiteSpace:"nowrap"}}>{addSpaces(stratLabel(lbl))}</span>
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
    .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_S).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#e2ddd5");});
  if (!small) g.append("text").attr("x",xScale.range()[1]/2).attr("y",iH+44).attr("text-anchor","middle").style("font-size",FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text("Year");
}
/** Draws the shared value y-axis: dashed horizontal gridlines, percentage formatting for categorical/share charts vs. plain numbers otherwise, plus an axis label (omitted for small-multiple panels, or overridden via `yLabelText`). Tick precision matches fmt() exactly (1dp for percentages, 2dp for plain numbers) so a value reads identically whether it's read off the axis or a tooltip. */
function applyYAxis(g,yScale,iW,iH,isCat,small,yLabelText){
  g.append("g").call(d3.axisLeft(yScale).ticks(5).tickFormat(v=>isCat?`${(v*100).toFixed(1)}%`:d3.format(",.2f")(v)).tickSize(-iW))
    .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_S).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#f0ece4").style("stroke-dasharray","3,3");});
  if (!small){
    const lbl=yLabelText||(isCat?"Share (%)":"Mean value");
    g.append("text").attr("transform","rotate(-90)").attr("x",-iH/2).attr("y",-56).attr("text-anchor","middle").style("font-size",FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text(lbl);
  }
}

/** Draws the small "— Baseline / ┄ Scenario" key at the bottom of a line/delta chart's plot area, explaining the solid-vs-dashed visual convention. Tagged "pub-skip" since the PNG export builds its own, more detailed legend instead of duplicating this compact in-chart one. */
function drawBSKey(g,iW,iH,showBaseline,showScenario){
  if (!showBaseline&&!showScenario) return;
  const skip=g.append("g").attr("class","pub-skip");
  let kx=4, ky=iH+52;
  if (showBaseline){
    skip.append("line").attr("x1",kx).attr("x2",kx+16).attr("y1",ky).attr("y2",ky).attr("stroke",TEXT_M).attr("stroke-width",2);
    skip.append("text").attr("x",kx+20).attr("y",ky+4).style("font-size","11px").style("fill",TEXT_M).style("font-family",PUB_FONT).text("Baseline");
    kx+=80;
  }
  if (showScenario){
    skip.append("line").attr("x1",kx).attr("x2",kx+16).attr("y1",ky).attr("y2",ky).attr("stroke",TEXT_M).attr("stroke-width",2).attr("stroke-dasharray","5,3");
    skip.append("text").attr("x",kx+20).attr("y",ky+4).style("font-size","11px").style("fill",TEXT_M).style("font-family",PUB_FONT).text("Scenario");
  }
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
 */
function LineChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,yDomain,varValues,enabledVarVals,showBaseline,showScenario,
    width,small,onYearClick,selectedYear,
    isStratified=false,stratValues=[],enabledStrats=new Set(),viewBy="",showCI=true,allYears:allYearsProp,missingLookup=null,missingStratValue}){
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
    const yScale=d3.scaleLinear().domain(yDomain).range([iH,0]).clamp(true);
    applyTimeXAxis(g,xScale,iH,small,allYears);
    applyYAxis(g,yScale,iW,iH,isCategorical,small);

    // Year-selection indicator (pub-skip so stripped in export)
    if (selectedYear&&!small){
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

    const buildSeriesList=(rows)=>{
      if (!isStratified||small){
        const grouped=d3.group(rows,d=>d.variable_value);
        return Array.from(grouped.entries()).map(([vv,pts])=>({
          key:`vv:${vv}`,vv,sv:null,pts:densify(pts),colour:colourMap[vv]||GREY,
          symIdx:undefined,strokeW:2,
          isLit:allLit||highlighted.has(vv),
          label:addSpaces(stratLabel(vv)),
        }));
      }
      const series=[];
      stratValues.forEach((sv,si)=>{
        if (!enabledStrats.has(sv)) return;
        varValues.forEach(vv=>{
          if (!enabledVarVals.has(vv)) return;
          const pts=rows.filter(d=>d.stratifier_value===sv&&d.variable_value===vv);
          if (!pts.length) return;
          // Highlight logic: AND when both types selected, OR when only one type
          const hV=highlighted.has(vv), hS=highlighted.has(sv);
          const hasVarH=[...highlighted].some(h=>varValues.includes(h));
          const hasStratH=[...highlighted].some(h=>stratValues.includes(h));
          const isLit=allLit
            ||(hasVarH&&hasStratH&&hV&&hS)  // both types → only exact combo
            ||(hasVarH&&!hasStratH&&hV)      // only var → all strats for that var
            ||(!hasVarH&&hasStratH&&hS);     // only strat → all vars for that strat
          const symIdx=isCatStrat?si%SYMBOLS.length:undefined;
          const strokeW=isCatStrat?2:ORDINAL_WIDTHS[si%ORDINAL_WIDTHS.length];
          series.push({key:`${sv}::${vv}`,vv,sv,pts:densify(pts),colour:colourMap[vv]||GREY,symIdx,strokeW,isLit,label:`${addSpaces(stratLabel(vv))} — ${addSpaces(stratLabel(sv))}`});
        });
      });
      return series;
    };

    const drawRibbon=(s,dashed)=>{
      const {vv,pts,colour,isLit}=s;
      if (!enabledVarVals.has(vv)||!isLit) return;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      if (!sorted.some(d=>!isNaN(d.lower_ci))) return;
      const area=d3.area().defined(d=>!isNaN(d.lower_ci)&&!isNaN(d.upper_ci)).x(d=>xScale(d.year)).y0(d=>yScale(d.lower_ci)).y1(d=>yScale(d.upper_ci)).curve(d3.curveMonotoneX);
      const band=g.append("path").datum(sorted).attr("d",area).attr("fill",colour).attr("opacity",0.13).style("pointer-events","none");
      // Scenario ribbons get a dashed outline (same solid/dashed convention as the lines) so overlapping baseline/scenario bands stay distinguishable
      if (dashed) band.attr("stroke",colour).attr("stroke-width",1).attr("stroke-dasharray","3,3").attr("stroke-opacity",0.55);
    };

    const drawLine=(s,dashed)=>{
      const {vv,pts,colour,isLit,strokeW}=s;
      if (!enabledVarVals.has(vv)) return;
      const fc=isLit?colour:GREY;
      const opacity=isLit?1:0.18;
      const sw=isLit?strokeW:(small?0.7:1);
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      if (!sorted.length) return;
      g.append("path").datum(sorted).attr("d",lineFn).attr("fill","none").attr("stroke",fc)
        .attr("stroke-width",sw).attr("stroke-dasharray",dashed?"6,4":"none").attr("opacity",opacity).style("pointer-events","none");
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
      const scenarioKey=scenLabel==="Baseline"?"baseline":"scenario";
      const stratValKey=missingStratValue??sv??"Overall";
      // Always draw dots + always add an invisible hit area so tooltips work
      // regardless of opacity, size, or baseline vs scenario
      sorted.filter(d=>!isNaN(d.mean_value)).forEach(d=>{
        const cx=xScale(d.year), cy=yScale(d.mean_value);
        const mrow=missingLookup?missingLookup.get(`${scenarioKey}|${d.year}|${stratValKey}`):null;
        const ttHtml=`<strong>${label}</strong><br/>${scenLabel}: ${fmt(d.mean_value,isCategorical)}`+(!isNaN(d.lower_ci)?`<br/>95% CI: [${fmt(d.lower_ci,isCategorical)}, ${fmt(d.upper_ci,isCategorical)}]`:"")+fmtSample(d)+fmtMissing(mrow)+`<br/>Year: ${d.year}${(!small&&onYearClick)?" · click to filter a cross-section":""}`;
        const dotR=small?(isLit?2.5:1.5):(isLit?3.5:2);
        if (symIdx!==undefined&&!small){
          const symPath=d3.symbol().type(SYMBOLS[symIdx]).size(isLit?52:28)();
          g.append("path").attr("d",symPath).attr("transform",`translate(${cx},${cy})`)
            .attr("fill",fc).attr("opacity",opacity).style("pointer-events","none");
        } else {
          g.append("circle").attr("cx",cx).attr("cy",cy).attr("r",dotR)
            .attr("fill",fc).attr("opacity",opacity).style("pointer-events","none");
        }
        // Invisible hit area — always present, covers both baseline and scenario dots,
        // and (since it's drawn in the topmost layer) is never covered by a CI ribbon
        g.append("circle").attr("cx",cx).attr("cy",cy).attr("r",Math.max(8,dotR+5))
          .attr("fill","transparent")
          .style("cursor",(!small&&onYearClick)?"pointer":"default")
          .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT)
          .on("click",()=>{if(!small&&onYearClick) onYearClick(d.year);});
      });
    };

    const byLitOrder=(a,b)=>(a.isLit?1:-1); // dim first so lit draws on top within its layer
    const baseSeries=showBaseline?buildSeriesList(baseData):[];
    const scenSeries=showScenario?buildSeriesList(scenData):[];

    // Click strips BEFORE everything else so dots paint on top and catch mouse events first
    if (onYearClick&&!small){
      allYears.forEach(yr=>{
        g.append("rect").attr("x",xScale(yr)-10).attr("y",0).attr("width",20).attr("height",iH)
          .attr("fill","transparent").style("cursor","pointer")
          .style("pointer-events","all")
          .on("click",()=>onYearClick(yr));
      });
    }

    // Layer 1 — CI ribbons for BOTH baseline and scenario, drawn first so they sit
    // behind every trajectory line (and their pointer-events:none means they never
    // block the dot hit-areas drawn in layer 3 anyway).
    if (showCI&&!small){
      [...baseSeries].sort(byLitOrder).forEach(s=>drawRibbon(s,false));
      [...scenSeries].sort(byLitOrder).forEach(s=>drawRibbon(s,true));
    }

    // Layer 2 — trajectory lines, on top of all ribbons
    [...baseSeries].sort(byLitOrder).forEach(s=>drawLine(s,false));
    [...scenSeries].sort(byLitOrder).forEach(s=>drawLine(s,true));

    // Layer 3 — dots + hit areas, topmost so tooltips always remain reachable
    [...baseSeries].sort(byLitOrder).forEach(s=>drawDots(s,"Baseline"));
    [...scenSeries].sort(byLitOrder).forEach(s=>drawDots(s,"Scenario"));

    // Baseline/scenario key at BOTTOM of plot, tagged pub-skip
    if (!small) drawBSKey(g,iW,iH,showBaseline,showScenario);

  },[baseData,scenData,colourMap,highlighted,yDomain,W,H,isCategorical,enabledVarVals,small,selectedYear,onYearClick,showBaseline,showScenario,isStratified,stratValues,enabledStrats,varValues,isCatStrat,showCI]);

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
 */
function StackedBarChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,varValues,enabledVarVals,showBaseline,showScenario,width,small,patId="",allYears:allYearsProp}){
  const mar=small?M_SM:M;
  const H=small?CHART_H_SM:CHART_H;
  const W=small?width:Math.min(width,MAX_W);
  const allLit=highlighted.size===0;

  useEffect(()=>{
    const svg=d3.select(svgRef.current); svg.selectAll("*").remove();
    const iW=W-mar.left-mar.right, iH=H-mar.top-mar.bottom;
    if (iW<10) return;
    svg.attr("width",W).attr("height",H);
    const g=svg.append("g").attr("transform",`translate(${mar.left},${mar.top})`);
    const filteredVV=varValues.filter(v=>enabledVarVals.has(v));
    if (!filteredVV.length) return;
    const innerKeys=[]; if (showBaseline) innerKeys.push("baseline"); if (showScenario) innerKeys.push("scenario");
    if (!innerKeys.length) return;
    const allYears=allYearsProp&&allYearsProp.length?allYearsProp:[...new Set([...baseData,...scenData].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b);
    const buildStack=(rows)=>allYears.map(yr=>{
      const yearRows=rows.filter(d=>d.year===yr&&filteredVV.includes(d.variable_value));
      let acc=0;
      return filteredVV.map(vv=>{
        const r=yearRows.find(d=>d.variable_value===vv);
        const val=r&&!isNaN(r.mean_value)?r.mean_value:0;
        const seg={year:yr,vv,val,y0:acc,y1:acc+val,row:r}; acc+=val; return seg;
      });
    });
    const baseStack=buildStack(baseData), scenStack=buildStack(scenData);
    const yScale=d3.scaleLinear().domain([0,1]).range([iH,0]).clamp(true);
    const xOuter=d3.scaleBand().domain(allYears.map(String)).range([0,iW]).paddingInner(0.2).paddingOuter(0.1);
    const xInner=d3.scaleBand().domain(innerKeys).range([0,xOuter.bandwidth()]).paddingInner(0.06);
    g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xOuter).tickFormat(d3.format("d")).tickSize(3))
      .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_S).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#e2ddd5");});
    if (!small) g.append("text").attr("x",iW/2).attr("y",iH+44).attr("text-anchor","middle").style("font-size",FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text("Year");
    applyYAxis(g,yScale,iW,iH,true,small,"Share (%)");

    const drawStack=(stack,key,isBase)=>{
      stack.forEach(yearSegs=>{
        const yr=yearSegs[0]?.year, ox=xOuter(String(yr));
        if (ox===undefined) return;
        const bx=xInner(key), bw=xInner.bandwidth();
        yearSegs.forEach(seg=>{
          if (!seg.val) return;
          const isLit=allLit||highlighted.has(seg.vv);
          const colour=colourMap[seg.vv]||GREY, fc=isLit?colour:GREY;
          const barY=yScale(seg.y1), barH=Math.abs(yScale(seg.y0)-yScale(seg.y1));
          const bh=Math.max(0.5,barH);
          const ttHtml=`<strong>${addSpaces(stratLabel(seg.vv))}</strong><br/>${isBase?"Baseline":"Scenario"}: ${fmt(seg.val,true)}`+(seg.row&&!isNaN(seg.row.lower_ci)?`<br/>95% CI: [${fmt(seg.row.lower_ci,true)}, ${fmt(seg.row.upper_ci,true)}]`:"")+fmtSample(seg.row)+`<br/>Year: ${yr}`;
          if (isBase){
            g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",bh)
              .attr("fill",fc).attr("opacity",isLit?0.88:0.18)
              .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
          } else {
            // Scenario: lighter fill + inline diagonal hatch (no url() refs) + border
            g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",bh)
              .attr("fill",fc).attr("opacity",isLit?0.32:0.07);
            // Inline hatch — survives SVG serialisation
            drawHatchClipped(svg,g,ox+bx,barY,bw,bh,fc,isLit?0.55:0.1);
            g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",bh)
              .attr("fill","none").attr("stroke",fc).attr("stroke-width",1).attr("opacity",isLit?0.65:0.12)
              .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
          }
        });
      });
    };
    // Draw baseline first (lower z), scenario second (higher z = on top, tooltip reachable)
    if (showBaseline) drawStack(baseStack,"baseline",true);
    if (showScenario) drawStack(scenStack,"scenario",false);
    // Raise scenario tooltip rects to very top using a separate overlay pass
    if (showScenario){
      scenStack.forEach(yearSegs=>{
        const yr=yearSegs[0]?.year, ox=xOuter(String(yr));
        if (ox===undefined) return;
        const bx=xInner("scenario"), bw=xInner.bandwidth();
        yearSegs.forEach(seg=>{
          if (!seg.val) return;
          const isLit=allLit||highlighted.has(seg.vv);
          const colour=colourMap[seg.vv]||GREY, fc=isLit?colour:GREY;
          const barY=yScale(seg.y1), barH=Math.abs(yScale(seg.y0)-yScale(seg.y1));
          const ttHtml=`<strong>${addSpaces(stratLabel(seg.vv))}</strong><br/>Scenario: ${fmt(seg.val,true)}`+(seg.row&&!isNaN(seg.row.lower_ci)?`<br/>95% CI: [${fmt(seg.row.lower_ci,true)}, ${fmt(seg.row.upper_ci,true)}]`:"")+fmtSample(seg.row)+`<br/>Year: ${yr}`;
          // Transparent overlay rect — painted last, always on top
          g.append("rect").attr("x",ox+bx).attr("y",barY).attr("width",bw).attr("height",Math.max(0.5,barH))
            .attr("fill","transparent")
            .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        });
      });
    }
    if (!small) drawBSKey(g,iW,iH,showBaseline,showScenario);
  },[baseData,scenData,colourMap,highlighted,W,H,varValues,enabledVarVals,small,showBaseline,showScenario,patId]);
  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   GROUPED BAR CHART — cross-section
═════════════════════════════════════════════════════════════════════════════ */
/**
 * Baseline-vs-Scenario comparison at a single point in time (either one
 * pinned year, or averaged across all years — see CrossSectionPanel/
 * averageAcrossYears). One group of bars per variable value (or, if
 * stratified, per stratum), with a Baseline bar and a Scenario bar
 * side-by-side in each group, plus error-bar whiskers showing the 95% CI —
 * this is also where the 95% CI first appears in a bar-chart tooltip (see
 * the ttHtml construction inside), which StackedBarChart's tooltips were
 * later brought in line with.
 *
 * @param {object} props - see LineChart/StackedBarChart JSDoc for shared prop meanings
 * @param {[number,number]} props.yDomain
 * @param {number|"Average"} [props.year] - which year's cross-section to show
 * @param {string} [props.patId] - unique hatch-pattern id fragment, as in StackedBarChart
 * @param {object} [props.missingBase] - for numeric variables, this cross-section's Baseline "Missing" row (if any), appended to every Baseline bar's tooltip
 * @param {object} [props.missingScen] - same, for Scenario
 */
function GroupedBarChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,yDomain,varValues,enabledVarVals,showBaseline,showScenario,width,small,year,patId="",missingBase=null,missingScen=null}){
  const mar=small?M_SM:M;
  const MB={...mar,bottom:small?48:90};
  const H=small?CHART_H_SM:CHART_H;
  const W=small?width:Math.min(width,MAX_W);
  const allLit=highlighted.size===0;
  useEffect(()=>{
    const svg=d3.select(svgRef.current); svg.selectAll("*").remove();
    const iW=W-MB.left-MB.right, iH=H-MB.top-MB.bottom;
    if (iW<10) return;
    svg.attr("width",W).attr("height",H);
    const g=svg.append("g").attr("transform",`translate(${MB.left},${MB.top})`);
    const filteredVV=varValues.filter(v=>enabledVarVals.has(v));
    if (!filteredVV.length) return;
    const innerKeys=[]; if (showBaseline) innerKeys.push("baseline"); if (showScenario) innerKeys.push("scenario"); if (!innerKeys.length) return;
    const xOuter=d3.scaleBand().domain(filteredVV).range([0,iW]).paddingInner(0.28).paddingOuter(0.1);
    const xInner=d3.scaleBand().domain(innerKeys).range([0,xOuter.bandwidth()]).paddingInner(0.08);
    const yScale=d3.scaleLinear().domain(yDomain).range([iH,0]).clamp(true);
    g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xOuter).tickFormat(()=>"").tickSize(3))
      .call(ax=>{ax.select(".domain").remove();ax.selectAll(".tick line").style("stroke","#e2ddd5");});
    // Two-line wrapping x-axis labels for grouped bar
    xOuter.domain().forEach(vv=>{
      const fullLabel=addSpaces(stratLabel(vv));
      const cx=(xOuter(vv)||0)+xOuter.bandwidth()/2;
      const words=fullLabel.split(" "); const mid=Math.ceil(words.length/2);
      const line1=words.slice(0,mid).join(" "), line2=words.slice(mid).join(" ");
      const lbl=g.append("text").attr("text-anchor","middle")
        .attr("x",cx).attr("y",iH+14)
        .style("font-size",small?"9px":"11px").style("fill",TEXT_S).style("font-family",PUB_FONT);
      lbl.append("tspan").attr("x",cx).attr("dy","0").text(line1);
      if (line2) lbl.append("tspan").attr("x",cx).attr("dy","1.2em").text(line2);
    });
    applyYAxis(g,yScale,iW,iH,isCategorical,small);
    const y0=yScale(Math.max(0,yDomain[0]>0?yDomain[0]:0));
    const getRow=(rows,vv)=>{const r=rows.find(d=>d.variable_value===vv);return r&&!isNaN(r.mean_value)?r:null;};
    filteredVV.forEach(vv=>{
      const colour=colourMap[vv]||GREY, isLit=allLit||highlighted.has(vv), fc=isLit?colour:GREY;
      const ox=xOuter(vv), bw=xInner.bandwidth();
      const drawBar=(rows,key,isBase)=>{
        const row=getRow(rows,vv); if (!row) return;
        const bx=xInner(key), barY=yScale(row.mean_value), barH=Math.abs(y0-barY);
        const lbl=isBase?"Baseline":"Scenario";
        const ttHtml=`<strong>${addSpaces(stratLabel(vv))}</strong><br/>${lbl}: ${fmt(row.mean_value,isCategorical)}`+(!isNaN(row.lower_ci)?`<br/>95% CI: [${fmt(row.lower_ci,isCategorical)}, ${fmt(row.upper_ci,isCategorical)}]`:"")+fmtSample(row)+fmtMissing(isBase?missingBase:missingScen)+(year?`<br/>Year: ${year}`:"");
        if (isBase){
          g.append("rect").attr("x",ox+bx).attr("y",Math.min(y0,barY)).attr("width",bw).attr("height",Math.max(1,barH)).attr("fill",fc).attr("opacity",isLit?0.85:0.18).attr("rx",2).on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        } else {
          const _gx=ox+bx, _gy=Math.min(y0,barY), _gh=Math.max(1,barH);
          g.append("rect").attr("x",_gx).attr("y",_gy).attr("width",bw).attr("height",_gh).attr("fill",fc).attr("opacity",isLit?0.32:0.07).attr("rx",2);
          drawHatchClipped(svg,g,_gx,_gy,bw,_gh,fc,isLit?0.55:0.1);
          g.append("rect").attr("x",_gx).attr("y",_gy).attr("width",bw).attr("height",_gh).attr("fill","none").attr("stroke",fc).attr("stroke-width",1.5).attr("opacity",isLit?0.9:0.2).attr("rx",2)
            .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        }
        if (!isNaN(row.lower_ci)&&!isNaN(row.upper_ci)&&isLit){
          // Darker than the bar's own fill so the whiskers read clearly
          // against it rather than blending in.
          const ciColour=d3.color(fc).darker(1.3).toString();
          const cx=ox+bx+bw/2;
          g.append("line").attr("x1",cx).attr("x2",cx).attr("y1",yScale(row.lower_ci)).attr("y2",yScale(row.upper_ci)).attr("stroke",ciColour).attr("stroke-width",1.5).attr("opacity",0.85);
          [yScale(row.upper_ci),yScale(row.lower_ci)].forEach(ty=>{g.append("line").attr("x1",cx-3).attr("x2",cx+3).attr("y1",ty).attr("y2",ty).attr("stroke",ciColour).attr("stroke-width",1.5).attr("opacity",0.85);});
        }
      };
      if (showBaseline) drawBar(baseData,"baseline",true);
      if (showScenario) drawBar(scenData,"scenario",false);
    });
    // Scenario tooltip overlay — transparent rects raised above everything
    if (showScenario){
      filteredVV.forEach(vv=>{
        const isLit=allLit||highlighted.has(vv);
        const ox=xOuter(vv), bw=xInner.bandwidth();
        const bx=xInner("scenario");
        if (bx===undefined) return;
        const row=filteredVV&&baseData?undefined:undefined; // scope trick
        const sRow=scenData.find(d=>d.variable_value===vv);
        if (!sRow||isNaN(sRow.mean_value)) return;
        const barY=yScale(sRow.mean_value), y0loc=yScale(Math.max(0,yDomain[0]>0?yDomain[0]:0));
        const barH=Math.abs(y0loc-barY);
        const ttHtml=`<strong>${addSpaces(stratLabel(vv))}</strong><br/>Scenario: ${fmt(sRow.mean_value,isCategorical)}`+(!isNaN(sRow.lower_ci)?`<br/>95% CI: [${fmt(sRow.lower_ci,isCategorical)}, ${fmt(sRow.upper_ci,isCategorical)}]`:"")+fmtSample(sRow)+fmtMissing(missingScen)+( year?`<br/>Year: ${year}`:"");
        g.append("rect").attr("x",ox+bx).attr("y",Math.min(y0loc,barY)).attr("width",bw).attr("height",Math.max(1,barH))
          .attr("fill","transparent")
          .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
      });
    }
    if (!small) drawBSKey(g,iW,iH,showBaseline,showScenario);
  },[baseData,scenData,colourMap,highlighted,yDomain,W,H,isCategorical,varValues,enabledVarVals,small,year,patId,showBaseline,showScenario,missingBase,missingScen]);
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
 * @param {object} ...rest - see LineChart's JSDoc for the remaining shared props (colourMap, highlighted, isCategorical, varValues, enabledVarVals, stratValues, enabledStrats, viewBy, width)
 */
function DeltaChart({svgRef,deltaData,colourMap,highlighted,isCategorical,
    varValues,enabledVarVals,stratValues=[],enabledStrats=new Set(),viewBy="",width}){
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
    const yMax=Math.max(Math.abs(d3.min(vals)||0),Math.abs(d3.max(vals)||0.1))*1.15;
    const xScale=d3.scaleLinear().domain(safeYearDomain(allYears)).range([0,iW]);
    const yScale=d3.scaleLinear().domain([-yMax,yMax]).range([iH,0]).clamp(true);
    applyTimeXAxis(g,xScale,iH,false,allYears);
    applyYAxis(g,yScale,iW,iH,isCategorical,false,isCategorical?"Δ percentage points":"Δ mean value");
    g.append("line").attr("x1",0).attr("x2",iW).attr("y1",yScale(0)).attr("y2",yScale(0)).attr("stroke","#64748b").attr("stroke-width",1).attr("stroke-dasharray","4,3");
    const lineFn=d3.line().defined(d=>!isNaN(d.mean_value)).x(d=>xScale(d.year)).y(d=>yScale(d.mean_value)).curve(d3.curveMonotoneX);

    // Same reasoning as LineChart: fill any year missing from a series with an
    // explicit NaN point so .defined() breaks the line there instead of a
    // straight connector bridging across the gap.
    const densify=(pts)=>{
      const byYear=new Map(pts.map(d=>[d.year,d]));
      return allYears.map(yr=>byYear.get(yr)||{year:yr,mean_value:NaN,lower_ci:NaN,upper_ci:NaN});
    };

    // Build series: stratified → strat×var combos; overall → just varVal
    const series=[];
    if (isStratified){
      stratValues.forEach((sv,si)=>{
        if (!enabledStrats.has(sv)) return;
        varValues.forEach(vv=>{
          if (!enabledVarVals.has(vv)) return;
          const pts=filtered.filter(d=>d.stratifier_value===sv&&d.variable_value===vv);
          if (!pts.length) return;
          const hV=highlighted.has(vv), hS=highlighted.has(sv);
          const hasVarH=[...highlighted].some(h=>varValues.includes(h));
          const hasStratH=[...highlighted].some(h=>stratValues.includes(h));
          const isLit=allLit||(hasVarH&&hasStratH&&hV&&hS)||(hasVarH&&!hasStratH&&hV)||(!hasVarH&&hasStratH&&hS);
          const symIdx=isCatStrat?si%SYMBOLS.length:undefined;
          const strokeW=isCatStrat?2:ORDINAL_WIDTHS[si%ORDINAL_WIDTHS.length];
          series.push({vv,sv,pts:densify(pts),isLit,colour:colourMap[vv]||GREY,symIdx,strokeW,label:`${addSpaces(stratLabel(vv))} — ${addSpaces(stratLabel(sv))}`});
        });
      });
    } else {
      const grouped=d3.group(filtered,d=>d.variable_value);
      grouped.forEach((pts,vv)=>{
        if (!enabledVarVals.has(vv)) return;
        const isLit=allLit||highlighted.has(vv);
        series.push({vv,sv:null,pts:densify(pts),isLit,colour:colourMap[vv]||GREY,symIdx:undefined,strokeW:2,label:addSpaces(stratLabel(vv))});
      });
    }

    // CI bands first
    series.forEach(({pts,isLit,colour,vv})=>{
      const fc=isLit?colour:GREY;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      if (sorted.some(d=>!isNaN(d.lower_ci)&&!isNaN(d.upper_ci))){
        const area=d3.area().defined(d=>!isNaN(d.lower_ci)&&!isNaN(d.upper_ci)).x(d=>xScale(d.year)).y0(d=>yScale(d.lower_ci)).y1(d=>yScale(d.upper_ci)).curve(d3.curveMonotoneX);
        g.append("path").datum(sorted).attr("d",area).attr("fill",fc).attr("opacity",isLit?0.13:0.04).style("pointer-events","none");
      }
    });
    // Lines + dots
    [...series].sort((a,b)=>a.isLit?1:-1).forEach(({pts,isLit,colour,symIdx,strokeW,label})=>{
      const fc=isLit?colour:GREY, opacity=isLit?1:0.18;
      const sw=isLit?strokeW:0.8;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      g.append("path").datum(sorted).attr("d",lineFn).attr("fill","none").attr("stroke",fc).attr("stroke-width",sw).attr("opacity",opacity).style("pointer-events","none");
      sorted.filter(d=>!isNaN(d.mean_value)).forEach(d=>{
        const cx=xScale(d.year), cy=yScale(d.mean_value);
        const ttHtml=`<strong>${label}</strong><br/>Δ: ${fmtDelta(d.mean_value,isCategorical)}`+(!isNaN(d.lower_ci)?`<br/>95% CI: [${fmtDelta(d.lower_ci,isCategorical)}, ${fmtDelta(d.upper_ci,isCategorical)}]`:"")+fmtDeltaSample(d)+`<br/>Year: ${d.year}`;
        if (symIdx!==undefined){
          const sp=d3.symbol().type(SYMBOLS[symIdx]).size(isLit?48:24)();
          g.append("path").attr("d",sp).attr("transform",`translate(${cx},${cy})`).attr("fill",fc).attr("opacity",opacity)
            .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        } else {
          g.append("circle").attr("cx",cx).attr("cy",cy).attr("r",isLit?3.5:2).attr("fill",fc).attr("opacity",opacity)
            .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
        }
      });
    });
  },[deltaData,colourMap,highlighted,isCategorical,varValues,enabledVarVals,stratValues,enabledStrats,viewBy,isStratified,isCatStrat,W]);
  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   PANEL CHART wrapper
═════════════════════════════════════════════════════════════════════════════ */
/** Thin wrapper that forces `small:true` sizing and picks StackedBarChart vs. LineChart based on `chartType` — this is what each cell of the small-multiples grid actually renders. `allYears` is the global year range (see LineChart's JSDoc) — required here specifically since each panel's own baseData/scenData is already scoped to a single stratum. `missingLookup`/`stratValue` (numeric variables only) let each panel's LineChart report the right stratum's missingness in its tooltips despite its own series reporting sv:null internally. */
function PanelChart({baseData,scenData,colourMap,highlighted,isCategorical,yDomain,
    varValues,enabledVarVals,showBaseline,showScenario,width,chartType,panelId,allYears,missingLookup,stratValue}){
  const svgRef=useRef();
  const props={svgRef,baseData,scenData,colourMap,highlighted,isCategorical,varValues,enabledVarVals,showBaseline,showScenario,width,small:true,allYears};
  if (chartType==="bar") return <StackedBarChart {...props} patId={panelId}/>;
  return <LineChart {...props} yDomain={yDomain} missingLookup={missingLookup} missingStratValue={stratValue}/>;
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
 */
function SmallMultiplesPanel({baseData,scenData,stratValues,colourMap,highlighted,
    isCategorical,varValues,enabledVarVals,enabledStrats,showBaseline,showScenario,
    chartType,width,pubPropsFactory,targetVariable,allBaseData,allScenData,missingLookup}){
  const cols=Math.max(1,Math.min(stratValues.length,Math.floor(width/PANEL_MIN_W)));
  const panelW=Math.floor((width-(cols-1)*12)/cols);
  const yDomain=useMemo(()=>buildYDomain([...baseData,...scenData],isCategorical),[baseData,scenData,isCategorical]);
  // Global year range across ALL strata combined — computed here, before any
  // per-stratum filtering below, and passed to every panel so a panel's own
  // (possibly empty-for-some-year) stratum can't silently drop that year
  // from its x-axis. See LineChart's JSDoc for the full reasoning.
  const allYears=useMemo(()=>[...new Set([...baseData,...scenData].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b),[baseData,scenData]);
  const visible=stratValues.filter(sv=>enabledStrats.has(sv));
  const panelSvgRefs=useRef({});

  const handleDownloadAll=useCallback(()=>{
    const slug=slugify(targetVariable||"chart");
    visible.forEach((sv,i)=>{
      setTimeout(()=>{
        const svgEl=panelSvgRefs.current[sv];
        if (svgEl) downloadPublicationPng(svgEl,`${slug}_${slugify(stratLabel(sv))}.png`,pubPropsFactory(sv));
      },i*350);
    });
  },[visible,targetVariable,pubPropsFactory]);

  const handleDownloadAllCsv=useCallback(()=>{
    const slug=slugify(targetVariable||"chart");
    const allData=[...allBaseData,...allScenData].filter(d=>enabledStrats.has(d.stratifier_value)&&enabledVarVals.has(d.variable_value));
    exportCsv(allData,`${slug}_all_panels.csv`);
  },[allBaseData,allScenData,enabledStrats,enabledVarVals,targetVariable]);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginBottom:8,alignItems:"center"}}>
        <span style={{fontSize:11,color:TEXT_S}}>All panels:</span>
        <button onClick={handleDownloadAll} style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ PNG ×{visible.length}</button>
        <button onClick={handleDownloadAllCsv} style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV (all)</button>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
        {visible.map(sv=>{
          const bR=baseData.filter(d=>d.stratifier_value===sv);
          const sR=scenData.filter(d=>d.stratifier_value===sv);
          const suppressed=[...bR,...sR].every(d=>isNaN(d.mean_value));
          const afterRender=(el)=>{if (el){const s=el.querySelector("svg");if(s)panelSvgRefs.current[sv]=s;}};
          return (
            <div key={sv} ref={afterRender} style={{width:panelW,background:BG_CARD,borderRadius:10,padding:"10px 12px",border:"1px solid #f0ece4",position:"relative",flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <p style={{margin:0,fontSize:12,fontWeight:600,color:TEXT_D}}>{addSpaces(stratLabel(sv))}</p>
                {!suppressed&&(
                  <div style={{display:"flex",gap:4}}>
                    <DownloadBtn small svgRef={{current:panelSvgRefs.current[sv]}} filename={`${slugify(targetVariable||"chart")}_${slugify(stratLabel(sv))}.png`} pubProps={pubPropsFactory(sv)}/>
                    <button onClick={()=>exportCsv([...bR,...sR].filter(d=>enabledVarVals.has(d.variable_value)),`${slugify(targetVariable||"chart")}_${slugify(stratLabel(sv))}.csv`)}
                      style={{fontSize:10,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:4,padding:"1px 6px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                  </div>
                )}
              </div>
              {suppressed?<SmallSampleOverlay/>:
                <PanelChart baseData={bR} scenData={sR} colourMap={colourMap} highlighted={highlighted}
                  isCategorical={isCategorical} yDomain={yDomain} varValues={varValues}
                  enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
                  width={panelW-24} chartType={chartType} panelId={`p_${slugify(sv)}`} allYears={allYears}
                  missingLookup={missingLookup} stratValue={sv}/>
              }
            </div>
          );
        })}
      </div>
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
    width,year,isAverage,pubPropsFactory,targetVariable}){
  const svgRef=useRef();
  const panelRefs=useRef({});
  const isStratified=viewBy!=="Overall";
  const filterYear=useCallback(rows=>rows.filter(d=>(isAverage||d.year===year)&&enabledVarVals.has(d.variable_value)),[year,isAverage,enabledVarVals]);
  const filtB=useMemo(()=>filterYear(baseData),[baseData,filterYear]);
  const filtS=useMemo(()=>filterYear(scenData),[scenData,filterYear]);
  const bRows=useMemo(()=>isAverage?averageAcrossYears(filtB):filtB.filter(d=>isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall"),[filtB,isAverage,isStratified,enabledStrats]);
  const sRows=useMemo(()=>isAverage?averageAcrossYears(filtS):filtS.filter(d=>isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall"),[filtS,isAverage,isStratified,enabledStrats]);

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

  if (isStratified&&!isAverage){
    const stratVals=[...new Set([...bRows,...sRows].map(d=>d.stratifier_value))].filter(sv=>enabledStrats.has(sv));
    const cols=Math.max(1,Math.min(stratVals.length,Math.floor(width/PANEL_MIN_W)));
    const panelW=Math.floor((width-(cols-1)*12)/cols);
    const yDomain=buildYDomain([...bRows,...sRows],isCategorical);
    if (!stratVals.length) return <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic",margin:0}}>No data for year {year}.</p>;
    return (
      <div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginBottom:8,alignItems:"center"}}>
          <span style={{fontSize:11,color:TEXT_S}}>All panels:</span>
          <button onClick={()=>stratVals.forEach((sv,i)=>setTimeout(()=>{const s=panelRefs.current[sv];if(s)downloadPublicationPng(s,`cs_${year}_${slugify(sv)}.png`,pubPropsFactory(sv));},i*350))}
            style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer"}}>↓ PNG ×{stratVals.length}</button>
          <button onClick={()=>exportCsv([...bRows,...sRows],`cross_section_${year}_all.csv`)}
            style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer"}}>↓ CSV (all)</button>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
          {stratVals.map(sv=>{
            const bSv=bRows.filter(d=>d.stratifier_value===sv);
            const sSv=sRows.filter(d=>d.stratifier_value===sv);
            const afterRender=(el)=>{if(el){const s=el.querySelector("svg");if(s)panelRefs.current[sv]=s;}};
            return (
              <div key={sv} ref={afterRender} style={{width:panelW,background:BG_CARD,borderRadius:10,padding:"10px 12px",border:"1px solid #f0ece4",position:"relative",flexShrink:0}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <p style={{margin:0,fontSize:12,fontWeight:600,color:TEXT_D}}>{addSpaces(stratLabel(sv))}</p>
                  <div style={{display:"flex",gap:4}}>
                    <button onClick={()=>{const s=panelRefs.current[sv];if(s)downloadPublicationPng(s,`cs_${year}_${slugify(sv)}.png`,pubPropsFactory(sv));}}
                      style={{fontSize:10,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:4,padding:"1px 6px",cursor:"pointer"}}>↓ PNG</button>
                    <button onClick={()=>exportCsv([...bSv,...sSv],`cs_${year}_${slugify(sv)}.csv`)}
                      style={{fontSize:10,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:4,padding:"1px 6px",cursor:"pointer"}}>↓ CSV</button>
                  </div>
                </div>
                <PanelChart baseData={bSv} scenData={sSv} colourMap={colourMap} highlighted={highlighted}
                  isCategorical={isCategorical} yDomain={yDomain} varValues={varValues}
                  enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
                  width={panelW-24} chartType="bar" panelId={`cs_${slugify(sv)}_${year}`}/>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const yDomain=buildYDomain([...bRows,...sRows],isCategorical);
  if (!bRows.length&&!sRows.length) return <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic",margin:0}}>No data.</p>;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      <GroupedBarChart svgRef={svgRef} baseData={bRows} scenData={sRows} colourMap={colourMap}
        highlighted={highlighted} isCategorical={isCategorical} yDomain={yDomain}
        varValues={varValues} enabledVarVals={enabledVarVals} showBaseline={showBaseline} showScenario={showScenario}
        width={width} year={isAverage?"average":year} patId={`cs_${year}_${isAverage}`}
        missingBase={missingBase} missingScen={missingScen}/>
      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
        <DownloadBtn svgRef={svgRef} filename={`cross_section_${year||"avg"}.png`} pubProps={pubPropsFactory(null)}/>
        <button onClick={()=>exportCsv([...bRows,...sRows],`cross_section_${year||"avg"}.csv`)}
          style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer"}}>↓ CSV</button>
      </div>
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
function DeltaSection({baseData,scenData,colourMap,highlighted,isCategorical,
    varValues,enabledVarVals,enabledStrats,viewBy,width,legendEntries,stratValues=[]}){
  const svgRef=useRef();
  const isStratified=viewBy!=="Overall";
  const filtB=useMemo(()=>baseData.filter(d=>enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall")),[baseData,enabledVarVals,enabledStrats,isStratified]);
  const filtS=useMemo(()=>scenData.filter(d=>enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall")),[scenData,enabledVarVals,enabledStrats,isStratified]);
  const deltaData=useMemo(()=>{
    // Union of both sides' keys — a year/combo missing from EITHER side still
    // needs to exist in the output (with a NaN delta) so the chart's x-axis
    // knows that year is real; dropping the row entirely (as opposed to
    // keeping it with mean_value:NaN) would make the year disappear from the
    // axis rather than just breaking the line at that point — exactly the
    // "line quietly bridges the gap" bug this is meant to avoid.
    const bMap=new Map();
    filtB.forEach(d=>bMap.set(`${d.year}||${d.variable_value}||${d.stratifier_value}`,d));
    const sMap=new Map();
    filtS.forEach(d=>sMap.set(`${d.year}||${d.variable_value}||${d.stratifier_value}`,d));
    const allKeys=new Set([...bMap.keys(),...sMap.keys()]);
    return Array.from(allKeys).map(key=>{
      const b=bMap.get(key), s=sMap.get(key);
      const meta=s||b; // whichever side has the row supplies year/variable_value/stratifier_value/etc.
      const valid=b&&s&&!isNaN(s.mean_value)&&!isNaN(b.mean_value);
      return {...meta,
        mean_value: valid?s.mean_value-b.mean_value:NaN,
        lower_ci:  valid&&!isNaN(s.lower_ci)&&!isNaN(b.upper_ci)?s.lower_ci-b.upper_ci:NaN,
        upper_ci:  valid&&!isNaN(s.upper_ci)&&!isNaN(b.lower_ci)?s.upper_ci-b.lower_ci:NaN,
        base_mean_sample:b?.mean_sample, base_n_runs:b?.n_runs,
        scen_mean_sample:s?.mean_sample, scen_n_runs:s?.n_runs};
    });
  },[filtB,filtS]);
  const hasDelta=deltaData.some(d=>!isNaN(d.mean_value));
  const varLabel=addSpaces(filtB[0]?.variable||"");
  return (
    <div>
      <p style={{margin:"0 0 8px",fontSize:13,color:TEXT_M,fontStyle:"italic"}}>Scenario minus Baseline. Positive = scenario is higher.</p>
      {hasDelta?(
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <DeltaChart svgRef={svgRef} deltaData={deltaData} colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical} varValues={varValues} enabledVarVals={enabledVarVals} stratValues={stratValues} enabledStrats={enabledStrats} viewBy={viewBy} width={width}/>
          <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
            <DownloadBtn svgRef={svgRef} filename="delta.png" pubProps={{title:`Scenario − Baseline: ${varLabel}`,legendEntries,stratLegendEntries:[],showBaseline:false,showScenario:false,highlighted:new Set()}}/>
            <button onClick={()=>exportCsv(deltaData,`${slugify(varLabel)}_delta.csv`)}
              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
          </div>
        </div>
      ):(
        <p style={{fontSize:13,color:TEXT_S,fontStyle:"italic"}}>No overlapping years between baseline and scenario.</p>
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
export default function DashboardSection({parsedCache,targetVariable}){
  const {baselineData,scenarioData}=useAggregatedData(parsedCache,targetVariable);
  const [viewBy,        setViewBy]        =useState("Overall");
  const [chartType,     setChartType]     =useState("line");
  const [displayMode,   setDisplayMode]   =useState("panels");
  const [activeTab,     setActiveTab]     =useState("timeseries");
  const [selectedYear,  setSelectedYear]  =useState(null);
  const [enabledStrats, setEnabledStrats] =useState(new Set());
  const [enabledVarVals,setEnabledVarVals]=useState(new Set());
  const [highlighted,   setHighlighted]   =useState(new Set());
  const [dataView,      setDataView]      =useState("both");
  const [showCI,        setShowCI]        =useState(true);

  const lineRef=useRef(), barRef=useRef();
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
    setEnabledStrats(new Set());setEnabledVarVals(new Set());setHighlighted(new Set());setDataView("both");setShowCI(true);
  },[targetVariable]);

  const combined     =useMemo(()=>[...baselineData,...scenarioData],[baselineData,scenarioData]);
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
  // "Missing" isn't a real value of a numeric variable — it's metadata about
  // how much data is missing at each point — so it's excluded from the
  // plottable value list for numeric variables (categorical variables DO
  // keep "Missing" as a real, plottable category — see parseCore.js's
  // missing-value handling).
  const varValues    =useMemo(()=>{
    const vals=uniqueValues(combined,"variable_value");
    return orderVariableValues(targetVariable,isCategorical?vals:vals.filter(v=>v!=="Missing"));
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
  const stratValues  =useMemo(()=>orderStratifierValues(viewBy,uniqueValues(combined.filter(d=>d.stratifier===viewBy),"stratifier_value")),[combined,viewBy]);
  const colourMap    =useMemo(()=>buildColourMap(targetVariable,varValues),[targetVariable,varValues]);
  const allYears     =useMemo(()=>[...new Set(combined.map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b),[combined]);
  const stratDef     =useMemo(()=>getStratifierDef(viewBy),[viewBy]);
  const isCatStrat   =stratDef?.type==="categorical";

  useEffect(()=>setEnabledStrats(new Set(stratValues)),[stratValues]);
  useEffect(()=>setEnabledVarVals(new Set(varValues)),[varValues]);
  // selectedYear===null => "average" (default). Set by clicking a point; reset by clicking Avg.

  const isStratified=viewBy!=="Overall";
  const baseTime=useMemo(()=>baselineData.filter(d=>isStratified?d.stratifier===viewBy:d.stratifier==="Overall"),[baselineData,viewBy,isStratified]);
  const scenTime=useMemo(()=>scenarioData.filter(d=>isStratified?d.stratifier===viewBy:d.stratifier==="Overall"),[scenarioData,viewBy,isStratified]);
  const yDomain =useMemo(()=>buildYDomain([...baseTime,...scenTime],isCategorical),[baseTime,scenTime,isCategorical]);

  const showBaseline=dataView==="both"||dataView==="baseline";
  const showScenario=dataView==="both"||dataView==="scenario";
  const showCrossSection=chartType==="line";

  const legendEntries=useMemo(()=>varValues.map(vv=>({label:vv,color:colourMap[vv]||GREY})),[varValues,colourMap]);

  // Stratifier legend entries for combined view (shape or width cue)
  const stratLegendEntries=useMemo(()=>{
    if (!isStratified||displayMode!=="combined") return [];
    return stratValues.filter(sv=>enabledStrats.has(sv)).map((sv,i)=>{
      if (isCatStrat){
        return {label:sv,color:TEXT_M,symIdx:i,symPath:d3.symbol().type(SYMBOLS[i%SYMBOLS.length]).size(52)()};
      } else {
        return {label:sv,color:TEXT_M,sw:ORDINAL_WIDTHS[i%ORDINAL_WIDTHS.length]};
      }
    });
  },[isStratified,displayMode,stratValues,enabledStrats,isCatStrat]);

  const varLabel=addSpaces(targetVariable||"");

  const pubPropsFactory=useCallback((sv)=>({
    title:`${varLabel}${sv?` — ${addSpaces(stratLabel(sv))}`:""} (${viewBy!=="Overall"?viewBy:"Overall"})`,
    legendEntries, stratLegendEntries:[], showBaseline, showScenario, highlighted,
  }),[varLabel,legendEntries,showBaseline,showScenario,highlighted,viewBy]);

  const pubProps=useCallback((title)=>({title,legendEntries,stratLegendEntries,showBaseline,showScenario,highlighted}),[legendEntries,stratLegendEntries,showBaseline,showScenario,highlighted]);

  const onHighlight=useCallback(val=>{
    if (!val){setHighlighted(new Set());return;}
    setHighlighted(prev=>{const n=new Set(prev);n.has(val)?n.delete(val):n.add(val);return n;});
  },[]);
  const onToggleStrat =useCallback(sv=>setEnabledStrats(p=>{const n=new Set(p);n.has(sv)?n.delete(sv):n.add(sv);return n;}),[]);
  const onToggleVarVal=useCallback(vv=>setEnabledVarVals(p=>{const n=new Set(p);n.has(vv)?n.delete(vv):n.add(vv);return n;}),[]);
  const onYearClick   =useCallback(yr=>setSelectedYear(yr),[]);

  const hasBase=baseTime.some(d=>!isNaN(d.mean_value));
  const hasScen=scenTime.some(d=>!isNaN(d.mean_value));

  const combinedBaseTime=useMemo(()=>isStratified?baseTime.filter(d=>enabledStrats.has(d.stratifier_value)):baseTime,[baseTime,isStratified,enabledStrats]);
  const combinedScenTime=useMemo(()=>isStratified?scenTime.filter(d=>enabledStrats.has(d.stratifier_value)):scenTime,[scenTime,isStratified,enabledStrats]);
  const combinedYDomain =useMemo(()=>buildYDomain([...combinedBaseTime,...combinedScenTime],isCategorical),[combinedBaseTime,combinedScenTime,isCategorical]);

  // Style helpers — a single flat toolbar rather than boxed cards: inline
  // labels next to each control, thin dividers between logical groups,
  // moderate (not oversized) touch targets.
  const controlLabel={fontSize:12,fontWeight:700,color:TEAL,textTransform:"uppercase",letterSpacing:"0.04em",whiteSpace:"nowrap"};
  const divider={width:1,alignSelf:"stretch",background:"#ddd8ce",flexShrink:0};
  const segGroup={display:"flex",gap:2,background:"#eae6de",borderRadius:8,padding:3};
  const tabStyle=t=>({padding:"9px 18px",borderRadius:7,fontSize:14,fontWeight:600,cursor:"pointer",border:activeTab===t?`1.5px solid ${TEAL}`:"1.5px solid #ddd8ce",background:activeTab===t?`${TEAL}18`:"#eae6de",color:activeTab===t?TEAL:TEXT_S});
  const togBtn=active=>({padding:"8px 16px",borderRadius:6,fontSize:13.5,fontWeight:600,cursor:"pointer",border:"none",background:active?"#fff":"transparent",color:active?TEAL:TEXT_S,boxShadow:active?"0 1px 2px rgba(0,0,0,0.08)":"none",transition:"all 0.15s"});
  const dvBtn=dv=>({padding:"8px 16px",borderRadius:6,fontSize:13.5,fontWeight:600,cursor:"pointer",border:"none",background:dataView===dv?"#fff":"transparent",color:dataView===dv?TEAL:TEXT_S,boxShadow:dataView===dv?"0 1px 2px rgba(0,0,0,0.08)":"none",transition:"all 0.15s"});

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
  const showHighlight   =!(activeTab==="timeseries"&&chartType==="bar")&&(legendEntries.length>1||stratLegendEntries.length>0);
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

      {/* ── Controls + filters + legend — flat toolbar, no boxes ── */}
      <div style={{marginBottom:14,display:"flex",flexDirection:"column",gap:10,paddingBottom:10,borderBottom:"1px solid #e2ddd5"}}>

        {/* Row 1: Stratify by, on its own — keeps the second row free for
            Chart type / View / Layout / CI / Compare to stay on one line */}
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={controlLabel}>Stratify by</span>
          <select value={viewBy} onChange={e=>{setViewBy(e.target.value);setHighlighted(new Set());}}
            style={{padding:"8px 12px",borderRadius:7,border:"1px solid #ddd8ce",fontSize:14,color:TEXT_D,background:"#eae6de",height:38,boxSizing:"border-box",cursor:"pointer",fontWeight:500}}>
            {["Overall","Age","Gender","Household Type","Disability Status","Region","Ethnicity","Income Quintile"].map(o=><option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        {/* Row 2: everything else — inline labels, thin dividers between
            logical groups, no boxed cards */}
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",rowGap:8}}>

          <span style={controlLabel}>Chart type</span>
          <div style={segGroup}>
            <button style={togBtn(chartType==="line"&&activeTab==="timeseries")} onClick={()=>{setChartType("line");setActiveTab("timeseries");}}>〜 Line</button>
            {isCategorical&&<button style={togBtn(chartType==="bar"&&activeTab==="timeseries")} onClick={()=>{setChartType("bar");setActiveTab("timeseries");}}>▦ Stacked</button>}
          </div>

          <span style={controlLabel}>View</span>
          <div style={segGroup}>
            <button style={dvBtn("both")}     onClick={()=>setDataView("both")}>Both</button>
            <button style={dvBtn("baseline")} onClick={()=>setDataView("baseline")}>Baseline</button>
            <button style={dvBtn("scenario")} onClick={()=>setDataView("scenario")}>Scenario</button>
          </div>

          {/* Layout — only when stratified + line + time series */}
          {activeTab==="timeseries"&&isStratified&&chartType==="line"&&(
            <>
              <span style={controlLabel}>Layout</span>
              <div style={segGroup}>
                <button style={togBtn(displayMode==="panels")}   onClick={()=>setDisplayMode("panels")}>⊞ Panels</button>
                <button style={togBtn(displayMode==="combined")} onClick={()=>setDisplayMode("combined")}>⊡ Combined</button>
              </div>
            </>
          )}

          {/* CI band toggle — small, only relevant for the full-size line chart (not small-multiple panels) */}
          {activeTab==="timeseries"&&chartType==="line"&&!(isStratified&&displayMode==="panels")&&(
            <button onClick={()=>setShowCI(v=>!v)} title="Toggle 95% confidence interval bands"
              style={{padding:"7px 12px",borderRadius:6,fontSize:12.5,fontWeight:600,cursor:"pointer",lineHeight:1.6,
                border:showCI?`1px solid ${TEAL}`:"1px solid #ddd8ce",background:showCI?`${TEAL}18`:"#eae6de",color:showCI?TEAL:TEXT_S}}>
              {showCI?"▮ 95% CI":"▯ 95% CI"}
            </button>
          )}

          <div style={divider}/>

          <span style={controlLabel}>Compare</span>
          <button style={{...tabStyle("delta"),height:38,boxSizing:"border-box",lineHeight:1}}
            onClick={()=>setActiveTab("delta")}>Δ Baseline → Scenario</button>
        </div>
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
                      <button key={vv} onClick={()=>onToggleVarVal(vv)} style={{
                        display:"flex",alignItems:"center",gap:7,cursor:"pointer",padding:"7px 12px",borderRadius:18,
                        width:"auto",flexShrink:0,boxSizing:"border-box",
                        border:`1.5px solid ${isOn?c:"#ddd8ce"}`,background:isOn?`${c}18`:"transparent",transition:"all 0.15s",
                      }}>
                        <span style={{width:9,height:9,borderRadius:"50%",background:isOn?c:"#c7c1b6",flexShrink:0}}/>
                        <span style={{fontSize:13,fontWeight:isOn?600:500,color:isOn?TEXT_D:TEXT_S,textAlign:"left",whiteSpace:"nowrap"}}>{addSpaces(stratLabel(vv))}</span>
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

            {showHighlight&&(
              <div style={{display:"flex",flexDirection:"column",gap:8,...(stackSidebar?{flex:"1 1 220px",minWidth:200}:{})}}>
                <span style={controlLabel}>
                  {highlighted.size>0?"Highlighting:":"Highlight variables"}
                </span>
                <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                  <LegendRow label={null} entries={legendEntries} highlighted={highlighted} onToggle={onHighlight}/>
                </div>
                {stratLegendEntries.length>0&&(
                  <>
                    <span style={{...controlLabel,marginTop:4,paddingTop:8,borderTop:"1px solid #e2ddd5"}}>Stratifier</span>
                    <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                      <LegendRow label={null} entries={stratLegendEntries} highlighted={highlighted} onToggle={onHighlight} showSymbols={isCatStrat}/>
                    </div>
                  </>
                )}
                {showBaseline&&showScenario&&(
                  <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:stackSidebar?16:6,marginTop:4,paddingTop:8,borderTop:"1px solid #e2ddd5"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <svg width="20" height="9"><line x1="0" y1="4" x2="20" y2="4" stroke={TEXT_M} strokeWidth="2.5"/></svg>
                      <span style={{fontSize:12.5,color:TEXT_S,fontWeight:500}}>Baseline</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <svg width="20" height="9"><line x1="0" y1="4" x2="20" y2="4" stroke={TEXT_M} strokeWidth="2.5" strokeDasharray="4,3"/></svg>
                      <span style={{fontSize:12.5,color:TEXT_S,fontWeight:500}}>Scenario</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Stratifiers always sits below Filter Variables and Highlight */}
            {showStratFilters&&(
              <div style={{display:"flex",flexDirection:"column",gap:8,...(stackSidebar?{flex:"1 1 220px",minWidth:200}:{})}}>
                <span style={controlLabel}>Stratifiers</span>
                <div style={{display:"flex",flexDirection:stackSidebar?"row":"column",flexWrap:"wrap",gap:6}}>
                  {stratValues.map(sv=>{
                    const isOn=enabledStrats.has(sv);
                    return (
                      <button key={sv} onClick={()=>onToggleStrat(sv)} style={{
                        display:"flex",alignItems:"center",gap:7,cursor:"pointer",padding:"7px 12px",borderRadius:18,
                        width:"auto",flexShrink:0,boxSizing:"border-box",
                        border:`1.5px solid ${isOn?TEAL:"#ddd8ce"}`,background:isOn?`${TEAL}18`:"transparent",transition:"all 0.15s",
                      }}>
                        <span style={{fontSize:13,fontWeight:isOn?600:500,color:isOn?TEXT_D:TEXT_S,textAlign:"left",whiteSpace:"nowrap"}}>{addSpaces(stratLabel(sv))}</span>
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
          </div>
        )}

        <div style={{flex:1,minWidth:0}}>

      {/* ════════ TIME SERIES ════════ */}
      {activeTab==="timeseries"&&(
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
                  showCI={showCI} allYears={allYears} missingLookup={missingLookup}/>
              );

              const crossSection=(
                <CrossSectionPanel baseData={baselineData} scenData={scenarioData}
                  colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                  varValues={varValues} enabledVarVals={enabledVarVals}
                  enabledStrats={enabledStrats} viewBy={viewBy}
                  showBaseline={showBaseline} showScenario={showScenario}
                  width={isOverall?crossW:chartAreaWidth} year={selectedYear} isAverage={selectedYear===null}
                  pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}/>
              );

              return (
                <div>
                  {isPanels
                    /* Panels — full width, no cross-section inline */
                    ?<SmallMultiplesPanel baseData={baseTime} scenData={scenTime} stratValues={stratValues}
                        colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                        varValues={varValues} enabledVarVals={enabledVarVals} enabledStrats={enabledStrats}
                        showBaseline={showBaseline} showScenario={showScenario} chartType="line" width={chartAreaWidth}
                        pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}
                        allBaseData={baseTime} allScenData={scenTime} missingLookup={missingLookup}/>
                    /* Overall or combined-stratified */
                    :<div>
                      {isOverall
                        /* Side-by-side: line left (with its own buttons below), cross-section right (with its own buttons) — stacks full-width on narrow screens instead */
                        ?<div style={{display:"flex",gap:20,alignItems:"flex-start",flexWrap:"wrap"}}>
                          {/* Line chart + its download buttons flush below */}
                          <div style={{flexShrink:0,display:"flex",flexDirection:"column",gap:4,width:stackOverallLayout?"100%":"auto"}}>
                            {lineChart}
                            <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                              <DownloadBtn svgRef={lineRef} filename="time_series.png" pubProps={pubProps(`${varLabel} over time`)}/>
                              <button onClick={()=>exportCsv([...baselineData,...scenarioData].filter(d=>d.stratifier==="Overall"),`${slugify(varLabel)}_time_series.csv`)}
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
                        /* Stratified combined — line + buttons below */
                        :<div style={{display:"flex",flexDirection:"column",gap:4}}>
                          {lineChart}
                          <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                            <DownloadBtn svgRef={lineRef} filename="time_series.png" pubProps={pubProps(`${varLabel} over time by ${viewBy}`)}/>
                            <button onClick={()=>exportCsv([...baselineData,...scenarioData],`${slugify(varLabel)}_time_series.csv`)}
                              style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
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
                      pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}
                      allBaseData={baseTime} allScenData={scenTime}/>
                  :<div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <StackedBarChart svgRef={barRef} baseData={baseTime} scenData={scenTime}
                      colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                      varValues={varValues} enabledVarVals={enabledVarVals}
                      showBaseline={showBaseline} showScenario={showScenario}
                      width={chartAreaWidth} patId="ts" allYears={allYears}/>
                    <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                      <DownloadBtn svgRef={barRef} filename="stacked_bar.png" pubProps={pubProps(`${varLabel} by year — stacked`)}/>
                      <button onClick={()=>exportCsv([...baselineData,...scenarioData].filter(d=>d.stratifier==="Overall"),`${slugify(varLabel)}_stacked.csv`)}
                        style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                    </div>
                  </div>
                }
              </div>
            )}
          </div>
      )}

      {/* ════════ DELTA ════════ */}
      {activeTab==="delta"&&(
        <DeltaSection baseData={baselineData} scenData={scenarioData}
          colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
          varValues={varValues} enabledVarVals={enabledVarVals}
          enabledStrats={enabledStrats} viewBy={viewBy} width={chartAreaWidth} legendEntries={legendEntries} stratValues={stratValues}/>
      )}
        </div>
      </div>
    </div>
  );
}