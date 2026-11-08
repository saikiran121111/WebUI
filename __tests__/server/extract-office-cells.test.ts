/**
 * D25/D26/D27 — Office cell/sheet/slide contracts (lib/server/extract/office.ts).
 *
 * The old xlsx reader dumped the sharedStrings DICTIONARY (every string in the
 * file, deduplicated, coordinate-less) — a spreadsheet became a word bag, and
 * sheet ORDER was irrelevant. The old pptx reader sorted slides LEXICALLY, so
 * slide 10 came before slide 2. These tests lock the cell model: REF=value
 * with real coordinates, shared-string misses reported not invented,
 * formulas/booleans/inline strings rendered, doc-order sheets AND slides via
 * relationship resolution, missing parts announced, and CRC-corrupt parts
 * reported instead of silently half-read.
 */
import { describe, expect, it } from "vitest";
import { strToU8, zipSync, type ZipOptions } from "fflate";
import { officeText } from "../../lib/server/extract/office";

const CT = "[Content_Types].xml";
const SS = "xl/sharedStrings.xml";

const workbook = (sheets: string, rels: string) => ({
  [CT]: strToU8("<?xml version=\"1.0\"?><Types/>"),
  "xl/workbook.xml": strToU8(`<workbook><sheets>${sheets}</sheets></workbook>`),
  "xl/_rels/workbook.xml.rels": strToU8(`<Relationships>${rels}</Relationships>`),
});
const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
// level 0 = STORED members: the XML sits verbatim in the container bytes, so a
// byte-flip test can find and tamper it (deflated payloads are opaque).
const xlsx = (parts: Record<string, Uint8Array>, opts: ZipOptions = {}) => Buffer.from(zipSync(parts, opts));

describe("xlsx — D25 cells, not the string dictionary", () => {
  const text = officeText(xlsx({
    ...workbook(
      // Doc order is Beta-then-Alpha while part names are sheet1-then-sheet2:
      // a numeric/part-name sort would flip them. The rId order decides.
      '<sheet name="Beta" sheetId="1" r:id="rId2"/><sheet name="Alpha" sheetId="2" r:id="rId1"/>',
      rel("rId1", "worksheet", "../worksheets/sheet1.xml") + rel("rId2", "worksheet", "worksheets/sheet2.xml"),
    ),
    // si 0 is a rich-text run split across <t> elements — the value must be
    // stitched, not just take the first fragment.
    [SS]: strToU8("<sst><si><t>Hello </t><t>World</t></si><si><t>Second</t></si></sst>"),
    "xl/worksheets/sheet1.xml": strToU8(
      "<worksheet><sheetData>" +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>7</v></c></row>' +
      '<row r="3"><c r="C3" t="inlineStr"><is><t>Inline &amp; Cell</t></is></c><c r="D3" t="str"><f>SUM(A1:B1)</f></c></row>' +
      '<row r="5"><c r="E5" t="b"><v>1</v></c><c r="F5"><v>42</v></c></row>' +
      "</sheetData></worksheet>",
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>1</v></c></row></sheetData></worksheet>",
    ),
  }), "xlsx");

  it("cells render as REF=value with real coordinates, row-joined on tabs", () => {
    expect(text).toContain("A1=Hello World\tB1=(shared string #7 missing)");
    expect(text).toContain("C3=Inline & Cell\tD3==SUM(A1:B1)"); // t="str" with only <f> -> =formula
    expect(text).toContain("E5=TRUE\tF5=42"); // t="b"; bare numeric
  });

  it("a shared-string index that is absent says so instead of inventing a value", () => {
    expect(text).toContain("(shared string #7 missing)");
  });

  it("sheets appear in WORKBOOK document order via relationship resolution", () => {
    expect(text.indexOf("### worksheet: Beta")).toBeGreaterThan(-1);
    expect(text.indexOf("### worksheet: Beta")).toBeLessThan(text.indexOf("### worksheet: Alpha"));
    expect(text).toContain("### worksheet: Beta\nA1=Second");
  });

  it("a sheet whose part is missing from the package is announced, not skipped silently", () => {
    const t = officeText(xlsx({
      ...workbook(
        '<sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="Gamma" sheetId="2" r:id="rId3"/>',
        rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId3", "worksheet", "worksheets/sheet3.xml"),
      ),
      [SS]: strToU8("<sst><si><t>ONLY-SHEET</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c></row></sheetData></worksheet>"),
    }), "xlsx");
    expect(t).toContain("ONLY-SHEET");
    expect(t).toContain("### worksheet: Gamma — part xl/worksheets/sheet3.xml is missing from the package");
  });
});

describe("pptx — D26 slide order follows sldIdLst, not file names", () => {
  const slides: Record<string, Uint8Array> = {
    [CT]: strToU8("<?xml version=\"1.0\"?><Types/>"),
    "ppt/presentation.xml": strToU8(
      "<p:presentation><p:sldIdLst>" +
      '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId10"/>' +
      '<p:sldId id="258" r:id="rId11"/><p:sldId id="259" r:id="rId2"/>' +
      "</p:sldIdLst></p:presentation>",
    ),
    "ppt/_rels/presentation.xml.rels": strToU8("<Relationships>" +
      ["1", "10", "11", "2"].map((n) => rel(`rId${n}`, "slide", `../slides/slide${n}.xml`)).join("") +
      "</Relationships>"),
  };
  for (let n = 1; n <= 12; n++) {
    const tag = [1, 10, 11, 2].includes(n) ? `ORDER-${n}` : `OTHER-${n}`;
    slides[`ppt/slides/slide${n}.xml`] = strToU8(
      `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${tag}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  }
  const text = officeText(Buffer.from(zipSync(slides)), "pptx");

  it("presentation order wins: 1, 10, 11, 2 before the rest", () => {
    const pos = (s: string) => text.indexOf(s);
    expect(pos("ORDER-1")).toBeGreaterThan(-1);
    expect(pos("ORDER-1")).toBeLessThan(pos("ORDER-10"));
    expect(pos("ORDER-10")).toBeLessThan(pos("ORDER-11"));
    expect(pos("ORDER-11")).toBeLessThan(pos("ORDER-2"));
  });

  it("without a presentation part, the fallback sorts NUMERICALLY (slide 9 before slide 10)", () => {
    const bare: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(slides)) {
      if (name.includes("presentation")) continue;
      bare[name] = data;
    }
    const t = officeText(Buffer.from(zipSync(bare)), "pptx");
    expect(t.indexOf("OTHER-9")).toBeLessThan(t.indexOf("OTHER-12"));
    expect(t.indexOf("OTHER-12")).toBeLessThan(t.length);
    // slide1/2/10/11 still render (they just lose declared order):
    for (const n of [1, 2, 10, 11]) expect(t).toContain(`ORDER-${n}`);
    // and numeric means slide9 precedes slide10:
    expect(t.indexOf("OTHER-9")).toBeLessThan(t.indexOf("ORDER-10"));
  });
});

describe("xlsx — D27 CRC integrity: tampered parts are reported, not half-read", () => {
  it("a byte-flipped member trips the stored-CRC check and is announced", () => {
    const buf = xlsx({
      ...workbook(
        // Two sheets, tamper only the FIRST one's stored bytes (indexOf hits the
        // first payload occurrence). The GOOD value rides on the INTACT sheet —
        // sharedStrings is a lookup table, so in the cell model an intact part
        // only "keeps working" through a sheet that actually cites it.
        '<sheet name="Bad" sheetId="1" r:id="rId1"/><sheet name="Good" sheetId="2" r:id="rId2"/>',
        rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId2", "worksheet", "worksheets/sheet2.xml"),
      ),
      [SS]: strToU8("<sst><si><t>BAD-PART-VALUE</t></si><si><t>GOOD-PART-STILL-READS</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c></row></sheetData></worksheet>"),
      "xl/worksheets/sheet2.xml": strToU8("<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>1</v></c></row></sheetData></worksheet>"),
    }, { level: 0 });
    // Stored (level 0) members sit verbatim in the bytes: flip one byte of the
    // sheet XML payload. The central-directory CRC was computed over the
    // ORIGINAL bytes, so the member now fails its own checksum.
    const anchor = Buffer.from("<worksheet><sheetData>");
    const at = buf.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    buf[at + 12] ^= 0x37;

    const text = officeText(buf, "xlsx");
    expect(text).toContain(
      "[integrity: 1 package part(s) failed their stored CRC checksum and were skipped: xl/worksheets/sheet1.xml]",
    );
    expect(text).toContain("GOOD-PART-STILL-READS"); // intact parts keep working
  });
});
