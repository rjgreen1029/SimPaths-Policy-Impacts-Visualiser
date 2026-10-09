/* (C) Copyright 2026, by Ross Richardson
 * Verify connected multi-scenario charts retain identities, paired metrics and safe labels.
 * @author ross richardson
 */
import React from "react";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import App from "./App";
import {normaliseAggregateRows} from "./aggregateDataSource";
import {csvParse} from "./csvParse";
import {formatChartCsv,buildPublicationSvg} from "./DashboardSection";

beforeEach(()=>{
  global.ResizeObserver=class {observe(){} disconnect(){}};
  SVGElement.prototype.getBBox=()=>({width:40,height:10,x:0,y:0});
  SVGElement.prototype.getComputedTextLength=()=>40;
});
afterEach(()=>jest.restoreAllMocks());
const row=(scenario,value)=>({year:2019,scenario,module:"Health",variable:"Mental Component Summary (MCS)",
  variable_value:"Mean",stratifier:"Overall",stratifier_value:"Overall",metric_type:"mean",
  n_runs:3,total_sample:300,min_sample:100,mean_sample:100,mean_value:value,sd_value:1,lower_ci:value-1,upper_ci:value+1,
  paired_mean_delta:scenario==="baseline"?null:value-40,paired_lower_ci:scenario==="baseline"?null:value-41,
  paired_upper_ci:scenario==="baseline"?null:value-39,paired_n_runs:scenario==="baseline"?0:3});

test("all alternatives render together; toggling one keeps the others and their original identities",async()=>{
  const rows=[row("baseline",40),row("scenario_1",45),row("scenario_2",50),row("scenario_3",55)];
  const names={baseline:"Reference",scenario_1:"Alternative A",scenario_2:"Alternative B",scenario_3:'<img src="canary" onerror="alert(1)">'};
  const {container}=render(<App dataSource={{rows,names,key:"set",label:"Online results"}}/>);
  fireEvent.click(screen.getByRole("button",{name:/^Health.*▼/}));
  fireEvent.click(screen.getByRole("button",{name:"Mental Component Summary (MCS)",exact:true}));
  await waitFor(()=>expect(container.querySelectorAll("svg path[stroke-dasharray]").length).toBeGreaterThanOrEqual(3));
  for(const name of Object.values(names).slice(1))expect(screen.getByRole("button",{name:new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"))})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:/Alternative B/}));
  expect(screen.getByRole("button",{name:/Alternative A/})).toBeInTheDocument();
  expect(container.querySelector('img[src="canary"],script')).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Δ Baseline → Scenario"}));
  expect(screen.getByText(/uncertainty intervals use paired run differences/)).toBeInTheDocument();
  expect(rows.map(r=>r.scenario)).toEqual(["baseline","scenario_1","scenario_2","scenario_3"]);
});

test("paired statistics and bins pass through unchanged; missing paired values stay unavailable",()=>{
  const value=row("scenario_2",50);
  expect(normaliseAggregateRows([value])[0]).toEqual(value);
  const absent=row("baseline",40);
  expect(normaliseAggregateRows([absent])[0].paired_mean_delta).toBeNaN();
  const bin={...value,variable:"Hourly earnings",variable_value:"£5–10",metric_type:"wage_bin"};
  expect(normaliseAggregateRows([bin])[0]).toEqual(bin);
  const pyramid={...value,variable:"Age",variable_value:"25-34",stratifier:"Gender",stratifier_value:"Female",metric_type:"pyramid_bin"};
  expect(normaliseAggregateRows([pyramid])[0]).toEqual(pyramid);
});

test("CSV exports preserve scenario identities, paired metrics and quoted names",()=>{
  const values=[row("scenario_2",50),row("baseline",40),row("scenario_1",45)];
  const names={baseline:"Reference",scenario_1:'Policy, "A"',scenario_2:"Policy\nB"};
  const label=name=>names[name];
  const csv=csvParse(formatChartCsv(values,{scenarioLabel:label}));
  expect(csv.map(r=>r.scenario)).toEqual(["baseline","scenario_1","scenario_2"]);
  expect(csv.map(r=>r.configuration_name)).toEqual([names.baseline,names.scenario_1,names.scenario_2]);
  expect(csv[2].paired_mean_delta).toBe("10");
  const delta=csvParse(formatChartCsv(values.slice(0,1).map(r=>({...r,scenarioName:r.scenario,mean_value:10})),{isDelta:true,scenarioLabel:label}));
  expect(delta[0].scenario).toBe("scenario_2");
  expect(delta[0].comparison).toBe("Scenario minus Baseline");
  expect(values[0].mean_value).toBe(50);
});

test("chart CSV buttons export all displayed alternatives and honour scenario toggles",async()=>{
  const originalBlob=global.Blob;
  let saved;
  global.Blob=class {constructor(parts){saved=parts.join("");}};
  URL.createObjectURL=jest.fn(()=>"blob:fixture");URL.revokeObjectURL=jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
  try{
    render(<App dataSource={{rows:[row("baseline",40),row("scenario_1",45),row("scenario_2",50)],
      names:{baseline:"Reference",scenario_1:"Policy A",scenario_2:"Policy B"},key:"export-set"}}/>);
    fireEvent.click(screen.getByRole("button",{name:/^Health.*▼/}));
    fireEvent.click(screen.getByRole("button",{name:"Mental Component Summary (MCS)",exact:true}));
    const button=await screen.findAllByRole("button",{name:"↓ CSV"});
    fireEvent.click(button[0]);
    expect(new Set(csvParse(saved).map(r=>r.scenario))).toEqual(new Set(["baseline","scenario_1","scenario_2"]));
    fireEvent.click(screen.getByRole("button",{name:/Policy A/}));
    fireEvent.click(screen.getAllByRole("button",{name:"↓ CSV"})[0]);
    expect(new Set(csvParse(saved).map(r=>r.scenario))).toEqual(new Set(["baseline","scenario_2"]));
  }finally{global.Blob=originalBlob;}
});

test("publication SVG includes separate named alternatives and allocates space for long labels",()=>{
  const chart=document.createElementNS("http://www.w3.org/2000/svg","svg");
  chart.width={baseVal:{value:280}};chart.height={baseVal:{value:200}};
  const entries=[{label:"Reference",colour:"#333"},
    {label:"Policy A with a very long description that needs several lines",dash:"6,4"},
    {label:'Policy B <img src="canary">',dash:"2,3"}];
  const pub=buildPublicationSvg(chart,{title:"Comparison",scenarioEntries:entries});
  const text=pub.textContent;
  expect(text).toContain("Reference");expect(text).toContain("Policy A");expect(text).toContain("Policy B");
  expect(pub.querySelector('img[src="canary"]')).toBeNull();
  expect(pub.querySelectorAll("line[stroke-dasharray]")).toHaveLength(2);
  expect(+pub.getAttribute("height")).toBeGreaterThan(320);
});
