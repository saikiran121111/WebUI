/**
 * F05 - the Python documents.parse capability becomes a PRODUCTION caller, not a
 * status page. Frozen answer key, written BEFORE the implementation.
 *
 * The payloads below are not hand-written: the ready envelope and the typed
 * refusal were dumped from the real adapter (python-backend ruke_ml.workers.
 * document_jobs.parse_job, pypdf 7.1.0) and recorded verbatim in
 * docs/overnight/logs/f05-py-payload-1.log.
 *
 * Laws this file locks:
 *  1. no capability route  -> the TS engine behaves exactly as before (state "none");
 *  2. a typed capability refusal is a NAMED state, never an empty success;
 *  3. coverage ids, not counts, decide what was read (pages 1 and 3 yes, page 2 no);
 *  4. the capability engine may FILL a page the TS engine could not read and may
 *     never overwrite a page the TS engine already read from its text layer;
 *  5. an OCR text block always carries engine + language + confidence provenance,
 *     and "OCR did not run" stays visible in the delivered text;
 *  6. for Office formats promotion is MEASURED BY CONTENT COVERAGE: the capability body
 *     may replace the TS body only when it carries EVERY distinct content item the TS
 *     body carried AND adds content or structure of its own; the losing engine's failed
 *     unit ids stay named either way. A non-whitespace character ratio is reported in the
 *     note but is NOT the bar - it was tried and is wrong for spreadsheets, because the
 *     TS reader repeats a merged block's value across the region it spans, so the ratio
 *     measured duplication and permanently protected the weaker reader (measured on
 *     f06-sheet.xlsx: 95 capability characters vs the TS reader's 224 for the SAME
 *     content, which is why the capability's merged-range/cell-reference rendering is
 *     what gets measured);
 *  6b. the reader's own structure-preserving rendering (`rendered_units`) is what the
 *     merge measures and what may serve as the body; joined block texts are only the
 *     fallback for a backend that ships no rendering, and the note says which one was used;
 *  7. a document no engine could read REFUSES, naming the real blocker and the
 *     vision path; it never returns empty text as a success.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  DOCUMENT_PARSE_CAPABILITY,
  readDocumentViaCapability,
  mergePdfUnits,
  mergeOfficeText,
  measureContentCoverage,
  normalizeDocument,
  LOST_ITEMS_NAMED,
  countStructureFacts,
  stripReaderArtifacts,
  structureTotal,
  unitFailureReasons,
  type CapabilityDoc,
  type CapabilityOutcome,
  type MlJobEnvelope,
  type RunJob,
} from "../../lib/server/extract/document-capability";
import { extractFileFromPath } from "../../lib/server/extract";
import { makePdf } from "./make-pdf";

/** Verbatim from docs/overnight/logs/f05-py-payload-1.log (real pypdf run). */
const REAL_READY_ENVELOPE = {
  state: "ready",
  capability: "documents.parse",
  job_id: "job_f05",
  run_id: "run_f05",
  request_id: "req_f05",
  deadline_s: 60,
  source: "rust-ml-job",
  result: {
    job_id: "job_f05",
    capability: "documents.parse",
    state: "ready",
    payload: {
      coverage_complete: false,
      document: {
        blocks: [
          {
            block_id: "fbf7ce4075aa86e5", confidence: null, kind: "page_text",
            loc: { extraction: "pypdf-plain", page: 1, rotation: 0 },
            source_hash: "2dbb9aee738b2a07012af27096ca3ff6c7173fb1add15c74dfbdce29a72ee67f",
            source_id: "hole.pdf",
            text: "Quarterly margin report for the freight ledger. Quarterly margin\nreport for the freight ledger.",
          },
          {
            block_id: "ce6fed7fef83acf7", confidence: null, kind: "page_text",
            loc: { extraction: "pypdf-plain", page: 3, rotation: 0 },
            source_hash: "2dbb9aee738b2a07012af27096ca3ff6c7173fb1add15c74dfbdce29a72ee67f",
            source_id: "hole.pdf",
            text: "Final page: the late evidence token zephyr-9 lives here. Final page:\nthe late evidence token zephyr-9 lives here.",
          },
        ],
        coverage: {
          method: "pypdf-7.1.0-plain",
          note: "2/3 pages produced a text layer; 1 page(s) had none, 0 page(s) failed to extract. A non-empty document is not proof that every page was read.",
          units_empty: [2], units_extracted: 2, units_failed: [], units_needing_ocr: [],
          units_succeeded: [1, 3], units_total: 3,
        },
        kind: "pdf",
        meta: {
          bytes: 1257, metadata: {}, needs_ocr: [], page_failures: [],
          page_numbering: "1-based", pages: 3, pages_with_images: {}, rotated_pages: {},
        },
        source_hash: "2dbb9aee738b2a07012af27096ca3ff6c7173fb1add15c74dfbdce29a72ee67f",
        source_id: "hole.pdf",
      },
      ocr: {
        attempted: 0, language: "", language_source: "", pages: [], ran: false,
        reason: "the OCR engine is not executable here: the pinned dependency (package or external program) is not present",
        recognized: 0, summary: "",
      },
      ocr_reasons: ["1 of 3 units produced too little text"],
      ocr_route: "light_ocr", ocr_units: [2], page_numbering: "1-based",
      units_empty: [2], units_failed: [], units_needing_ocr: [], units_succeeded: [1, 3],
    },
    coverage: {
      examined: [[0, 1], [2, 3]], skipped: [[1, 2]], units: "pages", total_source: 3,
      complete: false,
      note: "2/3 pages produced a text layer; 1 page(s) had none, 0 page(s) failed to extract. A non-empty document is not proof that every page was read. | OCR NOT run: the OCR engine is not executable here: the pinned dependency (package or external program) is not present",
    },
  },
} as unknown as MlJobEnvelope;

const REAL_UNSUPPORTED_ENVELOPE = {
  state: "failed",
  capability: "documents.parse",
  job_id: "job_f05b", run_id: "run_f05b", request_id: "req_f05b", deadline_s: 60,
  source: "rust-ml-job",
  error: {
    capability: "documents.parse",
    human_step: "convert the file to a supported format, or register a parser adapter for this extension",
    message: "No parser is configured for .odg",
    reason: "unsupported_input",
    retryable: false,
  },
} as unknown as MlJobEnvelope;

const runJobReturning = (envelope: MlJobEnvelope | null): RunJob & { calls: unknown[][] } => {
  const fn = (async (capability: string, payload: Record<string, unknown>) => {
    fn.calls.push([capability, payload]);
    return envelope;
  }) as RunJob & { calls: unknown[][] };
  fn.calls = [];
  return fn;
};

const write = (dir: string, name: string, buf: Buffer): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

describe("readDocumentViaCapability - typed envelope handling", () => {
  it("reports state none, and nothing else, when this deployment has no capability route", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05cap_"));
    const src = write(dir, "clean.pdf", makePdf(["ONE-PAGE-TEXT"]));
    const run = runJobReturning(null);
    const outcome = await readDocumentViaCapability(src, { runJob: run });
    expect(outcome).toEqual({ state: "none" });
    expect(run.calls.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("an unavailable capability keeps its reason, message and human step", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05cap_"));
    const src = write(dir, "clean.pdf", makePdf(["ONE-PAGE-TEXT"]));
    const envelope = {
      state: "unavailable", capability: "documents.parse", job_id: "j", run_id: "r",
      request_id: "q", deadline_s: 60, source: "rust-ml-job",
      error: {
        reason: "not_configured", capability: "documents.parse", retryable: true,
        message: "the capability backend is not answering its loopback port",
        human_step: "start the capability backend with `npm run dev`",
      },
    } as unknown as MlJobEnvelope;
    const outcome = await readDocumentViaCapability(src, { runJob: runJobReturning(envelope) });
    expect(outcome.state).toBe("unavailable");
    if (outcome.state === "unavailable") {
      expect(outcome.reason).toBe("not_configured");
      expect(outcome.humanStep).toContain("npm run dev");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("a typed unsupported-format refusal from the real adapter is named, never an empty success", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05cap_"));
    const src = write(dir, "diagram.odg", Buffer.from("not a real document"));
    const outcome = await readDocumentViaCapability(src, { runJob: runJobReturning(REAL_UNSUPPORTED_ENVELOPE) });
    expect(outcome.state).toBe("unavailable");
    if (outcome.state === "unavailable") {
      expect(outcome.reason).toBe("unsupported_input");
      expect(outcome.message).toContain("No parser is configured for .odg");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("a memory-pressure OCR refusal stays a memory condition all the way to the caller", async () => {
    // The Python side now types a refused allocation (or a declared demand that does not fit the
    // resource window) as `memory_pressure`, retryable, with the step being "free RAM / take the
    // handoff". Nothing in this TS layer has a reason ENUM, so the law being pinned here is that
    // no layer rewrites an unrecognised reason into `internal` or drops the human step - a
    // rewrite would send the user to re-prepare a model that is already valid on disk.
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05cap_"));
    const src = write(dir, "scan.pdf", makePdf([null]));
    const envelope = {
      state: "unavailable", capability: "documents.parse", job_id: "j", run_id: "r",
      request_id: "q", deadline_s: 60, source: "rust-ml-job",
      error: {
        reason: "memory_pressure", capability: "documents.parse", retryable: true,
        message: "resource_limit: the demand declared for this pipeline does not fit the "
          + "resource window it ran in; attached commit ceiling 3814 MiB",
        human_step: "free RAM/commit or let the resource coordinator take the unload/load "
          + "handoff, then retry. Do NOT re-download the asset",
      },
    } as unknown as MlJobEnvelope;
    const outcome = await readDocumentViaCapability(src, { runJob: runJobReturning(envelope) });
    expect(outcome.state).toBe("unavailable");
    if (outcome.state === "unavailable") {
      expect(outcome.reason).toBe("memory_pressure");
      expect(outcome.retryable).toBe(true);
      expect(outcome.humanStep).toContain("Do NOT re-download");
      expect(outcome.humanStep).toContain("handoff");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("normalizes the REAL adapter payload: 1-based unit ids, per-unit provenance, honest ocr report", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05cap_"));
    const src = write(dir, "hole.pdf", makePdf(["MARGIN-REPORT", null, "LATE-EVIDENCE"]));
    const outcome = await readDocumentViaCapability(src, { runJob: runJobReturning(REAL_READY_ENVELOPE) });
    expect(outcome.state).toBe("ready");
    if (outcome.state === "ready") {
      const doc = outcome.doc;
      expect(doc.kind).toBe("pdf");
      expect(doc.engine).toContain("pypdf");
      expect(doc.unitsTotal).toBe(3);
      expect(doc.unitsSucceeded).toEqual([1, 3]);
      expect(doc.unitsEmpty).toEqual([2]);
      expect(doc.complete).toBe(false);
      expect(doc.units.map((u) => u.unit)).toEqual([1, 3]);
      expect(doc.units.map((u) => u.provenance)).toEqual(["text-layer", "text-layer"]);
      expect(doc.ocr.ran).toBe(false);
      expect(doc.ocr.reason).toContain("not executable");
      expect(doc.note).toContain("2/3 pages produced a text layer");
      expect(doc.ocrUnits).toEqual([2]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("a ready envelope with no usable document is a contract fault, never a successful empty read", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05cap_"));
    const src = write(dir, "clean.pdf", makePdf(["ONE-PAGE-TEXT"]));
    for (const bad of [
      { ...REAL_READY_ENVELOPE, result: undefined },
      { ...REAL_READY_ENVELOPE, result: { ...(REAL_READY_ENVELOPE.result as object), payload: {} } },
    ]) {
      const outcome = await readDocumentViaCapability(src, { runJob: runJobReturning(bad as unknown as MlJobEnvelope) });
      expect(outcome.state).toBe("unavailable");
      if (outcome.state === "unavailable") expect(outcome.reason).toBe("contract_mismatch");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("readDocumentViaCapability - request shape", () => {
  it("names the file and its containing root, and never invents an OCR language", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05req_"));
    const src = write(dir, "clean.pdf", makePdf(["ONE-PAGE-TEXT"]));
    const run = runJobReturning(null);
    await readDocumentViaCapability(src, { runJob: run });
    const [capability, payload] = run.calls[0] as [string, Record<string, unknown>];
    expect(capability).toBe(DOCUMENT_PARSE_CAPABILITY);
    expect(path.isAbsolute(String(payload.path))).toBe(true);
    expect(String(payload.path).toLowerCase()).toBe(path.resolve(src).toLowerCase());
    expect(String(payload.root).toLowerCase()).toBe(path.dirname(path.resolve(src)).toLowerCase());
    expect(payload.language ?? "").toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("an explicitly configured document language reaches the job (no silent English default)", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05req_"));
    const src = write(dir, "scan.pdf", makePdf([null]));
    const previous = process.env.RUKE_DOCUMENT_OCR_LANGUAGE;
    process.env.RUKE_DOCUMENT_OCR_LANGUAGE = "deu+eng";
    try {
      const run = runJobReturning(null);
      await readDocumentViaCapability(src, { runJob: run });
      const [, payload] = run.calls[0] as [string, Record<string, unknown>];
      expect(payload.language).toBe("deu+eng");
    } finally {
      if (previous === undefined) delete process.env.RUKE_DOCUMENT_OCR_LANGUAGE;
      else process.env.RUKE_DOCUMENT_OCR_LANGUAGE = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

/** A CapabilityDoc shaped like the real payload but with the pages a test needs. */
const doc = (over: Partial<CapabilityDoc>): CapabilityDoc => ({
  kind: "pdf",
  engine: "pypdf-7.1.0-plain",
  unitsTotal: 3,
  unitsSucceeded: [1, 3],
  unitsEmpty: [2],
  unitsNeedingOcr: [],
  unitsFailed: [],
  ocrUnits: [],
  complete: false,
  note: "2/3 pages produced a text layer",
  units: [],
  rendered: [],
  ocr: {
    ran: false, attempted: 0, recognized: 0, language: "", summary: "",
    reason: "engine not executable here", needsLanguage: false,
    pages: [], engines: [], enginesRecognised: {}, primaryReady: false, languageSource: "",
  },
  meta: { page_numbering: "1-based" },
  ...over,
});

describe("mergePdfUnits - per-page evidence, never a count", () => {
  it("keeps the TS text layer for pages it read and names the page NO engine could read", () => {
    const merged = mergePdfUnits(
      { pages: 3, perPage: ["TS-PAGE-ONE", "", "TS-PAGE-THREE"], pagesWithoutText: [2] },
      doc({ units: [] }),
    );
    expect(merged.pages).toBe(3);
    expect(merged.unreadUnits).toEqual([2]);
    expect(merged.text).toContain("TS-PAGE-ONE");
    expect(merged.text).toContain("TS-PAGE-THREE");
    expect(merged.text).toContain("[page 2");
    expect(merged.coverageNote).toMatch(/OCR did not run/);
    expect(merged.refusal).toBe("");
  });

  it("a capability page TEXT LAYER never overwrites a page the TS engine already read", () => {
    const merged = mergePdfUnits(
      { pages: 2, perPage: ["TS-TEXT-IS-BETTER", "TS-PAGE-TWO"], pagesWithoutText: [] },
      doc({
        unitsTotal: 2, unitsSucceeded: [1, 2], unitsEmpty: [],
        units: [
          { unit: 1, text: "PYPDF-REORDERED-TEXT", provenance: "text-layer", engine: "pypdf-7.1.0", language: "", confidence: null },
          { unit: 2, text: "PYPDF-PAGE-TWO", provenance: "text-layer", engine: "pypdf-7.1.0", language: "", confidence: null },
        ],
      }),
    );
    expect(merged.readBy[1]).toBe("ts-text-layer");
    expect(merged.readBy[2]).toBe("ts-text-layer");
    expect(merged.text).toContain("TS-TEXT-IS-BETTER");
    expect(merged.text).not.toContain("PYPDF-REORDERED-TEXT");
    expect(merged.coverageNote).toContain("both readers agree every page carries a text layer");
  });

  it("an OCR page fills the hole and carries engine, language and confidence with it", () => {
    const merged = mergePdfUnits(
      { pages: 3, perPage: ["TS-ONE", "", "TS-THREE"], pagesWithoutText: [2] },
      doc({
        unitsSucceeded: [1, 2, 3], unitsEmpty: [],
        units: [
          { unit: 1, text: "PY-ONE", provenance: "text-layer", engine: "pypdf-7.1.0", language: "", confidence: null },
          { unit: 2, text: "OCR-ZWEI-SEITE", provenance: "ocr", engine: "tesseract-5.5.0", language: "deu", confidence: 0.91 },
          { unit: 3, text: "PY-THREE", provenance: "text-layer", engine: "pypdf-7.1.0", language: "", confidence: null },
        ],
        ocr: { ran: true, attempted: 1, recognized: 1, language: "deu", languageSource: "request",
          summary: "1/1 page(s) recognised (deu)", reason: "", needsLanguage: false,
          pages: [{ unit: 2, state: "recognised", engine: "tesseract-5.5.0", detail: "", confidence: 0.91,
                     languageCode: "deu", rotation: null }],
          engines: ["tesseract-5.5.0"], enginesRecognised: { "tesseract-5.5.0": 1 },
          primaryReady: false },
      }),
    );
    expect(merged.readBy[2]).toBe("capability-ocr");
    expect(merged.unreadUnits).toEqual([]);
    expect(merged.text).toContain("OCR-ZWEI-SEITE");
    expect(merged.text).toMatch(/\[page 2[^\]]*tesseract-5\.5\.0[^\]]*deu/);
    expect(merged.text).toMatch(/\[page 2[^\]]*0\.91/);
    expect(merged.text).toContain("TS-ONE");
    expect(merged.coverageNote).toContain("1 page(s) recognised by OCR");
  });
  it("a rotated scan says which orientation was corrected, so a page citation stays physical", () => {
    // The renderer, not the user, decided the page was sideways; the delivery has to say so.
    const merged = mergePdfUnits(
      { pages: 2, perPage: ["TS-ONE", ""], pagesWithoutText: [2] },
      doc({
        unitsSucceeded: [1, 2], unitsEmpty: [],
        units: [{ unit: 2, text: "ROTATED-SCAN-TEXT", provenance: "ocr", engine: "tesseract-5.5.3", language: "eng", confidence: 0.83 }],
        ocr: { ran: true, attempted: 2, recognized: 2, language: "eng", languageSource: "request",
          summary: "2/2 page(s) recognised (eng)", reason: "", needsLanguage: false,
          pages: [
            { unit: 2, state: "recognised", engine: "tesseract-5.5.3", detail: "", confidence: 0.83,
              languageCode: "eng", rotation: 90 },
            { unit: 1, state: "recognised", engine: "tesseract-5.5.3", detail: "", confidence: 0.9,
              languageCode: "eng", rotation: null },
          ],
          engines: ["tesseract-5.5.3"], enginesRecognised: { "tesseract-5.5.3": 2 },
          primaryReady: false },
      }),
    );
    expect(merged.coverageNote).toContain("raster rotation applied: page 2 90°");
    expect(merged.coverageNote).not.toMatch(/rotation applied[^;]*page 1/);
  });

  it("a weak TS text layer plus real OCR output keeps BOTH facts and never silently swaps", () => {
    const merged = mergePdfUnits(
      { pages: 1, perPage: ["FEW"], pagesWithoutText: [] },
      doc({
        unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [], unitsNeedingOcr: [1], ocrUnits: [1],
        units: [{ unit: 1, text: "FULL-OCR-LAYER-TEXT", provenance: "ocr", engine: "tesseract-5.5.0", language: "eng", confidence: 0.7 }],
        ocr: { ran: true, attempted: 1, recognized: 1, language: "eng", languageSource: "request",
          summary: "1/1 page(s) recognised (eng)", reason: "", needsLanguage: false,
          pages: [{ unit: 1, state: "recognised", engine: "tesseract-5.5.0", detail: "", confidence: 0.7,
                     languageCode: "eng", rotation: null }],
          engines: ["tesseract-5.5.0"], enginesRecognised: { "tesseract-5.5.0": 1 },
          primaryReady: false },
      }),
    );
    expect(merged.readBy[1]).toBe("ts-text-layer");
    expect(merged.text).toContain("FEW");
    expect(merged.coverageNote).toMatch(/page\(s\) were OCR-flagged and OCR output exists but the TS text layer was kept/);
  });

  it("OCR provenance names the engine that actually read each unit and never dresses recovery up as the primary", () => {
    const merged = mergePdfUnits(
      { pages: 3, perPage: ["", "", ""], pagesWithoutText: [1, 2, 3] },
      doc({
        unitsTotal: 3, unitsSucceeded: [], unitsEmpty: [], unitsNeedingOcr: [1, 2, 3], ocrUnits: [1, 2, 3],
        units: [
          { unit: 1, text: "PRIMARY-LAYOUT-TEXT", provenance: "ocr", engine: "paddleocr-vl-1.6", language: "eng", confidence: 0.93 },
          { unit: 2, text: "RESCUED-BY-TESSERACT", provenance: "ocr", engine: "tesseract-5.5.3.20260724", language: "eng", confidence: 0.61 },
        ],
        unitsFailed: [3],
        ocr: { ran: true, attempted: 3, recognized: 2, language: "eng", languageSource: "request",
          summary: "2/3 page(s) recognised (eng), 0 empty, 1 failed, 0 skipped by cancellation; recognised per engine: {'paddleocr-vl-1.6': 1, 'tesseract-5.5.3.20260724': 1}",
          reason: "", needsLanguage: false,
          pages: [
            { unit: 1, state: "recognised", engine: "paddleocr-vl-1.6", detail: "", confidence: 0.93, languageCode: "eng", rotation: null },
            { unit: 2, state: "recognised", engine: "tesseract-5.5.3.20260724", detail: "primary failed: raster timeout", confidence: 0.61, languageCode: "eng", rotation: null },
            { unit: 3, state: "ocr_failed", engine: "tesseract-5.5.3.20260724", detail: "both engines refused", confidence: null, languageCode: "eng", rotation: null },
          ],
          engines: ["paddleocr-vl-1.6", "tesseract-5.5.3.20260724"],
          enginesRecognised: { "paddleocr-vl-1.6": 1, "tesseract-5.5.3.20260724": 1 },
          primaryReady: true },
      }),
    );
    // Per-unit provenance carries the REAL engine, so page 2 can never be attributed to the primary.
    expect(merged.text).toMatch(/\[page 2[^\]]*tesseract-5\.5\.3/);
    expect(merged.text).toMatch(/\[page 1[^\]]*paddleocr-vl-1\.6/);
    // The coverage note states which engine read what, and names the unit that stayed unread.
    expect(merged.coverageNote).toContain("engines consulted: paddleocr-vl-1.6 -> tesseract-5.5.3.20260724");
    expect(merged.coverageNote).toContain("recognised per engine: paddleocr-vl-1.6=1, tesseract-5.5.3.20260724=1");
    expect(merged.coverageNote).toContain("unresolved after fallback: page 3");
    expect(merged.unreadUnits).toEqual([3]);
  });

  it("a recovery-only OCR run states that the primary engine was NOT ready", () => {
    const merged = mergePdfUnits(
      { pages: 1, perPage: [""], pagesWithoutText: [1] },
      doc({
        unitsTotal: 1, unitsSucceeded: [], unitsEmpty: [], unitsNeedingOcr: [1], ocrUnits: [1],
        units: [{ unit: 1, text: "TESS-ONLY", provenance: "ocr", engine: "tesseract-5.5.3.20260724", language: "eng", confidence: 0.55 }],
        ocr: { ran: true, attempted: 1, recognized: 1, language: "eng", languageSource: "document metadata",
          summary: "1/1 page(s) recognised (eng)", reason: "", needsLanguage: false,
          pages: [{ unit: 1, state: "recognised", engine: "tesseract-5.5.3.20260724", detail: "primary assets absent", confidence: 0.55, languageCode: "eng", rotation: null }],
          engines: ["tesseract-5.5.3.20260724"], enginesRecognised: { "tesseract-5.5.3.20260724": 1 },
          primaryReady: false },
      }),
    );
    expect(merged.coverageNote).toContain("the primary OCR engine was NOT ready");
    expect(merged.coverageNote).toContain("language eng from document metadata");
    // Fallback text still counts as read, but never as primary-engine quality.
    expect(merged.readBy[1]).toBe("capability-ocr");
  });

  it("nothing readable from either engine REFUSES, naming the real blocker and the vision path", () => {
    const merged = mergePdfUnits(
      { pages: 2, perPage: ["", ""], pagesWithoutText: [1, 2] },
      doc({
        unitsTotal: 2, unitsSucceeded: [], unitsEmpty: [1, 2], unitsNeedingOcr: [1, 2], ocrUnits: [1, 2],
      }),
    );
    expect(merged.unreadUnits).toEqual([1, 2]);
    // F12-2: the refusal may only state what the reader MEASURED. "scanned images" was an
    // inference; the measured fact is image content plus no text layer on the named pages.
    expect(merged.refusal).toContain("pages 1, 2 carry image content with no text layer");
    expect(merged.refusal).toContain("engine not executable here");
    expect(merged.refusal).toContain("vision model can read it");
  });

  it("an empty PDF with NO raster evidence is an honest empty read, not a fake scan and not a contract error", () => {
    // F12-2 (ho-empty.pdf): the reader produced no blocks, flagged no page for OCR and found
    // no image XObject anywhere. Inventing a "these are scanned, run OCR" refusal would advertise
    // an OCR job that has nothing to read.
    const merged = mergePdfUnits(
      { pages: 2, perPage: ["", ""], pagesWithoutText: [1, 2] },
      doc({
        unitsTotal: 2, unitsSucceeded: [], unitsEmpty: [1, 2], unitsNeedingOcr: [], ocrUnits: [],
        meta: { page_numbering: "1-based", pages: 2, pages_with_images: { "1": 0, "2": 0 } },
      }),
    );
    expect(merged.refusal).toBe("");
    expect(merged.honestEmpty).toBe(true);
    expect(merged.unreadUnits).toEqual([1, 2]);
    expect(merged.coverageNote).toContain("units: 0 of 2 read");
    expect(merged.text).toContain("no image content on this page");
  });

  it("a capability OCR need plus an unconfigured language says so instead of guessing", () => {
    const merged = mergePdfUnits(
      { pages: 2, perPage: ["TS-ONE", ""], pagesWithoutText: [2] },
      doc({
        unitsTotal: 2, unitsEmpty: [2], unitsNeedingOcr: [2], ocrUnits: [2], unitsSucceeded: [1],
        ocr: { ran: false, attempted: 0, recognized: 0, language: "", summary: "",
          reason: "no document language was given or declared", needsLanguage: true,
          pages: [], engines: [], enginesRecognised: {}, primaryReady: false, languageSource: "" },
      }),
    );
    expect(merged.unreadUnits).toEqual([2]);
    expect(merged.coverageNote).toMatch(/OCR needs an explicit language/);
    expect(merged.text).not.toMatch(/OCR read/);
  });

  it("unit ids decide coverage: a page 2 hole is never a 0-2 prefix", () => {
    const merged = mergePdfUnits(
      { pages: 3, perPage: ["A", "", "C"], pagesWithoutText: [2] },
      doc({ units: [] }),
    );
    expect(merged.readUnits).toEqual([1, 3]);
    expect(merged.coverageNote).toMatch(/read: pages 1, 3/);
    expect(merged.coverageNote).toMatch(/not read: page 2/);
  });

  it("the unit total is the larger of the two readers, never a silent drop", () => {
    const merged = mergePdfUnits(
      { pages: 3, perPage: ["A", "B", "C"], pagesWithoutText: [] },
      doc({ unitsTotal: 5, unitsSucceeded: [1, 2, 3], unitsEmpty: [4, 5], units: [] }),
    );
    expect(merged.pages).toBe(5);
    expect(merged.unreadUnits).toEqual([4, 5]);
  });
});

describe("mergeOfficeText - promotion is measured by CONTENT COVERAGE, never character counts", () => {
  const ws = (s: string) => s.replace(/\s+/g, "").length;
  const office = (kind: string, engine: string, body: string): CapabilityDoc => doc({
    kind, engine, unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [],
    units: [{ unit: 1, text: body, provenance: "text-layer", engine, language: "", confidence: null }],
  });

  it("a LONGER capability body that loses one content item is refused, naming what was lost", () => {
    const tsText = "Q1 120 quarterly ledger";
    const capText = "Q1 quarterly ledger summary overview notes notes notes notes";
    const merged = mergeOfficeText(tsText, office("xlsx", "ruke-ml xlsx reader", capText));
    expect(ws(capText)).toBeGreaterThan(ws(tsText));   // the retired ratio bar would have promoted this
    expect(merged.bodyEngine).toBe("ts");
    expect(merged.text).toContain("Q1 120 quarterly ledger");
    expect(merged.coverageNote).toMatch(/refused as the body: it loses 1 content item\(s\)/);
    expect(merged.coverageNote).toContain("120");
  });

  it("many lost items are named up to LOST_ITEMS_NAMED and then counted, never hidden", () => {
    const items = LOST_ITEMS_NAMED + 4;
    const tsText = Array.from({ length: items }, (_, i) => `item${i} word${i}`).join(" ");
    const merged = mergeOfficeText(tsText, office("xlsx", "ruke-ml xlsx reader", "shared token text text text"));
    expect(merged.bodyEngine).toBe("ts");
    // every distinct token is lost, and the note names 6 of them then counts the rest.
    expect(merged.coverageNote).toContain(`${2 * items} content item(s)`);
    expect(merged.coverageNote).toMatch(new RegExp(`\\+${2 * items - LOST_ITEMS_NAMED} more\\)`));
  });

  it("merged-region repetition is NOT a gain: same distinct items keeps the TS reader", () => {
    // Exactly what the retired ratio bar got wrong: the TS reader repeats one merged
    // block's value across the region it spans, so it has MORE characters for the SAME items.
    const tsText = "Q1 120 Q2 180\nQ1 120 Q2 180\nQ1 120 Q2 180";
    const capText = "Q1 120 Q2 180";
    const merged = mergeOfficeText(tsText, office("xlsx", "ruke-ml xlsx reader", capText));
    expect(ws(tsText)).toBeGreaterThan(ws(capText));
    expect(merged.bodyEngine).toBe("ts");
    expect(merged.coverageNote).toMatch(/carries the same 4 content item\(s\) as the TS reader and adds nothing/);
    expect(merged.coverageNote).toMatch(/not a language preference/);
  });

  it("a body that adds content and groups TS lines is promoted, and the note says why", () => {
    const tsText = "Payments\nAna";
    const capText = "Payments Ana paid the freight invoice in March 2026";
    const merged = mergeOfficeText(tsText, office("docx", "ruke-ml docx reader", capText));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.text).toContain("freight invoice in March 2026");
    expect(merged.coverageNote).toMatch(/chosen over the TS reader/);
    expect(merged.coverageNote).toMatch(/adds \d+ new item\(s\) plus 1 structurally grouped line\(s\)/);
  });

  it("the reader's own rendering is preferred over joined blocks and is labelled as such", () => {
    const merged = mergeOfficeText("Payments | Ana\nLedger | 99.9", doc({
      kind: "docx", engine: "ruke-ml docx reader", unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [],
      units: [{ unit: 1, text: "Payments Ana Ledger 99.9", provenance: "text-layer", engine: "ruke-ml docx reader", language: "", confidence: null }],
      rendered: [{
        unit: 1, blocks: 4, truncated: false, provenance: "text-layer", engine: "ruke-ml docx reader",
        text: "### tables in this document: 1\n| Payments | Ana | [table 1 row 1 of 2 cell(s)]\n| Ledger | 99.9 | [table 1 row 2 of 2 cell(s)]",
      }],
    }));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.text).toContain("[table 1 row 1 of 2 cell(s)]");
    expect(merged.text).not.toContain("Payments Ana Ledger 99.9");
    expect(merged.coverageNote).toMatch(/measured on the reader's own structure-preserving rendering/);
  });

  it("a rendering that hit its character cap says so; blocks still carry the rest", () => {
    const merged = mergeOfficeText("small body", doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [],
      rendered: [{
        unit: 1, blocks: 900, truncated: true, provenance: "text-layer", engine: "ruke-ml xlsx reader",
        text: "small body A1=1 [merged A1:B3]",
      }],
    }));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.coverageNote).toMatch(/per-unit character cap/);
  });

  it("no rendering from an older backend is measured as joined blocks, honestly labelled", () => {
    const merged = mergeOfficeText("ALPHA BETA", doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", units: [
        { unit: 1, text: "ALPHA BETA GAMMA", provenance: "text-layer", engine: "ruke-ml xlsx reader", language: "", confidence: null },
      ],
    }));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.coverageNote).toMatch(/measured on joined block texts \(this backend ships no rendering\)/);
  });

  it("Unicode survives promotion byte-for-byte", () => {
    const tsText = "kuchlu";
    const capText = "kuchlu Türkçe ağırlık ölçüleri - İstanbul 2026";
    const merged = mergeOfficeText(tsText, office("xlsx", "ruke-ml xlsx reader", capText));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.text).toContain("Türkçe ağırlık ölçüleri - İstanbul 2026");
  });

  it("when the TS reader produced nothing, the capability body serves rather than refusing", () => {
    const merged = mergeOfficeText("", office("pptx", "ruke-ml pptx reader", "SLIDE-TITLE notes carried"));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.text).toContain("SLIDE-TITLE");
  });

  it("a capability document with failed units keeps those ids in the note even when TS served the body", () => {
    const merged = mergeOfficeText("TS-BODY-WITH-LONG-ENOUGH-CONTENT-TO-CARRY-THE-TEST", doc({
      kind: "pptx", engine: "ruke-ml pptx reader", unitsTotal: 4, unitsSucceeded: [1, 2],
      unitsEmpty: [], unitsFailed: [3, 4], units: [],
    }));
    expect(merged.bodyEngine).toBe("ts");
    expect(merged.unreadUnits).toEqual([3, 4]);
    expect(merged.coverageNote).toMatch(/failed units: 3, 4/);
  });

  it("an honest corruption report beats a TS body that printed placeholder text (F12-1)", () => {
    // ho-corrupt.xlsx measured: the TS OOXML reader renders an out-of-range shared-string index
    // as "(shared string #99 missing)" and passes the stored #REF! through. Counting those as
    // "content the TS reader read" made the LAW reward fabrication, so the honest reader was
    // refused for losing them. Reader plumbing is now excluded from BOTH sides. The cell
    // REFERENCE stays on the TS side as real content: the honest body must name the same cell,
    // which is why a silent reader could never win here.
    const tsText = [
      "A1=(shared string #99 missing)\tA2=only string\tA3=#REF!",
      // A cell whose stored text the TS reader could not render: the TS line is plumbing, but
      // it does assert that B1 EXISTS. The capability reader reports that as a declared-empty
      // cell (measured behaviour of the ruke-ml xlsx reader), so nothing is lost.
      "B1=[formula present but neither expression nor cached value stored]",
    ].join("\n");
    const capText = [
      "### cells this reader could NOT read: A1: shared-string index 99 out of range (sheet Torn); A3: stored error type value (sheet Torn) - reported by reference and reason; they are NOT blank and NOT zero",
      "A2=only string",
      "### declared-empty cells in this worksheet (1): B1 - these cells exist and hold no value; an empty cell is not zero",
    ].join("\n");
    const stripped = stripReaderArtifacts(tsText);
    expect(stripped.dropped).toBe(3);
    const merged = mergeOfficeText(tsText, doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [1],
      unitsEmpty: [], unitsFailed: [],
      rendered: [{ unit: 1, text: capText, provenance: "text-layer", engine: "ruke-ml xlsx reader", blocks: 1, truncated: false }],
    }));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.text).toContain("cells this reader could NOT read");
    expect(merged.text).not.toContain("(shared string #99 missing)");
    expect(merged.text).toContain("B1");
    expect(merged.coverageNote).toMatch(/reader artifact rendering\(s\).*excluded from the loss measurement/);
    expect(merged.coverageNote).toMatch(/body_source: capability:/);
  });

  it("structure facts alone decide a tie the content-item set could not see (F12-3)", () => {
    // Same distinct CONTENT ITEMS on both sides - the TS side here is a deliberately flat
    // word-soup that contains every token the capability body uses, so the content-item law
    // measures a perfect tie (lostTokens empty, newTokens 0). Only the capability body states
    // WHICH merged area each value spans and which cells exist but hold no value, so the
    // structure measurement is what decides, and the note must say so.
    const tsText = "worksheet declared-empty cells in this 2 C1 C2 C3 A1 title merged A2 qty " +
      "B1 2 B2 3 these exist and hold no value an empty cell is not zero";
    const capText = [
      "A1=title [merged A1:C1]",
      "A2=qty [merged A2:C2]",
      "B1=2\tB2=3",
      "### declared-empty cells in this worksheet (2): C1, C3 - these cells exist and hold no value; an empty cell is not zero",
    ].join("\n");
    const tie = measureContentCoverage(tsText, capText);
    expect(tie.lostTokens).toEqual([]);
    expect(tie.newTokens).toBe(0);          // the retired law would have stopped here and kept TS
    const capFacts = countStructureFacts(capText);
    expect(countStructureFacts(tsText).mergedAttributions).toBe(0);
    expect(countStructureFacts(tsText).declaredEmptyCells).toBe(0);
    expect(capFacts.mergedAttributions).toBe(2);
    expect(capFacts.declaredEmptyCells).toBe(2);
    expect(structureTotal(capFacts)).toBeGreaterThan(0);
    const merged = mergeOfficeText(tsText, doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [],
      rendered: [{ unit: 1, text: capText, provenance: "text-layer", engine: "ruke-ml xlsx reader", blocks: 4, truncated: false }],
    }));
    expect(merged.bodyEngine).toBe("capability");
    expect(merged.coverageNote).toMatch(/plus structure: capability \d+ structural fact\(s\)/);
  });

  it("the coverage statement is delivered with the body in BOTH branches, not only on promotion", () => {
    const merged = mergeOfficeText("Q1 120 quarterly ledger", doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [],
      units: [{ unit: 1, text: "Q1 quarterly ledger summary", provenance: "text-layer", engine: "ruke-ml xlsx reader", language: "", confidence: null }],
    }));
    expect(merged.bodyEngine).toBe("ts");
    expect(merged.text.startsWith("[document capability documents.parse")).toBe(true);
    expect(merged.text).toContain("units: 1 of 1 read");
    expect(merged.text).toContain("Q1 120 quarterly ledger");
  });

  it("a corrupt unit named by the reader is flagged as unconfirmed when the TS body still carries it (F12-4)", () => {
    const merged = mergeOfficeText("A1=fabricated A2=only string", doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [], unitsEmpty: [],
      unitsFailed: [1],
      meta: {
        page_numbering: "1-based",
        sheet_failures: [{ sheet: "Torn", sheet_index: 1, part: "xl/worksheets/sheet1.xml", why: "not well-formed XML" }],
      },
      units: [],
    }));
    expect(merged.bodyEngine).toBe("ts");
    expect(merged.unitFailures).toEqual(["sheet Torn (unit 1): not well-formed XML [part xl/worksheets/sheet1.xml]"]);
    expect(merged.coverageNote).toMatch(/unit failures: sheet Torn \(unit 1\): not well-formed XML/);
    expect(merged.coverageNote).toMatch(/treat those units as unconfirmed/);
  });

  it("no engine produced any text and a unit failed: REFUSAL naming the reader's reason, never empty success", () => {
    const merged = mergeOfficeText("", doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [], unitsEmpty: [],
      unitsFailed: [1],
      meta: { page_numbering: "1-based", sheet_failures: [{ sheet: "Torn", sheet_index: 1, part: "xl/worksheets/sheet1.xml", why: "not well-formed XML" }] },
      units: [],
    }));
    expect(merged.bodyEngine).toBe("ts");
    expect(merged.honestEmpty).toBe(false);
    expect(merged.refusal).toContain("could not read unit(s) 1");
    expect(merged.refusal).toContain("not well-formed XML");
    expect(merged.refusal).toContain("vision model can read it");
    expect(merged.coverageNote).toMatch(/units: 0 of 1 read/);
  });

  it("every unit declared empty with no text anywhere is an honest empty workbook, not a refusal", () => {
    const merged = mergeOfficeText("", doc({
      kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 2, unitsSucceeded: [], unitsEmpty: [1, 2],
      unitsFailed: [], units: [],
    }));
    expect(merged.refusal).toBe("");
    expect(merged.honestEmpty).toBe(true);
    expect(merged.coverageNote).toMatch(/units: 0 of 2 read/);
    expect(merged.unitFailures).toEqual([]);
  });
});

describe("measureContentCoverage - the promotion bar itself, tested apart from the merge", () => {
  it("a capability body missing one token is never a superset", () => {
    const c = measureContentCoverage("alpha beta 42", "alpha beta gamma delta");
    expect(c.lostTokens).toEqual(["42"]);
    expect(c.newTokens).toBe(2);
    expect(c.tsItems).toBe(3);
  });

  it("line matching is token-boundary safe: ana is not inside analog, 99.9 is not inside 99.95", () => {
    const c = measureContentCoverage("ana 99.9", "analog 99.95");
    expect(c.lostTokens).toContain("9");              // "99.9" is a different item from "99.95"
    expect(c.lostLines).toBe(1);
    expect(c.rebuiltLines).toBe(0);
  });

  it("a capability body that re-broke a line but carried every item is a rebuild, not a loss", () => {
    const c = measureContentCoverage("alpha beta gamma delta epsilon zeta eta theta iota kappa", "alpha beta gamma delta epsilon\nzeta eta theta iota kappa lambda");
    expect(c.lostTokens).toEqual([]);
    expect(c.lostLines).toBe(0);
    expect(c.rebuiltLines).toBe(1);
  });

  it("a capability line that carries two TS lines is counted as structural grouping", () => {
    const c = measureContentCoverage("Payments\nAna", "Payments Ana");
    expect(c.groupedLines).toBe(1);
    expect(c.lostTokens).toEqual([]);
    expect(c.lostLines).toBe(0);
    expect(c.rebuiltLines).toBe(0);          // both lines are carried whole, not re-broken
    expect(c.tsLines).toBe(2);
  });

  it("CJK and underscore identifiers survive tokenisation intact", () =>
    {
      const c = measureContentCoverage("数据集 quarterly_report_v2", "数据集 quarterly_report_v2 附加说明");
      expect(c.lostTokens).toEqual([]);
      expect(c.newTokens).toBe(1);
    });

  it("an empty capability body loses every TS item (so nothing is promoted on an empty reader)", () => {
    const c = measureContentCoverage("alpha beta", "   ");
    expect(c.lostTokens.sort()).toEqual(["alpha", "beta"]);
    expect(c.newTokens).toBe(0);
  });
});

describe("normalizeDocument - the reader's own rendering reaches the merge layer", () => {
  const realResult = (REAL_READY_ENVELOPE as unknown as { result: unknown }).result;
  const cloneResult = (): Record<string, unknown> => JSON.parse(JSON.stringify(realResult));

  it("rendered_units become CapabilityDoc.rendered, with provenance, engine and truncation", () => {
    const payload = cloneResult();
    (payload.payload as Record<string, unknown>).rendered_units = [
      { unit: 1, text: "A1=1 [merged A1:B3]", provenance: "text-layer", engine: "ruke-ml xlsx reader", blocks: 3, truncated: false },
      { unit: 3, text: "OCR PAGE THREE", provenance: "ocr", engine: "tesseract-5.5.0-deu", blocks: 2, truncated: true },
      { unit: 2, text: "   ", provenance: "text-layer", engine: "x", blocks: 0, truncated: false },
      "not-an-object",
    ];
    const parsed = normalizeDocument(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.rendered.map((r) => r.unit)).toEqual([1, 3]);
    expect(parsed?.rendered[1].provenance).toBe("ocr");
    expect(parsed?.rendered[1].truncated).toBe(true);
    expect(parsed?.rendered[0].blocks).toBe(3);
  });

  it("an unknown provenance string is coerced, and a missing engine falls back to the coverage method", () => {
    const payload = cloneResult();
    (payload.payload as Record<string, unknown>).rendered_units = [
      { unit: 1, text: "SHEET ONE", provenance: "magic", blocks: 1 },
    ];
    const parsed = normalizeDocument(payload);
    expect(parsed?.rendered[0].provenance).toBe("text-layer");
    expect(parsed?.rendered[0].engine).toBe("pypdf-7.1.0-plain");
  });

  it("no rendered_units from an older backend is an empty list, not a failure", () => {
    const parsed = normalizeDocument(cloneResult());
    expect(parsed).not.toBeNull();
    expect(parsed?.rendered).toEqual([]);
    expect(parsed?.units.length).toBeGreaterThan(0);
  });
  it("the rotation the renderer actually applied survives normalization, normalised to 0-359", () => {
    // The python raster says how it turned the page; a delivery that drops that fact cannot
    // honestly claim a rotated scan was read.
    const payload = cloneResult();
    (payload.payload as Record<string, unknown>).ocr = {
      ran: true,
      pages: [
        { page: 1, state: "recognised", engine: "paddleocr-vl-1.6", raster: { rotation: 90 } },
        { page: 2, state: "recognised", engine: "paddleocr-vl-1.6", raster: { rotation: -90 } },
        { page: 3, state: "recognised", engine: "tesseract-5.5.3", raster: { rotation: 0 } },
        { page: 4, state: "not_read", engine: "paddleocr-vl-1.6" },
      ],
    };
    const parsed = normalizeDocument(payload);
    expect(parsed?.ocr.pages.map((o) => o.unit)).toEqual([1, 2, 3, 4]);
    expect(parsed?.ocr.pages.map((o) => o.rotation)).toEqual([90, 270, null, null]);
  });
});

describe("extractFileFromPath - the capability seam through the real entry point", () => {
  it("a capability-ready scan hole is delivered with per-page provenance and a coverage note", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05int_"));
    const src = write(dir, "hole.pdf", makePdf(["MARGIN-REPORT-TEXT", null, "LATE-EVIDENCE-ZEPHYR"]));
    const r = await extractFileFromPath("hole.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(REAL_READY_ENVELOPE),
    });
    expect(r.category).toBe("pdf");
    expect(r.pages).toBe(3);
    expect(r.text).toContain("MARGIN-REPORT-TEXT");
    expect(r.text).toContain("zephyr-9");
    expect(r.text).toMatch(/\[page 2/);
    expect(r.text).toMatch(/OCR did not run/);
    expect(r.coverageNote).toMatch(/not read: page 2/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("a capability refusal keeps the I06 refusal wording AND names the capability blocker", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05int_"));
    const src = write(dir, "scan.pdf", makePdf([null, null]));
    const envelope = {
      state: "unavailable", capability: "documents.parse", job_id: "j", run_id: "r", request_id: "q",
      deadline_s: 60, source: "rust-ml-job",
      error: {
        reason: "not_configured", capability: "documents.parse", retryable: true,
        message: "documents.ocr: no validated tesseract copy (override, PATH or project-local)",
        human_step: "install or point RUKE_TESSERACT at a validated OCR engine",
      },
    } as unknown as MlJobEnvelope;
    await expect(extractFileFromPath("scan.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(envelope),
    })).rejects.toThrow(/has no text layer . all 2 page\(s\) are scanned images/);
    await expect(extractFileFromPath("scan.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(envelope),
    })).rejects.toThrow(/RUKE_TESSERACT/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("a cancelled capability job is reported as cancelled, never as a document defect", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f05int_"));
    const src = write(dir, "scan2.pdf", makePdf([null]));
    const envelope = {
      state: "cancelled", capability: "documents.parse", job_id: "j", run_id: "r", request_id: "q",
      deadline_s: 60, source: "rust-ml-job",
      error: { reason: "cancelled", capability: "documents.parse", retryable: true, message: "cancelled", human_step: "re-run" },
    } as unknown as MlJobEnvelope;
    const outcome = await readDocumentViaCapability(src, { runJob: runJobReturning(envelope) });
    expect(outcome.state).toBe("unavailable");
    if (outcome.state === "unavailable") expect(outcome.reason).toBe("cancelled");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
