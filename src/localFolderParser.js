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

import { performCrossRunAggregation, processRunTexts } from "./parseCore.js";

const WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);
// How many runs to batch per worker message (tune if runs are very small/large)
const BATCH_SIZE = 2;

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
  const branches = [];
  for await (const entry of directoryHandle.values()) {
    if (entry.kind==="directory") {
      const n = entry.name.toLowerCase();
      if (n==="baseline"||n==="scenario") branches.push({ scenarioName:n, handle:entry });
    }
  }
  if (!branches.length) throw new Error("Could not find 'Baseline' or 'Scenario' subfolders.");

  // 2. Collect all run descriptors
  const runJobs = [];
  let runIdCounter = 0;
  for (const { scenarioName, handle } of branches) {
    for await (const runEntry of handle.values()) {
      if (runEntry.kind==="directory") {
        runJobs.push({ scenarioName, runEntry, runId:++runIdCounter });
      }
    }
  }
  if (!runJobs.length) throw new Error("No run subdirectories found inside Baseline/Scenario.");

  const total = runJobs.length;
  let done = 0;
  onProgress(`Found ${total} run(s). Locating files…`);

  // 3. Locate each run's CSV file handles on the main thread. This is a
  //    directory-listing pass only — no file content is read here — so it
  //    stays cheap and fast no matter how large the CSVs themselves are.
  const runHandles = [];
  for (const job of runJobs) {
    const handles = await locateRunFiles(job);
    if (handles) runHandles.push({ ...job, ...handles });
    done++;
    if (done % 10 === 0 || done===total) onProgress(`Locating files… ${done}/${total}`);
  }

  if (!runHandles.length) throw new Error("No person+benefit CSV pairs found in any run folder.");

  // 4. Dispatch to worker pool (or fall back to main thread). File contents
  //    are only read inside dispatchToWorkers/mainThreadFallback, one run (or
  //    one small batch) at a time — never all runs simultaneously.
  onProgress("Aggregating data across runs…");
  const allMetrics = await dispatchToWorkers(runHandles, onProgress, total);

  if (!allMetrics.length) throw new Error("No usable data rows after aggregation.");
  onProgress("Computing confidence intervals…");
  return performCrossRunAggregation(allMetrics);
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
  let targetDir = runEntry;
  for await (const sub of runEntry.values()) {
    if (sub.kind==="directory" && sub.name.toLowerCase()==="csv") { targetDir=sub; break; }
  }
  let personHandle=null, benefitHandle=null;
  for await (const fileEntry of targetDir.values()) {
    if (fileEntry.kind!=="file" || !fileEntry.name.toLowerCase().endsWith(".csv")) continue;
    const n = fileEntry.name.toLowerCase();
    if (n.includes("person"))       personHandle  = fileEntry;
    else if (n.includes("benefit")) benefitHandle = fileEntry;
  }
  if (!personHandle||!benefitHandle) return null;
  return { personHandle, benefitHandle };
}

// ─── Worker pool dispatch ─────────────────────────────────────────────────────
// FileSystemFileHandle is structured-clone-serializable, so posting handles to
// workers is a cheap reference copy — not a copy of the file's contents. Each
// worker reads, parses, and discards one run's text at a time (see
// parseWorker.js), so peak memory stays bounded by roughly WORKER_COUNT runs'
// worth of CSV text, rather than ALL runs' worth as before.
/**
 * Splits runHandles into batches of BATCH_SIZE, spins up a pool of up to
 * WORKER_COUNT Web Workers, and keeps every worker continuously fed with the
 * next unclaimed batch until all batches are processed (a simple work-stealing
 * pool, not a fixed 1:1 batch-to-worker assignment). Falls back to
 * mainThreadFallback() if Worker construction itself fails (e.g. some
 * file://-without-COOP-headers setups).
 *
 * @param {object[]} runHandles - output of locateRunFiles(), one entry per run
 * @param {(msg: string) => void} onProgress
 * @param {number} total - total run count, for progress messages
 * @returns {Promise<object[]>} combined per-run metrics from every worker
 */
async function dispatchToWorkers(runHandles, onProgress, total) {
  let useWorkers = true;
  try {
    const testWorker = new Worker(new URL("./parseWorker.js", import.meta.url), { type:"module" });
    testWorker.terminate();
  } catch {
    useWorkers = false;
  }

  if (!useWorkers) {
    return mainThreadFallback(runHandles, onProgress, total);
  }

  // Split into batches
  const batches = [];
  for (let i=0; i<runHandles.length; i+=BATCH_SIZE) {
    batches.push(runHandles.slice(i, i+BATCH_SIZE).map(r => ({
      personHandle:  r.personHandle,
      benefitHandle: r.benefitHandle,
      scenarioName:  r.scenarioName,
      runId:         r.runId,
    })));
  }

  const allMetrics = [];
  let runsProcessed = 0;

  // Pool: keep WORKER_COUNT workers busy
  const pool = Array.from({ length: Math.min(WORKER_COUNT, batches.length) }, () =>
    new Worker(new URL("./parseWorker.js", import.meta.url), { type:"module" })
  );

  await new Promise((resolve, reject) => {
    let batchIndex = 0;
    let active = 0;

    function assignNext(worker) {
      if (batchIndex >= batches.length) {
        active--;
        if (active===0) resolve();
        return;
      }
      const batch = batches[batchIndex++];
      active++;
      worker.onmessage = ({ data }) => {
        if (data.error) { reject(new Error(data.error)); return; }
        allMetrics.push(...data.metrics);
        runsProcessed = Math.min(runsProcessed + batch.length, total);
        onProgress(`Aggregating… ${runsProcessed}/${total} runs`);
        assignNext(worker);
      };
      worker.onerror = (e) => reject(new Error(e.message || "A worker failed while processing a run."));
      worker.postMessage({ runs: batch });
    }

    pool.forEach(w => assignNext(w));
  });

  pool.forEach(w => w.terminate());
  return allMetrics;
}

// ─── Main-thread fallback ──────────────────────────────────────────────────────
// Reads and processes one run at a time, so only a single run's CSV text is
// ever resident in memory even though there's no worker pool to spread the
// work across.
/**
 * Serial, single-threaded equivalent of dispatchToWorkers() — used when Web
 * Workers aren't available. Same output shape, just slower and without
 * parallelism, since it processes one run at a time on the main thread.
 *
 * @returns {Promise<object[]>} combined per-run metrics
 */
async function mainThreadFallback(runHandles, onProgress, total) {
  const allMetrics = [];
  let i = 0;
  for (const r of runHandles) {
    const [personText, benefitText] = await Promise.all([
      r.personHandle.getFile().then(f => f.text()),
      r.benefitHandle.getFile().then(f => f.text()),
    ]);
    const metrics = processRunTexts(personText, benefitText, r.scenarioName, r.runId);
    allMetrics.push(...metrics);
    i++;
    if (i % 3===0 || i===total) onProgress(`Aggregating… ${i}/${total} runs`);
  }
  return allMetrics;
}