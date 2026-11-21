/**
 * F77: chart exports when the render temp path contains URL-special
 * characters (`#`, `%`, spaces, Unicode).
 *
 * ROOT CAUSE CLASS (the shared cause this file pins): the chart-screenshot
 * path turns a filesystem path into a `file://` URL by STRING CONCATENATION
 * ("file:///" + path with backslashes swapped), and the egress guard compares
 * request URLs against that same hand-built string. Under URL grammar the
 * concatenation is wrong for EVERY special character, not just `#`:
 *   `#`  -> fragment separator: Chromium navigates to a truncated path,
 *   `%`  -> percent-escape start: "%20" in a file NAME becomes a space,
 *   space / Unicode -> raw bytes in a URL: Chromium percent-encodes the
 *          navigated URL, so the guard's raw string never matches.
 * So navigation lands on the wrong file (or the guard refuses its own file)
 * and chart rendering fails. The universal fix is Node's own
 * `pathToFileURL(absolutePath).href` on BOTH sides — the navigation and the
 * exact file the guard permits — with the guard matching the canonicalized
 * URL exactly, never a prefix.
 *
 * These tests build the REAL artifacts through the production engines with
 * DOC_TEMP_DIR pointing at a directory whose name carries every one of those
 * characters, reopen the produced XLSX/DOCX/PPTX packages, and require the
 * chart CONTENT to be present — not just a returned file. The PDF path rides
 * `setContent` (no file URL) and is covered as a regression control.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { buildXlsx } from "@/lib/documents/xlsxEngine";
import { buildDocx } from "@/lib/documents/docxEngine";
import { buildPptx } from "@/lib/documents/pptxEngine";
import { renderPdf, renderChartPng } from "@/lib/documents/pdfEngine";
import { chartHtmlDocument } from "@/lib/documents/chartHtml";
import { isolateRenderPage } from "@/lib/documents/renderGuard";
import { withRenderBrowser } from "@/lib/documents/browser";

/** Directory name exercising every character class that breaks naive URLs. */
const SPECIAL_SEGMENT = "f77 #%cJK 中文-ñ#x";

let tempDir: string;
const had = Object.prototype.hasOwnProperty.call(process.env, "DOC_TEMP_DIR");
const previous = process.env.DOC_TEMP_DIR;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "f77_special_"));
  tempDir = path.join(base, SPECIAL_SEGMENT);
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.DOC_TEMP_DIR = tempDir;
});
afterEach(() => {
  if (had) process.env.DOC_TEMP_DIR = previous;
  else delete process.env.DOC_TEMP_DIR;
  fs.rmSync(path.dirname(tempDir), { recursive: true, force: true });
});

const chart = (type: string, name: string) => ({
  type,
  title: name,
  categories: ["Jan", "Feb", "Mar"],
  series: [{ name: "Value", data: [10, 25, 17] }],
});

describe("chart exports under a URL-special temp path", () => {
  it("renderChartPng produces a real PNG from a temp file under # % space Unicode", async () => {
    const html = chartHtmlDocument(
      { type: "bar", title: "Special Path Chart", categories: ["Jan", "Feb", "Mar"], series: [{ name: "Value", data: [10, 25, 17] }] },
      { width: 640, height: 360, theme: "light" },
    );
    const shot = await renderChartPng(html, { width: 640, height: 360, scale: 2 });
    expect(shot.buffer.length).toBeGreaterThan(1000); // real screenshot, not stub
    expect(shot.buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
  }, 60000);

  it("xlsx embeds all 3 chart images when the temp dir name contains # % space Unicode", async () => {
    const out = await buildXlsx({
      filename: "Special Path Charts",
      sheets: [
        {
          name: "Dashboard",
          columns: [
            { key: "m", label: "Month", format: "text" },
            { key: "v", label: "Value", format: "number" },
          ],
          rows: [
            { m: "Jan", v: 10 },
            { m: "Feb", v: 25 },
            { m: "Mar", v: 17 },
          ],
          charts: [chart("bar", "Alpha"), chart("line", "Beta"), chart("pie", "Gamma")],
        },
      ],
    });
    // A chart render failure must never be silent: zero failures is the contract.
    expect(out.chartFailures).toEqual([]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const images = wb.getWorksheet("Dashboard")!.getImages();
    // A workbook that "succeeds" with ZERO of the 3 expected chart images is
    // exactly the silent-incomplete-export defect; the count is the contract.
    expect(images.length).toBe(3);
  }, 120000);

  it("docx embeds both chart images when the temp dir name contains # % space Unicode", async () => {
    const out = await buildDocx({
      filename: "Special Path Report",
      title: "Special Path Report",
      sections: [
        { type: "heading", level: 1, text: "Charts" },
        { type: "chart", title: "Quarterly Revenue", chart: chart("bar", "Quarterly Revenue") },
        { type: "chart", title: "Share", chart: chart("donut", "Share") },
      ],
    });
    const zip = unzipSync(new Uint8Array(out.buffer));
    const media = Object.keys(zip).filter((n) => n.startsWith("word/media/") && n.endsWith(".png"));
    expect(media.length).toBe(2);
    for (const m of media) expect(zip[m].length).toBeGreaterThan(1000);
  }, 120000);

  it("pptx keeps its native chart and its Chromium-rendered artwork under the special temp path", async () => {
    const out = await buildPptx({
      filename: "Special Path Deck",
      title: "Special Path Deck",
      tier: "insane",
      slides: [
        { layout: "title", title: "Special Path Deck", subtitle: "", bullets: [], stats: [] },
        // stats slide must NOT be slide 0: the Morph-gated Chromium-rendered
        // gradient fill only applies to transitioning (i > 0) slides.
        { layout: "stats", title: "Momentum", subtitle: "", bullets: [], stats: [{ label: "Revenue", value: "$4.2M" }] },
        { layout: "chart", title: "Adoption", subtitle: "", bullets: [], stats: [], chart: chart("line", "Adoption") },
      ],
    });
    const zip = unzipSync(new Uint8Array(out.buffer));
    const chartXml = Object.keys(zip).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    expect(chartXml.length).toBe(1); // native chart survives
    const media = Object.keys(zip).filter((n) => n.startsWith("ppt/media/") && n.endsWith(".png"));
    expect(media.length).toBeGreaterThanOrEqual(1); // Chromium gradient artwork present
  }, 120000);

  it("renderPdf (setContent path) is unaffected: chart HTML prints to a real PDF", async () => {
    const html = chartHtmlDocument(
      { type: "bar", title: "Pdf Control", categories: ["Jan", "Feb"], series: [{ name: "V", data: [3, 4] }] },
      { width: 640, height: 360, theme: "light" },
    );
    const out = await renderPdf(`<div>${html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? html}</div>`, "Special Pdf");
    expect(out.buffer.length).toBeGreaterThan(1000);
    expect(out.pageCount).toBeGreaterThanOrEqual(1);
  }, 120000);

  it("the guard permits the exact special-path file it was given and still blocks an unrelated local file", async () => {
    const own = path.join(tempDir, "own_chart.html");
    const other = path.join(tempDir, "secret_other.html");
    fs.writeFileSync(own, "<!doctype html><html><body><div id=\"chart-root\">own</div></body></html>", "utf8");
    fs.writeFileSync(other, "<!doctype html><html><body>SECRET-F77-MARKER</body></html>", "utf8");

    await withRenderBrowser(async (browser) => {
      const page = await browser.newPage();
      try {
        const guard = await isolateRenderPage(page, { allowLocalFile: own });
        await page.goto(pathToFileURL(own).href, { waitUntil: "domcontentloaded" });
        expect(await page.textContent("#chart-root")).toBe("own"); // own file loads
        expect(guard.blocked()).toBe(0); // the permitted file is NOT blocked
        await expect(
          page.goto(pathToFileURL(other).href, { waitUntil: "domcontentloaded" }),
        ).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT|net::/);
        expect(guard.blocked()).toBeGreaterThanOrEqual(1); // unrelated file refused
      } finally {
        await page.close().catch(() => {});
      }
    });
  }, 60000);
});
