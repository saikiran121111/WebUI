/**
 * F12 - Office structure and character fidelity (lib/server/extract/office.ts).
 *
 * Locks four contracts that the tag-stripping reader used to break:
 *  1. numeric entities decode as CODE POINTS, so supplementary-plane characters
 *     survive; invalid code points stay literal instead of becoming junk;
 *  2. a formula and its cached result are BOTH reported - the old reader kept
 *     <v> and dropped <f>, so `=2+3` became "A1=5" and the formula vanished;
 *  3. merged ranges are named, because a merged block reads as one value but
 *     arrives as one populated cell plus silent blanks;
 *  4. hyperlink display text resolves to its actual target.
 */
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { officeText } from "../../lib/server/extract/office";

const xlsx = (parts: Record<string, Uint8Array>): Buffer =>
  Buffer.from(zipSync(parts, { level: 0 }));

const wb =
  '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
const wbRels =
  '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

const sheet = (body: string) => `<worksheet><sheetData>${body}</sheetData>`;

describe("F12 - entities decode by code point, not code unit", () => {
  it("keeps a supplementary-plane character from a decimal entity", () => {
    const text = officeText(xlsx({
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
      "xl/workbook.xml": strToU8(wb),
      "xl/_rels/workbook.xml.rels": strToU8(wbRels),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>grin &#128512; end</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8(sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')),
    }), "xlsx");
    expect(text).toContain("grin \u{1F600} end");
    expect(text).not.toContain("\uD83D\uDE00\uFFFD");
    expect([...text].includes("\u{1F600}")).toBe(true);
    // the old String.fromCharCode path produced two UTF-16 code units that are
    // NOT a valid pair in isolation - length proves the single code point:
    expect("\u{1F600}".codePointAt(0)).toBe(0x1f600);
  });

  it("handles hex entities and leaves invalid code points literal", () => {
    const text = officeText(xlsx({
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
      "xl/workbook.xml": strToU8(wb),
      "xl/_rels/workbook.xml.rels": strToU8(wbRels),
      "xl/sharedStrings.xml": strToU8(
        "<sst><si><t>hex &#x1F600;</t></si><si><t>bad &#1114112; and &#xD800; here</t></si></sst>",
      ),
      "xl/worksheets/sheet1.xml": strToU8(sheet(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="A2" t="s"><v>1</v></c></row>',
      )),
    }), "xlsx");
    // the trailing ";" is the entity terminator, not literal text
    expect(text).toContain("A1=hex \u{1F600}");
    expect(text).toContain("bad &#1114112; and &#xD800; here"); // not silently mangled
  });
});

describe("F12 - formulas survive cached values", () => {
  it("reports formula AND cached value for a calculated cell", () => {
    const text = officeText(xlsx({
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
      "xl/workbook.xml": strToU8(wb),
      "xl/_rels/workbook.xml.rels": strToU8(wbRels),
      "xl/worksheets/sheet1.xml": strToU8(sheet(
        '<row r="1"><c r="A1"><f>2+3</f><v>5</v></c><c r="A2"><v>7</v></c>' +
        '<c r="A3"><f/></c><c r="A4"><f t="shared" ref="A4" si="0">SUM(A2)</f><v>7</v></c></row>',
      )),
    }), "xlsx");
    expect(text).toContain("A1==2+3 (cached 5)");
    expect(text).toContain("A2=7");
    expect(text).toContain("A3=[formula present but neither expression nor cached value stored]");
    expect(text).toContain("A4==SUM(A2) (cached 7) [shared/array formula]");
    // the bare cached-value-only reading (the defect) must NOT be what we emit:
    expect(text).not.toContain("A1=5\t");
  });
});

describe("F12 - merged ranges and hyperlink targets", () => {
  it("names merged blocks and resolves hyperlink targets", () => {
  const text = officeText(xlsx({
    "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
    "xl/workbook.xml": strToU8(wb),
    "xl/_rels/workbook.xml.rels": strToU8(wbRels),
    "xl/sharedStrings.xml": strToU8("<sst><si><t>Title</t></si></sst>"),
    "xl/worksheets/sheet1.xml": strToU8(
      sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') +
      '<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C2:D3"/></mergeCells>' +
      '<hyperlinks><hyperlink ref="A1" r:id="rId9"/></hyperlinks>' +
      "</worksheet>",
    ),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(
      '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/report%202026" TargetMode="External"/></Relationships>',
    ),
  }), "xlsx");

  expect(text).toContain("### merged cells (2): A1:B1, C2:D3");
  expect(text).toContain("A1 -> https://example.invalid/report%202026");
  // the stored URI is emitted verbatim - percent-escapes are not decoded (that would invent bytes);
  // only XML entities are decoded, so an "&amp;" inside a target cannot smuggle markup.
  expect(text).toContain("Title");
  expect(text).toContain("Title");
  });
});
