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
