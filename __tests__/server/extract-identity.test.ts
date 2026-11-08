/**
 * I09 — file identity by CONTENT, not by extension (lib/server/extract/sniff.ts
 * + the override rule in index.ts).
 *
 * Renaming a PNG to .pdf sent it to the office-zip reader; a zip renamed .txt
 * was read as raw binary garbage. The fix sniffs magic bytes: STRONG magics
 * always override the extension guess, WEAK ones (ZIP/Ogg/ftyp) only rescue a
 * text/unknown guess, and office extensions never get weak-overridden.
 * These tests drive the real product entry point (extractFileFromPath, no
 * attId — so no indexing and no model calls, fully deterministic).
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { extractFileFromPath } from "../../lib/server/extract";
import { makePdf } from "./make-pdf";

const SCRATCH = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "ident_"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const write = (name: string, buf: Buffer): string => {
  const p = path.join(SCRATCH, name);
  fs.writeFileSync(p, buf);
  return p;
};

// Canonical 1x1 PNG (IHDR 1x1, 8-bit RGBA) — real magic bytes.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("content sniffing — I09", () => {
  it("a PNG renamed report.pdf is treated as the IMAGE it is (strong magic wins)", async () => {
    const r = await extractFileFromPath("report.pdf", write("report.pdf", PNG_1PX));
    expect(r.category).toBe("image");
    expect(r.dataUrl).toMatch(/^data:image\/png/);
    expect(r.pages).toBe(1);
    expect(r.text).toBeUndefined();
  }, 120_000);

  it("a ZIP renamed notes.txt is rescued from the text reader by weak magic", async () => {
    const buf = Buffer.from(zipSync({ "m.txt": strToU8("ZIP-NAMED-TXT-9F") }));
    const r = await extractFileFromPath("notes.txt", write("notes.txt", buf));
    expect(r.category).toBe("archive");
    expect(r.text).toContain("ZIP-NAMED-TXT-9F");
    expect(r.text).toContain("archive coverage");
  }, 60_000);

  it("a ZIP renamed thing.dat (no extension class) is still found", async () => {
    const buf = Buffer.from(zipSync({ "m.txt": strToU8("ZIP-NAMED-DAT-2B") }));
    const r = await extractFileFromPath("thing.dat", write("thing.dat", buf));
    expect(r.category).toBe("archive");
    expect(r.text).toContain("ZIP-NAMED-DAT-2B");
  }, 60_000);

  it("RTF bytes renamed .txt are rendered as RTF, not as brace soup", async () => {
    const buf = Buffer.from("{\\rtf1\\ansi Test RTF Content}", "latin1");
    const r = await extractFileFromPath("note.txt", write("note.txt", buf));
    expect(r.category).toBe("rtf");
    expect(r.text).toContain("Test RTF Content");
    expect(r.text).not.toContain("\\rtf1"); // control word consumed, not dumped
  }, 60_000);

  it("real PDF bytes renamed report.docx follow the magic, not the office reader", async () => {
    const buf = makePdf(["PDF-IN-DISCOTIZED-DOCX-4T"]);
    const r = await extractFileFromPath("report.docx", write("report.docx", buf));
    expect(r.category).toBe("pdf");
    expect(r.text).toContain("PDF-IN-DISCOTIZED-DOCX-4T");
  }, 60_000);

  it("an office extension is NOT weak-overridden by its own ZIP header", async () => {
    // Every .xlsx IS a zip — the weak PK magic must not demote it to "archive".
    const xlsxParts: Record<string, Uint8Array> = {
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>OFFICE-STAYS-OFFICE-3M</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'),
    };
    const r = await extractFileFromPath("real.xlsx", write("real.xlsx", Buffer.from(zipSync(xlsxParts))));
    expect(r.category).toBe("office");
    expect(r.text).toContain("A1=OFFICE-STAYS-OFFICE-3M");
    expect(r.text).not.toContain("archive coverage");
  }, 60_000);
});
