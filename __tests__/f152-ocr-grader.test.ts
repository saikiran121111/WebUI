import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  selectRecordsForSource, parseRegionReport, gradeOcrExecution, gradeOcrRecovery,
  combineFacts, gradeCropDelivery, type OcrRecordEntry,
} from "../tests/lib/f152-ocr-grader";

/**
 * F153 audit repairs 4 + 5 — deterministic negative controls for the live
 * spec's OCR/crop graders (tests/lib/f152-ocr-grader). The live run to beat:
 * the engine RAN on the region, returned NOTHING (0/1 recognised, 2 engine
 * calls), the model answered the label from pixels — and the old P4 PASSED
 * "OCR recovered the label" because it searched serialized JSON for the sha
 * and serialized units for the label. Every control below is a case the old
 * grading accepted; the new grading must reject it.
 */

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const LABEL = "KAPPA 9";

const pngBytes = (tag: string) => Buffer.from(`png:${tag}`, "utf8");
const shaOf = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
const imgPart = (buf: Buffer) => ({
  type: "image_url", image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
});
const txt = (s: string) => ({ type: "text", text: s });

const durable = (over: Partial<OcrRecordEntry["body"]> = {}): OcrRecordEntry => ({
  name: "rec.json",
  body: {
    job_id: "job-1", written_at: "2026-11-24T00:00:00+0000",
    source: { sha256: SHA, size_bytes: 10, hash_basis: "sha256 over all 10 bytes" },
    pipeline: { primary_engine: "paddle", engines_used: ["tesseract"] },
    units: [{ page: 1, state: "recognised", text: "KAPPA 9", engine: "tesseract" }],
    coverage: { requested: 1, read: 1, complete: true },
    ...over,
  },
});

describe("repair 4: structured source selection", () => {
  it("a record that only MENTIONS the sha in prose is NOT this file's OCR record", () => {
    // The old ocrRecordFor searched JSON.stringify(body).includes(sha): a
    // record about a DIFFERENT source whose limitation note quotes the sha
    // (or whose path string contains it) was selected as evidence.
    const mentioner: OcrRecordEntry = {
      name: "other.json",
      body: {
        source: { sha256: OTHER_SHA },
        pipeline: { engines_used: ["tesseract"] },
        units: [{ page: 1, state: "recognised", text: `note: ${SHA} seen once`, engine: "tesseract" }],
        coverage: { read: 1 },
      },
    };
    expect(selectRecordsForSource([mentioner], SHA)).toEqual([]);
    expect(selectRecordsForSource([durable()], SHA).length).toBe(1);
    expect(selectRecordsForSource([durable()], SHA)[0].body.source?.sha256).toBe(SHA);
  });
});

describe("repair 4: OCR EXECUTION verdict", () => {
  it("the live run's shape passes EXECUTION on the report channel (probe + engine calls), recovery graded separately", () => {
    const report = parseRegionReport("0/1 region(s) recognised; states {'empty': 1}; probe passes 1, engine calls 2")!;
    const v = gradeOcrExecution({ records: [], report, sourceSha: SHA, regionUnit: 1 });
    expect(v.ok).toBe(true);
    expect(v.channel).toBe("region-report");
    expect(v.invocations).toBe(2);
  });
  it("zero probe passes fails: the region was never inspected", () => {
    const report = parseRegionReport("0/1 region(s) recognised; states {'skipped': 1}; probe passes 0, engine calls 0")!;
    const v = gradeOcrExecution({ records: [], report, sourceSha: SHA, regionUnit: 1 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/never inspected/);
  });
  it("a recognised claim with no durable record fails: persistence is broken", () => {
    const report = parseRegionReport("1/1 region(s) recognised; states {'recognised': 1}; probe passes 1, engine calls 1")!;
    const v = gradeOcrExecution({ records: [], report, sourceSha: SHA, regionUnit: 1 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/durable persistence is broken/);
  });
  it("a durable record with no adapter evidence fails (primary_engine alone is a selection, not a run)", () => {
    const rec = durable({ pipeline: { primary_engine: "paddle", engines_used: [] }, units: [{ page: 1, state: "recognised", text: "KAPPA 9", engine: "none" }] });
    const v = gradeOcrExecution({ records: [rec], report: null, sourceSha: SHA, regionUnit: 1 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/no adapter recorded/);
  });
  it("engine-ran-empty region: EXECUTION passes (state empty, engine named); recovery is the FAIL, not this", () => {
    const rec = durable({ units: [{ page: 1, state: "empty", text: "", engine: "tesseract" }] });
    const v = gradeOcrExecution({ records: [rec], report: null, sourceSha: SHA, regionUnit: 1 });
    expect(v.ok).toBe(true);
    expect(v.regionState).toBe("empty");
    const r = gradeOcrRecovery({ records: [rec], sourceSha: SHA, regionUnit: 1, labelText: LABEL });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("FAIL");
  });
});

describe("repair 4: OCR RECOVERY reads the unit's TEXT field", () => {
  it("label only in unit METADATA (detail/raster/lines), recognized text empty: FAIL", () => {
    // The old grade searched JSON.stringify(units): bbox JSON, detail notes
    // and provenance strings carrying the label counted as recognition.
    const rec = durable({
      units: [{
        page: 1, state: "empty", text: "", engine: "tesseract",
        detail: `probe saw glyph cluster; ${LABEL} expected by fixture`,
        raster: { label: LABEL }, lines: [{ text: LABEL }],
      }],
      coverage: { read: 1 },
    });
    const v = gradeOcrRecovery({ records: [rec], sourceSha: SHA, regionUnit: 1, labelText: LABEL });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/recognized text/);
  });
  it("partial label without the digit is NOT recovery (full-label law)", () => {
    const rec = durable({ units: [{ page: 1, state: "recognised", text: "KAPPA", engine: "tesseract" }] });
    expect(gradeOcrRecovery({ records: [rec], sourceSha: SHA, regionUnit: 1, labelText: LABEL }).ok).toBe(false);
  });
  it("recognized text with no producing engine is not attributable: FAIL", () => {
    const rec = durable({ units: [{ page: 1, state: "recognised", text: "KAPPA 9", engine: "none" }] });
    expect(gradeOcrRecovery({ records: [rec], sourceSha: SHA, regionUnit: 1, labelText: LABEL }).ok).toBe(false);
  });
  it("full label in the exact region's text from a named engine: PASS", () => {
    const v = gradeOcrRecovery({ records: [durable()], sourceSha: SHA, regionUnit: 1, labelText: LABEL });
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe("PASS");
    expect(v.engine).toBe("tesseract");
  });
  it("the three facts survive together, in the brief's words", () => {
    expect(combineFacts(true, true, false))
      .toBe("vision label PASS; OCR execution PASS; OCR recovery FAIL.");
  });
});

describe("repair 5: crop delivery correlates to the ANSWERING request's current-user content", () => {
  const crop = pngBytes("crop");
  const cropSha = shaOf(crop);
  const prompt = "What is the label printed in the image?";
  const body = (messages: any[]) => ({ messages });
  const userTurn = (extra: any[] = []) => ({ role: "user", content: [txt(prompt), ...extra] });

  it("crop in the answering request's current-user content: PASS", () => {
    const v = gradeCropDelivery({ bodies: [body([userTurn([imgPart(crop)])])], cropSha, promptText: prompt });
    expect(v.ok).toBe(true);
    expect(v.cropInCurrentUser).toBe(true);
  });
  it("NEGATIVE: crop only in HISTORY of the answering request: FAIL", () => {
    const v = gradeCropDelivery({
      bodies: [body([
        { role: "user", content: [txt("previous turn"), imgPart(crop)] },
        userTurn(),
      ])],
      cropSha, promptText: prompt,
    });
    expect(v.ok).toBe(false);
    expect(v.historyOnly).toBe(true);
  });
  it("NEGATIVE: crop only in a DIFFERENT captured request: FAIL", () => {
    const v = gradeCropDelivery({
      bodies: [body([userTurn([imgPart(crop)])]), body([userTurn()])],
      cropSha, promptText: prompt,
    });
    expect(v.ok).toBe(false);
    expect(v.otherRequestOnly).toBe(true);
  });
  it("NEGATIVE: answering request not carrying this turn's prompt is not correlated: FAIL", () => {
    const v = gradeCropDelivery({
      bodies: [body([{ role: "user", content: [txt("some other question"), imgPart(crop)] }])],
      cropSha, promptText: prompt,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/not correlated/);
  });
  it("crop on the current-user content PLUS an older copy (multi-turn chat) still PASSes", () => {
    const v = gradeCropDelivery({
      bodies: [body([
        { role: "user", content: [txt("earlier upload"), imgPart(crop)] },
        userTurn([imgPart(crop)]),
      ])],
      cropSha, promptText: prompt,
    });
    expect(v.ok).toBe(true);
  });
  it("no captured request at all: impossible, FAIL — not a vacuous pass", () => {
    const v = gradeCropDelivery({ bodies: [], cropSha, promptText: prompt });
    expect(v.ok).toBe(false);
  });
});
