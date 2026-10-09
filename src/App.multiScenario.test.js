/* (C) Copyright 2026, by Ross Richardson
 * Verify connected multi-scenario charts retain identities, paired metrics and safe labels.
 * @author ross richardson
 */
import React from "react";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import App from "./App";
import {normaliseAggregateRows} from "./aggregateDataSource";

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
});
