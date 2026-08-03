import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import * as d3 from "d3";
import {
  useAggregatedData, uniqueValues, stratLabel, averageAcrossYears,
  buildColourMap, orderVariableValues, orderStratifierValues, GREY,
  getStratifierDef,
} from "./useAggregatedData";

// ─── Layout ───────────────────────────────────────────────────────────────────
const CHART_H    = 380;
const CHART_H_SM = 200;
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

// Dot symbols for categorical stratifiers (d3 symbol path generators)
const SYMBOLS = [
  d3.symbolCircle, d3.symbolSquare, d3.symbolDiamond,
  d3.symbolTriangle, d3.symbolCross, d3.symbolStar,
];
// Ordinal stratifiers get increasing stroke widths
const ORDINAL_WIDTHS = [1.5, 2.5, 3.5, 4.5];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function addSpaces(str){
  if (!str) return str;
  return str.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g,"$1 $2").trim();
}
function fmt(v,isCat){
  if (v==null||isNaN(v)) return "—";
  return isCat?`${(v*100).toFixed(1)}%`:d3.format(",.2f")(v);
}
function fmtDelta(v,isCat){
  if (v==null||isNaN(v)) return "—";
  const s=v>=0?"+":"";
  return isCat?`${s}${(v*100).toFixed(2)} pp`:`${s}${d3.format(",.2f")(v)}`;
}
function safeYearDomain(yrs){
  const [y0,y1]=d3.extent(yrs);
  if (y0===undefined) return [0,1];
  if (y0===y1) return [y0-1,y1+1];
  return [y0,y1];
}
function buildYDomain(data,isCat){
  const v=data.filter(d=>!isNaN(d.mean_value));
  if (!v.length) return [0,1];
  const hi=d3.max(v,d=>isNaN(d.upper_ci)?d.mean_value:d.upper_ci)||1;
  const lo=d3.min(v,d=>isNaN(d.lower_ci)?d.mean_value:d.lower_ci)||0;
  const pad=(hi-lo)*0.1||0.05;
  return [Math.min(lo-pad,0),isCat?Math.min(1,hi+pad):hi+pad];
}
function slugify(s){ return String(s||"").replace(/\W+/g,"_").toLowerCase(); }

// Draw diagonal hatch lines directly into a rect area — no <defs> needed, survives SVG export.
// Call instead of url(#pattern). g = d3 selection, x/y/w/h = rect bounds, colour = stroke.
function drawHatch(g,x,y,w,h,colour,opacity=0.35,spacing=5){
  if (w<=0||h<=0) return;
  const hg=g.append("g").attr("clip-path","none").style("pointer-events","none");
  // Clip to the bar rectangle
  const uid=`hatch-clip-${Math.random().toString(36).slice(2,8)}`;
  // We draw lines diagonally across the bounding box; clip via a nested g with overflow hidden is
  // not reliable in SVG without clipPath, so just draw enough lines that they naturally stay inside.
  // Use SVG clipPath — but this needs a defs. Instead use a rect mask approach:
  // Simpler: just draw the stroke lines and mask with a rect of matching fill=background then lines on top.
  // Actually simplest that works in serialised SVG: use a foreignObject-free approach:
  // draw lines, clip to rect using explicit coord clamping.
  const step=spacing;
  const diag=w+h; // max diagonal
  for (let offset=-h; offset<w+h; offset+=step){
    const x1=x+Math.max(0,offset), y1=y+Math.max(0,-offset);
    const x2=x+Math.min(w,offset+h), y2=y+Math.min(h,-offset+w+h-w);
    // Simpler: parametric line across the box diagonal
    const lx1=x+Math.max(0,offset);
    const ly1=y+Math.max(0,-offset);
    const lx2=x+Math.min(w,offset+h);
    const ly2=y+Math.min(h,offset-0+h);
    if (lx1>=lx2&&ly1>=ly2) continue;
    hg.append("line").attr("x1",lx1).attr("y1",ly1).attr("x2",x+Math.min(w,offset+h)).attr("y2",y+Math.min(h,-offset+h))
      .attr("stroke",colour).attr("stroke-width",1.2).attr("opacity",opacity);
  }
}
// Simpler clip-based hatch that actually works — uses a rect clip path embedded inline
function drawHatchClipped(svgSel,g,x,y,w,h,colour,opacity=0.4,spacing=6){
  if (w<=0||h<=0) return;
  // Create a clipPath in the SVG defs (reuse if exists by id)
  const clipId=`hc_${Math.abs(Math.round(x*10+y*100+w*1000))%99999}`;
  let defsEl=svgSel.select("defs");
  if (defsEl.empty()) defsEl=svgSel.insert("defs","g");
  if (defsEl.select(`#${clipId}`).empty()){
    defsEl.append("clipPath").attr("id",clipId)
      .append("rect").attr("x",x).attr("y",y).attr("width",w).attr("height",h);
  }
  const hg=g.append("g").attr("clip-path",`url(#${clipId})`).style("pointer-events","none");
  for (let offset=-(h+spacing); offset<w+h+spacing; offset+=spacing){
    hg.append("line")
      .attr("x1",x+offset).attr("y1",y)
      .attr("x2",x+offset-h).attr("y2",y+h)
      .attr("stroke",colour).attr("stroke-width",1.4).attr("opacity",opacity);
  }
}

// Draw a symbol at (cx,cy)
function appendSymbol(g, symbolType, cx, cy, size, fill, opacity){
  const symPath = d3.symbol().type(symbolType).size(size)();
  g.append("path").attr("d",symPath).attr("transform",`translate(${cx},${cy})`)
    .attr("fill",fill).attr("opacity",opacity);
}

/* ─────────────────────────────────────────────────────────────────────────────
   PUBLICATION PNG
─────────────────────────────────────────────────────────────────────────────── */
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

function DownloadBtn({svgRef,filename,pubProps,small=false}){
  return <button onClick={()=>downloadPublicationPng(svgRef?.current,filename,pubProps||{})}
    title="Download publication-ready PNG"
    style={{fontSize:small?10:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:small?"1px 6px":"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ PNG</button>;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function getTooltip(){
  let el=document.getElementById("smpaths-tt");
  if (!el){ el=document.createElement("div"); el.id="smpaths-tt"; Object.assign(el.style,{position:"fixed",pointerEvents:"none",zIndex:9999,background:"rgba(15,23,42,0.93)",color:"#f8fafc",padding:"9px 13px",borderRadius:"8px",fontSize:"13px",lineHeight:"1.65",maxWidth:"240px",boxShadow:"0 4px 20px rgba(0,0,0,0.3)",opacity:0,transition:"opacity 0.1s ease",fontFamily:"system-ui,sans-serif"}); document.body.appendChild(el); }
  return el;
}
function showTT(html,e){const t=getTooltip();t.innerHTML=html;t.style.opacity=1;moveTT(e);}
function moveTT(e){const t=getTooltip();const w=t.offsetWidth||220;t.style.left=(e.clientX+14+w>window.innerWidth?e.clientX-w-14:e.clientX+14)+"px";t.style.top=(e.clientY-20)+"px";}
function hideTT(){const t=document.getElementById("smpaths-tt");if(t)t.style.opacity=0;}

function exportCsv(data,filename){
  if (!data?.length) return;
  const keys=Object.keys(data[0]);
  const rows=[keys.join(","),...data.map(d=>keys.map(k=>JSON.stringify(d[k]??"")).join(","))];
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([rows.join("\n")],{type:"text/csv"})); a.download=filename; a.click(); URL.revokeObjectURL(a.href);
}

function SmallSampleOverlay(){
  return <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(239,236,228,0.85)",borderRadius:8,zIndex:5,padding:16,textAlign:"center"}}>
    <p style={{margin:0,fontSize:12,color:TEXT_M,fontStyle:"italic"}}>Sample too small — suppressed.</p>
  </div>;
}

function LegendRow({label,entries,highlighted,onToggle,showSymbols=false,stratDef=null}){
  if (!entries?.length) return null;
  const allLit=highlighted.size===0;
  return (
    <div style={{marginBottom:4}}>
      {label&&<span style={{fontSize:11,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",marginRight:8}}>{label}</span>}
      <div style={{display:"flex",flexWrap:"wrap",gap:"4px 8px"}}>
        {entries.map(({label:lbl,color,symIdx,sw},i)=>{
          const isH=highlighted.has(lbl), active=allLit||isH;
          return (
            <button key={lbl} onClick={()=>onToggle(lbl)} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",padding:"2px 5px",borderRadius:5,outline:isH?`2px solid ${color||TEXT_M}`:"2px solid transparent",transition:"outline 0.1s"}}>
              {showSymbols&&symIdx!==undefined
                ? <svg width="12" height="12"><path d={d3.symbol().type(SYMBOLS[symIdx%SYMBOLS.length]).size(48)()} transform="translate(6,6)" fill={active?TEXT_M:GREY} opacity={active?1:0.35}/></svg>
                : sw!==undefined
                  ? <svg width="20" height="10"><line x1="0" y1="5" x2="20" y2="5" stroke={active?TEXT_M:GREY} strokeWidth={sw} opacity={active?1:0.35}/></svg>
                  : <span style={{width:11,height:11,borderRadius:3,background:active?color:GREY,flexShrink:0,display:"inline-block",transition:"background 0.15s"}}/>
              }
              <span style={{fontSize:13,color:active?TEXT_D:TEXT_S,fontWeight:active?500:400}}>{addSpaces(stratLabel(lbl))}</span>
            </button>
          );
        })}
        {highlighted.size>0&&<button onClick={()=>onToggle(null)} style={{fontSize:12,color:TEXT_S,background:"none",border:"none",cursor:"pointer",padding:"2px 5px",textDecoration:"underline"}}>Clear all</button>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   AXES
─────────────────────────────────────────────────────────────────────────────── */
function applyTimeXAxis(g,xScale,iH,small,allYears){
  const xTicks=allYears.length<=8?allYears:d3.ticks(allYears[0],allYears[allYears.length-1],6).filter(t=>t%1===0);
  g.append("g").attr("transform",`translate(0,${iH})`).call(d3.axisBottom(xScale).tickValues(xTicks).tickFormat(d3.format("d")).tickSize(3))
    .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_S).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#e2ddd5");});
  if (!small) g.append("text").attr("x",xScale.range()[1]/2).attr("y",iH+44).attr("text-anchor","middle").style("font-size",FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text("Year");
}
function applyYAxis(g,yScale,iW,iH,isCat,small,yLabelText){
  g.append("g").call(d3.axisLeft(yScale).ticks(5).tickFormat(v=>isCat?`${(v*100).toFixed(0)}%`:d3.format(",.1f")(v)).tickSize(-iW))
    .call(ax=>{ax.select(".domain").remove();ax.selectAll("text").style("font-size",small?"9px":FONT_SZ).style("fill",TEXT_S).style("font-family",PUB_FONT);ax.selectAll(".tick line").style("stroke","#f0ece4").style("stroke-dasharray","3,3");});
  if (!small){
    const lbl=yLabelText||(isCat?"Share (%)":"Mean value");
    g.append("text").attr("transform","rotate(-90)").attr("x",-iH/2).attr("y",-56).attr("text-anchor","middle").style("font-size",FONT_SZ).style("fill",TEXT_M).style("font-family",PUB_FONT).text(lbl);
  }
}

// Draw in-chart baseline/scenario key at the BOTTOM of the plot area (not top) — tagged pub-skip since it's duplicated in the PNG legend
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
function LineChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,yDomain,varValues,enabledVarVals,showBaseline,showScenario,
    width,small,onYearClick,selectedYear,
    isStratified=false,stratValues=[],enabledStrats=new Set(),viewBy="",showCI=true}){
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

    const allYears=[...new Set([...baseData,...scenData].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b);
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
      const {vv,pts,colour,symIdx,isLit,label}=s;
      if (!enabledVarVals.has(vv)) return;
      const fc=isLit?colour:GREY;
      const opacity=isLit?1:0.18;
      const sorted=[...pts].sort((a,b)=>a.year-b.year);
      // Always draw dots + always add an invisible hit area so tooltips work
      // regardless of opacity, size, or baseline vs scenario
      sorted.filter(d=>!isNaN(d.mean_value)).forEach(d=>{
        const cx=xScale(d.year), cy=yScale(d.mean_value);
        const ttHtml=`<strong>${label}</strong><br/>${scenLabel}: ${fmt(d.mean_value,isCategorical)}`+(!isNaN(d.lower_ci)?`<br/>95% CI: [${fmt(d.lower_ci,isCategorical)}, ${fmt(d.upper_ci,isCategorical)}]`:"")+`<br/>Year: ${d.year}${(!small&&onYearClick)?" · click to pin cross-section":""}`;
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
function StackedBarChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,varValues,enabledVarVals,showBaseline,showScenario,width,small,patId=""}){
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
    const allYears=[...new Set([...baseData,...scenData].map(d=>d.year))].filter(Boolean).sort((a,b)=>a-b);
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
          const ttHtml=`<strong>${addSpaces(stratLabel(seg.vv))}</strong><br/>${isBase?"Baseline":"Scenario"}: ${fmt(seg.val,true)}`+(seg.row&&!isNaN(seg.row.lower_ci)?`<br/>95% CI: [${fmt(seg.row.lower_ci,true)}, ${fmt(seg.row.upper_ci,true)}]`:"")+`<br/>Year: ${yr}`;
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
          const ttHtml=`<strong>${addSpaces(stratLabel(seg.vv))}</strong><br/>Scenario: ${fmt(seg.val,true)}`+(seg.row&&!isNaN(seg.row.lower_ci)?`<br/>95% CI: [${fmt(seg.row.lower_ci,true)}, ${fmt(seg.row.upper_ci,true)}]`:"")+`<br/>Year: ${yr}`;
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
function GroupedBarChart({svgRef,baseData,scenData,colourMap,highlighted,
    isCategorical,yDomain,varValues,enabledVarVals,showBaseline,showScenario,width,small,year,patId=""}){
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
        const ttHtml=`<strong>${addSpaces(stratLabel(vv))}</strong><br/>${lbl}: ${fmt(row.mean_value,isCategorical)}`+(!isNaN(row.lower_ci)?`<br/>95% CI: [${fmt(row.lower_ci,isCategorical)}, ${fmt(row.upper_ci,isCategorical)}]`:"")+(year?`<br/>Year: ${year}`:"");
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
          const cx=ox+bx+bw/2;
          g.append("line").attr("x1",cx).attr("x2",cx).attr("y1",yScale(row.lower_ci)).attr("y2",yScale(row.upper_ci)).attr("stroke",fc).attr("stroke-width",1.5).attr("opacity",0.7);
          [yScale(row.upper_ci),yScale(row.lower_ci)].forEach(ty=>{g.append("line").attr("x1",cx-3).attr("x2",cx+3).attr("y1",ty).attr("y2",ty).attr("stroke",fc).attr("stroke-width",1.5).attr("opacity",0.7);});
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
        const ttHtml=`<strong>${addSpaces(stratLabel(vv))}</strong><br/>Scenario: ${fmt(sRow.mean_value,isCategorical)}`+(!isNaN(sRow.lower_ci)?`<br/>95% CI: [${fmt(sRow.lower_ci,isCategorical)}, ${fmt(sRow.upper_ci,isCategorical)}]`:"")+( year?`<br/>Year: ${year}`:"");
        g.append("rect").attr("x",ox+bx).attr("y",Math.min(y0loc,barY)).attr("width",bw).attr("height",Math.max(1,barH))
          .attr("fill","transparent")
          .on("mouseover",e=>showTT(ttHtml,e)).on("mousemove",moveTT).on("mouseout",hideTT);
      });
    }
    if (!small) drawBSKey(g,iW,iH,showBaseline,showScenario);
  },[baseData,scenData,colourMap,highlighted,yDomain,W,H,isCategorical,varValues,enabledVarVals,small,year,patId,showBaseline,showScenario]);
  return <svg ref={svgRef} style={{display:"block",overflow:"visible"}}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   DELTA CHART
═════════════════════════════════════════════════════════════════════════════ */
// DeltaChart — shows stratifier × variable combos like the combined line chart.
// Colour = variable_value. Shape/width cue = stratifier_value.
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
    const filtered=deltaData.filter(d=>!isNaN(d.mean_value)&&enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):true));
    if (!filtered.length) return;
    const allYears=[...new Set(filtered.map(d=>d.year))].sort((a,b)=>a-b);
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
        const ttHtml=`<strong>${label}</strong><br/>Δ: ${fmtDelta(d.mean_value,isCategorical)}`+(!isNaN(d.lower_ci)?`<br/>95% CI: [${fmtDelta(d.lower_ci,isCategorical)}, ${fmtDelta(d.upper_ci,isCategorical)}]`:"")+`<br/>Year: ${d.year}`;
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
function PanelChart({baseData,scenData,colourMap,highlighted,isCategorical,yDomain,
    varValues,enabledVarVals,showBaseline,showScenario,width,chartType,panelId}){
  const svgRef=useRef();
  const props={svgRef,baseData,scenData,colourMap,highlighted,isCategorical,varValues,enabledVarVals,showBaseline,showScenario,width,small:true};
  if (chartType==="bar") return <StackedBarChart {...props} patId={panelId}/>;
  return <LineChart {...props} yDomain={yDomain}/>;
}

/* ═════════════════════════════════════════════════════════════════════════════
   SMALL MULTIPLES PANEL — per-panel and download-all
═════════════════════════════════════════════════════════════════════════════ */
function SmallMultiplesPanel({baseData,scenData,stratValues,colourMap,highlighted,
    isCategorical,varValues,enabledVarVals,enabledStrats,showBaseline,showScenario,
    chartType,width,pubPropsFactory,targetVariable,allBaseData,allScenData}){
  const cols=Math.max(1,Math.min(stratValues.length,Math.floor(width/PANEL_MIN_W)));
  const panelW=Math.floor((width-(cols-1)*12)/cols);
  const yDomain=useMemo(()=>buildYDomain([...baseData,...scenData],isCategorical),[baseData,scenData,isCategorical]);
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
                  width={panelW-24} chartType={chartType} panelId={`p_${slugify(sv)}`}/>
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
        width={width} year={isAverage?"average":year} patId={`cs_${year}_${isAverage}`}/>
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
function DeltaSection({baseData,scenData,colourMap,highlighted,isCategorical,
    varValues,enabledVarVals,enabledStrats,viewBy,width,legendEntries,stratValues=[]}){
  const svgRef=useRef();
  const isStratified=viewBy!=="Overall";
  const filtB=useMemo(()=>baseData.filter(d=>enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall")),[baseData,enabledVarVals,enabledStrats,isStratified]);
  const filtS=useMemo(()=>scenData.filter(d=>enabledVarVals.has(d.variable_value)&&(isStratified?enabledStrats.has(d.stratifier_value):d.stratifier_value==="Overall")),[scenData,enabledVarVals,enabledStrats,isStratified]);
  const deltaData=useMemo(()=>{
    const bMap=new Map();
    filtB.forEach(d=>bMap.set(`${d.year}||${d.variable_value}||${d.stratifier_value}`,d));
    return filtS.map(s=>{
      const b=bMap.get(`${s.year}||${s.variable_value}||${s.stratifier_value}`);
      if (!b||isNaN(s.mean_value)||isNaN(b.mean_value)) return null;
      return {...s,mean_value:s.mean_value-b.mean_value,
        lower_ci:(!isNaN(s.lower_ci)&&!isNaN(b.upper_ci))?s.lower_ci-b.upper_ci:NaN,
        upper_ci:(!isNaN(s.upper_ci)&&!isNaN(b.lower_ci))?s.upper_ci-b.lower_ci:NaN};
    }).filter(Boolean);
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

  useEffect(()=>{
    setViewBy("Overall");setChartType("line");setDisplayMode("panels");
    setActiveTab("timeseries");setSelectedYear(null);
    setEnabledStrats(new Set());setEnabledVarVals(new Set());setHighlighted(new Set());setDataView("both");setShowCI(true);
  },[targetVariable]);

  const combined     =useMemo(()=>[...baselineData,...scenarioData],[baselineData,scenarioData]);
  const isCategorical=useMemo(()=>combined.some(d=>d.metric_type==="share"),[combined]);
  const varValues    =useMemo(()=>orderVariableValues(targetVariable,uniqueValues(combined,"variable_value")),[combined,targetVariable]);
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

  // Style helpers
  const tabStyle=t=>({padding:"9px 20px",borderRadius:7,fontSize:14,fontWeight:600,cursor:"pointer",border:activeTab===t?`1.5px solid ${TEAL}`:"1.5px solid #ddd8ce",background:activeTab===t?`${TEAL}18`:"#e2ddd5",color:activeTab===t?TEAL:TEXT_S});
  const togBtn=active=>({padding:"8px 18px",borderRadius:6,fontSize:14,fontWeight:600,cursor:"pointer",border:"none",background:active?"#fff":"transparent",color:active?TEAL:TEXT_S});
  const dvBtn=dv=>({padding:"8px 18px",borderRadius:6,fontSize:14,fontWeight:600,cursor:"pointer",border:"none",background:dataView===dv?"#fff":"transparent",color:dataView===dv?TEAL:TEXT_S});

  const crossTitle=selectedYear===null?"Average across all years":`Year ${selectedYear}`;

  return (
    <div ref={containerRef} style={{width:"100%",maxWidth:"100%",overflowX:"hidden"}}>

      {/* ── Controls + filters + legend — compact single block ── */}
      <div style={{marginBottom:10,display:"flex",flexDirection:"column",gap:6}}>

        {/* Row 1: four labelled control groups */}
        <div style={{display:"flex",gap:16,alignItems:"flex-end",flexWrap:"wrap"}}>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            <span style={{fontSize:10,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.05em"}}>Stratify by</span>
            <select value={viewBy} onChange={e=>{setViewBy(e.target.value);setHighlighted(new Set());}}
              style={{padding:"8px 12px",borderRadius:6,border:"1px solid #ddd8ce",fontSize:14,color:TEXT_D,background:"#efece4",height:38,boxSizing:"border-box"}}>
              {["Overall","Age","Gender","Household Type","Disability Status","Region","Ethnicity","Income Quintile"].map(o=><option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            <span style={{fontSize:10,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.05em"}}>Chart type</span>
            <div style={{display:"flex",gap:2,background:"#e2ddd5",borderRadius:7,padding:3,height:38,boxSizing:"border-box",alignItems:"center"}}>
              <button style={togBtn(chartType==="line"&&activeTab==="timeseries")} onClick={()=>{setChartType("line");setActiveTab("timeseries");}}>〜 Line</button>
              {isCategorical&&<button style={togBtn(chartType==="bar"&&activeTab==="timeseries")} onClick={()=>{setChartType("bar");setActiveTab("timeseries");}}>▦ Stacked</button>}
            </div>
            {/* View data — directly under Chart type */}
            <div style={{display:"flex",gap:2,background:"#e2ddd5",borderRadius:7,padding:3,marginTop:3}}>
              <button style={dvBtn("both")}     onClick={()=>setDataView("both")}>Both</button>
              <button style={dvBtn("baseline")} onClick={()=>setDataView("baseline")}>Baseline</button>
              <button style={dvBtn("scenario")} onClick={()=>setDataView("scenario")}>Scenario</button>
            </div>
            {/* Layout — only when stratified + line + time series */}
            {activeTab==="timeseries"&&isStratified&&chartType==="line"&&(
              <div style={{display:"flex",gap:2,background:"#e2ddd5",borderRadius:7,padding:3,marginTop:3}}>
                <button style={togBtn(displayMode==="panels")}   onClick={()=>setDisplayMode("panels")}>⊞ Panels</button>
                <button style={togBtn(displayMode==="combined")} onClick={()=>setDisplayMode("combined")}>⊡ Combined</button>
              </div>
            )}
            {/* CI band toggle — small, only relevant for the full-size line chart (not small-multiple panels) */}
            {activeTab==="timeseries"&&chartType==="line"&&!(isStratified&&displayMode==="panels")&&(
              <button onClick={()=>setShowCI(v=>!v)} title="Toggle 95% confidence interval bands"
                style={{marginTop:3,alignSelf:"flex-start",padding:"3px 9px",borderRadius:5,fontSize:10,fontWeight:600,cursor:"pointer",lineHeight:1.6,
                  border:showCI?`1px solid ${TEAL}`:"1px solid #ddd8ce",background:showCI?`${TEAL}18`:"#e2ddd5",color:showCI?TEAL:TEXT_S}}>
                {showCI?"▮ 95% CI":"▯ 95% CI"}
              </button>
            )}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            <span style={{fontSize:10,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.05em"}}>Compare</span>
            <button style={{...tabStyle("delta"),height:38,boxSizing:"border-box",lineHeight:1,padding:"0 18px",fontSize:14}}
              onClick={()=>setActiveTab("delta")}>Δ Baseline → Scenario</button>
          </div>
        </div>


        {/* Filters — variable values first, then stratifiers */}
        {(isCategorical&&varValues.length>1||isStratified&&stratValues.length>0)&&(
          <div style={{display:"flex",flexDirection:"column",gap:3,padding:"5px 10px",background:"#eae6de",borderRadius:6}}>
            {isCategorical&&varValues.length>1&&(
              <div style={{display:"flex",flexWrap:"wrap",gap:"2px 10px",alignItems:"center"}}>
                <span style={{fontSize:10,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",marginRight:2,flexShrink:0}}>Variable values:</span>
                {varValues.map(vv=>(
                  <label key={vv} style={{display:"flex",alignItems:"center",gap:3,cursor:"pointer",userSelect:"none"}}>
                    <input type="checkbox" checked={enabledVarVals.has(vv)} onChange={()=>onToggleVarVal(vv)} style={{accentColor:colourMap[vv]||TEAL,width:11,height:11,cursor:"pointer"}}/>
                    <span style={{fontSize:12,color:enabledVarVals.has(vv)?TEXT_D:TEXT_S}}>{addSpaces(stratLabel(vv))}</span>
                  </label>
                ))}
                <button onClick={()=>setEnabledVarVals(new Set(varValues))} style={{fontSize:11,color:TEAL,background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>All</button>
                <button onClick={()=>setEnabledVarVals(new Set())} style={{fontSize:11,color:TEXT_S,background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>None</button>
              </div>
            )}
            {isStratified&&stratValues.length>0&&(
              <div style={{display:"flex",flexWrap:"wrap",gap:"2px 10px",alignItems:"center"}}>
                <span style={{fontSize:10,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",marginRight:2,flexShrink:0}}>Stratifiers:</span>
                {stratValues.map(sv=>(
                  <label key={sv} style={{display:"flex",alignItems:"center",gap:3,cursor:"pointer",userSelect:"none"}}>
                    <input type="checkbox" checked={enabledStrats.has(sv)} onChange={()=>onToggleStrat(sv)} style={{accentColor:TEAL,width:11,height:11,cursor:"pointer"}}/>
                    <span style={{fontSize:12,color:enabledStrats.has(sv)?TEXT_D:TEXT_S}}>{addSpaces(stratLabel(sv))}</span>
                  </label>
                ))}
                <button onClick={()=>setEnabledStrats(new Set(stratValues))} style={{fontSize:11,color:TEAL,background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>All</button>
                <button onClick={()=>setEnabledStrats(new Set())} style={{fontSize:11,color:TEXT_S,background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>None</button>
              </div>
            )}
          </div>
        )}

        {/* Legend + highlight — hidden for stacked bar mode */}
        {!(activeTab==="timeseries"&&chartType==="bar")&&<div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"4px 12px"}}>
          <span style={{fontSize:11,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",flexShrink:0}}>
            {highlighted.size>0?"Highlighting:":"Highlight by variable"}
          </span>
          <LegendRow label={null} entries={legendEntries} highlighted={highlighted} onToggle={onHighlight}/>
          {stratLegendEntries.length>0&&(
            <>
              <span style={{fontSize:11,fontWeight:700,color:TEXT_S,textTransform:"uppercase",letterSpacing:"0.04em",flexShrink:0,paddingLeft:6,borderLeft:"1px solid #ddd8ce"}}>
                Stratifier
              </span>
              <LegendRow label={null} entries={stratLegendEntries} highlighted={highlighted} onToggle={onHighlight} showSymbols={isCatStrat}/>
            </>
          )}
          {showBaseline&&showScenario&&(
            <div style={{display:"flex",gap:10,alignItems:"center",paddingLeft:6,borderLeft:"1px solid #ddd8ce",flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={TEXT_M} strokeWidth="2"/></svg>
                <span style={{fontSize:11,color:TEXT_S}}>Baseline</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={TEXT_M} strokeWidth="2" strokeDasharray="4,3"/></svg>
                <span style={{fontSize:11,color:TEXT_S}}>Scenario</span>
              </div>
            </div>
          )}
        </div>}
      </div>

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
              // Widths for side-by-side (overall only)
              const lineW   = isOverall ? Math.round(width*0.62) : width;
              const crossW  = isOverall ? Math.max(200, width - lineW - 20) : width;

              const crossSectionTitle=selectedYear===null
                ?<span>Average across all years <span style={{fontSize:11,color:TEXT_S,fontWeight:400}}>(click a point to pin a year)</span></span>
                :<span>Year {selectedYear} <button onClick={()=>setSelectedYear(null)} style={{fontSize:11,color:TEAL,background:"none",border:"none",cursor:"pointer",textDecoration:"underline",marginLeft:4,padding:0}}>reset to avg</button></span>;

              const lineChart=(
                <LineChart svgRef={lineRef} baseData={combinedBaseTime} scenData={combinedScenTime}
                  colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                  yDomain={combinedYDomain} varValues={varValues} enabledVarVals={enabledVarVals}
                  showBaseline={showBaseline} showScenario={showScenario}
                  width={isOverall?lineW:width} onYearClick={onYearClick} selectedYear={selectedYear}
                  isStratified={isStratified} stratValues={stratValues} enabledStrats={enabledStrats} viewBy={viewBy}
                  showCI={showCI}/>
              );

              const crossSection=(
                <CrossSectionPanel baseData={baselineData} scenData={scenarioData}
                  colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                  varValues={varValues} enabledVarVals={enabledVarVals}
                  enabledStrats={enabledStrats} viewBy={viewBy}
                  showBaseline={showBaseline} showScenario={showScenario}
                  width={isOverall?crossW:width} year={selectedYear} isAverage={selectedYear===null}
                  pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}/>
              );

              return (
                <div>
                  {isPanels
                    /* Panels — full width, no cross-section inline */
                    ?<SmallMultiplesPanel baseData={baseTime} scenData={scenTime} stratValues={stratValues}
                        colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                        varValues={varValues} enabledVarVals={enabledVarVals} enabledStrats={enabledStrats}
                        showBaseline={showBaseline} showScenario={showScenario} chartType="line" width={width}
                        pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}
                        allBaseData={baseTime} allScenData={scenTime}/>
                    /* Overall or combined-stratified */
                    :<div>
                      {isOverall
                        /* Side-by-side: line left (with its own buttons below), cross-section right (with its own buttons) */
                        ?<div style={{display:"flex",gap:20,alignItems:"flex-start"}}>
                          {/* Line chart + its download buttons flush below */}
                          <div style={{flexShrink:0,display:"flex",flexDirection:"column",gap:4}}>
                            {lineChart}
                            <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                              <DownloadBtn svgRef={lineRef} filename="time_series.png" pubProps={pubProps(`${varLabel} over time`)}/>
                              <button onClick={()=>exportCsv([...baselineData,...scenarioData],`${slugify(varLabel)}_time_series.csv`)}
                                style={{fontSize:11,color:TEXT_S,background:"#e2ddd5",border:"1px solid #ddd8ce",borderRadius:5,padding:"2px 8px",cursor:"pointer",lineHeight:1.6}}>↓ CSV</button>
                            </div>
                          </div>
                          {/* Cross-section with its own title + buttons handled inside CrossSectionPanel */}
                          <div style={{flexShrink:0,flexGrow:1,minWidth:0}}>
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
                      showBaseline={showBaseline} showScenario={showScenario} chartType="bar" width={width}
                      pubPropsFactory={pubPropsFactory} targetVariable={targetVariable}
                      allBaseData={baseTime} allScenData={scenTime}/>
                  :<div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <StackedBarChart svgRef={barRef} baseData={baseTime} scenData={scenTime}
                      colourMap={colourMap} highlighted={highlighted} isCategorical={isCategorical}
                      varValues={varValues} enabledVarVals={enabledVarVals}
                      showBaseline={showBaseline} showScenario={showScenario}
                      width={width} patId="ts"/>
                    <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                      <DownloadBtn svgRef={barRef} filename="stacked_bar.png" pubProps={pubProps(`${varLabel} by year — stacked`)}/>
                      <button onClick={()=>exportCsv([...baselineData,...scenarioData],`${slugify(varLabel)}_stacked.csv`)}
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
          enabledStrats={enabledStrats} viewBy={viewBy} width={width} legendEntries={legendEntries} stratValues={stratValues}/>
      )}
    </div>
  );
}