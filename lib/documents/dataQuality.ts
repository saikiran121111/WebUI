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