/* (C) Copyright 2026, by Ross Richardson
 * Optional, cancellable chart-section source for hosts with large comparisons.
 * Standalone CSV and locally selected folders retain their existing data flow.
 * @author ross richardson
 */
import { useEffect, useMemo, useState } from "react";
import { normaliseAggregateRows } from "./aggregateDataSource";

const EMPTY = [];

export function useAggregateView(source, selection, fallback) {
  const [result, setResult] = useState(null);
  const [revision, setRevision] = useState(0);
  const signature = JSON.stringify(selection);
  const request = useMemo(() => JSON.parse(signature), [signature]);
  useEffect(() => {
    if (!source) return undefined;
    setResult(null); // Release the previous decoded section while the next loads.
    const abort = new AbortController();
    let current = true;
    Promise.resolve().then(() => source.load(request, abort.signal)).then(rows => {
      if (current) {
        if (!Array.isArray(rows) || rows.length > 20000) throw new Error("This chart has too many rows. Select fewer scenarios or a smaller population breakdown.");
        setResult({ source, signature, revision, rows: normaliseAggregateRows(rows), error: "" });
      }
    }).catch(error => {
      if (current && error.name !== "AbortError") setResult({ source, signature, revision, rows: EMPTY,
        error: error.message || "This chart could not be loaded. Try again." });
    });
    return () => { current = false; abort.abort(); };
  }, [source, signature, request, revision]);
  const valid = result != null && result.source === source && result.signature === signature && result.revision === revision;
  return source ? {
    rows: valid ? result.rows : EMPTY,
    loading: !valid,
    error: valid ? result.error : "",
    retry: () => setRevision(value => value + 1),
  } : { rows: fallback, loading: false, error: "", retry: () => {} };
}
