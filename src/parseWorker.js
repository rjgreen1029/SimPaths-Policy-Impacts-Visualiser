/* eslint-disable no-restricted-globals */
// parseWorker.js — runs in a Web Worker, processes a batch of runs and posts results back.
// The main thread sends: { runs: [{ personHandle, benefitHandle, scenarioName, runId }] }
// The worker posts back: { metrics: [...] } or { error: string }
//
// File reading happens IN the worker (not on the main thread) so that only one
// run's CSV text is ever resident in memory at a time, per worker — the main
// thread never holds the raw file contents at all, and only lightweight
// FileSystemFileHandle references (not file data) cross postMessage.

import { processRunTexts } from "./parseCore.js";

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