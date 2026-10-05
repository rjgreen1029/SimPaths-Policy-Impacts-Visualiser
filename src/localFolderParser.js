/**
 * localFolderParser.js — Entry point for "Visualise Your Own Data": turns a
 * user-selected directory (via the File System Access API) into the same
 * aggregated row shape the dashboard normally gets from the default CSV.
 *
 * Pipeline: discoverBranches → collect run folders → locateRunFiles (cheap,
 * directory-listing only) → dispatchToWorkers (expensive — reads + parses +
 * aggregates every run) → performCrossRunAggregation (combines all runs into
 * final rows with cross-run means/SDs/95% CIs).
 *
 * Directory scanning + file-handle discovery stays on the main thread (cheap:
 * no file content is read here). Actual CSV reading + parsing + aggregating is
 * dispatched to a worker pool so multiple runs are read and processed in
 * parallel across CPU cores, and each worker only ever holds one run's file
 * text in memory at a time — never the whole dataset at once. Falls back to
 * main-thread, one-run-at-a-time processing if Workers aren't supported
 * (e.g. file:// without COOP headers).
 */

import { createGroupedAccumulator, accumulateRunMetrics, finaliseAggregation, processRunTexts } from "./parseCore.js";



// ─── Main entry point ─────────────────────────────────────────────────────────
/**
 * Parses a user-selected simulation output folder into aggregated dashboard
 * rows (same shape as the default pre-aggregated CSV).
 *
 * Expects `directoryHandle` to contain "Baseline" and/or "Scenario"
 * subfolders (case-insensitive), each containing one subfolder per model
 * run. See parseCore.js's COLUMN_MAP for the expected raw column names.
 *
 * @param {FileSystemDirectoryHandle} directoryHandle - the folder the user picked
 * @param {(msg: string) => void} onProgress - called with human-readable progress updates
 * @returns {Promise<object[]>} final aggregated rows, ready for the dashboard
 * @throws if no Baseline/Scenario folders, no runs, no valid person+benefit
 *         CSV pairs, or no usable data rows are found at any stage
 */
export async function parseLocalFolder(directoryHandle, onProgress) {
  // 1. Discover branches (baseline / scenario)
  // Discover branches: exactly one "Baseline" folder required, plus one or
  // more scenario folders (any name that isn't "baseline"). The scenario
  // folder name becomes the scenario label in the data (lowercased, spaces
  // replaced with underscores), e.g. "Scenario_Education" → "scenario_education".
  const branches = [];
  let hasBaseline = false;
  for await (const entry of directoryHandle.values()) {
    if (entry.kind !== "directory") continue;
    const n = entry.name.toLowerCase();
    if (n === "baseline") {
      hasBaseline = true;
      branches.push({ scenarioName: "baseline", handle: entry });
    } else {
      // Any other subfolder is treated as a scenario. Normalise the name to
      // lowercase with underscores so it round-trips through the CSV cleanly.
      const scenName = n.replace(/\s+/g, "_");
      branches.push({ scenarioName: scenName, handle: entry });
    }
  }
  if (!hasBaseline) throw new Error("Could not find a 'Baseline' subfolder. The root folder must contain a folder named exactly 'Baseline'.");
  if (branches.length < 2) throw new Error("Could not find any scenario subfolder alongside 'Baseline'. Add at least one other subfolder (e.g. 'Scenario' or 'Scenario_Education').");

  // 2. Collect all run descriptors, extracting the numeric seed from the folder
  //    name. Run folders are expected to contain a pattern like _606_ or _607_
  //    (underscore, 3-or-more digits, underscore) somewhere in their name —
  //    this seed is the pairing key that matches each Baseline run to its
  //    Scenario counterpart. Folders with no extractable seed are skipped with
  //    a warning; if NO valid seeds are found at all, an error is thrown.
  const SEED_RE = /_(6\d{2,})_/;   // matches _606_, _6071_, etc.
  function extractSeed(name) {
    const m = SEED_RE.exec(name);
    return m ? m[1] : null;
  }

  const runJobs = [];
  const skippedNames = [];
  for (const { scenarioName, handle } of branches) {
    for await (const runEntry of handle.values()) {
      if (runEntry.kind !== "directory") continue;
      const seed = extractSeed(runEntry.name);
      if (!seed) { skippedNames.push(`${scenarioName}/${runEntry.name}`); continue; }
      runJobs.push({ scenarioName, runEntry, runId: seed });
    }
  }
  if (skippedNames.length) {
    onProgress(`Warning: ${skippedNames.length} folder(s) skipped — no seed pattern (_60X_) found in name: ${skippedNames.slice(0,3).join(", ")}${skippedNames.length>3?" …":""}`);
  }
  if (!runJobs.length) throw new Error("No run subdirectories with a recognisable seed pattern (_60X_) found inside Baseline/Scenario.");

  // Validate that at least one seed appears in BOTH scenarios — if seeds are
  // entirely disjoint the paired aggregation will produce nothing useful.
  const seedsByScenario = {};
  for (const { scenarioName, runId } of runJobs) {
    if (!seedsByScenario[scenarioName]) seedsByScenario[scenarioName] = new Set();
    seedsByScenario[scenarioName].add(runId);
  }
  // Validate seed overlap: every scenario must share at least one seed with Baseline.
  const baseSeeds = seedsByScenario["baseline"] ?? new Set();
  const scenarioNames = Object.keys(seedsByScenario).filter(s => s !== "baseline");
  for (const sName of scenarioNames) {
    const overlap = [...baseSeeds].filter(s => seedsByScenario[sName].has(s));
    if (!overlap.length) throw new Error(
      `No matching seeds found between baseline and ${sName}. ` +
      `Baseline seeds: [${[...baseSeeds].join(", ")}]. ` +
      `${sName} seeds: [${[...seedsByScenario[sName]].join(", ")}]. ` +
      `Ensure run folders share the same _60X_ seed number across Baseline and each scenario.`
    );
    if (overlap.length < baseSeeds.size) {
      onProgress(`Warning: only ${overlap.length} of ${baseSeeds.size} baseline seeds matched in ${sName}. Unmatched runs will be excluded from the delta plot for that scenario.`);
    }
  }

  const total = runJobs.length;
  let done = 0;
  onProgress(`Found ${total} run(s). Locating files…`);

  // 3+4. Locate, read, and process each run immediately — never accumulate
  //      all runs' text in memory simultaneously.
  const grouped = createGroupedAccumulator();
  let processed = 0;
  const warnings = [];

  for (const job of runJobs) {
    try {
      const { personText, benefitText } = await locateRunFiles(job);
      const metrics = processRunTexts(personText, benefitText, job.scenarioName, job.runId);
      accumulateRunMetrics(grouped, metrics);
      processed++;
    } catch (e) {
      warnings.push(e.message);
    }
    done++;
    if (done % 2 === 0 || done === total) onProgress(`Reading and aggregating… ${done}/${total} runs`);
  }

  if (warnings.length) {
    onProgress(`Warning: ${warnings.length} run(s) failed — ${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length-1} more)` : ""}`);
  }
  if (!processed) throw new Error("No runs were successfully processed.");

  if (!grouped.size) throw new Error("No usable data rows after aggregation. Check that the CSV files contain recognised column names.");
  onProgress("Computing confidence intervals…");
  return finaliseAggregation(grouped);
}

// ─── File discovery (main thread, no file reads) ──────────────────────────────
/**
 * Finds the person + benefit CSV file handles for a single run, without
 * reading any file content. Looks inside a "csv" subfolder if present,
 * otherwise directly inside the run folder. Matching is by substring
 * ("person" / "benefit" in the filename, case-insensitive) rather than an
 * exact name, so this tolerates whatever naming convention the simulation
 * output actually used.
 *
 * @returns {Promise<{personHandle, benefitHandle}|null>} null if either file is missing
 */
async function locateRunFiles({ runEntry }) {
  // Find the csv subfolder if present — fully exhaust the iterator (no break)
  // to avoid corrupting directory handles on some browsers.
  let targetDir = runEntry;
  const subDirs = [];
  for await (const sub of runEntry.values()) {
    if (sub.kind === "directory") subDirs.push(sub);
  }
  const csvDir = subDirs.find(s => s.name.toLowerCase() === "csv");
  if (csvDir) targetDir = csvDir;

  // Collect all entries first (fully exhaust iterator), then process
  const allEntries = [];
  for await (const entry of targetDir.values()) {
    allEntries.push(entry);
  }

  const csvEntries = allEntries.filter(e =>
    e.kind === "file" && e.name.toLowerCase().endsWith(".csv")
  );

  const personEntry  = csvEntries.find(e => e.name.toLowerCase().includes("person"));
  const benefitEntry = csvEntries.find(e => e.name.toLowerCase().includes("benefit"));

  if (!personEntry || !benefitEntry) {
    const found = csvEntries.map(e => e.name).join(", ") || "(none)";
    throw new Error(
      `Could not find person+benefit CSV pair in ${runEntry.name}` +
      (csvDir ? "/csv" : "") +
      `. CSV files found: ${found}`
    );
  }

  // Get File objects first so we can log their sizes
  const [personFile, benefitFile] = await Promise.all([
    personEntry.getFile(),
    benefitEntry.getFile(),
  ]);

  const [personText, benefitText] = await Promise.all([
    personFile.text(),
    benefitFile.text(),
  ]);

  return {
    personText,
    benefitText,
    personName:  personEntry.name,
    benefitName: benefitEntry.name,
  };
}