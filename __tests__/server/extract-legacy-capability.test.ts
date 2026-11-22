/**
 * F78 family D - legacy binary formats (.doc/.xls/.ppt/.mat) go through the
 * documents.parse capability FIRST; the printable-run byte scan stays only as
 * the labeled fallback.
 *
 * Laws:
 *  1. a real structured capability parse serves its body, with
 *     `body_source: capability:<engine>` stated - the byte scan is not consulted;
 *  2. a typed refusal (malformed OLE -> the capability reports 0 readable units)
 *     and an offline backend (envelope null) keep the EXACT legacy label so a
 *     partial recovery is never read as a faithful extract;
 *  3. scan finds nothing AND the reader declined: the error names both facts;
 *  4. the capability is invoked with the documents.parse capability on the
 *     resolved path.
 *
 * The ready envelopes mirror the real adapter shape (rendered_units from
 * python-backend ruke_ml.documents.render.render_units).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { DOCUMENT_PARSE_CAPABILITY, type MlJobEnvelope, type RunJob } from "../../lib/server/extract/document-capability";
import { extractFileFromPath } from "../../lib/server/extract";

const LEGACY_LABEL =
  "[legacy binary format: text recovered by scanning raw bytes for printable runs — layout, formatting, and non-printable-encoded characters are lost; treat as a partial recovery]";

const structuredEnvelope = (kind: string, engine: string, unitText: string, unitsTotal = 1): MlJobEnvelope =>
  ({
    state: "ready",
    capability: DOCUMENT_PARSE_CAPABILITY,
    job_id: "job_f78", run_id: "run_f78", request_id: "req_f78", deadline_s: 90,
    source: "rust-ml-job",
    result: {
      payload: {
        coverage_complete: true,
        document: {
          kind,
          blocks: [],
          coverage: {
            method: engine,
            note: "",
            units_total: unitsTotal, units_extracted: unitsTotal,
            units_succeeded: [1], units_empty: [], units_needing_ocr: [], units_failed: [],
          },
          meta: {}, source_id: "x", source_hash: "h",
        },
        rendered_units: [
          { unit: 1, text: unitText, provenance: "text-layer", engine, blocks: 4, truncated: false },
        ],
        ocr: { ran: false, pages: [], engines_recognised: {} },
      },
      coverage: { units: "units", total_source: unitsTotal, complete: true, note: "" },
    },
  }) as unknown as MlJobEnvelope;

/** Ready envelope carrying the typed refusal: 0 readable units is normalizeDocument's null. */
const REFUSAL_ENVELOPE = structuredEnvelope("unsupported", "none", "", 0);

const runJobReturning = (envelope: MlJobEnvelope | null): RunJob & { calls: unknown[][] } => {
  const fn = (async (capability: string, payload: Record<string, unknown>) => {
    fn.calls.push([capability, payload]);
    return envelope;
  }) as RunJob & { calls: unknown[][] };
  fn.calls = [];
  return fn;
};

const scratch = (name: string, buf: Buffer): string => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f78leg_"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

/** Bytes whose printable runs the scan CAN recover (so fallback is observable). */
const scannable = (marker: string): Buffer =>
  Buffer.concat([Buffer.alloc(0x200), Buffer.from(` ${marker} recovered run text `, "latin1"), Buffer.alloc(16)]);

describe("extractFileFromPath - legacy binaries are capability-first", () => {
  it("a real structured .doc parse serves the capability body, not the byte scan", async () => {
    const src = scratch("policy.doc", scannable("WORDSCAN-JUNK-RUNTEXT"));
    const run = runJobReturning(structuredEnvelope(
      "doc", "word97-worddocument",
      "### WordDocument stream\nVisible body: Word 97-SR2 build CEDARDOC-910",
    ));
    const r = await extractFileFromPath("policy.doc", src, undefined, undefined, undefined, { runJob: run });
    expect(r.category).toBe("legacy");
    expect(r.text).toContain("Word 97-SR2 build CEDARDOC-910");
    expect(r.text).toContain("body_source: capability:word97-worddocument");
    expect(r.text).not.toContain("scanning raw bytes");
    expect(run.calls[0][0]).toBe(DOCUMENT_PARSE_CAPABILITY);
  });

  it("a .mat parse delivers the exact numeric values", async () => {
    const src = scratch("sample.mat", scannable("MATSCAN-JUNK"));
    const run = runJobReturning(structuredEnvelope(
      "mat", "mat-numeric",
      "### variables: yields (values are column-major, rows/cols are 1-based)\nyields[1,1] = 12.25\nyields[2,2] = 440.125",
    ));
    const r = await extractFileFromPath("sample.mat", src, undefined, undefined, undefined, { runJob: run });
    expect(r.text).toContain("yields[2,2] = 440.125");
    expect(r.text).toContain("body_source: capability:mat-numeric");
  });

  it("a typed refusal (malformed OLE) falls back to the EXACT labeled byte scan", async () => {
    const src = scratch("smoke.doc", scannable("SMOKE-RUNTABLE"));
    const r = await extractFileFromPath("smoke.doc", src, undefined, undefined, undefined, {
      runJob: runJobReturning(REFUSAL_ENVELOPE),
    });
    expect((r.text ?? "").startsWith(LEGACY_LABEL)).toBe(true);
    expect(r.text).toContain("SMOKE-RUNTABLE");
  });

  it("an offline backend keeps the pre-capability labeled byte-scan behavior", async () => {
    const src = scratch("simple.doc", scannable("OFFLINE-RUNTABLE"));
    const r = await extractFileFromPath("simple.doc", src, undefined, undefined, undefined, {
      runJob: runJobReturning(null),
    });
    expect((r.text ?? "").startsWith(LEGACY_LABEL)).toBe(true);
    expect(r.text).toContain("OFFLINE-RUNTABLE");
  });

  it("scan finds nothing AND the reader declined: the error names both facts", async () => {
    const src = scratch("empty.doc", Buffer.alloc(0x400)); // zero bytes: no printable runs
    await expect(extractFileFromPath("empty.doc", src, undefined, undefined, undefined, {
      runJob: runJobReturning(REFUSAL_ENVELOPE),
    })).rejects.toThrow(/No readable text found in this file [\s\S]* document capability backend also refused \(contract_mismatch\)/);
  });
});
