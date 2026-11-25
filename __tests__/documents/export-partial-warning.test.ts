/**
 * F153 §2d — the PARTIAL-EXPORT law.
 *
 * The engines already report every incompleteness in response headers (F11
 * value decisions, F77 chart-image failures) and F77's own law says an
 * incomplete export must NEVER report success silently. But the moment the
 * user actually experiences an export — the DOWNLOAD — the file saved with
 * zero of that report on screen: a workbook missing chart images downloaded
 * as a plain success. The law: the download UI turns the engine's header
 * report into ONE bounded visible warning line; a complete export stays
 * silent.
 *
 * Seam: the pure header→warning function (the engine's report in, the user's
 * line out) + the exported view line (renderToStaticMarkup). The live row in
 * the final exclusive batch clicks Download on a real partial export in
 * Chromium and reads the line (and reopens the saved file through the app).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  exportWarningFromHeaders,
  DATA_QUALITY_COUNT_HEADER,
  DATA_QUALITY_SUMMARY_HEADER,
  CHART_FAILURE_COUNT_HEADER,
  CHART_FAILURE_SAMPLE_HEADER,
} from "@/lib/documents/dataQuality";
import { ExportWarningLine } from "@/components/render/DocumentCard";

const H = (init: Record<string, string>) => new Headers(init);

describe("the engine's header report becomes one bounded warning line", () => {
  it("a complete export: null — the download stays silent", () => {
    expect(exportWarningFromHeaders(H({ "Content-Disposition": 'attachment; filename="a.xlsx"' }))).toBeNull();
  });

  it("value decisions alone: the count and the decoded sample are named", () => {
    const w = exportWarningFromHeaders(H({
      [DATA_QUALITY_COUNT_HEADER]: "2",
      [DATA_QUALITY_SUMMARY_HEADER]: encodeURIComponent("issues=2; B4 no unit declared; C9 blank kept blank"),
    }));
    expect(w).toContain("Partial export");
    expect(w).toContain("2 value decision(s)");
    expect(w).toContain("B4 no unit declared");
  });

  it("missing chart images alone: named, so the workbook never downloads as a plain success", () => {
    const w = exportWarningFromHeaders(H({
      [CHART_FAILURE_COUNT_HEADER]: "1",
      [CHART_FAILURE_SAMPLE_HEADER]: encodeURIComponent("Revenue trend: png render timed out"),
    }));
    expect(w).toContain("1 chart image(s) missing");
    expect(w).toContain("Revenue trend: png render timed out");
  });

  it("both reports ride the same line; the line is bounded", () => {
    const w = exportWarningFromHeaders(
      H({
        [DATA_QUALITY_COUNT_HEADER]: "9",
        [DATA_QUALITY_SUMMARY_HEADER]: encodeURIComponent("issues=9; " + "A1 invented; ".repeat(80)),
        [CHART_FAILURE_COUNT_HEADER]: "3",
        [CHART_FAILURE_SAMPLE_HEADER]: encodeURIComponent("c1: fail; c2: fail; c3: fail"),
      }),
      200,
    );
    expect(w!.length).toBeLessThanOrEqual(200);
    expect(w).toContain("9 value decision(s)");
    expect(w).toContain("3 chart image(s) missing");
  });

  it("garbage headers never fabricate a warning and never crash (undecodable sample)", () => {
    expect(exportWarningFromHeaders(H({ [DATA_QUALITY_COUNT_HEADER]: "not-a-number" }))).toBeNull();
    // A count with an undecodable sample still warns (the count is the fact).
    const w = exportWarningFromHeaders(H({ [CHART_FAILURE_COUNT_HEADER]: "2", [CHART_FAILURE_SAMPLE_HEADER]: "100%zz" }));
    expect(w).toContain("2 chart image(s) missing");
  });
});

describe("the warning line is visible on the card", () => {
  it("renders a live status region with the exact text", () => {
    const html = renderToStaticMarkup(h(ExportWarningLine, { text: "Partial export — 1 chart image(s) missing: Sales: render failed" }));
    expect(html).toContain('data-testid="doc-card-warning"');
    expect(html).toContain('role="status"');
    expect(html).toContain("1 chart image(s) missing: Sales: render failed");
  });

  it("a complete export renders no line", () => {
    expect(renderToStaticMarkup(h(ExportWarningLine, { text: null }))).toBe("");
  });
});
