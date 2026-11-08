/**
 * I06 — PDF text-layer coverage honesty (lib/server/extract/index.ts + pdf.ts).
 *
 * Before the fix a 12-page PDF with text on 2 pages returned those 2 pages'
 * text and NOTHING else — the model happily answered questions about the 10
 * scanned pages it was never shown. These tests lock: a coverage line naming
 * exactly which pages carry NO text layer, an all-scanned PDF refusing loudly
 * (and pointing at the vision path that CAN read them), and single-layer PDFs
 * staying quiet (no noise when nothing is missing).
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractFileFromPath } from "../../lib/server/extract";
import { makePdf } from "./make-pdf";

const SCRATCH = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "pdfcov_"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const write = (name: string, buf: Buffer): string => {
  const p = path.join(SCRATCH, name);
  fs.writeFileSync(p, buf);
  return p;
};

describe("PDF coverage — I06", () => {
  it("names the image-only pages IN THE INDEXED TEXT, not just in the response", async () => {
    const src = write("mixed.pdf", makePdf(["PDF-ONE-LAYER-TEXT", null]));
    const r = await extractFileFromPath("mixed.pdf", src);
    expect(r.category).toBe("pdf");
    expect(r.pages).toBe(2);
    expect(r.text).toContain("PDF-ONE-LAYER-TEXT");
    expect(r.text).toContain(
      "[PDF coverage: 1 of 2 page(s) carry a text layer; image-only (scanned) pages: 2 — those pages are NOT readable here (no OCR engine)]",
    );
  }, 60_000);

  it("an all-scanned PDF refuses loudly and points at the vision path", async () => {
    const src = write("scan.pdf", makePdf([null, null]));
    await expect(extractFileFromPath("scan.pdf", src)).rejects.toThrow(
      /has no text layer — all 2 page\(s\) are scanned images/,
    );
    await expect(extractFileFromPath("scan.pdf", src)).rejects.toThrow(/vision model can read it/);
  }, 60_000);

  it("a full-text PDF gets NO coverage noise", async () => {
    const src = write("clean.pdf", makePdf(["EVERY-PAGE-HAS-TEXT-QX"]));
    const r = await extractFileFromPath("clean.pdf", src);
    expect(r.text).toContain("EVERY-PAGE-HAS-TEXT-QX");
    expect(r.text).not.toContain("PDF coverage");
  }, 60_000);

  it("many scanned pages collapse to a count instead of a 500-page list", async () => {
    // 1 text page + 16 scanned pages: the scanned list is too long to print,
    // so it collapses to a count (the <=15 rule in index.ts).
    const pages: (string | null)[] = ["MIXED-BORDER-MARKER", ...Array.from({ length: 16 }, () => null)];
    const src = write("many.pdf", makePdf(pages));
    const r = await extractFileFromPath("many.pdf", src);
    expect(r.text).toContain("image-only (scanned) pages: 16 pages —");
    expect(r.text).toContain("1 of 17 page(s) carry a text layer");
  }, 60_000);
});
