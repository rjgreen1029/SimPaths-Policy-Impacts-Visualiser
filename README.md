# SimPaths Policy Impacts Visualiser

An interactive React + D3 dashboard for exploring outputs from SimPaths, a dynamic microsimulation model developed by the Centre for Microsimulation and Policy Analysis (CeMPA) at the University of Essex. Built by researchers at the University of Glasgow as part of the Policy Modelling for Health research group.

The dashboard compares a Baseline run against a Policy Scenario across demographic, employment, income and health outcomes — as a time series, at a single point in time, or as the difference between the two — with all aggregation happening entirely client-side, in the browser.

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
- [Colour system](#colour-system)
- [Browser support](#browser-support)
- [Privacy & data handling](#privacy--data-handling)
- [Customising the dashboard](#customising-the-dashboard)
- [Known limitations](#known-limitations)
- [Credit & citation](#credit--citation)
- [Feedback](#feedback)

---

## Features

- Line, stacked-bar and grouped-bar charts for numeric and categorical variables, rendered directly with D3 (no charting library dependency).
- Three ways to view the data: time series, a single cross-sectional year, and Baseline → Scenario deltas.
- Stratify any variable by Age, Gender, Household Type, Disability Status, Region, Ethnicity or Income Quintile, shown as small-multiple panels or combined onto one chart.
- 95% confidence intervals computed across model runs; unreliable estimates (small underlying samples) are automatically suppressed rather than shown.
- Two data sources: a pre-packaged default dataset, or point the dashboard at your own local SimPaths output folder — no upload, no server round-trip.
- Parallelised, memory-lean parsing: your own runs are read and aggregated by a pool of Web Workers, one run's CSV text in memory at a time per worker, so large multi-run folders don't blow out browser memory.
- Export any chart panel as a PNG, or its underlying data as CSV.
- Responsive layout, from a compact mobile view up to wide desktop screens.

## Tech stack

- React (function components + hooks) for the UI
- D3.js for both data-side aggregation (`d3.csvParse`, `d3.csv`) and chart rendering (raw SVG, no chart library)
- Web Workers (native, no bundler-specific worker loader) for parallel CSV parsing/aggregation
- File System Access API (`window.showDirectoryPicker`) for reading local simulation output folders directly, with no file upload step

No backend is required — this is a fully static, client-side application.

## Project structure

```
src/
├── index.js               # React entry point (createRoot + <App />)
├── App.js                 # Page shell: header, intro card, sidebar, main viz, closing banner
├── DashboardSection.js     # All D3 chart rendering + view/filter controls
├── useAggregatedData.js    # Variable/stratifier definitions, colour engine, CSV row parser, data hook
├── parseCore.js            # Pure parsing + per-run aggregation logic (no browser APIs)
├── localFolderParser.js    # Directory discovery + worker-pool dispatch for local folders
└── parseWorker.js          # Web Worker: reads + aggregates one batch of runs at a time

public/
├── SimPaths_All_Aggregated_Outputs.csv   # Default pre-aggregated dataset (see below)
├── pmh_logo.png                          # Header logo
├── guidance_notes.pdf                    # Folder/file layout guidance for "Visualise Your Own Data"
└── bottom_banner_image.png               # Optional — see "Customising the dashboard"
```

`parseCore.js` is imported by both `localFolderParser.js` (the main-thread, no-Worker fallback) and `parseWorker.js` (the Worker path), so the CSV join/rename/aggregation logic exists in exactly one place regardless of which path runs.

## Getting started

This project follows standard Create React App conventions (`react-scripts`). If your `package.json` differs, adjust accordingly.

```bash
# install dependencies
npm install

# start a local dev server
npm start

# build a production bundle
npm run build
```

The app expects `d3` as a dependency — if you're starting from a bare CRA scaffold, install it with:

```bash
npm install d3
```

## Required public assets

Drop these into `public/` before running the app — the dashboard references them directly:

| File | Required? | Purpose |
|---|---|---|
| `SimPaths_All_Aggregated_Outputs.csv` | Yes | Default dataset loaded on first visit |
| `pmh_logo.png` | Yes | Logo shown in the header banner |
| `guidance_notes.pdf` | Yes | Linked from the "Guidance Notes" button in the Connect Data card |
| `bottom_banner_image.png` | No | Optional logo strip (e.g. funder/partner logos) in the closing banner — the slot stays invisible until this file exists |

## Data inputs

The dashboard can be driven by either of two data sources, toggled from the Connect Data card in the sidebar.

### 1. Default pre-aggregated dataset

On load, the app fetches `/SimPaths_All_Aggregated_Outputs.csv` and parses each row with `parseCsvRow()` in `useAggregatedData.js`. Expected columns (case-insensitive alternates are supported for several — see the parser):

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

This is the same shape produced by the local-folder aggregation pipeline (see `performCrossRunAggregation`), so a folder you've processed once can be exported and reused as a new default dataset.

### 2. Bring your own simulation output

Clicking "Visualise Your Own Data" opens a native folder picker. The selected parent folder must be laid out as:

```
YourSimulationOutput/
├── Baseline/
│   ├── run_1/
│   │   └── csv/                 # optional — files are also found directly in the run folder
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

Full details, including exact expected file naming, live in `guidance_notes.pdf`, linked from the Connect Data card.

## How the aggregation pipeline works

1. **Discovery** (main thread): the folder tree is scanned for `Baseline`/`Scenario` → run subfolders → person/benefit CSV file handles. This step only lists directory contents — no file content is read yet, so it's fast regardless of file size.
2. **Dispatch**: run handles are batched (2 runs per message by default) and sent to a pool of Web Workers — sized to `min(navigator.hardwareConcurrency, 8)` — so multiple runs are read and aggregated in parallel across CPU cores. If Workers aren't supported (e.g. `file://` without cross-origin isolation headers), the app falls back to processing runs one at a time on the main thread with identical logic.
3. **Per-run aggregation** (`parseCore.js`, inside each worker): person and benefit CSVs are streamed and joined on `<year>_<benefitUnitId>`, renamed to display variable names, and reduced — in a single pass per year — into weighted means (numeric variables) and weighted shares (categorical variables), each broken down overall and by every stratifier.
4. **Cross-run aggregation**: once every run's metrics are collected, `performCrossRunAggregation()` groups matching rows across runs and computes the cross-run mean, standard deviation, and a 95% CI (mean ± 1.96·SD). Any estimate whose smallest contributing run sample is below 100 is suppressed (`NaN`) rather than shown, to avoid presenting unreliable small-sample estimates.
5. The result is the same row shape as the default CSV (`year, scenario, module, variable, variable_value, stratifier, stratifier_value, metric_type, n_runs, total_sample, min_sample, mean_sample, mean_value, sd_value, lower_ci, upper_ci`), so the rest of the app doesn't need to know which data source it came from.

At every stage, only a bounded amount of raw CSV text is held in memory at once (roughly one run per worker), rather than the whole dataset — so this scales to folders with many, or large, runs without exhausting browser memory.

## Dashboard views & controls

Once a variable is selected from the sidebar, `DashboardSection.js` offers:

- **Stratify by** — Overall, or any of Age / Gender / Household Type / Disability Status / Region / Ethnicity / Income Quintile.
- **Chart type** — Line (numeric or categorical) or Stacked bar (categorical only).
- **View data** — Both / Baseline only / Scenario only.
- **Layout** — Panels (small multiples, one per stratum) or Combined (all strata on one chart), when stratified.
- **Compare** — a dedicated Δ Baseline → Scenario view showing the modelled effect of the policy change directly.
- **Filters** — toggle individual variable values and/or stratum values on/off.
- **Highlighting** — click a legend entry to spotlight one series across the whole chart.
- **Export** — every panel has PNG and CSV export buttons; "download all" buttons export every visible panel at once.

Baseline and Scenario are always distinguished by the same visual channel throughout — solid vs. dashed lines, full vs. translucent bars — independent of colour, so the two remain distinguishable even for colourblind users or in greyscale printouts.

## Colour system

All chart colours are defined once, centrally, in `useAggregatedData.js` (`buildColourMap()`), and reused by every chart type, so a given variable value always gets the same colour whether it appears in a line chart, a bar chart, or a legend.

- Numeric variables → solid teal.
- Binary variables (exactly two values) → a fixed coral/teal pair.
- Ordinal variables (education, income quintile, self-rated health) → purpose-built ramps (e.g. a red–teal diverging scale for income quintile and for health).
- Categorical variables → a 10-colour, colourblind-friendly qualitative palette (`BRAND_QUAL`), sliced in a fixed order so colours stay consistent across variables that share values (e.g. household type and employment status).
- A shared muted grey (`GREY`) is used for any series that's present but not currently highlighted.

## Browser support

- The default pre-loaded dataset works in any modern browser.
- "Visualise Your Own Data" requires the File System Access API (`window.showDirectoryPicker`), currently supported in Chromium-based browsers (Chrome, Edge, Opera, Arc, etc.). In browsers without it (e.g. Firefox, Safari), the folder picker itself won't open — the default dataset view still works normally.
- Within that Chromium path, if Web Workers are unavailable for any reason, the app automatically falls back to slower, single-threaded, main-thread processing — the UI and results are otherwise identical.
- A screen narrower than 320px shows a "screen too small" message instead of the dashboard; everything from a typical phone width upward gets a responsive layout.

## Privacy & data handling

This tool is entirely JavaScript-based. All aggregation of your own simulation output happens locally in your browser — nothing you select via "Visualise Your Own Data" is uploaded, stored, or transmitted anywhere.

## Customising the dashboard

- **Variables & domains**: edit `DOMAIN_SECTIONS`, `DOMAIN_BLURBS` and `VARIABLE_DESCRIPTIONS` in `App.js` to change which variables appear, how they're grouped, and their descriptions.
- **Variable/stratifier ordering & types**: edit `VARIABLE_DEFS` / `STRATIFIER_DEFS` in `useAggregatedData.js`.
- **Colours**: edit the palettes at the top of `useAggregatedData.js` (`BRAND_QUAL`, the `SEQ_*` ramps, `DIV_RED_TEAL`, `INDIGO_EDU`, `HEALTH_DIV`, etc.) — everything downstream picks these up automatically.
- **Raw CSV → display-variable mapping**: edit `COLUMN_MAP` in `parseCore.js` if your simulation output uses different raw column names.
- **Suppression threshold**: the `min_sample < 100` check in `performCrossRunAggregation()` (`parseCore.js`) controls when an estimate is suppressed for being based on too small a sample.
- **Worker batching**: `WORKER_COUNT` and `BATCH_SIZE` in `localFolderParser.js` control parallelism and memory/throughput trade-offs when processing local folders.
- **Bottom banner logo**: drop an image at `public/bottom_banner_image.png` to populate the (otherwise invisible) logo slot in the closing banner.

## Known limitations

- Outputs are based on simulated data, intended for research purposes only — they should not be interpreted as forecasts or official statistics.
- Every figure is an average across multiple model runs, shown with a 95% confidence interval; estimates with an insufficient underlying sample in any contributing run are suppressed rather than shown.
- Differences between Baseline and Scenario reflect the modelled effect of the policy change being tested, not an observed real-world outcome.

## Credit & citation

This tool visualises outputs from the SimPaths microsimulation model using data from Understanding Society: the UK Household Longitudinal Study. See the in-app Credit & Citation section for the DOI and citation details, and the SimPaths License for licensing terms.

## Feedback

Bug reports, feature requests, and general feedback are welcome — use the Feedback button in the app, or email healthmod@glasgow.ac.uk.
