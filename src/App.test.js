/** Standalone startup retains the maintained interface and default-data loader. */
import {render,screen} from '@testing-library/react';
import * as d3 from 'd3';
import App from './App';

jest.mock('d3',()=>({...jest.requireActual('d3'),text:jest.fn()}));
beforeEach(()=>d3.text.mockImplementation(()=>new Promise(()=>{})));

test('standalone startup shows the Visualiser and requests its bundled data',()=>{
  render(<App/>);
  expect(screen.getByText('SimPaths Policy Impacts Visualiser',{exact:true})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Visualise Locally Saved Data'})).toBeInTheDocument();
  expect(screen.getByText('Loading default dataset…')).toBeInTheDocument();
  expect(d3.text).toHaveBeenCalledWith('/SimPaths_All_Aggregated_Outputs.csv');
});
