/**
 * PDF engine (PHASE 3): semantic HTML + inline SVG → real A4 PDF via
 * headless Chromium. Charts are screenshotted at deviceScaleFactor 2 for
 * DOCX/PPTX embedding. Temp HTML/PNG files are always deleted in finally.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBrowser } from "./browser";
import { buildPrintableHtml } from "./printCss";
import { safeName } from "./schemas";

export interface PdfResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
  pageCount: number;
}

async function settle(page: any): Promise<void> {
  try {
    await page.evaluate(() => (document as any).fonts?.ready ?? Promise.resolve());
  } catch { /* page may have navigated */ }
  await page.waitForTimeout(120);
}

/** Render HTML (fragment or full document) to an A4 PDF buffer. */
export async function renderPdf(html: string, filenameHint = "document"): Promise<PdfResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(buildPrintableHtml(html), { waitUntil: "networkidle", timeout: 45_000 });
    await settle(page);
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
    });
    const pageCount = await pdfPageCount(buffer);
    return { buffer, filename: safeName(filenameHint) + ".pdf", contentType: "application/pdf", pageCount };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Screenshot a self-contained chart HTML at 2x for image embedding.
 * Writes a temp self-contained HTML file (temp_chart_<uuid>.html) and
 * deletes it — plus any temp PNG — in the finally block.
 */
export async function renderChartPng(
  html: string,
  opts: { width: number; height: number; scale?: number },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const browser = await getBrowser();
  const id = crypto.randomUUID();
  // DOC_TEMP_DIR lets tests isolate their temp files from parallel runs.
  const tmpHtml = path.join(process.env.DOC_TEMP_DIR || os.tmpdir(), `temp_chart_${id}.html`);
  const page = await browser.newPage({
    viewport: { width: opts.width + 64, height: opts.height + 64 },
    deviceScaleFactor: opts.scale ?? 2,
  });
  try {
    await fs.writeFile(tmpHtml, html, "utf8");
    await page.goto("file:///" + tmpHtml.replace(/\\/g, "/"), { waitUntil: "networkidle", timeout: 30_000 });
    await settle(page);
    const el = (await page.$("#chart-root")) ?? (await page.$("body"));
    const box = el ? await el.boundingBox() : null;
    const buffer = await page.screenshot({ clip: box ?? undefined });
    return { buffer, width: box?.width ?? opts.width, height: box?.height ?? opts.height };
  } finally {
    await page.close().catch(() => {});
    await fs.rm(tmpHtml, { force: true });
  }
}

/** Page count via unpdf (works without a canvas). */
export async function pdfPageCount(buffer: Buffer): Promise<number> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  return Number(doc.numPages ?? 0);
}

// safeName lives in schemas.ts (client-safe) so the preview blocks compute the
// exact filename the server will send; re-exported here for existing importers.
export { safeName } from "./schemas";
