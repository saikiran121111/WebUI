/**
 * I11 — archive flattening & coverage ledger (lib/server/extract/archives.ts).
 *
 * Before the fix, a zip/tar member that was corrupt, deeply nested, or another
 * archive type simply VANISHED — the model saw a partial corpus and believed
 * it was the whole thing. The fix keeps a ledger. These tests lock every
 * ledger line: CORRUPT / NOT EXPANDED / TRUNCATED / no-text-content, members
 * parsed by THEIR type (a PDF inside a zip gets the PDF parser), the depth
 * limit, the per-member byte cap, and the single-stream gzip special case
 * (no members, so no ledger).
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";
import { archiveText } from "../../lib/server/extract/archives";
import { makePdf } from "./make-pdf";

const SCRATCH = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "arc_"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const S = (s: string) => strToU8(s);

/** Minimal ustar writer — enough for the nesting-limit contract. */
function makeTar(entries: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name.slice(0, 99), 0);
    h.write(e.data.length.toString(8).padStart(11, "0"), 124); h[135] = 0;
    h.write("        ", 148); // checksum placeholder while summing
    h[156] = 0x30; // '0' = regular file
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0"), 148); h[154] = 0; h[155] = 0x20;
    blocks.push(h);
    const padded = Math.ceil(e.data.length / 512) * 512;
    const d = Buffer.alloc(padded);
    e.data.copy(d);
    blocks.push(d);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return Buffer.concat(blocks);
}

describe("archive ledger — I11", () => {
  it("a member that fails its stored CRC is LISTED and skipped, not silently half-read", async () => {
    const buf = Buffer.from(zipSync({
      "good.txt": [S("GOOD-MEMBER-TEXT-3F"), { level: 0 }],
      "bad.txt": [S("BAD-PAYLOAD-DATA-6H"), { level: 0 }],
    }));
    const at = buf.indexOf(Buffer.from("BAD-PAYLOAD"));
    expect(at).toBeGreaterThan(-1);
    buf[at + 5] ^= 0x42;

    const text = await archiveText(buf, "zip");
    expect(text).toContain("--- member: good.txt");
    expect(text).toContain("GOOD-MEMBER-TEXT-3F");
    expect(text).toContain("CORRUPT (checksum failed, skipped): bad.txt");
  }, 60_000);

  it("tar-inside-zip nesting stops at the depth limit and SAYS where it stopped", async () => {
    const l4 = makeTar([{ name: "x.txt", data: Buffer.from("DEEP-TAR-CONTENT-4W") }]);
    const l3 = makeTar([{ name: "l4.tar", data: l4 }]);
    const l2 = makeTar([{ name: "l3.tar", data: l3 }]);
    const l1 = makeTar([{ name: "l2.tar", data: l2 }]);
    const outer = Buffer.from(zipSync({ "l1.tar": new Uint8Array(l1) }));

    const text = await archiveText(outer, "zip");
    expect(text).toContain("NOT EXPANDED: l4.tar (nesting limit)");
    expect(text).not.toContain("DEEP-TAR-CONTENT-4W"); // never surfaced, never faked
  }, 60_000);

  it("a nested 7z member inside a zip is admitted, not treated as absent", async () => {
    const buf = Buffer.from(zipSync({
      "inner.7z": S("this-bytes-are-not-a-real-7z-but-the-name-declares-one"),
      "plain.txt": S("ZIP-PLAIN-MEMBER-5R"),
    }));
    const text = await archiveText(buf, "zip");
    expect(text).toContain("NOT EXPANDED: inner.7z (nested 7z not expanded here)");
    expect(text).toContain("inner.7z — unrecognised content type");
    expect(text).toContain("ZIP-PLAIN-MEMBER-5R");
  }, 60_000);

  it("members are parsed by their OWN type — xlsx/PDF/text members all get their real parser", async () => {
    const xlsxParts: Record<string, Uint8Array> = {
      "[Content_Types].xml": S("<?xml version=\"1.0\"?><Types/>"),
      "xl/workbook.xml": S('<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": S('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": S("<sst><si><t>XLSX-INSIDE-ARCHIVE-7K</t></si></sst>"),
      "xl/worksheets/sheet1.xml": S('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'),
    };
    const pdf = makePdf(["EMBEDDED-PDF-TXT-XZ", null]); // 1 text + 1 scanned
    const buf = Buffer.from(zipSync({
      "docs/report.pdf": new Uint8Array(pdf),
      "sheets/book.xlsx": new Uint8Array(zipSync(xlsxParts)),
      "data/table.csv": S("col_a,col_b\n1,2"),
      "img/photo.png": S("not-a-real-png-bytes"),
    }));
    const text = await archiveText(buf, "zip");

    expect(text).toContain("--- member: docs/report.pdf");
    expect(text).toContain("EMBEDDED-PDF-TXT-XZ");
    expect(text).toMatch(/\[\d+ of \d+ pages have a text layer\]/); // the per-PDF note rides along
    expect(text).toContain("XLSX-INSIDE-ARCHIVE-7K");
    expect(text).toContain("### worksheet: Sheet1");
    expect(text).toContain("col_a,col_b");
    expect(text).toContain("photo.png — image content (binary — not text-extracted)");
    expect(text).toContain("no text content:");
  }, 60_000);

  it("an oversize member decodes up to the budget and DECLARES the cut", async () => {
    const big = new Uint8Array(9 * 1024 * 1024).fill(0x41); // 9 MiB of 'A' — compresses tiny
    const buf = Buffer.from(zipSync({ "big.txt": [big, { level: 9 }] }));
    const text = await archiveText(buf, "zip");
    expect(text).toContain("TRUNCATED: big.txt (9437184 bytes — first 8388608 decoded)");
  }, 120_000);

  it("a single-stream gzip has no members, so it gets NO fake coverage ledger", async () => {
    const buf = Buffer.from(gzipSync(S("PLAIN-GZ-STREAM-TEXT-8V")));
    const text = await archiveText(buf, "gz");
    expect(text).toContain("PLAIN-GZ-STREAM-TEXT-8V");
    expect(text).not.toContain("archive coverage");
    expect(text).not.toContain("member(s) flattened");
  }, 60_000);
});
