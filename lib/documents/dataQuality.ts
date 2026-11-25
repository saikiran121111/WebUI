/**
 * F11: honest reporting of value decisions an engine made on a data table.
 *
 * A workbook/BI file that quietly replaced "unknown" with 0 is a fabricated
 * measurement, so every such decision is returned as a typed issue. The file
 * download itself has nowhere to put that report, so a compact, bounded summary
 * rides in response headers that the preview/UI can surface.
 */
export interface DataQualityHeaderBag { [k: string]: string }

export const DATA_QUALITY_COUNT_HEADER = "X-Ruke-Data-Quality-Issues";
export const DATA_QUALITY_SUMMARY_HEADER = "X-Ruke-Data-Quality-Summary";

/** Header-safe (ASCII, bounded) summary. Never claims more than it shows. */
export function dataQualityHeaders(count: number, sample: string, maxBytes = 512): DataQualityHeaderBag {
  if (!count) return {};
  const summary = `issues=${count}; ${sample}`
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/[\r\n]+/g, " ")
    .slice(0, maxBytes);
  return {
    [DATA_QUALITY_COUNT_HEADER]: String(count),
    [DATA_QUALITY_SUMMARY_HEADER]: encodeURIComponent(summary),
  };
}

/**
 * F153 §2d — the PARTIAL-EXPORT law. The engines report every incompleteness
 * in response headers (F11 value decisions, F77 chart-image failures), but the
 * one moment the user experiences an export — the DOWNLOAD — saved the file
 * with zero of that report on screen, so a workbook missing chart images
 * downloaded as a plain success. This turns the engine's header report back
 * into the ONE bounded warning line the download UI must show. Null means the
 * export was complete; a non-null string must never be swallowed.
 */
export const CHART_FAILURE_COUNT_HEADER = "x-xlsx-chart-failures";
export const CHART_FAILURE_SAMPLE_HEADER = "x-xlsx-chart-failure-sample";

export function exportWarningFromHeaders(h: Headers, maxChars = 400): string | null {
  const dec = (v: string | null) => {
    try { return decodeURIComponent(v ?? ""); } catch { return v ?? ""; }
  };
  // Each section is capped on its own so a long sample in one report cannot
  // push the other fact off the bounded line.
  const cap = Math.max(0, Math.floor((maxChars - 16) / 2));
  const parts: string[] = [];
  const issues = parseInt(h.get(DATA_QUALITY_COUNT_HEADER) ?? "0", 10) || 0;
  if (issues > 0) parts.push(`${issues} value decision(s): ${dec(h.get(DATA_QUALITY_SUMMARY_HEADER)).slice(0, cap)}`);
  const charts = parseInt(h.get(CHART_FAILURE_COUNT_HEADER) ?? "0", 10) || 0;
  if (charts > 0) parts.push(`${charts} chart image(s) missing: ${dec(h.get(CHART_FAILURE_SAMPLE_HEADER)).slice(0, cap)}`);
  if (!parts.length) return null;
  return ("Partial export — " + parts.join("; ")).slice(0, maxChars);
}