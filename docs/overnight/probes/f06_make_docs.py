"""F06 integration fixtures: one PDF (native text, two-column page, rotated page, a page
with NO text layer, and late evidence on the last page), one XLSX (merged range, typed
values, formula, empty cell) and one DOCX (headings + two tables).

Hand-built PDF/OOXML on purpose: no library that WRITES the fixture is also the reader
under test, so the fixture cannot silently depend on the thing being validated.

Run from the repo root:  python docs/overnight/probes/f06_make_docs.py
Writes scratch outputs to .data/tmp/f06/ (not committed).
"""
import os
import zipfile

OUT = os.path.join(".data", "tmp", "f06")


def _wrap(text, width=64):
    lines, cur = [], ""
    for w in text.split():
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return lines


def _stream(cols):
    """cols = [(x, y_top, [lines])]; two columns are expressible on purpose."""
    out = []
    for x, y0, lines in cols:
        for i, line in enumerate(lines):
            esc = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            out.append(f"BT /F1 11 Tf {x} {y0 - 16 * i} Td ({esc}) Tj ET")
    return "\n".join(out).encode("ascii")


def pdf_bytes(pages, rotate=None):
    rotate = rotate or {}
    objs, n = {}, len(pages)
    first = 4
    kids = " ".join(f"{first + 2 * i} 0 R" for i in range(n))
    objs[1] = b"<</Type/Catalog/Pages 2 0 R>>"
    objs[2] = f"<</Type/Pages/Kids[{kids}]/Count {n}>>".encode()
    objs[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"
    for i, content in enumerate(pages):
        pid = first + 2 * i
        extra = f" /Rotate {rotate[i + 1]}" if rotate.get(i + 1) else ""
        objs[pid] = (f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]{extra}"
                     f"/Resources<</Font<</F1 3 0 R>>>>/Contents {pid + 1} 0 R>>").encode()
        objs[pid + 1] = (b"<</Length " + str(len(content)).encode() + b">>stream\n"
                         + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    off = {}
    for num in sorted(objs):
        off[num] = len(out)
        out += f"{num} 0 obj\n".encode() + objs[num] + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(off) + 1}\n".encode() + b"0000000000 65535 f \n"
    for num in sorted(off):
        out += f"{off[num]:010d} 00000 n \n".encode()
    out += (f"trailer<</Size {len(off) + 1}/Root 1 0 R>>\n"
            f"startxref\n{start}\n%%EOF\n").encode()
    return bytes(out)


def make_pdf():
    p1 = _stream([(72, 740,
                   ["Quarterly Operations Review - North Region",
                    "Prepared by the field analytics group."]
                   + _wrap("The depot network handled record volumes through the first three "
                           "months. Tonnage rose while dwell time fell, which the regional "
                           "managers attribute to the new slotting policy."))])
    left = ["LEFT COLUMN page 2", "Slotting policy notes:", "- bay utilisation 74 percent",
            "- re-handling down 12 percent"]
    right = ["RIGHT COLUMN page 2", "Dwell time notes:", "- mean dwell 3.4 hours",
             "- worst corridor: Ridgeway"]
    p2 = _stream([(72, 740, left), (320, 740, right)])
    p4 = _stream([(72, 740,
                   ["PAGE 4 rotated 90 degrees",
                    "Pivot check: d/dx of x^2 equals 2x",
                    "code: SELECT id FROM depots WHERE region = 'north';"])])
    p6 = _stream([(72, 740,
                   ["PAGE SIX - late evidence",
                    "Answer-bearing fact: the Ridgeway corridor was suspended on 3 March.",
                    "Appendix note: figures audited by the external reviewer."])])
    pages = [p1, p2, b"", p4, _stream([(72, 740, ["PAGE FIVE filler paragraph."] +
                                       _wrap("Nothing decisive happens on this page; it exists "
                                             "to push the answer-bearing page toward the end "
                                             "of a long source."))]), p6]
    data = pdf_bytes(pages, rotate={4: 90})
    with open(os.path.join(OUT, "f06-review.pdf"), "wb") as fh:
        fh.write(data)
    return len(data)


def xlsx(path):
    # A1 merged across A1:B2 (title), typed numbers in B4:B5, SUM formula that depends on
    # them, an EMPTY C4 cell (must never become 0), and a shared-string header row.
    cells = ('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/></row>'
             '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c>'
             '<c r="C3" t="s"><v>3</v></c></row>'
             '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><v>12.5</v></c>'
             '<c r="C4"/></row>'
             '<row r="5"><c r="A5" t="s"><v>5</v></c><c r="B5"><v>7.5</v></c>'
             '<c r="C5"><f>SUM(B4:B5)</f><v>20</v></c></row>')
    sheet = ('<?xml version="1.0" encoding="UTF-8"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<sheetData>{cells}</sheetData>'
             '<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells></worksheet>')
    sst = ('<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/'
           'spreadsheetml/2006/main" count="6" uniqueCount="6"><si><t>Depot throughput report '
           '(merged title)</t></si><si><t>Depot</t></si><si><t>Inbound</t></si><si><t>Outbound'
           '</t></si><si><t>Ridgeway</t></si><si><t>Total</t></si></sst>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.'
                   'openxmlformats.org/package/2006/content-types"><Default Extension="rels" '
                   'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/><Override PartName='
                   '"/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument'
                   '.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml"'
                   ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.work'
                   'sheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application'
                   '/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.'
                   'openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type='
                   '"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDoc'
                   'ument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.'
                   'openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.'
                   'openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name='
                   '"Grid" sheetId="1" r:id="rIdA"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.'
                   'openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Type='
                   '"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
                   ' Target="worksheets/sheet1.xml"/><Relationship Id="rIdB" Type="http://schemas.'
                   'openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
                   'Target="sharedStrings.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        z.writestr("xl/sharedStrings.xml", sst)
    return os.path.getsize(path)


def docx(path):
    # Two tables, two rows each, plus headings; row identity must survive as table+row.
    def para(text, style=None):
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

    def table(rows):
        out = ["<w:tbl><w:tblPr/>"]
        for r in rows:
            out.append("<w:tr>" + "".join(
                f"<w:tc><w:tcPr/><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in r)
                + "</w:tr>")
        return "".join(out) + "</w:tbl>"

    body = (para("Service Catalogue", "Heading1")
            + para("Table one: owners", "Heading2")
            + table([["Service", "Owner"], ["Payments", "Ana"], ["Ledger", "Bruno"]])
            + para("Table two: SLAs", "Heading2")
            + table([["Service", "Target"], ["Payments", "99.95"], ["Ledger", "99.9"]])
            + para("Closing note: owners rotate each quarter.", None))
    doc = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{body}</w:body></w:document>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.'
                   'openxmlformats.org/package/2006/content-types"><Default Extension="rels" '
                   'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/><Override PartName='
                   '"/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument'
                   '.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.'
                   'openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type='
                   '"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDoc'
                   'ument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", doc)
    return os.path.getsize(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("pdf bytes:", make_pdf())
    print("xlsx bytes:", xlsx(os.path.join(OUT, "f06-sheet.xlsx")))
    print("docx bytes:", docx(os.path.join(OUT, "f06-notes.docx")))


if __name__ == "__main__":
    main()
