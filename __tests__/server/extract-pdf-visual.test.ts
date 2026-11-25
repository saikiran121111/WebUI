/**
 * F78 family E - PDF pages whose CONTENT is drawn (vector chart/diagram paint
 * operations counted in the page's own content streams) are rendered by the
 * capability reader and delivered as page-image FRAMES, so a chart question
 * ("which reservoir dropped more?") reaches the model even when the text layer
 * extracts cleanly - the text layer of a chart page carries only its labels.
 *
 * Laws:
 *  1. payload visual_pages become result frames with `at` = the 1-based PDF page
 *     number (frames' `at` is polymorphic by design; consumers pairing frames with
 *     time windows check the category first), each labelled `page N` (F152: an
 *     indexed frame must be self-describing once it rides alone);
 *  2. no visual pages (an ordinary text PDF) -> NO frames key at all, never an
 *     empty array pretending to be evidence;
 *  3. malformed visual entries (page <= 0, missing png) drop individually, never
 *     the document;
 *  4. frames are ADDITIVE: the text merge (both-readers law) stays intact.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { DOCUMENT_PARSE_CAPABILITY, type MlJobEnvelope, type RunJob } from "../../lib/server/extract/document-capability";
import { extractFileFromPath } from "../../lib/server/extract";

// Real 1x1 PNG bytes; the reader ships page rasters as base64 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const pdfEnvelope = (visualPages: unknown[]): MlJobEnvelope =>
  ({
    state: "ready",
    capability: DOCUMENT_PARSE_CAPABILITY,
    job_id: "job_f78e", run_id: "run_f78e", request_id: "req_f78e", deadline_s: 90,
    source: "rust-ml-job",
    result: {
      payload: {
        coverage_complete: true,
        document: {
          kind: "pdf",
          blocks: [
            {
              text: "Reservoir measurements\nWest East",
              kind: "page_text",
              loc: { page: 1, rotation: 0, extraction: "pypdf-plain" },
            },
          ],
          coverage: {
            method: "pypdf-7.1.0-plain",
            note: "1/1 pages produced a text layer",
            units_total: 1, units_extracted: 1,
            units_succeeded: [1], units_empty: [], units_needing_ocr: [], units_failed: [],
          },
          meta: { page_numbering: "1-based", pages_with_visual: { "1": 2 } },
          source_id: "plot-a.pdf", source_hash: "h",
        },
        ocr: { ran: false, pages: [], engines_recognised: {} },
        visual_pages: visualPages,
        visual_note: visualPages.length
          ? "1 page image(s) rendered for pages whose content is drawn (vector chart/diagram marks the text layer cannot carry); `page` is the 1-based PDF page index"
          : "",
      },
      coverage: { units: "pages", total_source: 1, complete: true, note: "" },
    },
  }) as unknown as MlJobEnvelope;

const runJobReturning = (envelope: MlJobEnvelope | null): RunJob =>
  (async () => envelope) as RunJob;

const scratch = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f78vis_"));
  const p = path.join(dir, name);
  // Not a parseable PDF: pdf.js fails, and the ready capability drives the merge -
  // the same shape as a pdf.js-less read of a real chart file on a worker host.
  fs.writeFileSync(p, Buffer.from("%PDF-1.7 not a real pdf\n"));
  return p;
};

describe("extractFileFromPath - drawn-content PDF pages deliver page-image frames", () => {
  it("visual_pages become frames with at = the 1-based page, PNG data URLs", async () => {
    const src = scratch("plot-a.pdf");
    const r = await extractFileFromPath("plot-a.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(pdfEnvelope([{ page: 1, ops: 2, png_base64: PNG_B64, width: 1240, height: 1754, dpi: 150 }])),
    });
    expect(r.category).toBe("pdf");
    expect(r.text).toContain("Reservoir measurements"); // the text merge is untouched
    // F152: document frames are self-describing — each carries its unit label.
    expect(r.frames).toEqual([{ dataUrl: `data:image/png;base64,${PNG_B64}`, at: 1, label: "page 1" }]);
  });

  it("a text-only PDF (no visual_pages) carries NO frames key at all", async () => {
    const src = scratch("report.pdf");
    const r = await extractFileFromPath("report.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(pdfEnvelope([])),
    });
    expect(r.frames).toBeUndefined();
  });

  it("malformed visual entries drop individually; valid entries survive", async () => {
    const src = scratch("plot-b.pdf");
    const r = await extractFileFromPath("plot-b.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(pdfEnvelope([
        { page: 0, ops: 9, png_base64: PNG_B64 },   // page 0 is not a page id
        { page: 2, ops: 3 },                          // no png: not evidence
        null,
        { page: 3, ops: 2, png_base64: PNG_B64 },
      ])),
    });
    expect(r.frames).toEqual([{ dataUrl: `data:image/png;base64,${PNG_B64}`, at: 3, label: "page 3" }]);
  });

  it("frames reach the reader through the real payload field names (visual_pages)", async () => {
    // normalizeDocument is the contract seam: the python key is visual_pages
    // (page, ops, png_base64) and the typed field is visualPages (page, ops, dataUrl).
    const src = scratch("plot-c.pdf");
    const r = await extractFileFromPath("plot-c.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(pdfEnvelope([{ page: 7, ops: 4, png_base64: PNG_B64 }])),
    });
    expect(r.frames?.[0]?.at).toBe(7);
    expect(r.frames?.[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});
