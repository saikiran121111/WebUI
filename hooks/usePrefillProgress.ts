"use client";
import { useEffect, useState } from "react";
import { estimatePrefillPct, readPrefillTps } from "../lib/ui/prefillCalibration";

/**
 * Live prefill percentage for an in-flight "reading the prompt" wait.
 * Returns null when the prompt size is unknown (caller shows an
 * indeterminate shimmer instead of a fake number).
 */
export function usePrefillProgress(
  active: boolean,
  estTokens: number | null,
  startedAt: number | null,
): number | null {
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    if (!active || estTokens == null || startedAt == null) {
      setPct(null);
      return;
    }
    const tps = readPrefillTps();
    const tick = () => setPct(estimatePrefillPct(Date.now() - startedAt, estTokens, tps));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [active, estTokens, startedAt]);

  return pct;
}
