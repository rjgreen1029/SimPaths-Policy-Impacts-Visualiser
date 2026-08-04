/* eslint-disable no-restricted-globals */
/**
 * parseWorker.js — Web Worker entry point for parsing local simulation data.
 *
 * Spawned by localFolderParser.js's dispatchToWorkers(), one instance per
 * pool slot (see WORKER_COUNT there). Each worker is handed a *batch* of
 * runs (see BATCH_SIZE) and processes them one at a time in a simple loop —
 * it does not parallelise within a batch, since the parallelism already
 * comes from having multiple workers running concurrently.
 *
 * Message contract:
 *   IN  — { runs: [{ personHandle, benefitHandle, scenarioName, runId }, ...] }
 *   OUT — { metrics: [...] }  on success
 *         { error: string }   on failure (any run in the batch throwing aborts the batch)
 *
 * Why file reading happens HERE and not on the main thread: FileSystemFileHandle
 * objects are structured-clone-serialisable, so posting them to a worker is a
 * cheap reference copy, not a copy of the file's contents. Reading (`getFile().text()`)
 * only happens once the handle arrives in the worker, so the main thread never
 * holds any raw CSV text — only lightweight handles cross postMessage in either
 * direction. That keeps peak memory bounded to roughly one run's worth of CSV
 * text per worker, rather than the whole dataset at once.
 */

import { processRunTexts } from "./parseCore.js";

/**
 * Handles one batch-of-runs message from the main thread: reads each run's
 * person + benefit CSV text, hands it to processRunTexts() for parsing and
 * per-run aggregation, and posts the combined metrics back once the whole
 * batch is done (or posts an error and aborts if any run fails).
 */
self.onmessage = async ({ data }) => {
  try {
    const allMetrics = [];
    for (const { personHandle, benefitHandle, scenarioName, runId } of data.runs) {
      const [personText, benefitText] = await Promise.all([
        personHandle.getFile().then(f => f.text()),
        benefitHandle.getFile().then(f => f.text()),
      ]);
      const metrics = processRunTexts(personText, benefitText, scenarioName, runId);
      allMetrics.push(...metrics);
      // personText/benefitText fall out of scope here and become eligible for
      // GC before the next run in this batch is read.
    }
    self.postMessage({ metrics: allMetrics });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};