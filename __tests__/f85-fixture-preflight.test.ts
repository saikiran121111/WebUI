/**
 * F85 (2026-11-23): fixture preflight, model-free (no inference slot, no lock).
 *
 * C3 burned live-model turns on rows whose PREMISE was false at the staged
 * file (fr-P10 insulin key, fr-S4 absent identity, S-V1 absent greeting,
 * S-V5 begin card). A staged-file preflight catches that family BEFORE the
 * slot. This spec runs FIRST, before any exclusive replay.
 *
 * Two layers:
 *  1. IDENTITY: every row of stage-live-manifest.tsv must exist on disk with
 *     the manifest's size and SHA-256 — one drifted fixture fails the batch
 *     preflight, not twelve live rows.
 *  2. FACT DERIVATION: the expected facts of the rows C3 proved fragile are
 *     re-derived from the staged bytes with repo readers (fflate, the same
 *     zip engine lib/server/extract/zip.ts ships), never from the model and
 *     never from the answer key's prose. Where the derivation matches the
 *     key, the key stands; where it does not, the row is key-vs-fixture
 *     (S-P5/S-X4/S-V1 family) and must be fixed at the key/spec layer.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const LIVE = path.join(ROOT, ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live");
const MANIFEST = path.join(ROOT, ".data", "tmp", "file-regression", "fr-20261122a", "stage-live-manifest.tsv");

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex").toUpperCase();
const bytes = (name: string): Buffer => readFileSync(path.join(LIVE, name));
const xmlOf = (name: string, member: (k: string) => boolean): string => {
  const zip = unzipSync(bytes(name));
  return Object.keys(zip).filter(member).map((k) => strFromU8(zip[k])).join("\n");
};

describe("F85 preflight 1/2: every staged row matches its frozen manifest identity", () => {
  const rows = readFileSync(MANIFEST, "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split("\t"))
    // NOTE: names are NOT trimmed — "  README  .txt" is a deliberate
    // leading/trailing-space fixture; trimming its name is a preflight bug,
    // proven by the disk census (disk bytes: "  README  .txt").
    .map(([name, size, sha]) => ({ name, size: Number(size.trim()), sha: sha.trim().toUpperCase() }));

  it("the manifest itself is complete (55 rows)", () => {
    expect(rows.length).toBe(55);
  });

  it("every row exists on disk at the manifest size and SHA-256", () => {
    const bad: string[] = [];
    for (const r of rows) {
      const p = path.join(LIVE, r.name);
      if (!existsSync(p)) {
        bad.push(`${r.name}: MISSING`);
        continue;
      }
      const buf = readFileSync(p);
      if (buf.length !== r.size) bad.push(`${r.name}: size ${buf.length} != ${r.size}`);
      else if (sha256(buf) !== r.sha) bad.push(`${r.name}: sha256 drift`);
    }
    expect(bad, `staged identity drift:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});

describe("F85 preflight 2/2: the fragile rows' expected facts derive from staged bytes", () => {
  // F83 — fr-S4 identity: the deck the row uploads MUST carry the code.
  it("deck-4.pptx slide XML carries SC-ALPHA-4460", () => {
    expect(xmlOf("deck-4.pptx", (k) => k.startsWith("ppt/slides/slide"))).toContain("SC-ALPHA-4460");
  });

  // F83 + F94 — the chart part of the deck the S3 row uploads, keyed from
  // the raw OOXML (model-free). CENSUS CORRECTION (2026-11-23): the brief
  // said "deck-4 contains a bar chart" and "deck-3 carries scatter" — the
  // staged truth is the reverse of both: deck-4's single chart part IS a
  // native c:scatterChart (scatterStyle lineMarker), and deck-3 carries
  // ZERO chart parts (zip census: slides + notes only). The scatter
  // series/values law therefore lives on deck-4, whose cached values are
  // pinned here: series "Sales", yVals 8.2/3.2/1.4/1.2.
  it("deck-4.pptx chart part is a native scatterChart carrying Sales + 8.2/3.2/1.4/1.2", () => {
    const chart = xmlOf("deck-4.pptx", (k) => k.startsWith("ppt/charts/"));
    expect(chart).toContain("<c:scatterChart>");
    expect(chart).not.toContain("<c:barChart>");
    for (const v of ["Sales", "8.2", "3.2", "1.4", "1.2"]) expect(chart).toContain(v);
  });

  // F94 premise, pinned so nobody re-keys a scatter row against deck-3.
  it("deck-3.pptx carries NO chart part (scatter law must not key against it)", () => {
    const zip = unzipSync(bytes("deck-3.pptx"));
    expect(Object.keys(zip).filter((k) => k.toLowerCase().includes("chart"))).toEqual([]);
  });

  // F88 — deck-5 presenter-notes key fact: "use gate 76" is IN the file,
  // so the model quoting it obeyed answer fidelity. Key stands.
  it("deck-5.odp content carries the presenter-note fact 'gate 76'", () => {
    expect(xmlOf("deck-5.odp", (k) => k.endsWith("content.xml"))).toContain("gate 76");
  });

  // F81 — the d1 pair: the answer-key's identity must be the STAGED bytes,
  // proven from the key's own recorded source, not prose. scan-1 is the
  // scanned file (its keyed facts live in the d1 page text); scan-2 is the
  // native file (text layer answers, OCR must not run).
  const d1 = JSON.parse(
    readFileSync(path.join(ROOT, "docs", "overnight", "fixtures", "d1", "answer-key.json"), "utf8"),
  ) as { key_version: string; fixtures: Record<string, { pages: unknown[] }> };
  it("the d1 key covers the staged pair with >=6 keyed pages each", () => {
    for (const name of ["d1_scanned.pdf", "d1_native.pdf"]) {
      expect(d1.fixtures[name], `d1 key missing ${name}`).toBeDefined();
      // pages is the keyed page COUNT in this key (not an array).
      expect(d1.fixtures[name].pages).toBeGreaterThanOrEqual(6);
    }
    expect(existsSync(path.join(LIVE, "scan-1.pdf"))).toBe(true);
    expect(existsSync(path.join(LIVE, "scan-2.pdf"))).toBe(true);
  });

  // F81 — scan-2's keyed fact (S-P11 page 3 table → Kandla) lives in a
  // compressed PDF stream; the honest model-free proof is the live
  // provenance row (fr-P11 asserts the text-layer page headers). Preflight
  // pins the staged identity; the text-layer law is graded live.
  it("scan-2.pdf is a real staged PDF (identity, not prose)", () => {
    expect(bytes("scan-2.pdf").subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  // F87 — the .mat contract conflict, pinned model-free. BYTE CENSUS
  // (2026-11-23): mat-1.mat is NOT MAT v5 (no "MATLAB 5.0" header) — it is
  // a 59-byte MAT v4 (mat44) matrix: type 0, mrows 2, ncols 2, name
  // "yields", data 4-byte-aligned (a legacy writer quirk: spec-conformant
  // padding would start data at 32; real data starts at 28). The S-M1 key
  // facts 98.75 and 440.125 are present ONLY as IEEE-754 little-endian
  // doubles (offsets 35 and 51), never as decimal text — so the legacy
  // printable-strings reader can recover "yields" but NOT the numbers,
  // exactly the C3 conflict. This pins the F87 product contract: the
  // structured MAT parser (v4, tolerant 4-byte alignment) must surface
  // yields = [.., 98.75, .., 440.125].
  it("mat-1.mat is MAT v4 named 'yields' carrying 98.75 and 440.125 as LE doubles", () => {
    const raw = bytes("mat-1.mat");
    expect(raw.readUInt32LE(0)).toBe(0); // miMATRIX
    expect(raw.readUInt32LE(4)).toBe(2); // mrows
    expect(raw.readUInt32LE(8)).toBe(2); // ncols
    expect(raw.subarray(20, 26).toString("latin1")).toBe("yields");
    const seen = new Set<number>();
    for (let off = 0; off + 8 <= raw.length; off++) {
      const v = raw.readDoubleLE(off);
      if (v === 98.75 || v === 440.125) seen.add(v);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([98.75, 440.125]);
    // The numbers must NOT be recoverable as printable decimal text: that
    // is what makes the legacy contract lossy and the product fix needed.
    const printable = raw.toString("latin1").replace(/[^\x20-\x7e]/g, " ");
    expect(printable).not.toMatch(/440\.125|98\.75/);
  });

  // S-X1 — data-5.xlsx cell B4 fact, from the workbook's own XML census.
  it("data-5.xlsx shared strings carry Almarai (S-X1 B4)", () => {
    expect(xmlOf("data-5.xlsx", (k) => k.includes("sharedStrings"))).toContain("Almarai");
  });

  // S-X10 / F72 — data-6.xlsx ToC formula, the raw-XML census the key cites.
  it("data-6.xlsx stores the cross-range SUM(B9:B19) formula", () => {
    expect(xmlOf("data-6.xlsx", (k) => k.startsWith("xl/worksheets/"))).toContain("SUM(B9:B19)");
  });

  // F92 / fr-T3b — the quoted-newline CSV key, derived by a hand-rolled
  // RFC4180 scan INDEPENDENT of lib/files/csv-records.ts (the record count
  // cross-checks against Python's csv module: 101 logical records). Row 50
  // carries the £ cell (fr-T3); Row 51's column b is ONE logical cell
  // spanning TWO physical lines — the addressing law the live row grades.
  it("txt-3.csv logical rows 50/51 carry the £ cell and the quoted-newline cell", () => {
    const raw = bytes("txt-3.csv").toString("utf8").replace(/^﻿/, "");
    const records: string[][] = [];
    let field = "", record: string[] = [], inQ = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQ) {
        if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQ = false;
        else field += ch;
      } else if (ch === '"' && field === "") inQ = true;
      else if (ch === ",") { record.push(field); field = ""; }
      else if (ch === "\r" || ch === "\n") {
        const crlf = ch === "\r" && raw[i + 1] === "\n";
        if (crlf) i++;
        record.push(field); field = "";
        records.push(record); record = [];
      } else field += ch;
    }
    if (field !== "" || record.length) { record.push(field); records.push(record); }
    expect(records.length).toBe(101);
    expect(records[50][1]).toContain("Average cost per FTE");
    expect(records[50][1]).toContain("£");
    expect(records[51][1]).toBe("S1.2c\n(multi-line cell)");
    // The law being graded: logical rows and physical lines DIVERGE —
    // Row 51 exists only if the quoted newline is respected.
    expect(raw.split(/\r?\n/).length).toBeGreaterThan(records.length);
  });

  // F94 / fr-S3b — the native scatter key, derived from the RAW chart XML
  // (never from a model run): c:scatterChart, series "Sales", PAIRED cached
  // points under c:xVal/c:yVal. This is the exact expectation set the live
  // row grades; the xVal/yVal shape is also why a cat/val-only reader loses
  // the series entirely (F64).
  it("deck-4.pptx chart1 is a scatterChart with Sales xVal/yVal pairs 8.2/3.2/1.4/1.2", () => {
    const x = xmlOf("deck-4.pptx", (k) => k.includes("chart1.xml"));
    expect(x).toContain("<c:scatterChart>");
    expect(x).not.toContain("<c:cat>"); // the pairs live ONLY under xVal/yVal
    const pts = (tag: string): string[] => {
      const seg = x.slice(x.indexOf(`<c:${tag}>`));
      return [...seg.matchAll(/<c:pt idx="\d+"[^>]*>\s*<c:v>([^<]+)<\/c:v>/g)].map(m => m[1]);
    };
    expect(pts("xVal").slice(0, 4)).toEqual(["1st Qtr", "2nd Qtr", "3rd Qtr", "4th Qtr"]);
    const ys = pts("yVal").slice(0, 4);
    expect(Number(ys[0])).toBeCloseTo(8.2, 6);
    expect(ys.slice(1)).toEqual(["3.2", "1.4", "1.2"]);
    expect(x).toContain("<c:v>Sales</c:v>");
  });

  // F89 — S-V1: the KEY prose cannot be verified from video bytes in a unit
  // test; the derivation lives in evidence-f89-key-verification.txt (frames
  // + pinned Parakeet run). The preflight pins the staged video identity;
  // the live row is graded against the verified spoken fact.
  it("the video pair is staged (frame/audio facts verified in F89 evidence)", () => {
    expect(existsSync(path.join(LIVE, "vid-1.mp4"))).toBe(true);
    expect(existsSync(path.join(LIVE, "vid-2.mp4"))).toBe(true);
  });
});
