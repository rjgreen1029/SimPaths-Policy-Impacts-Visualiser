# SimPaths Policy Impacts Visualiser

An interactive React + D3 dashboard for exploring outputs from [SimPaths](https://simpaths.org/), a dynamic microsimulation model developed by the Centre for Microsimulation and Policy Analysis (CeMPA) at the University of Essex. The visualiser was built by researchers at the University of Glasgow as part of the [Policy Modelling for Health](https://www.phiuk.org/policy-modelling-for-health) research group.

The dashboard compares a **Baseline** against one or more **Scenario** runs across demographic, employment, income and health outcomes — over time, at a single year, or as the difference between the two. All aggregation of your own data happens in the browser.

Licensed under the [European Union Public Licence v. 1.2](#licence) (EUPL-1.2).

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Data inputs](#data-inputs)
  - [Default pre-aggregated dataset](#1-default-pre-aggregated-dataset)
  - [Your own simulation output](#2-your-own-simulation-output)
- [How the aggregation works](#how-the-aggregation-works)
- [The R pre-aggregation script](#the-r-pre-aggregation-script)
- [Dashboard views & controls](#dashboard-views--controls)
- [Multi-scenario support](#multi-scenario-support)
- [Colour system](#colour-system)
- [Browser support](#browser-support)
- [Privacy & data handling](#privacy--data-handling)
- [Customising the dashboard](#customising-the-dashboard)
- [Validation](#validation)
- [Known limitations](#known-limitations)
- [Credit & citation](#credit--citation)
- [Licence](#licence)
- [Feedback](#feedback)

---

## Features

- Line, stacked-bar, grouped-bar, population pyramid and hourly-earnings distribution charts, drawn directly with D3 (no charting library).
- Over time, at a single year (or averaged across years), and Baseline → Scenario differences.
- **Several scenarios at once**, each with its own line style and bar fill.
- Stratify any variable by Age, Gender, Household Type, Disability Status, Region, Ethnicity or Income Quintile — as small-multiple panels or combined on one chart (each stratum gets its own marker shape).
- 95% intervals across model runs; estimates with too small a sample are hidden, and a "⚠ Values for groups < 20 hidden" note appears on any chart affected.
- **Full screen** for every chart, with larger text.
- Drag up or down on a line chart to zoom its y-axis; drag on the population pyramid to zoom into an age range.
- Population pyramid by single year of age (0–99, 100+); **Population size** (number of simulated people) as its own variable.
- Two data sources: the bundled default dataset, or your own local SimPaths output folder — nothing is uploaded.
- Export any chart as PNG and its data as an .xlsx workbook (with an About sheet explaining the columns).
- Plain-language help: a "Key terms" section on the Dataset tab, and an ⓘ next to "benefit unit" in variable descriptions.
- Responsive layout from mobile to wide desktop screens.

## Tech stack

- **React** (Create React App, function components + hooks)
- **D3.js** for aggregation helpers and SVG chart rendering
- **File System Access API** (`window.showDirectoryPicker`) to read local simulation folders

No backend: a fully static, client-side app (deployed to GitHub Pages — see `homepage` in `package.json`).

## Project structure

```
src/
├── index.js               # React entry point — mounts <App> inside <PasscodeGate>
├── PasscodeGate.js        # Access gate (git-ignored — see note below)
├── App.js                 # Page shell: header, tabs, intro, Connect Data, sidebar, footer
├── DashboardSection.js    # All charts + their controls (stratify, chart type, layout, view, filters)
├── useAggregatedData.js   # Variable/stratifier definitions, colours, CSV row parser, data hooks
├── parseCore.js           # Pure parsing + aggregation logic (no browser APIs)
├── localFolderParser.js   # "Visualise Your Own Data": finds runs, processes them one at a time
├── StaticPage.js          # Shows the public/*.html pages inside an app tab
├── InfoPages.js           # Dataset (incl. Key terms) and More Resources tabs
├── ScenarioGraphic.js     # Diagram of the default education scenario
├── datasetExport.js       # .xlsx downloads (full dataset and each chart): columns, About sheet, blanking
├── xlsxWriter.js          # Small dependency-free .xlsx writer used by datasetExport.js
├── reportWebVitals.js     # Create React App performance hook (imported by index.js)
└── index.css              # Global styles

public/
├── SimPaths_All_Aggregated_Outputs.csv   # Default pre-aggregated dataset (loaded on start-up)
├── interpreting-results.html             # Interpreting Results tab (also works standalone)
├── citation.html                         # Citation tab
├── funders.html                          # Funders & Partners tab
├── SimPaths-logo-transparent.png         # Header logo
├── pmh_logo.png, UKRILogo.png            # Funders page logos
└── index.html, manifest.json, favicon.ico, logo192.png, logo512.png, robots.txt

docs/aggregation-spec.md   # Exact aggregation rules shared by the dashboard and the R script
validation/                # Fake-data tests that the dashboard and R script agree (see below)
validation/r/              # R aggregation script versions (latest: SimPathsAggFaster_v19.Rmd)
LICENSE                    # EUPL-1.2 licence text
```

> **Note — `PasscodeGate.js`.** `src/index.js` imports `./PasscodeGate`, but `src/PasscodeGate.js` is listed in `.gitignore`. A fresh clone will not build until that file exists. Either commit it, or add a stand-in that just renders its children:
> ```js
> export default function PasscodeGate({ children }) { return children; }
> ```

## Getting started

```bash
npm install
npm start        # development server at http://localhost:3000
npm run build    # production build in /build
```

The default dataset (`public/SimPaths_All_Aggregated_Outputs.csv`) loads automatically. The default view shows the **Baseline** and the **Increased Education** scenario (+5% of 16–29 year olds in education from 2025). Every scenario in the CSV is shown, so the CSV should contain only those two.

## Data inputs

### 1. Default pre-aggregated dataset

Produced by the [R pre-aggregation script](#the-r-pre-aggregation-script) and read by `parseCsvRow()` in `useAggregatedData.js`. Columns:

| Column | Meaning |
|---|---|
| `Year` | Simulation year |
| `scenario` | `Baseline`, or a scenario name (read case-insensitively) |
| `module` | Demographics / Activity status / Income / Health |
| `variable` | Variable name (as in the sidebar, before Title Case display) |
| `variable_value` | Category, band or single year of age — or `Continuous Mean` for numeric variables |
| `stratifier`, `stratifier_value` | Stratifier and stratum, or `Overall` |
| `metric_type` | `mean`, `share`, `wage_bin`, `income_bin` or `pyramid_bin` |
| `n_runs` | Runs contributing to this estimate |
| `total_sample`, `min_sample`, `mean_sample` | People behind the estimate: total, smallest and average per run |
| `mean_value`, `sd_value` | Mean across runs and its standard deviation |
| `ci_lower`, `ci_upper` | 95% interval |
| `paired_n_runs`, `paired_mean_delta`, `paired_lower_ci`, `paired_upper_ci` | Baseline → Scenario difference from seed-matched runs (scenario rows only) |

### 2. Your own simulation output

"Visualise Your Own Data" opens a folder picker. The folder you pick must contain a `Baseline` folder and at least one scenario folder:

```
YourSimulationOutput/
├── Baseline/
│   ├── run_606_…/
│   │   └── csv/
│   │       ├── …Person….csv
│   │       └── …BenefitUnit….csv
│   └── run_607_…/
├── Scenario/              ← any name except "Baseline"
└── Scenario_Education/    ← several scenarios are supported
```

- One folder named `Baseline` (any case) is required; every other folder is a scenario, labelled from its folder name.
- Run folders are paired between Baseline and scenarios by the seed in their name (e.g. `_606_`).
- Person and benefit-unit CSVs are found by name (`person` / `benefit`), in the run folder or its `csv` subfolder.
- Each person is joined to their benefit unit (by benefit-unit ID and year). Benefit-unit variables — income quintile, equivalised income, benefits, region, household type and `careProvidedFlag` — come from the benefit-unit file.

A **benefit unit** is a single adult or a couple, together with any dependent children they are responsible for — the unit used to assess benefit entitlement (it can be smaller than a household). Benefit-unit variables are given to every person in the unit, so their shares are shares of *people* (e.g. "people living in a benefit unit where someone provides care"). The definition shown in the app is `BENEFIT_UNIT_DEFINITION` in `InfoPages.js`.

`COLUMN_MAP` in `parseCore.js` lists every raw column used.

## How the aggregation works

The rules are written out in full in [`docs/aggregation-spec.md`](docs/aggregation-spec.md). In short:

1. **Per run:** recode values (−9 → missing; codes → labels), then for every year and every group (Overall and each stratum) compute weighted means (numeric variables), shares (categorical variables, income/wage bands), shares of the whole population by single year of age and gender (pyramid), and the number of people (Population size).
2. **Across runs:** mean of the run values, SD, and a 95% interval (mean ± 1.96 × SD / √runs; needs at least 2 runs).
3. **Baseline → Scenario:** for each seed, scenario value − Baseline value; the mean of these and its 95% interval (needs at least 2 matched pairs).

Runs are processed one at a time, so only one run's data is in memory at once.

**The first simulated year is dropped.** It is the starting population, before the model has run a step or any policy starts, so it is left out of the output — in the dashboard's own aggregation (`finaliseAggregation` in `parseCore.js`) and in the R script (v20 onwards).

### Missing values (−9)

- **Numeric variables:** −9 is left out of the mean (never treated as 0). The share missing is shown in tooltips, not plotted.
- **Categorical variables and bands:** −9 is left out of both numerator and denominator, so valid categories add up to 100%.
- **Stratifiers:** a person with a missing stratifier is left out of that breakdown, but still counted in Overall.

### Hidden (suppressed) estimates

An estimate is shown only if **every run** has at least **20 people** behind it (`MIN_RUN_SAMPLE` in `parseCore.js`). For a categorical share, that is the number of people *in that category*. A group missing from a run counts as 0. Otherwise the estimate, its interval and any difference involving it are hidden — shown as gaps or missing bars, with a "⚠ Values for groups < 20 hidden" note on the chart (hover it for the explanation). A panel whose values are all hidden says "Sample too small — suppressed".

## The R pre-aggregation script

`SimPathsAggFaster_v20.Rmd` produces the default CSV from SimPaths output, with exactly the same rows and values as the dashboard's own aggregation (checked by the [validation](#validation) tests). Set `data_root` (the folder containing `Baseline` and scenario folders) and `OUTPUT_DIR` near the top, then knit or run it. It processes several runs at once — one per CPU core; lower `N_WORKERS` if memory runs short. Needs `data.table` and `future.apply`. v20 drops the first simulated year, as the dashboard does.

## Dashboard views & controls

The **Visualiser** tab holds the introduction (with "The default view" and "Limitations & interpretation" drop-downs), **Connect Data**, the variable list and the charts. Other tabs: Dataset, Interpreting Results, Citation, Funders & Partners, More Resources.

- **Stratify by** — Overall or a stratifier (a variable can't be stratified by itself).
- **Chart type** — Line, Stacked (categorical variables), or Δ Baseline → Scenario.
- **Layout** — Panels (one small chart per stratum) or Combined; shown under Chart type when it applies.
- **View** — turn the Baseline and each scenario on/off; toggle 95% interval bands.
- **Filter / Highlight** — show or emphasise particular categories and strata.
- **Cross-section** — next to (or under) the line chart: values averaged across years, or for a year you click.
- **Δ Baseline → Scenario** — all enabled scenarios on one chart; click a year for that year's values.
- **Population Pyramid** — single years of age; drag up/down to zoom into an age range.
- **Hourly Earnings** — also as a binned distribution.
- Every chart has **⤢ Full screen**, **↓ PNG** and **↓ XLSX**. The .xlsx has an **About** sheet (the chart, each column, and why some cells are blank) and a **Data** sheet with the estimates behind the chart, for the scenarios shown. Like the full-dataset download, it leaves out `module`, `total_sample`, `min_sample` and `paired_n_runs` and blanks estimates based on fewer than 20 people. The Baseline → Scenario chart exports the difference, its 95% interval and each side's sample size.
- **↓ Download full dataset (.xlsx)** (next to the data source) downloads every aggregated estimate currently loaded — preloaded or your own — as an .xlsx workbook. Its first sheet, **About**, explains each column and why some cells are blank; the second, **Data**, holds the estimates. Estimates based on fewer than 20 people in a model run are left blank, together with their intervals and differences. The download leaves out `module`, `total_sample`, `min_sample` and `paired_n_runs`. The .xlsx is written in the browser by `src/datasetExport.js` and `src/xlsxWriter.js` (no extra dependency).
- **Benefit-unit variables** (Income Quintile, Household Type, Equivalised yearly disposable income, Amount of benefits received per month, Provided care) show a short note explaining that they count people, not benefit units.

## Multi-scenario support

- **Line style:** scenario 1 dotted, scenario 2 dashed, further scenarios other patterns (`SCENARIO_DASHES` in `DashboardSection.js`).
- **Bar fill:** scenario 1 dots, other scenarios hatching; the Baseline is solid.
- **Colours:** numeric variables use dark grey (Baseline) and teal (scenarios); categorical variables are coloured by category.
- A scenario keeps its style when others are switched off.

## Colour system

Colours are defined in `useAggregatedData.js` (`buildColourMap()`):

- **Numeric variables** — Baseline dark grey, scenarios teal (told apart by line/fill style).
- **Highest Level of Education** — In Education warm grey; Low → Medium → High from light blue to dark navy.
- **Ordinal variables** — sequential ramps; **categorical variables** — a colour-blind-friendly qualitative palette (`BRAND_QUAL`).
- **Backgrounds** — page `#f7f3ed`, cards `#fcfaf5`, chart cards `BG_CARD_LIGHT` in `DashboardSection.js`.

## Browser support

- The default dataset works in any modern browser.
- "Visualise Your Own Data" needs the File System Access API — Chromium-based browsers (Chrome, Edge, Arc, …).
- Screens narrower than 320 px show a "screen too small" message.

## Privacy & data handling

Everything runs in your browser. Nothing selected with "Visualise Your Own Data" is uploaded, stored or sent anywhere.

## Customising the dashboard

| What | Where |
|---|---|
| Variables and domains in the sidebar; their descriptions | `DOMAIN_SECTIONS`, `VARIABLE_DESCRIPTIONS` in `App.js` |
| Raw column → variable name | `COLUMN_MAP` in `parseCore.js` (and in the R script) |
| Category labels (e.g. Received care 0–3) | `*_MAP` constants in `parseCore.js` (and in the R script) |
| Category / stratum order and variable types | `VARIABLE_DEFS`, `STRATIFIER_DEFS` in `useAggregatedData.js` |
| Colours | `useAggregatedData.js` (`BRAND_QUAL`, `INDIGO_EDU`, `SEQ_*`, …) |
| Minimum sample per run | `MIN_RUN_SAMPLE` in `parseCore.js` (and the R script) |
| Oldest single year in the pyramid | `PYRAMID_TOP_AGE` in `parseCore.js` (and the R script) |
| Full-screen line-chart shape / text size | `FS_LINE_ASPECT`, `FS_TEXT_SCALE` in `DashboardSection.js` |
| Default view text | `renderDefaultViewSection` in `App.js`; `ScenarioGraphic.js`; `InfoPages.js` |
| Benefit unit definition (Key terms and ⓘ popup) | `BENEFIT_UNIT_DEFINITION` in `InfoPages.js` |
| Tab pages | `public/interpreting-results.html`, `citation.html`, `funders.html` |

If you change an aggregation rule, change it in both `parseCore.js` and the R script, update `docs/aggregation-spec.md`, and re-run the validation.

## Validation

`validation/` contains a fake SimPaths dataset generator with known edge cases (−9 codes, groups below the threshold, 1-run scenarios, ages 100+, benefit-unit variables), an independent reference implementation of the spec, and scripts that run the dashboard's real aggregation code and the R script on it and compare the results. See [`validation/README.md`](validation/README.md).

## Known limitations

- Outputs are simulated, for research purposes — not forecasts or official statistics.
- Estimates are hidden unless every run has at least 20 people behind them.
- A 95% interval needs at least 2 runs (or 2 matched pairs for differences); with a single run the tooltip says so. Intervals from only a few runs are less reliable.
- −9 is treated as missing everywhere; a variable that uses −9 as a real value would be wrongly excluded.
- Benefit-unit variables (including Provided care and Income Quintile) are given to every person in the benefit unit, so their shares are shares of people, not of benefit units — e.g. income quintiles are not 20% each when counted by person.
- The first simulated year (the starting population) is not shown.
- Baseline → Scenario differences are modelled policy effects, not observed outcomes.
- "Visualise Your Own Data" needs a Chromium-based browser.

## Credit & citation

This tool visualises outputs from the SimPaths microsimulation model, using data from Understanding Society: the UK Household Longitudinal Study. See the Citation tab in the app for how to cite it.

## Licence

This software is licensed under the **European Union Public Licence v. 1.2 (EUPL-1.2)**. You may not use this work except in compliance with the Licence. You may obtain a copy of the Licence at:

<https://eur-lex.europa.eu/eli/dec_impl/2017/863/oj>

Unless required by applicable law or agreed to in writing, software distributed under the Licence is distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the Licence for the specific language governing permissions and limitations under the Licence.

The full licence text is in [`LICENSE`](LICENSE). SimPaths itself is distributed under its own licence — see the [SimPaths repository](https://github.com/simpaths/SimPaths/blob/main/license.txt).

## Feedback

Use the Feedback button in the app, or email [healthmod@glasgow.ac.uk](mailto:healthmod@glasgow.ac.uk?subject=SimPaths%20Policy%20Impacts%20Visualiser).

The Connect Data panel includes keyboard and pointer access to the folder layout. CSV imports use D3’s row parser without dynamic code generation. Chart tooltips display labels as literal text.

## Optional connected aggregate source

Standalone use retains the bundled data and local-folder workflows. An embedding
application may pass an optional `dataSource` prop to `App`:

```jsx
<App dataSource={{
  key: "comparison-identifier",
  label: "Online results",
  rows: aggregateRows,
  names: { baseline: "Reference", scenario_1: "Policy A", scenario_2: "Policy B" },
  message: "",
  notice: "",
  showDelta: true,
  navigation: <a href="/results">Return to results</a>,
}} />
```

The host fetches authenticated aggregates and supplies loading/error messages.
The Visualiser does not fetch online data itself or fall back to bundled data
when a connected source is empty or invalid. Changing `key` resets chart state;
omitting `dataSource` restores standalone use.

Rows use the chart-ready fields documented above, with distinct scenario IDs
for every alternative. Optional `paired_mean_delta`, `paired_lower_ci`,
`paired_upper_ci` and `paired_n_runs` fields pass through without recalculation.
JSON null metrics remain unavailable, rather than becoming zero. `names` maps
stable IDs to display labels, which are rendered as text. Scenario toggles show
or hide alternatives within the same charts. The host may set `showDelta: false`
for legacy level-only aggregates.

When the host updates an open comparison, newly available scenarios appear
automatically. Scenarios the user hid stay hidden, even if their data becomes
temporarily unavailable and returns. Opening a different source key starts with
all its available scenarios selected.
The connected-source summary is highlighted in the Connect Data panel, and the
Connect Data guidance distinguishes host-supplied results from browser-only
local processing. Folder-layout help is shared by standalone and connected use.

Only aggregated rows belong in this interface. Authentication, permission
checks, processing limits, disclosure approval and retention remain the host's
responsibility; raw person/benefit-unit records must not be supplied here.

### Optional selected-chart loading

Large online comparisons can supply `viewSource` instead of a full `rows` array:

```jsx
<App dataSource={{
  key: "comparison-identifier",
  names: { baseline: "Reference", scenario_1: "Policy A", scenario_2: "Policy B" },
  viewSource: {
    scenarioNames: ["scenario_1", "scenario_2"],
    variables: [{ name: "Mental Component Summary (MCS)", years: [2019, 2020] }],
    load: async ({ variable, stratifier, kind, scenarios }, signal) => {
      // Host-provided function: return validated, already calculated rows
      // for this view, including baseline rows for paired comparisons.
      return await loadApprovedRows({ variable, stratifier, kind, scenarios }, signal);
    },
    // Optional, best-effort hints; omitting these keeps ordinary click-to-load.
    hint: ({ variable }) => hintApprovedView(variable),
    cancelHint: () => cancelHintedView(),
  },
}} />
```

Keep `viewSource`, its metadata arrays and configuration IDs stable for the
comparison's lifetime. `kind` is `levels` for means/shares, `wage_bin` for wage
histograms, or `pyramid_bin` for the Age/Gender pyramid. `scenarios` contains the
enabled alternative IDs; preserve those IDs in returned rows. The host retains
baseline rows even when its display toggle is off. Years come from metadata,
so selecting a year does not require other variables or breakdowns.

Only the selected view is normalised and passed to the existing charts. Obsolete
requests are cancelled and late replies discarded. Loading or failed requests
hide stale charts and exports; an explicit retry uses the same selection.
There is no two-alternative limit; twelve alternatives are covered by chart
tests. The host must bound response sizes, rows and any cache, recheck permissions
even when reusing cached rows, and provide a controlled error for oversized views.
Optional `hint({ variable })` and `cancelHint()` callbacks let the host prepare a
likely next view when a variable receives pointer or keyboard focus. Hints do
not select a variable or display their results. Leaving the control cancels the
hint; callback failures do not prevent ordinary chart selection. The host must
bound and cancel background work, prioritise selected views and honour the same
permissions as foreground reads.

The SimPaths Online adapter uses 8 MiB/20,000-row view limits, bounded memory and
session-partitioned browser storage, and delayed, bounded hints. Stored rows are
reused only after a fresh access check. These hosting choices are not calculation
rules, and this repository's standalone/local-file loaders do not enable them.

This interface does not aggregate raw files or change suppression, paired impacts,
confidence intervals or exports. Standalone and locally saved data retain their
existing loaders. Supplying `rows` still supports the original connected interface.

```bash
CI=true npm test -- --watchAll=false --runInBand --transformIgnorePatterns '^$' --runTestsByPath src/aggregateDataSource.test.js src/App.aggregateData.test.js src/App.aggregateCharts.test.js src/App.multiScenario.test.js src/useAggregateView.test.js
```
