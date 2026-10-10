/* (C) Copyright 2026, by Ross Richardson
 * Chart-section selection, cancellation, validation and controlled failure tests.
 * @author ross richardson
 */
import React from 'react';
import {act,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {useAggregateView} from './useAggregateView';
import DashboardSection from './DashboardSection';
import AggregateDataPanel from './AggregateDataPanel';

const row=(changes={})=>({year:2019,scenario:'baseline',module:'Health',variable:'Mental Component Summary (MCS)',
 variable_value:'Continuous Mean',stratifier:'Overall',stratifier_value:'Overall',metric_type:'mean',
 n_runs:3,total_sample:300,min_sample:100,mean_sample:100,mean_value:40,sd_value:1,lower_ci:39,upper_ci:41,
 paired_mean_delta:null,paired_lower_ci:null,paired_upper_ci:null,paired_n_runs:0,...changes});
const selection={variable:row().variable,stratifier:'Overall',kind:'levels',scenarios:['scenario_1']};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const source=load=>({load,scenarioNames:['scenario_1'],variables:[{name:row().variable,years:[2019,2070]}]});

const previousResizeObserver=global.ResizeObserver;
const previousBBox=SVGElement.prototype.getBBox;
const previousTextLength=SVGElement.prototype.getComputedTextLength;
beforeAll(()=>{
 global.ResizeObserver=class{constructor(cb){this.cb=cb;}observe(){this.cb([{contentRect:{width:960,height:600}}]);}disconnect(){}};
 SVGElement.prototype.getBBox=()=>({x:0,y:0,width:40,height:14});
 SVGElement.prototype.getComputedTextLength=()=>40;
});
afterAll(()=>{
 global.ResizeObserver=previousResizeObserver;
 SVGElement.prototype.getBBox=previousBBox;
 SVGElement.prototype.getComputedTextLength=previousTextLength;
});

test('a section is normalised once and unavailable numeric values retain NaN semantics',async()=>{
 const rows=[row({mean_value:null})],s=source(jest.fn(async()=>rows));
 const {result}=renderHook(()=>useAggregateView(s,selection,[]));
 expect(result.current.loading).toBe(true);
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.rows[0].mean_value).toBeNaN();expect(rows[0].mean_value).toBeNull();
 expect(s.load).toHaveBeenCalledTimes(1);
});
test('obsolete selection is cancelled and its late reply cannot replace the latest chart',async()=>{
 const first=deferred(),second=deferred();
 const s=source(jest.fn().mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise));
 const {result,rerender}=renderHook(({selected})=>useAggregateView(s,selected,[]),{initialProps:{selected:selection}});
 await waitFor(()=>expect(s.load).toHaveBeenCalledTimes(1));
 const firstSignal=s.load.mock.calls[0][1];
 rerender({selected:{...selection,stratifier:'Gender'}});
 expect(result.current.rows).toEqual([]);expect(firstSignal.aborted).toBe(true);
 await waitFor(()=>expect(s.load).toHaveBeenCalledTimes(2));
 await act(async()=>second.resolve([row({stratifier:'Gender',mean_value:50})]));
 await act(async()=>first.resolve([row({mean_value:999})]));
 expect(result.current.rows[0].mean_value).toBe(50);
});
test('failed or invalid responses remove chart data; an explicit retry can recover',async()=>{
 const s=source(jest.fn().mockResolvedValueOnce([row({id_Person:'PRIVATE'})]).mockResolvedValueOnce([row()]));
 const {result}=renderHook(()=>useAggregateView(s,selection,[]));
 await waitFor(()=>expect(result.current.error).toMatch(/aggregate rows/));
 expect(result.current.rows).toEqual([]);
 act(()=>result.current.retry());await waitFor(()=>expect(result.current.rows).toHaveLength(1));
 expect(result.current.error).toBe('');
});
test('without a connected source the existing local row objects are returned directly',()=>{
 const rows=[row()];const {result}=renderHook(()=>useAggregateView(undefined,selection,rows));
 expect(result.current.rows).toBe(rows);expect(result.current.loading).toBe(false);
});
test('the maintained charts load only the selected variable and breakdown; controls persist on denial',async()=>{
 const s=source(jest.fn(async selected=>[
  row({stratifier:selected.stratifier,stratifier_value:selected.stratifier==='Overall'?'Overall':'Female'}),
  row({scenario:'scenario_1',mean_value:45,stratifier:selected.stratifier,stratifier_value:selected.stratifier==='Overall'?'Overall':'Female',
       paired_mean_delta:5,paired_lower_ci:4,paired_upper_ci:6,paired_n_runs:3})]));
 const {container}=render(<DashboardSection parsedCache={[]} targetVariable={row().variable} viewSource={s}/>);
 await waitFor(()=>expect(container.querySelector('svg path[fill="none"][stroke-dasharray]')).not.toBeNull());
 expect(s.load.mock.calls[0][0]).toEqual(selection);
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'Gender'}});
 await waitFor(()=>expect(s.load.mock.calls.at(-1)[0].stratifier).toBe('Gender'));
 await waitFor(()=>expect(screen.queryByText('Loading chart data…')).toBeNull());
 s.load.mockRejectedValueOnce(new Error('Sign in with the original owner.'));
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'Region'}});
 expect(await screen.findByRole('alert')).toHaveTextContent('original owner');
 expect(container.querySelector('svg path[fill="none"][stroke-dasharray]')).toBeNull();
 expect(screen.getByRole('combobox')).toHaveValue('Region');
 expect(screen.queryByRole('button',{name:'↓ CSV'})).toBeNull();
});
test('twelve alternatives remain selectable together without a two-scenario restriction',async()=>{
 const scenarios=Array.from({length:12},(_,i)=>'scenario_'+(i+1));
 const s={...source(jest.fn(async selected=>[row(),...selected.scenarios.map((scenario,i)=>row({scenario,mean_value:41+i}))])),
  scenarioNames:scenarios};
 const {container}=render(<DashboardSection parsedCache={[]} targetVariable={row().variable} viewSource={s}/>);
 await waitFor(()=>expect(s.load).toHaveBeenCalled());
 expect(s.load.mock.calls[0][0].scenarios).toEqual(scenarios);
 await waitFor(()=>expect(container.querySelectorAll('svg path[fill="none"][stroke-dasharray]:not([stroke-dasharray="none"])').length).toBe(12));
 fireEvent.click(screen.getByRole('button',{name:'Scenario: 4',exact:true}));
 await waitFor(()=>expect(s.load.mock.calls.at(-1)[0].scenarios).not.toContain('scenario_4'));
 expect(screen.getByRole('button',{name:'Scenario: 12',exact:true})).toBeInTheDocument();
});
test('a baseline-only catalogue does not invent an alternative or mutate its metadata',()=>{
 const scenarioNames=Object.freeze([]);
 render(<AggregateDataPanel source={{viewSource:{scenarioNames},names:{baseline:'Reference'}}} rowCount={0}/>);
 expect(screen.getByText('Baseline — Reference')).toBeInTheDocument();
 expect(screen.queryByText(/^Scenario/)).toBeNull();expect(scenarioNames).toEqual([]);
});
test('wage histograms request only bins and returning to levels restores the existing chart',async()=>{
 const s={...source(jest.fn(async selected=>['baseline','scenario_1'].flatMap(scenario=>[
  row({scenario,variable:selected.variable,stratifier:selected.stratifier,metric_type:selected.kind==='levels'?'mean':selected.kind,
   variable_value:selected.kind==='levels'?'Continuous Mean':'£10–15',mean_value:selected.kind==='levels'?15:.3}),
 ]))),variables:[{name:'Hourly earnings',years:[2019,2070]}]};
 const {container}=render(<DashboardSection parsedCache={[]} targetVariable="Hourly earnings" viewSource={s}/>);
 await waitFor(()=>expect(container.querySelector('svg path[fill="none"][stroke-dasharray]')).not.toBeNull());
 fireEvent.click(screen.getByRole('button',{name:/Binned distribution/i}));
 await waitFor(()=>expect(s.load.mock.calls.at(-1)[0]).toEqual({...selection,variable:'Hourly earnings',kind:'wage_bin'}));
 await waitFor(()=>expect(screen.queryByText('Loading chart data…')).toBeNull());
 expect(screen.getByRole('button',{name:'↓ CSV'})).toBeInTheDocument();
 await waitFor(()=>expect(container.querySelector('svg rect[opacity="0.82"]')).not.toBeNull());
 fireEvent.click(screen.getByRole('button',{name:'〜 Line'}));
 await waitFor(()=>expect(s.load.mock.calls.at(-1)[0].kind).toBe('levels'));
 await waitFor(()=>expect(container.querySelector('svg path[fill="none"][stroke-dasharray]')).not.toBeNull());
});
test('the population pyramid requests only Age/Gender bins and preserves its years and scenarios',async()=>{
 const s={...source(jest.fn(async selected=>['baseline','scenario_1'].flatMap(scenario=>['Male','Female'].map(gender=>
  row({scenario,variable:selected.variable,stratifier:selected.stratifier,metric_type:selected.kind,
   variable_value:'25-34',stratifier_value:gender,mean_value:.3}))))),variables:[{name:'Age',years:[2019,2070]}]};
 const {container}=render(<DashboardSection parsedCache={[]} targetVariable="Population Pyramid" viewSource={s}/>);
 await waitFor(()=>expect(s.load.mock.calls[0][0]).toEqual({...selection,variable:'Age',stratifier:'Gender',kind:'pyramid_bin'}));
 await waitFor(()=>expect(screen.queryByText('Loading chart data…')).toBeNull());
 await waitFor(()=>expect(container.querySelector('svg rect[opacity="0.88"]')).not.toBeNull());
 expect(screen.getByRole('button',{name:'2070',exact:true})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Scenario: 1',exact:true})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'↓ CSV'})).toBeInTheDocument();
});
