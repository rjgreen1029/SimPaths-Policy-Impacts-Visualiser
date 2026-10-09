# SimPaths Policy Impacts Visualiser

An interactive React + D3 dashboard for exploring outputs from [SimPaths](https://simpaths.org/), a dynamic microsimulation model developed by the Centre for Microsimulation and Policy Analysis (CeMPA) at the University of Essex. The visualiser was built by researchers at the University of Glasgow as part of the [Policy Modelling for Health](https://www.phiuk.org/policy-modelling-for-health) research group.

The dashboard compares a **Baseline** against one or more **Scenario** runs across demographic, employment, income, and health outcomes — as a time series, at a single year, or as the difference between the two — with all aggregation happening entirely client-side in the browser.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Required public assets](#required-public-assets)
- [Data inputs](#data-inputs)
  - [Default pre-aggregated dataset](#1-default-pre-aggregated-dataset)
  - [Bring your own simulation output](#2-bring-your-own-simulation-output)
- [How the aggregation pipeline works](#how-the-aggregation-pipeline-works)
- [Dashboard views & controls](#dashboard-views--controls)
- [Multi-scenario support](#multi-scenario-support)
- [Colour system](#colour-system)
- [Browser support](#browser-support)
- [Privacy & data handling](#privacy--data-handling)
- [Customising the dashboard](#customising-the-dashboard)
- [Known limitations](#known-limitations)
- [Credit & citation](#credit--citation)
- [Feedback](#feedback)

---

## Features

- Line, stacked-bar, grouped-bar, population pyramid, and wage-bin distribution charts rendered directly with D3 (no charting library dependency).
- Three ways to view the data: time series, single cross-sectional year, and Baseline → Scenario deltas.
- **Multi-scenario support**: compare Baseline against multiple named scenarios simultaneously; each scenario has a distinct colour and line/fill pattern throughout.
- Stratify any variable by Age, Gender, Household Type, Disability Status, Region, Ethnicity, or Income Quintile — shown as small-multiple panels or combined onto one chart.
- Click any year on a panel chart to see a cross-section view for that stratum.
- 95% confidence intervals computed across model runs; estimates with small underlying samples are automatically suppressed.
- Two data sources: a pre-packaged default dataset, or point the dashboard at your own local SimPaths output folder — no upload, no server round-trip.
- Memory-lean serial parsing: each run is read, processed, and accumulated incrementally so large multi-run folders don't exhaust browser memory.
- Export any chart panel as a PNG, or its underlying data as CSV.
- Responsive layout from compact mobile up to wide desktop screens.

## Tech stack

- **React** (function components + hooks) for the UI
- **D3.js** for data-side aggregation and chart rendering (raw SVG — no charting library)
- **File System Access API** (`window.showDirectoryPicker`) for reading local simulation output folders without file-by-file upload

No backend required. This is a fully static, client-side application.

## Project structure

```
src/
├── index.js               # React entry point — mounts App inside PasscodeGate
├── App.js                 # Page shell: header, intro card, sidebar, main viz, footer
├── DashboardSection.js    # All D3 chart rendering + view/filter/scenario controls
├── useAggregatedData.js   # Variable/stratifier definitions, colour engine,
│                          #   CSV row parser, data hooks
├── parseCore.js           # Pure parsing + aggregation logic (no browser APIs)
│                          #   Incremental accumulator API:
│                          #   createGroupedAccumulator / accumulateRunMetrics /
│                          #   finaliseAggregation
├── localFolderParser.js   # Directory discovery + serial run processing
└── parseWorker.js         # Web Worker: processes a pre-read batch of runs

public/
├── SimPaths_All_Aggregated_Outputs.csv   # Default pre-aggregated dataset
├── pmh_logo.png                          # Header logo
├── Interpreting-results.html             # In-app guidance page
├── citation.html                         # Citation information
└── bottom_banner_image.png               # Optional footer logo
```

`parseCore.js` is imported by both `localFolderParser.js` (main-thread path) and `parseWorker.js` (Worker path), so all CSV join/rename/aggregation logic lives in exactly one place.

## Getting started

```bash
npm install
npm start        # development server at http://localhost:3000
npm run build    # production build to /build
```

The default dataset (`public/SimPaths_All_Aggregated_Outputs.csv`) is loaded automatically on startup.

## Required public assets

| File | Purpose |
|---|---|
| `public/SimPaths_All_Aggregated_Outputs.csv` | Default pre-aggregated dataset |
| `public/pmh_logo.png` | Logo shown in the header and footer |
| `public/Interpreting-results.html` | Guidance page linked from the intro card |
| `public/citation.html` | Citation page linked from the intro card |

## Data inputs

### 1. Default pre-aggregated dataset

Parsed by `parseCsvRow()` in `useAggregatedData.js`. Expected columns:

| Column | Meaning |
|---|---|
| `Year` | Simulation year |
| `scenario` | `baseline`, or any scenario name (lowercased) |
| `module` | Domain grouping (Demographics / Activity status / Income / Health) |
| `variable` | Variable name matching the dashboard's variable list |
| `variable_value` | Category label (or `Continuous Mean` for numeric variables) |
| `stratifier` | Stratifier name, or `Overall` |
| `stratifier_value` | Stratum label, or `Overall` |
| `metric_type` | `mean`, `share`, `wage_bin`, `income_bin`, or `pyramid_bin` |
| `n_runs` | Number of model runs averaged |
| `total_sample`, `min_sample`, `mean_sample` | Sample-size diagnostics |
| `mean_value` | Cross-run mean |
| `lower_ci` / `upper_ci` | 95% CI bounds |
| `paired_mean_delta`, `paired_lower_ci`, `paired_upper_ci`, `paired_n_runs` | Paired delta stats (scenario rows only) |

The recommended R aggregation script (`SimPathsAggFaster_v10.Rmd`) produces this format directly and discovers all non-Baseline subfolders automatically.

### 2. Bring your own simulation output

Clicking "Visualise Your Own Data" opens a native folder picker. The parent folder must contain a `Baseline` subfolder and at least one scenario subfolder (any name):

```
YourSimulationOutput/
├── Baseline/
│   ├── run_606_…/
│   │   └── csv/
│   │       ├── …_person_….csv
│   │       └── …_benefit_….csv
│   └── run_607_…/
├── Scenario/              ← any name except "Baseline"
└── Scenario_Education/    ← multiple scenarios supported
```

Rules applied by `localFolderParser.js`:

- Exactly one folder named `Baseline` (case-insensitive) required at the top level.
- Any other subfolder is treated as a named scenario; its folder name (lowercased, spaces → underscores) becomes the scenario label.
- Run folders must contain a seed pattern like `_606_` in their name for pairing baseline and scenario runs.
- Person and benefit CSV files are matched by substring (`"person"` / `"benefit"`, case-insensitive), either directly in the run folder or inside a `csv` subfolder.

See `COLUMN_MAP` in `parseCore.js` for the full list of expected raw column names.

## How the aggregation pipeline works

1. **Discovery** — folder tree is scanned for `Baseline`/scenario subfolders and run folders.
2. **Serial processing** — each run's CSVs are read on the main thread then immediately accumulated. Only one run's text lives in memory at a time.
3. **Per-run aggregation** (`parseCore.js`) — CSVs are joined, column names mapped, and data reduced into weighted means/shares per year broken down by every stratifier.
4. **Cross-run aggregation** (`finaliseAggregation`) — computes cross-run mean, SD, and 95% CI. A **paired delta** (Scenario − Baseline matched by seed) is computed for each scenario. Estimates with `min_sample < 100` are suppressed.

## Dashboard views & controls

- **Stratify by** — Overall, Age, Gender, Household Type, Disability Status, Region, Ethnicity, or Income Quintile.
- **Chart type** — Line or Stacked bar (categorical only).
- **View** — Toggle Baseline and each Scenario on/off independently.
- **Layout** — Panels (small multiples, one per stratum) or Combined. In panel view, click any year to see a cross-section for that stratum.
- **Delta tab** — all enabled scenarios on one chart versus Baseline.
- **Filters** — toggle variable values and stratum values; panels resize as strata are toggled.
- **Highlighting** — click a legend entry to spotlight one series.
- **Export** — PNG and CSV on every panel.

Special views:
- **Population Pyramid** — Age variable; all enabled scenarios with distinct fill patterns.
- **Wage Distribution** — Hourly Earnings; within-scenario earnings distribution.

## Multi-scenario support

Any number of named scenarios are supported alongside Baseline:

- **Line style**: Scenario 1 = dotted (`2,2`), Scenario 2 = dashed (`6,4`). Defined in `SCENARIO_DASHES` in `DashboardSection.js`.
- **Bar fill**: Scenario 1 = dot pattern, Scenario 2 = diagonal hatch.
- **Colours**: for numeric/continuous variables, Baseline = dark grey (`#586369`), scenarios = teal (`#0f93a1`), distinguished by line/fill style. For categorical/ordinal variables, colour encodes the variable value.
- **Colour identity**: scenario colours and styles are assigned by global index so toggling one scenario off does not reassign another's appearance.
- **Delta plots**: all enabled scenarios on one chart.

## Colour system

All colours are defined in `useAggregatedData.js` (`buildColourMap()`).

- **Numeric variables** — Baseline: dark grey; scenarios: teal (distinguished by line/fill style).
- **Binary variables** — fixed coral/teal pair.
- **Ordinal variables** — purpose-built diverging or sequential ramps.
- **Categorical variables** — 10-colour, colourblind-friendly qualitative palette (`BRAND_QUAL`).
- **Muted grey** (`GREY`) for dimmed/unhighlighted series.

## Browser support

- Default dataset works in any modern browser.
- "Visualise Your Own Data" requires the File System Access API — supported in Chromium-based browsers (Chrome, Edge, Arc, etc.).
- Screens narrower than 320px show a "screen too small" message.

## Privacy & data handling

Everything runs locally in the browser. Nothing you select via "Visualise Your Own Data" is uploaded, stored, or transmitted anywhere.

## Customising the dashboard

| What | Where |
|---|---|
| Variables & domains shown in sidebar | `DOMAIN_SECTIONS`, `VARIABLE_DESCRIPTIONS` in `App.js` |
| Variables tagged as "Benefit unit" source | `BENEFIT_UNIT_VARS` in `App.js` |
| Variable/stratifier ordering & types | `VARIABLE_DEFS` / `STRATIFIER_DEFS` in `useAggregatedData.js` |
| Colours | `BRAND_QUAL`, `SEQ_*`, `DIV_RED_TEAL` etc. in `useAggregatedData.js` |
| Scenario line styles | `SCENARIO_DASHES` in `DashboardSection.js` |
| Scenario colours (numeric variables) | `NUMERIC_BASE_COLOUR`, `NUMERIC_SCEN_COLOURS` in `DashboardSection.js` |
| Raw CSV → display-name mapping | `COLUMN_MAP` in `parseCore.js` |
| Suppression threshold | `min_sample < 100` in `finaliseAggregation()` in `parseCore.js` |
| Default dataset description in intro card | Edit the Getting Started section in `App.js` |

## Known limitations

- Outputs are simulated data for research purposes only — not forecasts or official statistics.
- Every figure is a cross-run mean with a 95% CI; estimates with insufficient sample sizes are suppressed.
- Baseline → Scenario differences reflect the modelled policy effect, not an observed real-world outcome.
- "Visualise Your Own Data" requires a Chromium-based browser.

## Credit & citation

This tool visualises outputs from the SimPaths microsimulation model. See the in-app Credit & Citation section for DOI and citation details.

## Feedback

Bug reports, feature requests, and general feedback — use the Feedback button in the app, or email [healthmod@glasgow.ac.uk](mailto:healthmod@glasgow.ac.uk?subject=SimPaths%20Policy%20Impacts%20Visualiser).


## Browser parsing and tooltip checks

CSV object conversion uses D3's row parser without dynamic code generation, so
imports work with a Content Security Policy that excludes `unsafe-eval`. Chart
tooltip headings and values are inserted as text, preserving line breaks without
interpreting labels as HTML. These changes do not change scientific calculations
or suppression rules.

The updated local-folder workflow processes runs serially with the upstream
streaming parser. It replaces the old worker-pool path; the earlier worker-count
fix is consequently no longer needed.

```bash
CI=true npm test -- --watchAll=false --runInBand --transformIgnorePatterns '^$' --runTestsByPath src/csvParse.test.js src/tooltipContent.test.js
```


## Data inputs

The standalone dashboard offers the default dataset and local-folder workflows. An embedding application can provide a third source through the optional interface described below.

### 1. Default pre-aggregated dataset

On load, the app fetches the preaggregated data and parses each row with `parseCsvRow()` in `useAggregatedData.js`. Expected columns (case-insensitive alternates are supported for several — see the parser):

| Column | Meaning |
|---|---|
| `Year` | Simulation year |
| `scenario` | `baseline` or `scenario` |
| `module` | Domain grouping (Demographics / Activity status / Income / Health) |
| `variable` | Variable name, matching the dashboard's variable list |
| `variable_value` | Category label (or "Mean" for numeric variables) |
| `stratifier` | Stratifier name, or `Overall` |
| `stratifier_value` | Stratum label, or `Overall` |
| `metric_type` | `mean` (numeric variables) or `share` (categorical variables) |
| `n_runs` | Number of model runs the estimate is averaged across |
| `total_sample`, `min_sample`, `mean_sample` | Sample-size diagnostics used for suppression |
| `mean_value`, `sd_value` | Cross-run mean and standard deviation |
| `ci_lower` / `lower_ci`, `ci_upper` / `upper_ci` | 95% confidence interval bounds |


### 2. Bring your own simulation output

Clicking "Visualise Locally Saved Data" opens a native folder picker. The selected parent folder must be laid out as:

```
YourSimulationOutput/
├── Baseline/
│   ├── run_1/
│   │   └── csv/               
│   │       ├── ..._person_....csv
│   │       └── ..._benefit_....csv
│   ├── run_2/
│   │   └── ...
│   └── ...
└── Scenario/
    ├── run_1/
    │   └── ...
    └── ...
```

Rules the folder scanner (`localFolderParser.js`) applies:

- Top level must contain a `Baseline` and/or `Scenario` subfolder (matched case-insensitively).
- Each run is a subfolder of `Baseline`/`Scenario` — any number of runs is supported, and results are averaged across them.
- Within each run, CSV files are looked for either directly in the run folder or inside a `csv` subfolder.
- The person file is the `.csv` file whose name contains "person"; the benefit file is the one whose name contains "benefit" (case-insensitive). Both are required for a run to be included.

Expected raw columns (person and/or benefit CSV — see `COLUMN_MAP` in `parseCore.js` for the full, authoritative list):

| Raw column | Dashboard variable |
|---|---|
| `eduHighestC4` | Highest Level of Education |
| `demAge` | Age (used for the Age stratifier) |
| `demMaleFlag` | Gender |
| `demEthnC6` | Ethnicity |
| `healthDsblLongtermFlag` | Disability Status |
| `dhhtp_c4` | Household Type |
| `yHhQuintilesMonthC5` | Income Quintile |
| `i_demRgn` | Region |
| `demPartnerStatus` | Partnership status |
| `demNChild` | Number of children |
| `labC4` | Employment status |
| `labHrsWorkWeek` | Hours worked |
| `yCapitalPersMonth` | Capital Income |
| `yDispEquivYear` | Equivalised yearly disposable income |
| `yEmpPersGrossMonth` | Gross personal employment income |
| `yPensYear` | Gross private pension income |
| `yBenAmountMonth` | Amount of benefits received per month |
| `yBenNonUCReceivedFlag` / `yBenUCReceivedFlag` | Benefits Received (derived) |
| `yFinDstrssFlag` | Financial distress flag |
| `healthPsyDstrss0to12` | Psychological distress score |
| `healthMentalMcs` | Mental Component Summary (MCS) |
| `healthPhysicalPcs` | Physical Component Summary (PCS) |
| `healthSelfRated` | Self-Rated Health |
| `demLifeSatScore0to10` | Life Satisfaction Score |
| `healthWbScore0to36` | Subjective wellbeing (GHQ) |
| `careNeedFlag` | Need of social care |
| `careProvidedFlag` / `careProvidedFlag.y` | Provided social care |

Plus join/weighting keys: `time`/`Time`/`Year`, `id_BenefitUnit`/`idbu`/`idBu`, and an optional `wgt`/`Wgt` weight column (defaults to 1.0 per row if absent or invalid).

### 3. Connect pre-aggregated results

An embedding application can render `<App dataSource={...} />` with the same
aggregate row shape used by the existing charts. This is an optional presentation
interface: it does not add API URLs, authentication, server-side aggregation or
new statistical calculations to the Visualiser. Rendering `<App />` continues
to load the bundled dataset and offer the local-folder viewer.

For example, a host that has already loaded authorised aggregate rows can use:

```jsx
import App from "./App";

function ResultsView({ rows, comparison, message, onReload }) {
  return <App dataSource={{
    key: comparison.id,
    rows,
    label: "Online results",
    names: {
      baseline: comparison.baselineName,
      scenario: comparison.scenarioName,
    },
    description: "These simulation results were aggregated by the hosting service.",
    message,
    controls: <button onClick={onReload}>Reload results</button>,
    navigation: <a href="/">Return to SimPaths Online</a>,
  }} />;
}
```

| Field | Purpose |
|---|---|
| `rows` | Array of chart-ready aggregate rows; use `[]` while loading or unavailable. Omitted rows also mean an empty connected source. |
| `key` | Optional string comparison identity. Change it when selecting a different comparison to reset chart filters and selections. |
| `label` | Optional plain-text source label, such as `Online results`. Defaults to `Connected results`. |
| `names.baseline`, `names.scenario` | Optional configuration names, shown alongside their roles in Connect Data and the comparison description. Without names, the labels remain `Baseline` and `Scenario`. |
| `description`, `message`, `notice` | Optional plain-text source explanation, loading/error status and comparison notice. |
| `controls` | Optional React content for host-owned source selection or retry controls, rendered in Connect Data. |
| `navigation` | Optional React content rendered in the header, such as a link back to the hosting application. |
| `showDelta` | Set to `false` to hide the difference view while retaining the level charts. Defaults to `true`, preserving the standalone behaviour. This is a presentation option, not an access-control mechanism. |

The host owns loading and source switching. It can offer locally saved data by
calling the existing `parseLocalFolder()` and supplying its aggregate result to
the same prop. `controls` and `navigation` are trusted application components,
not HTML or React objects received from an API. Source labels, configuration names
and status messages are rendered as text. Configuration names never replace the `baseline`/`scenario` identifiers
used by filtering and calculations.

Treat row arrays as immutable: supply a new array when results change. Row
normalisation is memoised by that array. Changing `key` also resets chart state.
The interface does not alter the upstream seed-paired difference calculations; a host can
hide that view until its results support the required comparison method.

**Keep the `dataSource` object present while loading or when access is lost.**
Supply `rows: []` and an appropriate `message`; the Visualiser then removes its
charts and shows the connected-source status. It does not fetch bundled data,
open a folder picker or make a network request on behalf of a connected source.
Only omitting the prop (or explicitly setting it to `null`/`undefined`) returns
to the standalone default/local workflow. Late responses from a previous
standalone load cannot replace connected results.

Rows use the normalised shape returned by `performCrossRunAggregation()`, not
the alternate CSV header names accepted by `parseCsvRow()`:

- Numeric `year` and text `scenario`, `module`, `variable`, `variable_value`,
  `stratifier`, `stratifier_value`, `metric_type`.
- `scenario` is `baseline` or `scenario`; `metric_type` is `mean` or `share`.
- Numeric `n_runs`, `total_sample`, `min_sample`, `mean_sample`, `mean_value`,
  `sd_value`, `lower_ci`, `upper_ci`. Missing numeric metrics or JSON `null`
  become `NaN`, preserving unavailable/suppressed estimates rather than
  converting them to zero. Native `NaN` is also accepted; infinity and numeric
  strings are rejected.
- Other row fields are rejected to catch accidental use of a different data
  format. Rows are copied without mutating their source or recalculating values.

**Browser validation is not a privacy boundary.** The hosting service must
authenticate the user, check ownership and permissions, apply its approved
aggregation/disclosure rules, and send only permitted aggregate data. It must
never send restricted raw records, identifiers, file paths or diagnostic logs
to this interface. Rejecting a row after it reached the browser cannot undo
that disclosure. This PR supplies a reusable Visualiser interface; the
authenticated results API and VM integration remain in the hosting repositories.

#### Checking the connected-source interface

```bash
npm ci --legacy-peer-deps
CI=true npm test -- --watchAll=false --runInBand --transformIgnorePatterns '^$' \
  --runTestsByPath src/aggregateDataSource.test.js src/App.aggregateData.test.js src/App.aggregateCharts.test.js
```

These tests use fictional data and the real D3 charts. They cover chart-data
handoff, configuration names, unavailable and
suppressed values, source switching, late responses, absence of automatic
connected-source requests, and preservation of the default/local workflows.



Connected sources can supply several distinct scenario identities. The `names`
object maps those identities to configuration names; labels remain plain text.
Rows may also include the upstream paired-impact fields and wage/income-bin
metrics. The interface preserves these values without recomputing them.
