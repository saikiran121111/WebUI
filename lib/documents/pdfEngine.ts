/**
 * PDF engine (PHASE 3): semantic HTML + inline SVG → real A4 PDF via
 * headless Chromium. Charts are screenshotted at deviceScaleFactor 2 for
 * DOCX/PPTX embedding. Temp HTML/PNG files are always deleted in finally.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withRenderBrowser } from "./browser";
import { buildPrintableHtml } from "./printCss";
import { chartPageGuardOptions, isolateRenderPage } from "./renderGuard";
import { safeName } from "./schemas";
import { docTempPath } from "./tempFiles";

export interface PdfResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
  pageCount: number;
  /**
   * Requests the render tried to make that the egress guard refused
   * (lib/documents/renderGuard.ts). Surfaced as `x-pdf-blocked-requests` by the
   * PDF route: an export that silently tried to phone home stays observable
   * without ever logging the artifact's contents or the URLs it reached for.
   */
  blockedRequests: number;
}

async function settle(page: any): Promise<void> {
  try {
    await page.evaluate(() => (document as any).fonts?.ready ?? Promise.resolve());
  } catch { /* page may have navigated */ }
  await page.waitForTimeout(120);
}

/**
 * Render HTML (fragment or full document) to an A4 PDF buffer.
 *
 * The `html` here can be RAW MODEL OUTPUT (the ```html artifact's "Export as PDF"
 * button posts the fence body verbatim), so the page is guarded before any
 * content exists — see lib/documents/renderGuard.ts. `offline: true` is on top
 * of the route guard because Playwright's route layer never sees a WebSocket or
 * EventSource handshake; offline mode denies those at the network stack, which
 * also removes the `waitUntil:"networkidle"` stall a hanging socket used to cause.
 */
export async function renderPdf(html: string, filenameHint = "document"): Promise<PdfResult> {
  return withRenderBrowser(async (browser) => {
    // F21: page creation and the egress guard are INSIDE the try. They used to
    // sit outside it, so a guard that threw (route setup rejected, context
    // died) returned without ever closing the page — a leak per failed export.
    let page: import("playwright").Page | undefined;
    try {
      page = await browser.newPage({ offline: true });
      const guard = await isolateRenderPage(page);
      await page.setContent(buildPrintableHtml(html), { waitUntil: "networkidle", timeout: 45_000 });
      await settle(page);
      const buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
      });
      const pageCount = await pdfPageCount(buffer);
      return {
        buffer,
        filename: safeName(filenameHint) + ".pdf",
        contentType: "application/pdf",
        pageCount,
        blockedRequests: guard.blocked(),
      };
    } finally {
      await page?.close().catch(() => {});
    }
  });
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
  // The temp file is named before the lease so it is always removable, even if
  // acquiring the browser fails. DOC_TEMP_DIR isolates these files from
  // parallel runs; the shared helper is also what keeps `next build` from
  // turning this path into a glob over the OS temp directory (see
  // lib/documents/tempFiles.ts).
  const id = crypto.randomUUID();
  const tmpHtml = docTempPath(id, ".html");
  try {
    return await withRenderBrowser(async (browser) => {
      let page: import("playwright").Page | undefined;
      try {
        page = await browser.newPage({
          viewport: { width: opts.width + 64, height: opts.height + 64 },
          deviceScaleFactor: opts.scale ?? 2,
        });
        // The chart document is first-party inline SVG (lib/documents/chartHtml.ts,
        // no <script>), but it is still rendered with a guard: only its OWN temp file
        // may load, so a chart HTML that ever becomes model-influenced cannot fetch
        // loopback or WAN resources either.
        await isolateRenderPage(page, chartPageGuardOptions(tmpHtml));
        await fs.writeFile(tmpHtml, html, "utf8");
        // pathToFileURL (NOT string concatenation) is the same canonical form
        // the guard compares against, so navigation and permission agree for
        // every path — including ones containing #, %, spaces and Unicode.
        await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: "networkidle", timeout: 30_000 });
        await settle(page);
        const el = (await page.$("#chart-root")) ?? (await page.$("body"));
        const box = el ? await el.boundingBox() : null;
        const buffer = await page.screenshot({ clip: box ?? undefined });
        return { buffer, width: box?.width ?? opts.width, height: box?.height ?? opts.height };
      } finally {
        await page?.close().catch(() => {});
      }
    });
  } finally {
    await fs.rm(tmpHtml, { force: true });
  }
}

/** Page count via unpdf (works without a canvas). */
export async function pdfPageCount(buffer: Buffer): Promise<number> {
  const { getDocumentProxy } = await import("unpdf");
  // F21: every export called this and NEVER released the proxy. unpdf hands a
  // PDFDocumentProxy holding the parsed document, so page counting leaked one
  // parsed copy of every generated PDF for the life of the process.
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  type Destroyable = { destroy?: () => unknown };
  try {
    return Number(doc.numPages ?? 0);
  } finally {
    try {
      // Older unpdf builds have no destroy(); the cast is a capability probe,
      // not a claim that the pinned type has the method.
      await (doc as unknown as Destroyable).destroy?.();
    } catch {
      /* already released / older unpdf build without destroy */
    }
  }
}

// safeName lives in schemas.ts (client-safe) so the preview blocks compute the
// exact filename the server will send; re-exported here for existing importers.
export { safeName } from "./schemas";
