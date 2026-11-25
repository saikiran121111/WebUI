/**
 * F153 (2026-11-25) — the ready-as-complete law for a capability failure.
 *
 * Live chain: f152-survey.pdf uploaded, the document capability pass hit its
 * 90 s parse deadline (95 s with the RPC grace), pdf.js served the text layer,
 * and the attachment recorded READY with ZERO frames and no page-level
 * statement that the visual/OCR pass never ran. Every later question about a
 * figure answered from chunks that claimed a complete read.
 *
 * Laws pinned here:
 *  1. a capability failure (typed envelope) over a document whose TS reader
 *     worked is an HONEST PARTIAL, never a complete record: the delivered
 *     text carries a coverage sentence naming the pages/units NOT inspected
 *     as images and saying the read is retryable (the I06 law: partial
 *     coverage rides INTO the indexed text, not only a side field);
 *  2. zero frames with an unannounced visual pass is the lie — the side
 *     coverageNote carries the same page-level sentence, so the attachment
 *     record tells the user exactly what could not be read;
 *  3. the sentence is per-page (<=15 listed, larger collapses to a count);
 *  4. a deployment with NO capability route (state "none") keeps its silence:
 *     that is a configuration fact, not a per-file coverage gap;
 *  5. Office follows the same law: embedded images/charts the reader never
 *     rendered are named as uninspected and retryable.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

import {
  DOCUMENT_PARSE_CAPABILITY,
  type MlJobEnvelope,
  type RunJob,
} from "../../lib/server/extract/document-capability";
import { extractFileFromPath } from "../../lib/server/extract";
import { makePdf } from "./make-pdf";

const SCRATCH = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f153cov_"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const write = (name: string, buf: Buffer): string => {
  const p = path.join(SCRATCH, name);
  fs.writeFileSync(p, buf);
  return p;
};

/** The exact envelope the mlJob seam returns when the parse deadline fires. */
const deadlineEnvelope: MlJobEnvelope = {
  state: "failed",
  capability: DOCUMENT_PARSE_CAPABILITY,
  job_id: "job_f153",
  run_id: "run_f153",
  request_id: "req_f153",
  deadline_s: 90,
  source: "rust-ml-job",
  error: {
    reason: "deadline_exceeded",
    message: "the capability backend did not answer within 95000 ms",
    retryable: true,
    capability: DOCUMENT_PARSE_CAPABILITY,
    human_step: "retry, or ask for a narrower range",
  },
} as unknown as MlJobEnvelope;

const runJobReturning = (envelope: MlJobEnvelope | null): RunJob =>
  (async () => envelope) as RunJob;

describe("F153: a capability timeout over a working TS read is an honest partial", () => {
  it("the 2-page survey PDF: no frames, and BOTH channels say pages 1, 2 were never inspected as images", async () => {
    const src = write("f153-survey.pdf", makePdf(["SURVEY-TITLE-AND-FINDINGS", "page two body text"]));
    const r = await extractFileFromPath("f153-survey.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(deadlineEnvelope),
    });
    expect(r.category).toBe("pdf");
    expect(r.text).toContain("SURVEY-TITLE-AND-FINDINGS"); // the usable pdf.js layer survives
    expect(r.frames).toBeUndefined(); // zero frames — the visual pass never ran
    // The coverage sentence rides the delivered (and indexed) text, up front.
    expect(r.text).toMatch(/NOT inspected as images/);
    expect(r.text).toContain("deadline_exceeded");
    expect(r.text).toMatch(/retryable/i);
    expect(r.text).toMatch(/page\(s\) 1, 2/);
    // The attachment record carries the same statement (the side field).
    expect(r.coverageNote).toBeTruthy();
    expect(r.coverageNote).toMatch(/NOT inspected as images/);
    expect(r.coverageNote).toMatch(/retryable/i);
    expect(r.coverageNote).toContain("deadline_exceeded");
  }, 60_000);

  it("a scanned page keeps BOTH coverage statements: no text layer AND no image inspection", async () => {
    const src = write("f153-mixed.pdf", makePdf(["TEXT-LAYER-PAGE-ONE", null]));
    const r = await extractFileFromPath("f153-mixed.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(deadlineEnvelope),
    });
    expect(r.text).toContain("image-only (scanned) pages: 2");
    expect(r.text).toMatch(/NOT inspected as images/);
    expect(r.coverageNote).toMatch(/NOT inspected as images/);
  }, 60_000);

  it("the statement collapses to a count past 15 pages, never a wall of numbers", async () => {
    const pages = Array.from({ length: 17 }, (_, i) => (i === 0 ? "FIRST-PAGE-TEXT" : null));
    const src = write("f153-many.pdf", makePdf(pages));
    const r = await extractFileFromPath("f153-many.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(deadlineEnvelope),
    });
    expect(r.coverageNote).toMatch(/all 17 pages/);
  }, 60_000);

  it("NO capability route in this deployment stays silent (config fact, not a coverage gap)", async () => {
    const src = write("offline-clean.pdf", makePdf(["OFFLINE-TEXT-PAGE"]));
    const r = await extractFileFromPath("offline-clean.pdf", src, undefined, undefined, undefined, {
      runJob: runJobReturning(null),
    });
    expect(r.text).toContain("OFFLINE-TEXT-PAGE");
    expect(r.text).not.toMatch(/NOT inspected as images/);
  }, 60_000);

  it("DOCX: embedded images the capability reader never rendered are named, retryable, in both channels", async () => {
    const docx = Buffer.from(
      zipSync({
        "word/document.xml": strToU8(
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          "<w:body><w:p><w:r><w:t>DOCX-F153-BODY-MARKER</w:t></w:r></w:p></w:body></w:document>",
        ),
      }),
    );
    const src = write("f153-report.docx", docx);
    const r = await extractFileFromPath("f153-report.docx", src, undefined, undefined, undefined, {
      runJob: runJobReturning(deadlineEnvelope),
    });
    expect(r.category).toBe("office");
    expect(r.text).toContain("DOCX-F153-BODY-MARKER");
    expect(r.text).toMatch(/embedded images[^\n]*NOT rendered/i);
    expect(r.text).toMatch(/retryable/i);
    expect(r.coverageNote).toMatch(/embedded images[^\n]*NOT rendered/i);
    expect(r.coverageNote).toContain("deadline_exceeded");
  }, 60_000);
});
