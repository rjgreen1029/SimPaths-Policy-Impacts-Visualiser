/**
 * localFolderParser.js — Entry point for "Visualise Your Own Data": turns a
 * user-selected directory (via the File System Access API) into the same
 * aggregated row shape the dashboard normally gets from the default CSV.
 */

import { createGroupedAccumulator, accumulateRunMetrics, finaliseAggregation, processRunFiles } from "./parseCore.js";

export async function parseLocalFolder(directoryHandle, onProgress) {
  // 1. Discover branches (baseline / scenario subfolders)
  const branches = [];
  let hasBaseline = false;
  for await (const entry of directoryHandle.values()) {
    if (entry.kind !== "directory") continue;
    const n = entry.name.toLowerCase();
    if (n === "baseline") {
      hasBaseline = true;
      branches.push({ scenarioName: "baseline", handle: entry });
    } else {
      const scenName = n.replace(/\s+/g, "_");
      branches.push({ scenarioName: scenName, handle: entry });
    }
  }
  if (!hasBaseline) throw new Error("Could not find a 'Baseline' subfolder. The root folder must contain a folder named exactly 'Baseline'.");
  if (branches.length < 2) throw new Error("Could not find any scenario subfolder alongside 'Baseline'. Add at least one other subfolder.");


  // 2. Collect run descriptors
  const SEED_RE = /_(\d{3,})_/;
  const runJobs = [];
  const skippedNames = [];
  for (const { scenarioName, handle } of branches) {
    for await (const runEntry of handle.values()) {
      if (runEntry.kind !== "directory") continue;
      const m = SEED_RE.exec(runEntry.name);
      const runId = m ? m[1] : runEntry.name;
      runJobs.push({ scenarioName, runEntry, runId });
    }
  }
  if (skippedNames.length) {
    onProgress(`Warning: ${skippedNames.length} folder(s) skipped: ${skippedNames.slice(0,3).join(", ")}`);
  }
  if (!runJobs.length) throw new Error("No run subdirectories found inside Baseline/Scenario.");

  // Validate seed overlap
  const seedsByScenario = {};
  for (const { scenarioName, runId } of runJobs) {
    if (!seedsByScenario[scenarioName]) seedsByScenario[scenarioName] = new Set();
    seedsByScenario[scenarioName].add(runId);
  }
  const baseSeeds = seedsByScenario["baseline"] ?? new Set();
  for (const sName of Object.keys(seedsByScenario).filter(s => s !== "baseline")) {
    const overlap = [...baseSeeds].filter(s => seedsByScenario[sName].has(s));
    if (!overlap.length) onProgress(`Warning: no matching seeds between baseline and ${sName}.`);
    else if (overlap.length < baseSeeds.size) {
      onProgress(`Warning: only ${overlap.length} of ${baseSeeds.size} baseline seeds matched in ${sName}.`);
    }
  }

  const total = runJobs.length;
  let done = 0;
  onProgress(`Found ${total} run(s). Reading and aggregating…`);

  // 3+4. Read and process each run serially — one run in memory at a time
  const grouped = createGroupedAccumulator();
  let processed = 0;
  const warnings = [];

  for (const job of runJobs) {
    try {
      const { personEntry, benefitText } = await locateRunFiles(job);
      const metrics = await processRunFiles(personEntry, benefitText, job.scenarioName, job.runId);
      accumulateRunMetrics(grouped, metrics);
      processed++;
    } catch (e) {
      warnings.push(`${job.scenarioName}/${job.runId}: ${e.message}`);
    }
    done++;
    if (done % 2 === 0 || done === total) onProgress(`Aggregating… ${done}/${total} runs`);
  }

  if (warnings.length) {
    onProgress(`Warning: ${warnings.length} run(s) failed — ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}`);
  }
  if (!processed) {
    throw new Error(`No runs were successfully processed (${total} attempted).\nErrors: ${warnings.slice(0,3).join(" | ")}`);
  }

  if (!grouped.size) throw new Error("No usable data rows after aggregation.");
  onProgress("Computing confidence intervals…");
  return finaliseAggregation(grouped);
}

async function locateRunFiles({ runEntry }) {
  // Fully exhaust the iterator — no break — to avoid Chrome handle corruption
  let targetDir = runEntry;
  for await (const sub of runEntry.values()) {
    if (sub.kind === "directory" && sub.name.toLowerCase() === "csv") {
      targetDir = sub;
    }
  }

  // Fully exhaust target directory iterator before touching any handle
  const allEntries = [];
  for await (const entry of targetDir.values()) {
    allEntries.push(entry);
  }

  const csvEntries   = allEntries.filter(e => e.kind === "file" && e.name.toLowerCase().endsWith(".csv"));
  const personEntry  = csvEntries.find(e => e.name.toLowerCase().includes("person"));
  const benefitEntry = csvEntries.find(e => e.name.toLowerCase().includes("benefit"));

  if (!personEntry || !benefitEntry) {
    throw new Error(
      `Could not find person+benefit CSV pair in ${runEntry.name}. ` +
      `CSV files found: ${csvEntries.map(e => e.name).join(", ") || "(none)"}`
    );
  }

  // Read sequentially using arrayBuffer+TextDecoder — avoids Chrome .text() bug
  // Benefit CSV is small — read as text. Person CSV is huge — pass the handle
  // to parsePersonCsvStream in parseCore.js which reads it in 32MB chunks.
  const benefitFile = await benefitEntry.getFile();
  const benefitText = await benefitFile.text();

  return { personEntry, benefitText };
}