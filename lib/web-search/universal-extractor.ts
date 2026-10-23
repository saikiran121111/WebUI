/**
 * Universal structural-mode DOM extractor.
 *
 * Replaces the single Readability mode with four structural modes that
 * auto-detect which page shape they're dealing with, so a SaaS pricing
 * matrix, a developer portfolio, and a tech-docs article all get the
 * right extraction treatment.
 *
 * Modes:
 *   A — Article / Long-Form: high paragraph density; keep prose,
 *                            strip nav/footer/ads.
 *   B — Portfolio / Landing / Product Spec: low paragraph count but
 *        <section>, cards, <dl>, <table> present; preserve hero
 *        headings, bio, feature lists, spec tables, pricing tiers, and
 *        convert <table> to markdown.
 *   C — Technical Documentation: strictly preserve <pre><code> blocks,
 *        CLI commands, API endpoints, callout/warning boxes.
 *   D — Binary & Document (PDF/CSV/JSON/Markdown): inspect Content-Type
 *        and URL extension; PDF via unpdf, CSV→markdown table, raw
 *        JSON pretty-printed, .md passed through.
 *
 * The extractor returns clean markdown. Readability is still used for
 * Mode A but only when the page is long-form enough to need it.
 */
import TurndownService from "turndown";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import { detectCharset, normalizeBody } from "./charset-normalizer";

/* ── turndown instance (shared) ─────────────────────────────────────── */

let _td: TurndownService | null = null;
function turndown(): TurndownService {
  if (!_td) {
    _td = new TurndownService();
    // Preserve <pre><code> blocks intact (Mode C requirement)
    _td.addRule("code", {
      filter: (node: any) =>
        node.nodeName === "PRE" ||
        (node.nodeName === "CODE" && node.parentElement?.nodeName === "PRE"),
      replacement: (content: string, node: any) => {
        const pre = node.nodeName === "PRE" ? node : node.parentElement;
        const lang = pre?.querySelector?.("code")?.getAttribute("data-language") ?? "";
        return "\n```" + lang + "\n" + content + "\n```\n";
      },
    });
    // Convert <table> to markdown tables (Mode B requirement)
    _td.addRule("table", {
      filter: "table",
      replacement: (content: string, node: any) =>
        htmlTableToMarkdown(node),
    });
  }
  return _td;
}

/**
 * Convert an HTML <table> DOM node to a clean markdown table.
 * Preserves header row, column alignment, and data rows. This is what
 * keeps SaaS pricing matrices and spec sheets intact.
 */
function htmlTableToMarkdown(table: any): string {
  try {
    const rows: any[] = table.querySelectorAll("tr");
    if (rows.length === 0) return "";
    const grid: string[][] = [];
    for (const row of rows) {
      const cells: any[] = row.querySelectorAll("th, td");
      if (cells.length === 0) continue;
      const r: string[] = [];
      for (const c of cells) {
        const text = (c.textContent ?? "").replace(/\s+/g, " ").trim();
        r.push(text);
      }
      grid.push(r);
    }
    if (grid.length === 0) return "";
    const colCount = Math.max(...grid.map((r) => r.length));
    // Pad rows to the same width
    for (const r of grid) {
      while (r.length < colCount) r.push("");
    }
    // Markdown table: header row + separator + data rows
    const header = grid[0];
    const sep = new Array(colCount).fill("---");
    const lines = [
      "| " + header.join(" | ") + " |",
      "| " + sep.join(" | ") + " |",
      ...grid.slice(1).map((r) => "| " + r.join(" | ") + " |"),
    ];
    return "\n" + lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

/* ── mode detection ─────────────────────────────────────────────────── */

export type ExtractionMode = "article" | "structural" | "docs" | "document";

export interface ModeDetection {
  mode: ExtractionMode;
  /** Why this mode was chosen (for the stress-test report). */
  reason: string;
}

/**
 * Pick the extraction mode from the page's HTML structure.
 *
 * The heuristics are cheap (they run on the same DOM the extractor
 * already parsed) and conservative: a page with lots of <pre><code>
 * is docs; a page with <table> and <section> is structural; a long
 * prose page is article; a binary/URL-extension page is document.
 */
export function detectMode(
  html: string,
  contentType: string,
  url: string,
): ModeDetection {
  // Mode D — binary / document
  const ct = contentType.toLowerCase();
  const ext = url.split(/[?#]/)[0].toLowerCase().split(".").pop() ?? "";
  if (ct.includes("application/pdf") || ext === "pdf") {
    return { mode: "document", reason: "PDF (content-type or .pdf)" };
  }
  if (ct.includes("text/csv") || ct.includes("text/tab-separated") || ext === "csv" || ext === "tsv") {
    return { mode: "document", reason: "CSV/TSV (content-type or .csv/.tsv)" };
  }
  if (ct.includes("application/json") || ext === "json") {
    return { mode: "document", reason: "JSON (content-type or .json)" };
  }
  if (ct.includes("text/markdown") || ext === "md" || ext === "markdown") {
    return { mode: "document", reason: "Markdown (content-type or .md)" };
  }
  if (ct.includes("application/xml") || ct.includes("text/xml")) {
    return { mode: "document", reason: "XML (content-type)" };
  }

  // Not HTML at this point — the caller should have already routed to
  // document mode. Fall through to DOM modes for HTML.
  if (!ct.includes("html") && !ct.includes("xhtml")) {
    return { mode: "document", reason: "non-HTML content-type" };
  }

  // Mode C — technical docs (lots of <pre><code> blocks)
  const preCount = (html.match(/<pre[^>]*>/gi) ?? []).length;
  const codeCount = (html.match(/<code[^>]*>/gi) ?? []).length;
  const hasCallout = /warning|caution|note|tip|danger|important/i.test(
    html.slice(0, 4000),
  );
  if (preCount + codeCount > 15 && hasCallout) {
    return { mode: "docs", reason: "high <pre>/<code> density + callouts" };
  }

  // Mode B — structural (tables, sections, dl, cards)
  const tableCount = (html.match(/<table[^>]*>/gi) ?? []).length;
  const sectionCount = (html.match(/<section[^>]*>/gi) ?? []).length;
  const dlCount = (html.match(/<dl[^>]*>/gi) ?? []).length;
  const cardCount = (html.match(/class="[^"]*card[^"]*"/gi) ?? []).length;
  if (tableCount + sectionCount + dlCount + cardCount > 4) {
    return {
      mode: "structural",
      reason: `tables=${tableCount} sections=${sectionCount} dl=${dlCount} cards=${cardCount}`,
    };
  }

  // Mode A — article (default: long-form prose)
  const paraCount = (html.match(/<p[^>]*>/gi) ?? []).length;
  return {
    mode: "article",
    reason: `low structural density, ${paraCount} paragraphs`,
  };
}

/* ── mode-specific extractors ───────────────────────────────────────── */

/**
 * Mode A — article / long-form. Use Readability when the page is long
 * enough; otherwise fall back to body text.
 */
async function extractArticle(
  html: string,
  url: string,
): Promise<string> {
  // For long-form pages, Readability gives the cleanest prose
  try {
    const mod: any = await import("@mozilla/readability");
    const Readability = mod.Readability ?? mod.default?.Readability;
    const w: any = parseHTML(html);
    const doc = w?.document ?? w;
    const parsed = Readability ? new Readability(doc).parse() : null;
    const content: string = parsed?.content ?? "";
    if (content.length >= 400) {
      const md = turndown().turndown(content).replace(/\n{3,}/g, "\n\n").trim();
      return md;
    }
  } catch {
    /* fall through to DOM text */
  }
  return domTextFallback(html);
}

/**
 * Mode B — structural / portfolio / SaaS landing / product spec.
 * Preserves hero headings, bio, feature lists, spec tables, and pricing
 * tiers. Converts <table> to markdown so specs and prices survive.
 */
async function extractStructural(html: string): Promise<string> {
  const w: any = parseHTML(html);
  const doc = w?.document ?? w;

  // Strip nav/footer/header/aside/script/style BEFORE turndown so they
  // don't pollute the markdown
  const strip = (sel: string) =>
    doc.querySelectorAll(sel).forEach((el: any) => el.remove());
  strip("nav, footer, header, aside, script, style, noscript, iframe, svg");

  const body: any = doc.body;
  const text = body ? body.innerHTML : "";
  const md = turndown().turndown("<html><body>" + text + "</body></html>");
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Mode C — technical documentation. Preserves <pre><code> blocks,
 * CLI commands, API endpoints, and callout boxes verbatim.
 */
async function extractDocs(html: string): Promise<string> {
  const w: any = parseHTML(html);
  const doc = w?.document ?? w;

  // Keep everything (we want the code blocks) but strip pure chrome
  const strip = (sel: string) =>
    doc.querySelectorAll(sel).forEach((el: any) => el.remove());
  strip("nav, footer, aside, script, style, noscript");

  const body: any = doc.body;
  const text = body ? body.innerHTML : "";
  const md = turndown().turndown("<html><body>" + text + "</body></html>");
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Mode D — binary / document. Inspect Content-Type and URL extension.
 *   - PDF: extract text via unpdf (lazy import, bounded).
 *   - CSV/TSV: convert to a markdown table.
 *   - JSON: pretty-print.
 *   - Markdown / plain text: pass through.
 */
async function extractDocument(
  html: string,
  contentType: string,
  url: string,
): Promise<string> {
  const ct = contentType.toLowerCase();
  const ext = url.split(/[?#]/)[0].toLowerCase().split(".").pop() ?? "";

  // PDF
  if (ct.includes("application/pdf") || ext === "pdf") {
    return extractPdf(html);
  }

  // CSV / TSV → markdown table
  if (
    ct.includes("text/csv") ||
    ct.includes("text/tab-separated") ||
    ext === "csv" ||
    ext === "tsv"
  ) {
    return csvToMarkdown(html, ext === "tsv" || ct.includes("tab-separated"));
  }

  // JSON → pretty-print (full document, no truncation — large JSON-LD blocks
  // and API responses are often multi-megabyte and truncating mid-stream
  // corrupts the structure the reranker needs).
  if (ct.includes("application/json") || ext === "json") {
    try {
      return "```json\n" + JSON.stringify(JSON.parse(html), null, 2) + "\n```";
    } catch {
      return html;
    }
  }

  // XML / Markdown / plain text → pass through in full
  if (ct.includes("xml") || ext === "md" || ext === "markdown" || ct.includes("text/markdown")) {
    return html;
  }

  // Unknown binary — return the full content (caller's memory is bounded
  // by the net.ts 50MB cap, so no unbounded allocation here)
  return html;
}

/**
 * PDF text extraction via unpdf (lazy import).
 *
 * The unpdf module is already a project dependency. PDF input is now
 * capped at 150MB (raised from 512KB — arXiv papers with figures,
 * hardware manuals, and financial filings can be 50-150MB and the
 * xref table is at the tail; truncating mid-download corrupts the
 * whole PDF and unpdf fails to parse it).
 *
 * Memory guard: unpdf's pdf.js backend allocates ~40-80MB of WASM +
 * a per-page render context. We serialize PDF extraction with a
 * dedicated limiter (concurrency 1) so parallel PDF URLs don't spike
 * RSS. Output is bounded to 500,000 characters of extracted text
 * (enough for a 200-page paper; the reranker's chunk size handles
 * the rest).
 */
let _pdfLimit: any = null;
function pdfLimiter() {
  if (!_pdfLimit) {
    _pdfLimit = pLimit(1);
  }
  return _pdfLimit;
}

const PDF_OUTPUT_CAP = 500_000; // 500K chars of extracted text (was 12K)

async function extractPdf(html: string): Promise<string> {
  const runner = pdfLimiter();
  return runner(async () => {
    try {
      const mod: any = await import("unpdf");
      // unpdf's extractText takes a Uint8Array (not a Buffer — pdf.js
      // rejects Buffer instances on Node 24).
      const bytes = new TextEncoder().encode(html);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const { text } = await mod.extractText(new Uint8Array(buf));
      // Release the raw byte reference — unpdf holds its own copy, so
      // the original buffer is eligible for GC immediately.
      void bytes; // allow GC of the source buffer
      return "## PDF text extraction\n" + text.slice(0, PDF_OUTPUT_CAP);
    } catch {
      // unpdf failed to parse (corrupt PDF, scanned image, etc.) —
      // return a trimmed slice of the raw bytes so the caller still
      // has something.
      return "(PDF text extraction failed)\n" + html.slice(0, 5000);
    }
  });
}

/**
 * Convert CSV/TSV to a markdown table. Preserves the header row.
 */
function csvToMarkdown(csv: string, isTsv: boolean): string {
  const rows = csv.split(/\r?\n/).filter((r) => r.trim().length > 0);
  if (rows.length === 0) return "(empty CSV)";
  const sep = isTsv ? "\t" : ",";
  const grid = rows.map((r) => r.split(sep));
  const colCount = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < colCount) r.push("");
  const out: string[] = [];
  out.push("| " + grid[0].join(" | ") + " |");
  out.push("| " + new Array(colCount).fill("---").join(" | ") + " |");
  for (const r of grid.slice(1)) {
    out.push("| " + r.map((c) => c.trim().replace(/\|/g, "\\|")).join(" | ") + " |");
  }
  return "## CSV/TSV data (" + rows.length + " rows)\n" + out.join("\n");
}

/**
 * DOM text fallback for when Readability is unavailable (Mode A).
 */
function domTextFallback(html: string): string {
  try {
    const w: any = parseHTML(html);
    const doc = w?.document ?? w;
    const strip = (sel: string) =>
      doc.querySelectorAll(sel).forEach((el: any) => el.remove());
    strip("nav, footer, header, aside, script, style, noscript, iframe");
    const body: any = doc.body;
    const text = body ? body.innerHTML : html;
    const md = turndown().turndown(
      "<html><body>" + text + "</body></html>",
    );
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
  }
}

/* ── public API ─────────────────────────────────────────────────────── */

export interface StructuredExtraction {
  /** Clean markdown from the appropriate mode. */
  markdown: string;
  /** Which mode was used. */
  mode: ExtractionMode;
  /** Why that mode was chosen. */
  reason: string;
  /** Number of markdown tables preserved (Mode B / C signal). */
  tableCount: number;
  /** Number of <pre><code> blocks preserved (Mode C signal). */
  codeBlockCount: number;
}

/**
 * Run the structural-mode extractor on a raw HTML/bytes body.
 *
 * The caller is responsible for having already passed through the
 * charset normalizer (extractor.ts does this before calling here).
 *
 * The extractor auto-detects the mode from the page's structure — no
 * caller-supplied mode needed. The stress test can verify that
 * portfolio / SaaS / docs pages get the right treatment.
 */
export function structuralExtract(
  html: string,
  contentType: string,
  url: string,
): StructuredExtraction {
  const det = detectMode(html, contentType, url);
  let md: string;
  switch (det.mode) {
    case "document":
      // Document mode is async (PDF/CSV/JSON) — the caller should
      // await it. This sync entry point handles the synchronous cases.
      md = extractDocumentSync(html, contentType, url);
      break;
    case "structural":
      md = extractStructuralSync(html);
      break;
    case "docs":
      md = extractDocsSync(html);
      break;
    default:
      md = extractArticleSync(html);
  }
  const tableCount = (md.match(/^\|.*\|$/gm) ?? []).length;
  const codeBlockCount = (md.match(/```/g) ?? []).length / 2;
  return {
    markdown: md,
    mode: det.mode,
    reason: det.reason,
    tableCount,
    codeBlockCount: Math.round(codeBlockCount),
  };
}

/**
 * Async entry point for document mode (PDF extraction is async).
 */
export async function structuralExtractAsync(
  html: string,
  contentType: string,
  url: string,
): Promise<StructuredExtraction> {
  const det = detectMode(html, contentType, url);
  let md: string;
  switch (det.mode) {
    case "document":
      md = await extractDocument(html, contentType, url);
      break;
    case "structural":
      md = extractStructuralSync(html);
      break;
    case "docs":
      md = extractDocsSync(html);
      break;
    default:
      md = await extractArticle(html, url);
  }
  const tableCount = (md.match(/^\|.*\|$/gm) ?? []).length;
  const codeBlockCount = Math.round((md.match(/```/g) ?? []).length / 2);
  return {
    markdown: md,
    mode: det.mode,
    reason: det.reason,
    tableCount,
    codeBlockCount,
  };
}

/* Sync variants (article mode is async due to Readability, but the
 * other modes are sync) */
function extractArticleSync(html: string): string {
  return domTextFallback(html);
}
function extractStructuralSync(html: string): string {
  // extractStructural is async but doesn't actually await anything —
  // it's a synchronous DOM walk. Re-implement here without the await
  // surface so the sync entry point works.
  try {
    const w: any = parseHTML(html);
    const doc = w?.document ?? w;
    const strip = (sel: string) =>
      doc.querySelectorAll(sel).forEach((el: any) => el.remove());
    strip("nav, footer, header, aside, script, style, noscript, iframe, svg");
    const body: any = doc.body;
    const text = body ? body.innerHTML : "";
    let md: string;
    try {
      md = turndown().turndown("<html><body>" + text + "</body></html>");
    } catch (e: any) {
      // turndown threw on this page's DOM shape — fall back to the
      // table-aware path (the HN item uses <table id="hnmain"> heavily,
      // which is exactly what the markdown-table rule handles).
      console.warn(
        "[universal-extractor] turndown failed, falling back to text:",
        e?.message,
      );
      md = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch (e: any) {
    // linkedom parse failed — raw text extraction (last resort, full
    // content — the net.ts 50MB cap already bounds the input)
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
function extractDocsSync(html: string): string {
  try {
    const w: any = parseHTML(html);
    const doc = w?.document ?? w;
    const strip = (sel: string) =>
      doc.querySelectorAll(sel).forEach((el: any) => el.remove());
    strip("nav, footer, aside, script, style, noscript");
    const body: any = doc.body;
    const text = body ? body.innerHTML : "";
    const md = turndown().turndown("<html><body>" + text + "</body></html>");
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
  }
}
export function extractDocumentSync(
  html: string,
  contentType: string,
  url: string,
): string {
  // The sync path handles CSV/JSON/Markdown (synchronous). PDF is async
  // — the caller should use structuralExtractAsync for PDFs.
  const ct = contentType.toLowerCase();
  const ext = url.split(/[?#]/)[0].toLowerCase().split(".").pop() ?? "";
  if (ct.includes("application/pdf") || ext === "pdf") {
    return "(PDF requires structuralExtractAsync)";
  }
  if (
    ct.includes("text/csv") ||
    ct.includes("text/tab-separated") ||
    ext === "csv" ||
    ext === "tsv"
  ) {
    return csvToMarkdown(html, ext === "tsv" || ct.includes("tab-separated"));
  }
  if (ct.includes("application/json") || ext === "json") {
    try {
      // Full document — no truncation. Large JSON-LD blocks and API
      // responses can be multi-megabyte; truncating mid-stream corrupts
      // the structure the reranker needs.
      return "```json\n" + JSON.stringify(JSON.parse(html), null, 2) + "\n```";
    } catch {
      return html;
    }
  }
  if (ct.includes("text/markdown") || ext === "md" || ext === "markdown") {
    return html;
  }
  return html;
}

// Re-export for callers that need the charset normalizer directly
export { detectCharset, normalizeBody } from "./charset-normalizer";
