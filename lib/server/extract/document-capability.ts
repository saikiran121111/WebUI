/**
 * document-capability.ts - the PRODUCTION CALLER for the Python `documents.parse` job.
 *
 * Why this module exists: the capability backend could already run a real PDF/XLSX/
 * DOCX/PPTX extraction (ruke_ml/workers/document_jobs.py, pypdf 7.1.0), and the Rust
 * server already exposed POST /api/ruke/ml/job for it, but NOTHING in the product ever
 * called it. A capability nobody calls is not a capability: the upload path kept reading
 * every document through the TS engines and every scanned page stayed unread.
 *
 * The rules this seam enforces (each one was a reproduced defect class somewhere in
 * this repo's history):
 *  1. NO SILENT SWAP. The TS engines (unpdf/pdf.js, the OOXML reader) stay in charge of
 *     any unit they already read. The capability engine may only FILL a unit the TS
 *     engine could not read, plus it supplies the per-page OCR cascade the TS engines
 *     do not have. For Office documents promotion is MEASURED by CONTENT COVERAGE
 *     (`measureContentCoverage`): the capability body may replace the TS body only when it
 *     carries every distinct content item the TS body carried AND adds something (new
 *     content or structure the TS body did not express). A raw character ratio was tried
 *     and is WRONG for spreadsheets: the TS reader repeats a merged block's value across
 *     the region it spans, so the ratio measured duplication and protected the weaker
 *     reader. Character counts are still reported in the note, never used as the decision.
 *  2. COVERAGE IS A SET OF UNIT IDS, NEVER A COUNT. readUnits/unreadUnits come from the
 *     pages the readers actually produced text for, so a page-2 hole stays a page-2 hole.
 *     Unit ids are 1-based everywhere (Python `page_numbering: 1-based`, Rust, TS, citations).
 *  3. PROVENANCE TRAVELS WITH THE TEXT. Every delivered unit says which engine read it
 *     and, for OCR, which engine version, language and engine-reported confidence.
 *     "OCR did not run" is written into the body, not hidden in a log.
 *  4. A DOCUMENT NO ENGINE COULD READ REFUSES, naming the real blocker (missing tool,
 *     missing language, corrupt file) and the vision path that CAN read a page image.
 *     An empty extraction is never a success.
 *  5. EVERY capability outcome is a TYPED state. `state: "none"` means this deployment
 *     has no capability route at all, which is exactly the pre-existing behaviour.
 *  6. A configured document language is explicit (RUKE_DOCUMENT_OCR_LANGUAGE) and is
 *     never defaulted to English; the backend refuses to pick one silently either.
 *
 * Cross-language contract: rust-backend/crates/ruke-server/src/ml_job.rs owns the path
 * law and the envelope; ruke_ml/workers/document_jobs.py owns the payload shape. The
 * real payloads recorded in docs/overnight/logs/f05-py-payload-1.log are the fixtures in
 * __tests__/server/extract-document-capability.test.ts.
 */
import path from "node:path";

import {
  mlJob,
  type MlJobEnvelope,
  type MlJobOptions,
} from "../ml-job";

export type { MlJobEnvelope, MlJobOptions } from "../ml-job";

export const DOCUMENT_PARSE_CAPABILITY = "documents.parse";

/** A document parse is bounded deliberately: it runs inside an upload request. */
export const DOCUMENT_PARSE_DEADLINE_MS = 90_000;

/** How many lost content items are named in the coverage note before it is summarised. */
export const LOST_ITEMS_NAMED = 6;

/**
 * Second-reader bar for ONE PAGE of a PDF. When the capability reader carries
 * materially more on a page the TS text layer already read, its text is appended
 * as a labelled VARIANT: the text layer is never replaced (law 4), and the extra
 * content is never silently discarded either. Two readers disagreeing on one page
 * is evidence; keeping only one reading hides it. Below this bar the variant is
 * dropped as a paraphrase of the same runs, so a good text layer costs no tokens.
 */
export const PDF_VARIANT_RATIO = 1.2;

/** Explicit operator configuration; never defaulted, never guessed per file. */
export const DOCUMENT_OCR_LANGUAGE_ENV = "RUKE_DOCUMENT_OCR_LANGUAGE";

/** The injectable job seam (same shape as the timeline module's runJob). */
export type RunJob = (
  capability: string,
  payload: Record<string, unknown>,
  opts?: MlJobOptions,
) => Promise<MlJobEnvelope | null>;

export interface CapabilityRequestOptions {
  runJob?: RunJob;
  signal?: AbortSignal;
  deadlineMs?: number;
  language?: string;
  /**
   * F152 targeted reread: region ids ("{kind}:{unit}:{part}") narrowing the
   * inspection to EXACTLY those regions — a closer read of one figure must not
   * re-inspect the others. Absent = inspect every eligible region.
   */
  regions?: string[];
}

export type UnitProvenance = "text-layer" | "text-layer-weak" | "ocr";

export interface CapabilityUnit {
  /** 1-based page / sheet / slide id; 0 means "the reader did not name a unit". */
  unit: number;
  text: string;
  provenance: UnitProvenance;
  engine: string;
  language: string;
  confidence: number | null;
}

export interface CapabilityOcrReport {
  ran: boolean;
  attempted: number;
  recognized: number;
  language: string;
  summary: string;
  reason: string;
  needsLanguage: boolean;
  /** What the engine actually did per unit, straight from the worker's own page rows. */
  pages: CapabilityOcrPage[];
  /** Engines the cascade consulted, in order tried (primary first, recovery last). */
  engines: string[];
  /** Recognised-unit counts keyed by the engine that read them. */
  enginesRecognised: Record<string, number>;
  /** Whether the PRIMARY engine was asset-ready for this run (recovery is not parity). */
  primaryReady: boolean;
  /** Where the language came from: request, document metadata, or none. */
  languageSource: string;
  /** Wall clock the recognition engines ran, from the cascade's own clock
   *  (item 5, user brief 2026-11-24). "" / null = a worker that recorded no clock. */
  recognition: { startedAt: string; finishedAt: string; wallS: number | null };
}

/** One unit's OCR outcome: recognised | empty | ocr_failed | raster_failed | skipped. */
export interface CapabilityOcrPage {
  unit: number;
  state: string;
  engine: string;
  detail: string;
  confidence: number | null;
  languageCode: string;
  /**
   * Page rotation the renderer actually applied, in degrees, from the raster the engine read.
   * Stated because a rotated scan is only "read" if the rotation was corrected first; a page
   * reference (page 1) must not silently become a different physical orientation.
   */
  rotation: number | null;
}

/**
 * A reader's OWN rendering of one unit, shipped beside the raw blocks. The blocks carry
 * coordinates and identity as structured `loc` data; the rendering is what a text reader
 * needs so that joining blocks does not silently drop cell references, merged ranges,
 * heading levels or table-row identity. `truncated` is stated by the reader, never inferred.
 */
export interface CapabilityRenderedUnit {
  unit: number;
  text: string;
  provenance: UnitProvenance;
  engine: string;
  blocks: number;
  truncated: boolean;
}

export interface CapabilityVisualPage {
  page: number;
  /** The extractor's count of drawn paint operations on this page. */
  ops: number;
  /** Rendered page image, PNG data URL (the reader bounded pages and total bytes). */
  dataUrl: string;
  /**
   * F152: for embedded-raster regions (office documents, standalone images) the
   * reader names the unit ("slide 1", "sheet 2, cell C4") and carries the stable
   * region id + the region's inspection state. PDF page renders have no label;
   * consumers fall back to "Page {page}".
   */
  label?: string;
  region?: string;
  region_state?: string;
}

export interface CapabilityDoc {
  kind: string;
  /** The extractor's own method string, e.g. "pypdf-7.1.0-plain". */
  engine: string;
  unitsTotal: number;
  unitsSucceeded: number[];
  unitsEmpty: number[];
  unitsNeedingOcr: number[];
  unitsFailed: number[];
  /** Units the backend's OWN assessment flagged for OCR. */
  ocrUnits: number[];
  complete: boolean;
  note: string;
  units: CapabilityUnit[];
  /** Structure-preserving per-unit rendering, when the reader provided one. */
  rendered: CapabilityRenderedUnit[];
  /**
   * Pages the extractor flagged as DRAWN content (vector chart/diagram paint operations
   * the text layer cannot carry), rendered to PNG by the reader on demand. A chart answer
   * routes through these page images; the flag is content-derived, never a name match.
   */
  visualPages: CapabilityVisualPage[];
  ocr: CapabilityOcrReport;
  meta: Record<string, unknown>;
}

export type CapabilityOutcome =
  | { state: "none" }
  | { state: "ready"; doc: CapabilityDoc }
  | { state: "unavailable"; reason: string; message: string; humanStep: string; retryable: boolean };

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;

const asNumber = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback;

/** Int list guard: anything malformed drops that entry, never the whole document. */
function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = asNumber(item, NaN as unknown as number);
    if (Number.isFinite(n) && n > 0) out.push(Math.trunc(n));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function normalizeUnitProvenance(kind: string, extraction: string): UnitProvenance {
  if (kind === "ocr_text") return "ocr";
  if (extraction.includes("weak")) return "text-layer-weak";
  return "text-layer";
}

/**
 * Turn the adapter payload into a typed document. Returns null when the envelope
 * claims success but carries nothing usable: treating that as "the document is
 * empty" is the false-success bug this module exists to prevent.
 */
export function normalizeDocument(result: unknown): CapabilityDoc | null {
  if (!result || typeof result !== "object") return null;
  const outer = result as Record<string, unknown>;
  const payload = outer.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const document = p.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const rawDoc = document as Record<string, unknown>;
  const coverage = (rawDoc.coverage && typeof rawDoc.coverage === "object" ? rawDoc.coverage : {}) as Record<string, unknown>;
  const meta = (rawDoc.meta && typeof rawDoc.meta === "object" ? rawDoc.meta : {}) as Record<string, unknown>;
  const blocks = Array.isArray(rawDoc.blocks) ? rawDoc.blocks : [];

  const unitsTotal = asNumber(coverage.units_total, 0);
  if (unitsTotal <= 0) return null;

  // Group blocks by the unit the reader named. A unit with two provenances (a weak
  // text layer plus OCR text on the same page) stays TWO entries: the merge layer
  // picks, and picking is visible.
  const grouped: CapabilityUnit[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const loc = (b.loc && typeof b.loc === "object" ? b.loc : {}) as Record<string, unknown>;
    const kind = asString(b.kind);
    const extraction = asString(loc.extraction);
    const unit = asNumber(loc.page ?? loc.slide ?? loc.sheet ?? loc.unit ?? 0, 0);
    const text = asString(b.text);
    if (!text.trim()) continue;
    const confidence = typeof b.confidence === "number" && Number.isFinite(b.confidence) ? b.confidence : null;
    grouped.push({
      unit,
      text,
      provenance: normalizeUnitProvenance(kind, extraction),
      engine: asString(loc.engine, asString(coverage.method)),
      language: asString(loc.language_code ?? loc.language),
      confidence,
    });
  }
  // NOTE: "this reader produced no text" is NOT by itself a contract fault. A reader that
  // honestly reports units_failed / units_empty / units_needing_ocr has accounted for the
  // document; rejecting that envelope is what turned a corrupt sheet part into an opaque
  // 422 (F12-2/F12-4). The contract guard below only fires when the reader reports NEITHER
  // text NOR any per-unit accounting, which is the "ready with nothing in it" lie.

  // The reader's own structure-preserving rendering, when this backend version ships it.
  // An absent/empty list means an older reader, not a document with no structure: the
  // office merge then falls back to joining block texts and measures that honestly.
  const rendered: CapabilityRenderedUnit[] = [];
  for (const raw of Array.isArray(p.rendered_units) ? p.rendered_units : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const text = asString(r.text);
    if (!text.trim()) continue;
    const who = asString(r.provenance);
    rendered.push({
      unit: asNumber(r.unit, 0),
      text,
      provenance: who === "ocr" || who === "text-layer-weak" ? who : "text-layer",
      engine: asString(r.engine, asString(coverage.method)),
      blocks: asNumber(r.blocks, 0),
      truncated: r.truncated === true,
    });
  }

  const ocrRaw = (p.ocr && typeof p.ocr === "object" ? p.ocr : {}) as Record<string, unknown>;
  const ran = ocrRaw.ran === true;
  const ocrPages: CapabilityOcrPage[] = [];
  if (Array.isArray(ocrRaw.pages)) {
    for (const row of ocrRaw.pages as Record<string, unknown>[]) {
      if (!row || typeof row !== "object") continue;
      const unit = asNumber(row.page, 0);
      if (!unit) continue;
      ocrPages.push({
        unit,
        state: asString(row.state, "unknown"),
        engine: asString(row.engine),
        detail: asString(row.detail),
        confidence:
          typeof row.confidence === "number" && Number.isFinite(row.confidence)
            ? row.confidence
            : null,
        languageCode: asString(row.language_code),
        rotation: (() => {
          const raster = (row.raster && typeof row.raster === "object" && !Array.isArray(row.raster))
            ? (row.raster as Record<string, unknown>)
            : {};
          const rot = Number(raster.rotation);
          return Number.isFinite(rot) && rot !== 0 ? ((rot % 360) + 360) % 360 : null;
        })(),
      });
    }
  }
  const enginesRecognised: Record<string, number> = {};
  if (ocrRaw.engines_recognised && typeof ocrRaw.engines_recognised === "object") {
    for (const [engine, count] of Object.entries(
      ocrRaw.engines_recognised as Record<string, unknown>,
    )) {
      enginesRecognised[engine] = asNumber(count, 0);
    }
  }
  const engines = Array.isArray(ocrRaw.engines)
    ? (ocrRaw.engines as unknown[]).map((engine) => asString(engine)).filter(Boolean)
    : [];
  // Item 5 (user brief 2026-11-24): the worker records the wall clock its recognition
  // engines ran. "" / null = a worker that predates the clock, read as honestly unknown.
  const recRaw =
    ocrRaw.recognition && typeof ocrRaw.recognition === "object" && !Array.isArray(ocrRaw.recognition)
      ? (ocrRaw.recognition as Record<string, unknown>)
      : {};
  const visualPages: CapabilityVisualPage[] = [];
  for (const raw of Array.isArray(p.visual_pages) ? p.visual_pages : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const v = raw as Record<string, unknown>;
    const page = asNumber(v.page, 0);
    const png = asString(v.png_base64);
    if (page > 0 && png) {
      const label = asString(v.label);
      const region = asString(v.region);
      const regionState = asString(v.region_state);
      visualPages.push({
        page, ops: asNumber(v.ops, 0), dataUrl: `data:image/png;base64,${png}`,
        ...(label ? { label } : {}), ...(region ? { region } : {}),
        ...(regionState ? { region_state: regionState } : {}),
      });
    }
  }
  const doc: CapabilityDoc = {
    kind: asString(rawDoc.kind, "unknown"),
    engine: asString(coverage.method, `${asString(rawDoc.kind)} reader`),
    unitsTotal,
    unitsSucceeded: idList(coverage.units_succeeded),
    unitsEmpty: idList(coverage.units_empty),
    unitsNeedingOcr: idList(coverage.units_needing_ocr),
    unitsFailed: idList(coverage.units_failed),
    ocrUnits: idList(p.ocr_units),
    complete: p.coverage_complete === true,
    note: asString(coverage.note) || asString((outer.coverage as Record<string, unknown> | undefined)?.note),
    units: grouped,
    rendered,
    visualPages,
    ocr: {
      ran,
      attempted: asNumber(ocrRaw.attempted, 0),
      recognized: asNumber(ocrRaw.recognized, 0),
      language: asString(ocrRaw.language),
      summary: asString(ocrRaw.summary),
      reason: asString(ocrRaw.reason),
      needsLanguage: ocrRaw.needs_language === true,
      pages: ocrPages,
      engines,
      enginesRecognised,
      primaryReady: ocrRaw.primary_ready === true,
      languageSource: asString(ocrRaw.language_source),
      recognition: {
        startedAt: asString(recRaw.started_utc),
        finishedAt: asString(recRaw.finished_utc),
        wallS: typeof recRaw.wall_s === "number" && Number.isFinite(recRaw.wall_s)
          ? recRaw.wall_s
          : null,
      },
    },
    meta,
  };
  const reportsNothing =
    doc.units.length === 0 &&
    doc.rendered.length === 0 &&
    doc.unitsFailed.length === 0 &&
    doc.unitsEmpty.length === 0 &&
    doc.unitsNeedingOcr.length === 0;
  if (reportsNothing) return null;
  return doc;
}

/** Run one documents.parse job. Never throws: every failure is a typed state. */
export async function readDocumentViaCapability(
  srcPath: string,
  opts: CapabilityRequestOptions = {},
): Promise<CapabilityOutcome> {
  const run: RunJob = opts.runJob ?? mlJob;
  const resolved = path.resolve(srcPath);
  const language = (opts.language ?? process.env[DOCUMENT_OCR_LANGUAGE_ENV] ?? "").trim();
  const payload: Record<string, unknown> = { path: resolved, root: path.dirname(resolved) };
  if (language) payload.language = language;
  if (opts.regions?.length) payload.regions = opts.regions;

  const envelope = await run(DOCUMENT_PARSE_CAPABILITY, payload, {
    deadlineMs: opts.deadlineMs ?? DOCUMENT_PARSE_DEADLINE_MS,
    signal: opts.signal,
  });
  if (envelope === null) return { state: "none" };

  if (envelope.state === "ready") {
    const doc = normalizeDocument(envelope.result);
    if (doc) return { state: "ready", doc };
    return {
      state: "unavailable",
      reason: "contract_mismatch",
      message: "the capability backend reported a successful document parse that carries no readable units, which is refused rather than treated as an empty document",
      humanStep: "report this: the payload shape and the reader version must match",
      retryable: false,
    };
  }

  const error = envelope.error;
  return {
    state: "unavailable",
    reason: error?.reason || (envelope.state === "cancelled" ? "cancelled" : "internal"),
    message: error?.message || `the capability job ended in state ${envelope.state}`,
    humanStep: error?.human_step || "",
    retryable: error?.retryable === true,
  };
}

/** The TS side of a merge: per-page text is required, a joined blob is not enough. */
export interface TsPageText {
  pages: number;
  /** 1-based order; index 0 is page 1. An empty string means "no text layer". */
  perPage: string[];
  pagesWithoutText: number[];
}

export type UnitReader = "ts-text-layer" | "capability-text-layer" | "capability-ocr";

export interface MergedDocument {
  text: string;
  pages: number;
  readUnits: number[];
  unreadUnits: number[];
  readBy: Record<number, UnitReader>;
  coverageNote: string;
  /** Non-empty ONLY when no engine read anything; the caller must refuse. */
  refusal: string;
  /**
   * True when NO engine produced text but the reader MEASURED why: every unit is accounted
   * for as empty/corrupt and no unit carries raster evidence. That is an honest empty
   * document, which must be DELIVERED with its coverage statement; a 422 contract error
   * tells the user nothing (F12-2). Refusal stays for scanned/raster documents, where the
   * actionable step (OCR, or send the page as an image) is real.
   */
  honestEmpty: boolean;
  /** Unit-level failure reasons the reader itself reported (corrupt part, unread page). */
  unitFailures: string[];
  bodyEngine: "ts" | "capability";
}

const unitLabel = (units: number[]): string =>
  !units.length ? "no pages" : units.length === 1 ? `page ${units[0]}` : `pages ${units.join(", ")}`;

const listForNote = (units: number[], limit = 15): string =>
  units.length <= limit ? unitLabel(units) : `${units.length} pages`;

/**
 * Which OCR engine actually read what. The primary engine's readiness is stated
 * separately from the recovery engine's result: a Tesseract rescue is NOT parity,
 * and a unit the cascade could not read stays named instead of vanishing.
 */
function ocrEngineNote(ocr: CapabilityOcrReport): string {
  const bits: string[] = [];
  const engines = Array.isArray(ocr.engines) ? ocr.engines : [];
  const recognised =
    ocr.enginesRecognised && typeof ocr.enginesRecognised === "object"
      ? ocr.enginesRecognised
      : {};
  const pages = Array.isArray(ocr.pages) ? ocr.pages : [];
  if (engines.length) bits.push(`engines consulted: ${engines.join(" -> ")}`);
  if (Object.keys(recognised).length) {
    bits.push(
      `recognised per engine: ${Object.entries(recognised)
        .map(([engine, count]) => `${engine}=${count}`)
        .join(", ")}`,
    );
  }
  if (ocr.ran && !ocr.primaryReady) {
    bits.push("the primary OCR engine was NOT ready for this run, so any OCR here came from the recovery engine with lower layout/formula fidelity");
  }
  const unresolved = pages
    .filter((p) => p.state === "ocr_failed" || p.state === "raster_failed")
    .map((p) => p.unit);
  if (unresolved.length) bits.push(`unresolved after fallback: ${listForNote(unresolved)}`);
  const skipped = pages.filter((p) => p.state === "skipped").map((p) => p.unit);
  if (skipped.length) bits.push(`cancelled before OCR: ${listForNote(skipped)}`);
  const emptied = pages.filter((p) => p.state === "empty").map((p) => p.unit);
  if (emptied.length) bits.push(`OCR found no text on ${listForNote(emptied)}`);
  if (ocr.language && ocr.languageSource) bits.push(`language ${ocr.language} from ${ocr.languageSource}`);
  return bits.join("; ");
}

const nonSpace = (s: string): number => s.replace(/\s+/g, "").length;

/**
 * Drop lines a second reader shares with the text this page ALREADY delivered.
 * A whole-page scan's OCR output repeats the heading the native layer carried; a later
 * count of that heading over the whole body (frozen key d1-ocr-1) must see it exactly
 * once, so the variant contributes only what is new to the page.
 */
function dropSharedLines(variant: string, primary: string): string {
  const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
  const delivered = collapse(primary);
  return variant
    .trim()
    .split(/\r?\n/)
    .filter((line) => {
      const c = collapse(line);
      return c.length > 0 && !delivered.includes(c);
    })
    .join("\n")
    .trim();
}

/** The capability engine's best unit for one page: native layer beats OCR, longer beats shorter. */
function unitForPage(doc: CapabilityDoc, page: number): CapabilityUnit | null {
  const candidates = doc.units.filter((u) => u.unit === page && u.text.trim());
  if (!candidates.length) return null;
  const nativeFirst = (u: CapabilityUnit): number => (u.provenance === "ocr" ? 1 : 0);
  candidates.sort((a, b) =>
    nativeFirst(a) - nativeFirst(b) ||
    b.text.replace(/\s+/g, "").length - a.text.replace(/\s+/g, "").length,
  );
  return candidates[0];
}

function provenanceLabel(reader: UnitReader, unit: CapabilityUnit | null): string {
  if (reader === "ts-text-layer") return "pdf.js text layer";
  if (unit?.provenance === "ocr") {
    const extra = [unit.language, unit.confidence !== null ? `confidence ${unit.confidence}` : ""]
      .filter(Boolean)
      .join(", ");
    return `${unit.engine || "ocr engine"} OCR${extra ? ` (${extra})` : ""}`;
  }
  return `${unit?.engine || "capability reader"} text layer`;
}

/**
 * The reader's OWN per-unit failure statements, turned into sentences. A corrupt sheet part
 * or a page whose text layer threw is a fact the user must see even when another reader
 * supplied partial text for that unit (F12-4: the reason was being dropped).
 */
export function unitFailureReasons(doc: CapabilityDoc): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  const lists: [unknown, (entry: Record<string, unknown>) => string][] = [
    [doc.meta.page_failures, (e) => `page ${asString(e.page, "?")}: ${asString(e.stage, "extract")} failed - ${asString(e.detail)}`],
    [doc.meta.sheet_failures, (e) => `sheet ${asString(e.sheet, "?")} (unit ${asString(e.sheet_index, "?")}): ${asString(e.why)}${e.part ? ` [part ${asString(e.part)}]` : ""}`],
  ];
  for (const [raw, format] of lists) {
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) push(format(entry as Record<string, unknown>));
      else push(entry);
    }
  }
  return [...new Set(out)].slice(0, 12);
}

/** Raster evidence the reader actually measured: an image XObject, an OCR-flagged unit, or a
 * page OCR really attempted. "No raster evidence anywhere" is what makes an empty document an
 * honest empty document rather than an unread scanned one. */
export function hasRasterEvidence(doc: CapabilityDoc): boolean {
  if (doc.unitsNeedingOcr.length > 0) return true;
  if (doc.ocrUnits.length > 0) return true;
  if (doc.ocr.attempted > 0 || doc.ocr.recognized > 0) return true;
  const images = doc.meta.pages_with_images;
  if (images && typeof images === "object" && !Array.isArray(images)) {
    for (const value of Object.values(images as Record<string, unknown>)) {
      if (asNumber(value, 0) > 0) return true;
    }
  }
  return false;
}

/**
 * Merge the TS text layer with the capability result, ONE PAGE AT A TIME.
 * A page the TS engine read keeps its text; only pages with no TS text may be
 * filled by the capability engine. The body carries a bracketed provenance line
 * per page so a later citation can point at a real page, and so an unread page
 * can never be mistaken for content.
 */
export function mergePdfUnits(ts: TsPageText, doc: CapabilityDoc): MergedDocument {
  const pages = Math.max(ts.pages || 0, doc.unitsTotal || 0);
  const readBy: Record<number, UnitReader> = {};
  const bodies: string[] = [];
  const readUnits: number[] = [];
  const unreadUnits: number[] = [];
  let filledByOcr = 0;
  let filledByCapText = 0;
  let keptWeakWithOcr = 0;
  let variantsKept = 0;
  const pageRaster = (page: number): boolean => {
    if (doc.unitsNeedingOcr.includes(page) || doc.ocrUnits.includes(page)) return true;
    const images = doc.meta.pages_with_images;
    if (images && typeof images === "object" && !Array.isArray(images)) {
      const entry = (images as Record<string, unknown>)[String(page)];
      return asNumber(entry, 0) > 0;
    }
    return false;
  };

  for (let page = 1; page <= pages; page += 1) {
    const tsText = (ts.perPage[page - 1] ?? "").trim();
    const capUnit = unitForPage(doc, page);
    if (tsText) {
      readBy[page] = "ts-text-layer";
      readUnits.push(page);
      bodies.push(`[page ${page} | read by: ${provenanceLabel("ts-text-layer", null)}]\n${tsText}`);
      // The second reader worth keeping is the OCR read, NOT the capability engine's own
      // text-layer unit: that unit is the same pypdf extraction pdf.js just printed, so it
      // only ever duplicates the page. F73 production measured the consequence of picking it
      // anyway: on d1_mixed page 1 the text layer carried only the heading, the body lived
      // in a raster image, capability OCR read that image - and the variant never carried
      // the OCR text, so the body fact was undeliverable end-to-end.
      const ocrUnit = doc.units.find((u) => u.unit === page && u.provenance === "ocr" && u.text.trim()) ?? null;
      const variant = ocrUnit ?? capUnit;
      if (variant) {
        if (ocrUnit) keptWeakWithOcr += 1;
        const tsChars = nonSpace(tsText);
        const capChars = nonSpace(variant.text);
        if (capChars >= Math.max(1, tsChars) * PDF_VARIANT_RATIO) {
          const delivered = dropSharedLines(variant.text, tsText);
          const deliveredChars = nonSpace(delivered);
          if (deliveredChars > 0) {
            variantsKept += 1;
            const who = provenanceLabel(ocrUnit ? "capability-ocr" : "capability-text-layer", variant);
            const shared = nonSpace(variant.text) - deliveredChars;
            bodies.push(
              `[page ${page} | second reader ${who}: ${deliveredChars} non-whitespace characters vs the ` +
              `pdf.js text layer's ${tsChars}${shared > 0 ? `, ${shared} characters already delivered above were not repeated` : ""}; ` +
              `kept as a variant, the text layer above was NOT replaced]\n` +
              delivered,
            );
          }
        }
      }
      continue;
    }
    if (capUnit) {
      readBy[page] = capUnit.provenance === "ocr" ? "capability-ocr" : "capability-text-layer";
      readUnits.push(page);
      if (capUnit.provenance === "ocr") filledByOcr += 1;
      else filledByCapText += 1;
      bodies.push(`[page ${page} | read by: ${provenanceLabel(readBy[page], capUnit)}]\n${capUnit.text.trim()}`);
      continue;
    }
    unreadUnits.push(page);
    bodies.push(
      `[page ${page} | not read: ${
        pageRaster(page)
          ? "no text layer, and OCR produced nothing for this page"
          : "no text layer AND no image content on this page, so there is nothing for an OCR engine to read"
      }]`,
    );
  }

  const capUnread = [...doc.unitsEmpty, ...doc.unitsNeedingOcr, ...doc.unitsFailed]
    .filter((u) => u >= 1 && u <= pages)
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .sort((a, b) => a - b)
    .filter((u) => !readUnits.includes(u));
  const tsUnreadCount = ts.pagesWithoutText.filter((p) => p >= 1 && p <= pages).length;

  const parts: string[] = [];
  parts.push(`document capability ${DOCUMENT_PARSE_CAPABILITY} (${doc.engine})`);
  if (ts.pages > 0) {
    parts.push(`text layer: ${readUnits.filter((u) => readBy[u] === "ts-text-layer").length} of ${ts.pages} page(s) via pdf.js`);
    parts.push(`capability filled ${filledByOcr} page(s) by OCR and ${filledByCapText} page(s) by its own text layer`);
    if (tsUnreadCount === 0 && capUnread.length === 0 && doc.unitsTotal === ts.pages) {
      parts.push("both readers agree every page carries a text layer");
    }
  } else {
    parts.push("the TS engine could not open this document; the capability engine served the body");
  }
  parts.push(`read: ${listForNote(readUnits)}`);
  // The same "units: X of Y read" statement the office path emits, so coverage has ONE
  // shape across document kinds and a citation tool cannot be fed two different grammars.
  parts.push(`units: ${readUnits.length} of ${pages} read`);
  if (unreadUnits.length) parts.push(`not read: ${listForNote(unreadUnits)}`);
  if (doc.unitsFailed.length) parts.push(`failed units: ${doc.unitsFailed.join(", ")}`);
  const failures = unitFailureReasons(doc);
  if (failures.length) parts.push(`unit failures: ${failures.join(" | ")}`);
  if (doc.ocr.ran) {
    parts.push(`${doc.ocr.recognized} page(s) recognised by OCR${doc.ocr.language ? ` (${doc.ocr.language})` : ""}: ${doc.ocr.summary || doc.ocr.attempted + " attempted"}`);
    parts.push(ocrEngineNote(doc.ocr));
    // A rotated page is not a different page: the delivery says which orientation was corrected
    // so a citation to page N still points at the physical sheet the user is holding.
    const rotated = doc.ocr.pages.filter((o) => (o.rotation ?? 0) !== 0);
    if (rotated.length) {
      parts.push(`raster rotation applied: ${rotated.map((o) => `page ${o.unit} ${o.rotation}°`).join(", ")}`);
    }
  } else if (doc.ocr.needsLanguage) {
    parts.push(`OCR needs an explicit language (set ${DOCUMENT_OCR_LANGUAGE_ENV}); ${doc.ocr.reason}`);
  } else {
    parts.push(`OCR did not run: ${doc.ocr.reason || "no reason reported"}`);
  }
  if (keptWeakWithOcr) {
    parts.push(`${keptWeakWithOcr} page(s) were OCR-flagged and OCR output exists but the TS text layer was kept`);
  }
  if (variantsKept) {
    parts.push(`${variantsKept} page(s) carry a second-reader variant alongside the TS text layer (kept beside it, never replaced)`);
  }
  const coverageNote = `[${parts.join("; ")}]`;

  let refusal = "";
  let honestEmpty = false;
  if (!readUnits.length && pages > 0) {
    if (hasRasterEvidence(doc)) {
      // Scanned content with no readable text: the actionable step is real (OCR, or send the
      // page as an image), so refusing is honest. The wording states only what was MEASURED.
      const scanned = doc.unitsNeedingOcr.length
        ? `${listForNote(doc.unitsNeedingOcr)} ${doc.unitsNeedingOcr.length === 1 ? "carries" : "carry"}`
        : "every page carries";
      const blocker = doc.ocr.ran
        ? "OCR ran and recognised nothing on these pages"
        : doc.ocr.needsLanguage
          // The frozen key checks the DELIVERED refusal: a 422 carries only this sentence
          // (route -> extractFileFromPath throws `${name}: ${refusal}`), so the coverage
          // note's language clause never reaches the user unless the refusal names it too.
          ? `OCR needs an explicit language (set ${DOCUMENT_OCR_LANGUAGE_ENV}); the engine was not run: ${doc.ocr.reason}`
          : `OCR did not run: ${doc.ocr.reason || "no reason reported"}`;
      refusal =
        `this document has no readable text layer - ${scanned} image content with no text layer. ` +
        `${blocker}. Send the page you care about as an image and the vision model can read it.`;
    } else {
      // Nothing readable AND no raster evidence anywhere: the honest result is an EMPTY
      // extraction whose body says so per page, not an invented "scanned images" claim and
      // not an internal contract error (F12-2 measured exactly this).
      honestEmpty = true;
    }
  }

  return {
    text: [coverageNote, "", bodies.join("\n\n")].join("\n"),
    pages,
    readUnits,
    unreadUnits,
    readBy,
    coverageNote,
    refusal,
    honestEmpty,
    unitFailures: unitFailureReasons(doc),
    bodyEngine: "ts",
  };
}

/**
 * Unicode-aware content token: letters, digits and marks, keeping CJK runs intact.
 */
const CONTENT_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;

const normLine = (value: string): string =>
  value.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

const contentLines = (value: string): string[] => value.split(/\r?\n/).map(normLine).filter(Boolean);

const contentTokens = (value: string): string[] => value.toLowerCase().match(CONTENT_TOKEN) ?? [];

/** Boundary-safe search: "ana" is not inside "analog", "99.9" is not a slice of "99.95". */
function lineInside(needle: string, haystack: string): boolean {
  if (!needle) return true;
  if (needle === haystack) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(haystack);
  } catch {
    return false;                       // a line that cannot be searched is never "covered"
  }
}

export interface ContentCoverage {
  /** Distinct content items the TS body has and the capability body does not carry. */
  lostTokens: string[];
  /** Distinct content items only the capability body has (new content or structure). */
  newTokens: number;
  /** TS lines the capability body re-broke but fully carried (line-wrap differences). */
  rebuiltLines: number;
  /** TS lines that genuinely lost content (they contain at least one lost item). */
  lostLines: number;
  /** Capability lines that each carry >= 2 distinct TS content lines (row/table identity). */
  groupedLines: number;
  /** Distinct content items the TS body carried at all. */
  tsItems: number;
  /** Distinct non-empty content lines each body is made of. */
  tsLines: number;
  capLines: number;
  /** Reader artifact renderings excluded from BOTH sides of the measurement (see below). */
  droppedArtifacts: number;
}

/**
 * READER ARTIFACTS - an engine's own placeholder or error-value text.
 *
 * Measured defect (F12-1, ho-corrupt.xlsx): the TS OOXML reader turns an out-of-range
 * shared-string index into `(shared string #99 missing)` and passes a stored `#REF!` through
 * as if it were readable text. The capability reader instead names the cell and the reason.
 * The old law counted those artifacts as "content the TS reader read", so the honest reader
 * was REFUSED for losing them: the law was rewarding fabrication.
 *
 * They are therefore excluded from the loss measurement, on both sides symmetrically. This is
 * not a free pass: dropping a real value is still a loss, and the artifacts stay visible in
 * whichever body is delivered - the exclusion covers only which body is measured as more
 * faithful. Each pattern names the engine that emits it.
 */
const READER_ARTIFACT_PATTERNS: { why: string; re: RegExp }[] = [
  { why: "TS OOXML reader: out-of-range shared-string index", re: /\((?:shared string|shared string #\d*|string #\d*)\s*missing\)/gi },
  { why: "spreadsheet stored error value (OOXML t=\"e\")", re: /#(?:REF!|VALUE!|DIV\/0!|NAME\?|NULL!|NUM!|N\/A)/g },
  { why: "TS OOXML reader: formula half missing", re: /\[formula (?:continuation; expression not stored in this cell|present but neither expression nor cached value stored)\]/gi },
  { why: "legacy byte-scan recovery marker", re: /\[binary (?:string|run)[^\]]*\]/gi },
];

export interface StripResult {
  text: string;
  dropped: number;
}

/** Remove reader artifacts (never document content) before measuring body fidelity. */
export function stripReaderArtifacts(value: string): StripResult {
  let text = value;
  let dropped = 0;
  for (const artifact of READER_ARTIFACT_PATTERNS) {
    text = text.replace(artifact.re, () => {
      dropped += 1;
      return " ";
    });
  }
  return { text, dropped };
}

/**
 * STRUCTURAL facts a body states, counted by pattern rather than by prose.
 *
 * Why this exists alongside content items (F12-3, ho-inventory.xlsx): the two spreadsheet
 * bodies can carry the SAME distinct content items while one of them additionally states
 * which merged area each value spans, which cells exist but hold no value, and which cells it
 * could not read. A content-item set cannot see that difference because the facts re-use
 * coordinates the other body already printed, so the old law called real fidelity "adds
 * nothing" and kept the weaker body. Counting the fact categories makes the comparison
 * structure-aware on both sides, with the same patterns.
 */
export interface StructureFacts {
  /** Per-cell merged attribution, e.g. `A1=title [merged A1:C1]`. */
  mergedAttributions: number;
  /** Cells declared as existing with no value (never coerced to zero). */
  declaredEmptyCells: number;
  /** Cells reported unreadable BY REFERENCE AND REASON. */
  corruptCells: number;
  /** Units the reader itself reported as failed, with the reason. */
  unitFailures: number;
  /** Formula cells that carry their cached result beside the formula text. */
  formulaWithCache: number;
}

const CELL_REF_TOKEN = /[A-Z]{1,3}[1-9][0-9]*/;

export function countStructureFacts(value: string): StructureFacts {
  const count = (re: RegExp): number => value.match(re)?.length ?? 0;

  let declaredEmptyCells = 0;
  for (const header of value.matchAll(/### declared-empty cells[^\n]*?:\s*([^\n]*)/gi)) {
    const listed = (header[1] ?? "").match(new RegExp(CELL_REF_TOKEN.source, "g")) ?? [];
    declaredEmptyCells += listed.length;
  }

  let corruptCells = 0;
  for (const header of value.matchAll(/### cells this reader could NOT read:\s*([^\n]*)/gi)) {
    const listed = (header[1] ?? "").match(new RegExp(`${CELL_REF_TOKEN.source}\\s*:`, "g")) ?? [];
    corruptCells += listed.length;
  }

  return {
    mergedAttributions: count(/\[merged\s+[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?\]/g),
    declaredEmptyCells,
    corruptCells,
    // Deliberately disjoint from the corrupt-CELL header above: a unit failure is a WHOLE unit
    // the reader could not read, and double-counting one header would inflate the tie-breaker.
    unitFailures: count(/(?:could NOT be read|could not be read|no parser is configured|part [^\n]*is missing from the package)/gi),
    formulaWithCache: count(/(?:^|[\t >])=\S[^\n]*\(cached\s+[^\n)]+\)/gim),
  };
}

/** Total structural facts, used as the tie-breaker when content items are identical. */
export const structureTotal = (facts: StructureFacts): number =>
  facts.mergedAttributions + facts.declaredEmptyCells + facts.corruptCells +
  facts.unitFailures + facts.formulaWithCache;

const STRUCTURE_LABELS: [keyof StructureFacts, string][] = [
  ["mergedAttributions", "merged-area attributions"],
  ["declaredEmptyCells", "declared-empty cells"],
  ["corruptCells", "cells unreadable-by-reference"],
  ["unitFailures", "reported unit failures"],
  ["formulaWithCache", "formulas carrying cached values"],
];

/** The nonzero categories behind a structure total, so the number is not opaque. */
export function structureBreakdown(facts: StructureFacts): string {
  const named = STRUCTURE_LABELS
    .filter(([key]) => facts[key] > 0)
    .map(([key, label]) => `${label} ${facts[key]}`);
  return named.length ? named.join(", ") : "none stated";
}

/**
 * The promotion measurement, separate so it can be tested on its own.
 *
 * Why DISTINCT content items rather than counts: the TS spreadsheet reader legitimately
 * repeats a merged block's value across the region it spans, so a character-count bar
 * measured duplication and permanently protected the weaker reader (reproduced on
 * f06-sheet.xlsx: 95 capability characters vs the TS reader's 224 for the SAME content).
 * Coverage asks the real question - does every item the old reader produced still exist -
 * and never lets a longer body that drops one item win.
 */
export function measureContentCoverage(tsText: string, capabilityText: string): ContentCoverage {
  // Reader artifacts (placeholders, error values) are excluded from BOTH sides first: they
  // are an engine's own plumbing, and protecting them is what made the honest reader lose.
  const tsClean = stripReaderArtifacts(tsText);
  const capClean = stripReaderArtifacts(capabilityText);
  const tsItems = new Set(contentTokens(tsClean.text));
  const capItems = new Set(contentTokens(capClean.text));

  const lostTokens: string[] = [];
  for (const item of tsItems) if (!capItems.has(item)) lostTokens.push(item);
  let newTokens = 0;
  for (const item of capItems) if (!tsItems.has(item)) newTokens += 1;

  const tsLines = contentLines(tsClean.text);
  const capLines = contentLines(capClean.text);
  // DISTINCT content lines: the TS spreadsheet reader legitimately repeats one line
  // across a merged region, and counting that repetition three times would both inflate
  // "groupedLines" and inflate "lostLines" - the exact duplication bias this measurement
  // replaced the character ratio to remove.
  const distinct = (values: string[]): string[] => [...new Set(values)];
  const tsUnique = distinct(tsLines);
  const capUnique = distinct(capLines);
  let rebuiltLines = 0;
  let lostLines = 0;
  for (const line of tsUnique) {
    if (capUnique.some((cap) => lineInside(line, cap))) continue;
    const items = new Set(contentTokens(line));
    if ([...items].some((item) => !capItems.has(item))) lostLines += 1;
    else rebuiltLines += 1;                     // re-broken across lines, fully carried
  }

  let groupedLines = 0;
  for (const cap of capUnique) {
    let carried = 0;
    for (const line of tsUnique) if (lineInside(line, cap)) carried += 1;
    if (carried >= 2) groupedLines += 1;
  }

  return {
    lostTokens,
    newTokens,
    rebuiltLines,
    lostLines,
    groupedLines,
    tsItems: tsItems.size,
    tsLines: tsUnique.length,
    capLines: capUnique.length,
    droppedArtifacts: tsClean.dropped + capClean.dropped,
  };
}

/** Why the body engine chose what it chose, in the delivered note. */
function officeBodyDecision(
  promote: boolean,
  coverage: ContentCoverage,
  engine: string,
  capCount: number,
  tsCount: number,
  renderingMeasured: boolean,
  capStructure: StructureFacts,
  tsStructure: StructureFacts,
): string {
  const measured = renderingMeasured
    ? "measured on the reader's own structure-preserving rendering"
    : "measured on joined block texts (this backend ships no rendering)";
  // Both the STRUCTURE facts and the artifact exclusion are stated in the delivered note,
  // so the note proves which measurements were made instead of leaving them in comments.
  const structure = `plus structure: capability ${structureTotal(capStructure)} structural fact(s) ` +
    `[${structureBreakdown(capStructure)}] vs TS ${structureTotal(tsStructure)} ` +
    `[${structureBreakdown(tsStructure)}]`;
  const artifacts = coverage.droppedArtifacts > 0
    ? `; ${coverage.droppedArtifacts} reader artifact rendering(s) (placeholder/error text, not document content) excluded from the loss measurement on both sides`
    : "";
  if (promote) {
    const rebuilt = coverage.rebuiltLines ? `, ${coverage.rebuiltLines} line(s) re-broken but fully carried` : "";
    return `${engine} chosen over the TS reader: it carries all ${coverage.tsItems} content item(s) the TS reader read ` +
      `and adds ${coverage.newTokens} new item(s) plus ${coverage.groupedLines} structurally grouped line(s)${rebuilt} ${structure}; ` +
      `${capCount} vs ${tsCount} non-whitespace characters (reported, not the decision); ${measured}${artifacts}`;
  }
  if (capCount === 0) return `${engine} produced no body text at all, so the TS reader served the body`;
  if (coverage.lostTokens.length > 0) {
    const named = coverage.lostTokens.slice(0, LOST_ITEMS_NAMED).join(", ");
    const more = coverage.lostTokens.length > LOST_ITEMS_NAMED ? ` +${coverage.lostTokens.length - LOST_ITEMS_NAMED} more` : "";
    return `${engine} refused as the body: it loses ${coverage.lostTokens.length} content item(s) the TS reader read ` +
      `(${named}${more}), so promoting it would be a regression whatever its ${capCount} characters suggest ` +
      `${structure}; ${measured}${artifacts}`;
  }
  return `${engine} carries the same ${coverage.tsItems} content item(s) as the TS reader and adds nothing ` +
    `(${capCount} vs ${tsCount} non-whitespace characters) ${structure}, so the merge kept the TS reader: a measurement, ` +
    `not a language preference; ${measured}${artifacts}`;
}

/**
 * Office bodies: the TS reader keeps the body unless the capability reader measures as a
 * CONTENT SUPERSET (nothing the TS body carried is missing) AND adds something - new items
 * or structure the TS body did not express. Whichever body serves, the note names both
 * engines, the measured numbers and every unit the capability reader failed, so a
 * promotion is a measurement and never a language bias.
 */
export function mergeOfficeText(tsText: string, doc: CapabilityDoc): MergedDocument {
  // Prefer the reader's own structure-preserving rendering: cell coordinates, merged
  // ranges, heading levels and table-row identity are part of the document's content.
  // Joined block texts are the fallback for a backend that ships no rendering, and the
  // note below says which of the two was measured.
  const source: { unit: number; text: string }[] =
    doc.rendered.length > 0 ? doc.rendered : doc.units;
  const renderingMeasured = doc.rendered.length > 0;
  const capabilityBody = source
    .slice()
    .sort((a, b) => a.unit - b.unit)
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const tsCount = nonSpace(tsText);
  const capCount = nonSpace(capabilityBody);
  const coverage = measureContentCoverage(tsText, capabilityBody);
  const capStructure = countStructureFacts(capabilityBody);
  const tsStructure = countStructureFacts(tsText);
  // Promotion law: nothing the TS body carried may be missing, AND the capability body must
  // add something measurable. "Something" is new content items, structural grouping, OR more
  // stated structural facts - the last one is what the pure content-item set could not see
  // (F12-3: a body naming which merged area each value spans, which cells are declared empty
  // and which cells it could NOT read was called "adds nothing" and the weaker body won).
  const promote = capCount > 0
    && coverage.lostTokens.length === 0
    && (coverage.newTokens > 0 || coverage.groupedLines > 0
        || structureTotal(capStructure) > structureTotal(tsStructure));

  const failedUnits = [...doc.unitsFailed, ...doc.unitsEmpty].filter((u, i, a) => a.indexOf(u) === i).sort((a, b) => a - b);
  const failureReasons = unitFailureReasons(doc);
  const parts = [
    `document capability ${DOCUMENT_PARSE_CAPABILITY} (${doc.engine})`,
    `body: ${officeBodyDecision(promote, coverage, doc.engine, capCount, tsCount, renderingMeasured, capStructure, tsStructure)}`,
    // Which engine's bytes the reader is actually looking at. The Python renderer and the TS
    // office reader phrase some headers almost identically, so a note that only names the
    // CANDIDATE engine cannot prove which body was delivered. This token is checkable.
    `body_source: ${promote ? `capability:${doc.engine}` : "ts:office-reader"}`,
    `units: ${doc.unitsSucceeded.length} of ${doc.unitsTotal} read`,
  ];
  if (failedUnits.length) parts.push(`failed units: ${failedUnits.join(", ")}`);
  if (failureReasons.length) parts.push(`unit failures: ${failureReasons.join(" | ")}`);
  if (coverage.lostLines > 0) {
    parts.push(`${coverage.lostLines} TS content line(s) were not carried by the capability reader`);
  }
  if (!promote && doc.unitsFailed.length) {
    // The TS body may be holding text for a unit the capability reader measured as corrupt.
    // Saying so is the only way a later citation cannot present that unit as confirmed.
    parts.push(
      `the TS body may carry unverified content for the unit(s) the capability reader reported as ` +
      `failed (${doc.unitsFailed.join(", ")}); treat those units as unconfirmed`,
    );
  }
  if (doc.rendered.some((u) => u.truncated)) {
    parts.push("a capability rendering hit its per-unit character cap; the block list still carries every block");
  }
  if (!doc.ocr.ran && doc.ocrUnits.length) parts.push(`OCR did not run: ${doc.ocr.reason || "no reason reported"}`);
  if (doc.ocr.ran) parts.push(`${doc.ocr.recognized} unit(s) recognised by OCR: ${doc.ocr.summary}`);
  if (doc.ocr.ran) {
    const engineNote = ocrEngineNote(doc.ocr);
    if (engineNote) parts.push(engineNote);
  }
  const coverageNote = `[${parts.join("; ")}]`;

  const body = promote ? capabilityBody : tsText;
  // Neither body has any text: the honest outcome is either a stated failure with the reader's
  // own reasons, or an accounted-for empty document. Returning "" as a successful extraction is
  // the false-success shape this module exists to prevent.
  let refusal = "";
  let honestEmpty = false;
  if (!body.trim()) {
    if (doc.unitsFailed.length) {
      refusal =
        `no engine produced text for this file - the capability reader could not read unit(s) ` +
        `${doc.unitsFailed.join(", ")}` +
        `${failureReasons.length ? ` (${failureReasons.join(" | ")})` : ""}, and the TS reader ` +
        `produced nothing. Re-save the file from the application that wrote it, or send the ` +
        `affected page/sheet as an image so the vision model can read it.`;
    } else {
      honestEmpty = doc.unitsTotal > 0
        && [...doc.unitsEmpty, ...doc.unitsFailed].length >= doc.unitsTotal;
    }
  }
  return {
    // The coverage statement is part of the delivered text in BOTH branches: a reader that
    // says "1 of 3 sheets read" must say it where the model sees it, not only in a side field.
    text: [coverageNote, "", body].join("\n"),
    pages: doc.unitsTotal,
    readUnits: doc.unitsSucceeded,
    unreadUnits: failedUnits.filter((u) => !doc.unitsSucceeded.includes(u)),
    readBy: Object.fromEntries(doc.unitsSucceeded.map((u) => [u, promote ? "capability-text-layer" : "ts-text-layer"])),
    coverageNote,
    refusal,
    honestEmpty,
    unitFailures: failureReasons,
    bodyEngine: promote ? "capability" : "ts",
  };
}

/** One-line sentence for a caller that must refuse and tell the human what to do. */
export function capabilityBlockerLine(outcome: Exclude<CapabilityOutcome, { state: "none" | "ready" }>): string {
  const step = outcome.humanStep ? ` - ${outcome.humanStep}` : "";
  return `the document capability backend also refused (${outcome.reason}): ${outcome.message}${step}`;
}
