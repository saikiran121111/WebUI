"""F09 HELD-OUT document fixtures - written before the reader repairs were re-scored.

Held-out means: these fixtures and their answer key (answer-key.json, same directory) were
authored independently of the reader code, in subject domains the development fixtures never
used (hydrology, insurance claims, warehouse inventory, transit catalogue), and they exercise
the properties the brief lists: entity substitution, paraphrase, negation, irrelevant
distractors, late answer-bearing evidence, unicode, chunk-boundary variation (the long
sources cross the reader's own block/character limits), merged ranges in BOTH directions,
typed values against empty cells, formulas against cached values, and a corrupt input.

Hand-built PDF/OOXML on purpose: no library that WRITES a fixture is also the reader under
test, so a fixture can never silently depend on the thing being validated.

Run from anywhere (the output directory is anchored to the repository root, never to the current
working directory, and is gitignored scratch):
    python docs/overnight/fixtures/f09/ho_docs.py
"""
from __future__ import annotations

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
OUT = os.path.join(REPO, ".data", "tmp", "f09-heldout")

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
A_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


NON_ASCII_GAP = (
    "These hand-built PDFs carry only a Helvetica/WinAnsiEncoding text layer, so they cannot "
    "express Devanagari, CJK or emoji. Non-ASCII fidelity IS tested where the format actually "
    "carries it (OOXML parts are UTF-8: ho-inventory.xlsx 'Zürich', ho-catalog.docx "
    "'Morne-Rouge'/'Zürich West', ho-slides.pptx '日本語') and end to end at the worker byte "
    "protocol level (tests/test_worker_protocol.py). Unicode inside a PDF text layer needs a "
    "ToUnicode CMap fixture, which this suite does not build: recorded as a gap, not passed off "
    "as covered."
)


def wrap(text: str, width: int = 64) -> list[str]:
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


def _stream(cols: list[tuple[int, int, list[str]]]) -> bytes:
    out = []
    for x, y0, lines in cols:
        for i, line in enumerate(lines):
            esc = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            out.append(f"BT /F1 11 Tf {x} {y0 - 16 * i} Td ({esc}) Tj ET")
    return "\n".join(out).encode("ascii")


def pdf_bytes(pages: list[bytes], rotate: dict[int, int] | None = None) -> bytes:
    """Minimal but legal PDF: xref table, per-page /Rotate, no compressed streams.

    /Encoding /WinAnsiEncoding is NOT decorative. A standard Type1 font with no /Encoding
    entry is read with StandardEncoding, where byte 0x27 is quoteright (U+2019), so an
    apostrophe written as ASCII in the content stream comes back as a curly quote and the
    answer-bearing string no longer matches the source. That is a real fidelity property of
    PDF text layers (the declared encoding decides the code point), and the fixture must be
    built the way a real writer builds it, otherwise it tests its own accident.
    """
    rotate = rotate or {}
    objs: dict[int, bytes] = {}
    n = len(pages)
    first = 4
    kids = " ".join(f"{first + 2 * i} 0 R" for i in range(n))
    objs[1] = b"<</Type/Catalog/Pages 2 0 R>>"
    objs[2] = f"<</Type/Pages/Kids[{kids}]/Count {n}>>".encode()
    objs[3] = (b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica"
               b"/Encoding /WinAnsiEncoding>>")
    for i, content in enumerate(pages):
        pid = first + 2 * i
        extra = f" /Rotate {rotate[i + 1]}" if rotate.get(i + 1) else ""
        objs[pid] = (f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]{extra}"
                     f"/Resources<</Font<</F1 3 0 R>>>>/Contents {pid + 1} 0 R>>").encode()
        objs[pid + 1] = (b"<</Length " + str(len(content)).encode() + b">>stream\n"
                         + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    off: dict[int, int] = {}
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


def ho_hydro_pdf() -> bytes:
    """7 pages: two-column page 2, NO text layer page 3, rotated page 4, last-page answer."""
    p1 = _stream([(72, 740,
                   ["Kestrel Basin Hydrological Survey - Water Resources Board",
                    "Prepared by the basin engineering group."]
                   + wrap("Discharge through the upper gauges stayed within the seasonal band. "
                          "Sediment load fell after the restoration works, which the district "
                          "engineers attribute to the new buffer planting."))])
    left = ["LEFT COLUMN page 2", "Weir condition notes:", "- crest free of debris",
            "- guide rail corrosion noted"]
    right = ["RIGHT COLUMN page 2", "Gate inspection notes:", "- spillway gate 4 failed "
             "inspection on 12 May", "- actuator fluid logged at 61 percent"]
    p2 = _stream([(72, 740, left), (320, 740, right)])
    p4 = _stream([(72, 740,
                   ["PAGE 4 rotated 270 degrees",
                    "code: SELECT gauge_id FROM stations WHERE basin = 'kestrel';",
                    "formula: Q = C * b * sqrt(2 * g * h)"])])
    fill = wrap("Nothing decisive happens on this page; it exists to push the answer-bearing "
                "page toward the end of a long source and to cross the reader's own block "
                "limits, so that a chunk-boundary defect cannot hide behind a short file.")
    p7 = _stream([(72, 740,
                   ["PAGE SEVEN - late evidence",
                    "Answer-bearing fact: the Kestrel weir closure was approved on 8 August.",
                    "Distractor that must not be mistaken for it: the footbridge repair was "
                    "approved on 8 August.",
                    "Appendix note: figures audited by the external reviewer."])])
    pages = [p1, p2, b"", p4,
             _stream([(72, 740, ["PAGE FIVE filler paragraph."] + fill)]),
             _stream([(72, 740, ["PAGE SIX filler paragraph."] + fill)]),
             p7]
    return pdf_bytes(pages, rotate={4: 270})


def ho_negate_pdf() -> bytes:
    """9 pages, negation + paraphrase + a fact that is deliberately ABSENT from the source."""
    head = _stream([(72, 740,
                     ["Maritime Cargo Underwriting Panel - Q3 minute",
                      "Held by the classification committee."]
                     + wrap("Delegates reviewed the schedule of endorsements. The panel "
                            "considered whether the 14 percent surcharge should apply to "
                            "reefer containers, and recorded the vote in the addendum."))])
    neg = _stream([(72, 740,
                    ["NEGATION page 2 - read exactly, polarity matters",
                     "The board did not approve the 14 percent surcharge.",
                     "No delegate objected to the inspection levy, but the surcharge itself "
                     "remained unapproved.",
                     "Paraphrase trap: the surcharge was NOT accepted."])])
    fill = wrap("Distractor content, deliberately plausible: reefer claims, deductible bands, "
                "subrogation recoveries and classification society audits appear on every "
                "page so that a reader which only samples the front of a document can never "
                "produce the answer-bearing material.")
    late = _stream([(72, 740,
                     ["PAGE NINE - late evidence",
                      "Answer-bearing fact: the inspection levy was set at EUR 2,400 per "
                      "vessel.",
                      "Numeric unit line: 2,400 EUR 3.5 m depth 92 % relative humidity"])])
    pages = [head, neg] + [_stream([(72, 740, [f"PAGE {i} filler.", *fill])])
                           for i in range(3, 9)] + [late]
    return pdf_bytes(pages)


def _zip(parts: dict[str, str]) -> bytes:
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in parts.items():
            z.writestr(name, body)
    return buf.getvalue()


def _ct(overrides: dict[str, str]) -> str:
    body = "".join(f'<Override PartName="/{p}" ContentType="{t}"/>' for p, t in overrides.items())
    return (f'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="{CT_NS}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
            'relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            f"{body}</Types>")


def _rels(root_type: str, root_target: str, extra: list[tuple[str, str, str]] | None = None,
          first_id: str = "rId1") -> str:
    out = [f'<Relationship Id="{first_id}" Type="{A_NS}/{root_type}" Target="{root_target}"/>']
    for rid, t, target in (extra or []):
        out.append(f'<Relationship Id="{rid}" Type="{t}" Target="{target}"/>')
    return f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{REL_NS}">' + "".join(out) + "</Relationships>"


STRINGS = [
    "Kestrel depot inventory (merged title spans three columns)",   # 0
    "Lane", "Inbound tonnes", "Outbound tonnes", "Note",             # 1-4
    "Dock A", "Zürich", "12B", "Total", "empty cell carries no value",  # 5-9
]


def ho_inventory_xlsx() -> bytes:
    """Merged range in BOTH directions, typed values vs empty cells, formula + cached value."""
    cells = (
        # merged across A1:C1 (title) with nothing else on the row
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/><c r="C1"/></row>'
        # merged DOWN B3:B4: the value exists only in the anchor cell
        '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>5</v></c>'
        '<c r="C3" t="s"><v>2</v></c><c r="D3" t="s"><v>3</v></c></row>'
        '<row r="4"><c r="A4" t="s"><v>6</v></c><c r="B4"/><c r="C4"><v>0</v></c>'
        '<c r="D4" t="s"><v>9</v></c></row>'
        # explicit 0 in C4 must stay distinguishable from the EMPTY cell C5
        '<row r="5"><c r="A5" t="s"><v>7</v></c><c r="B5"><v>1234.5</v></c><c r="C5"/>'
        '<c r="E5"><f>SUM(B5:C5)</f><v>1234.5</v></c></row>')
    sheet = (f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{S_NS}">'
             f'<dimension ref="A1:E5"/><sheetData>{cells}</sheetData>'
             '<mergeCells count="2"><mergeCell ref="A1:C1"/>'
             '<mergeCell ref="B3:B4"/></mergeCells></worksheet>')
    sst = (f'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="{S_NS}" count="{len(STRINGS)}" '
           f'uniqueCount="{len(STRINGS)}">'
           + "".join(f"<si><t xml:space=\"preserve\">{s}</t></si>" for s in STRINGS) + "</sst>")
    return _zip({
        "[Content_Types].xml": _ct({
            "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml."
                               "sheet.main+xml",
            "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument."
                                        "spreadsheetml.worksheet+xml",
            "xl/sharedStrings.xml": "application/vnd.openxmlformats-officedocument."
                                    "spreadsheetml.sharedStrings+xml"}),
        "_rels/.rels": _rels("officeDocument", "xl/workbook.xml"),
        "xl/workbook.xml": (f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{S_NS}" '
                            f'xmlns:r="{A_NS}"><sheets><sheet name="Yard" sheetId="1" '
                            'r:id="rIdA"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": _rels("worksheet", "worksheets/sheet1.xml", [
            ("rIdB", f"{A_NS}/sharedStrings", "sharedStrings.xml")], first_id="rIdA"),
        "xl/worksheets/sheet1.xml": sheet,
        "xl/sharedStrings.xml": sst,
    })


def ho_badxml_xlsx() -> bytes:
    """A sheet part that is not well-formed XML at all (duplicate attribute on a cell).

    Split out of ho-corrupt.xlsx on purpose: a fatal sheet-parse error masks the
    shared-string-index defect when both live in one part, so each corruption needs its own
    fixture and its own expected outcome. The honest answer here is "this sheet failed", NOT
    "the workbook has no cells".
    """
    cells = ('<row r="1"><c r="A1"><v>1</v></c></row>'
             '<row r="2"><c r r="A2"><v>2</v></c></row>')
    sheet = (f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{S_NS}">'
             f'<sheetData>{cells}</sheetData></worksheet>')
    return _zip({
        "[Content_Types].xml": _ct({
            "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml."
                               "sheet.main+xml",
            "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument."
                                        "spreadsheetml.worksheet+xml"}),
        "_rels/.rels": _rels("officeDocument", "xl/workbook.xml"),
        "xl/workbook.xml": (f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{S_NS}" '
                            f'xmlns:r="{A_NS}"><sheets><sheet name="Torn" sheetId="1" '
                            'r:id="rIdA"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": _rels("worksheet", "worksheets/sheet1.xml",
                                            first_id="rIdA"),
        "xl/worksheets/sheet1.xml": sheet,
    })


def ho_corrupt_xlsx() -> bytes:
    """Corruption INSIDE a well-formed part: a shared-string index past the table end, and a
    cell holding an error value. Both must be reported, never blanked into an empty cell."""
    cells = ('<row r="1"><c r="A1" t="s"><v>99</v></c></row>'
             '<row r="2"><c r="A2" t="s"><v>0</v></c></row>'
             '<row r="3"><c r="A3" t="e"><v>#REF!</v></c></row>')
    sheet = (f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{S_NS}">'
             f'<sheetData>{cells}</sheetData></worksheet>')
    sst = (f'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="{S_NS}" count="1" uniqueCount="1">'
           "<si><t>only string</t></si></sst>")
    return _zip({
        "[Content_Types].xml": _ct({
            "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml."
                               "sheet.main+xml",
            "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument."
                                        "spreadsheetml.worksheet+xml",
            "xl/sharedStrings.xml": "application/vnd.openxmlformats-officedocument."
                                    "spreadsheetml.sharedStrings+xml"}),
        "_rels/.rels": _rels("officeDocument", "xl/workbook.xml"),
        "xl/workbook.xml": (f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{S_NS}" '
                            f'xmlns:r="{A_NS}"><sheets><sheet name="Broken" sheetId="1" '
                            'r:id="rIdA"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": _rels("worksheet", "worksheets/sheet1.xml", [
            ("rIdB", f"{A_NS}/sharedStrings", "sharedStrings.xml")], first_id="rIdA"),
        "xl/worksheets/sheet1.xml": sheet,
        "xl/sharedStrings.xml": sst,
    })


def ho_catalog_docx() -> bytes:
    """Three tables with different widths, a pipe inside a cell, unicode, literal markdown."""
    def para(text: str, style: str | None = None) -> str:
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

    def table(rows: list[list[str]]) -> str:
        out = ["<w:tbl><w:tblPr/>"]
        for r in rows:
            out.append("<w:tr>" + "".join(
                f"<w:tc><w:tcPr/><w:p><w:r><w:t xml:space=\"preserve\">{c}</w:t></w:r></w:p>"
                "</w:tc>" for c in r) + "</w:tr>")
        return "".join(out) + "</w:tbl>"

    body = (para("Transit Route Catalogue", "Heading1")
            + para("Table one: operators", "Heading2")
            + table([["Route", "Operator"], ["Morne-Rouge", "Chantal"], ["Zürich West", "Anders"]])
            + para("Table two: frequencies", "Heading2")
            + table([["Route", "Peak", "Off-peak"], ["Morne-Rouge", "12", "7"],
                     ["Zürich West", "9", "6"]])
            + para("Table three: a cell that contains a delimiter", "Heading2")
            + table([["Route", "Interchange"], ["Morne-Rouge", "Quai | Ferme"],
                     ["Zürich West", "Kant | Ost"]])
            + para("Closing note: the timetable is re-tendered each spring.", None)
            + para("### this literal markdown line is a paragraph, not a heading", None)
            + para("code-ish line: SELECT route_id FROM runs WHERE operator = 'Chantal';", None))
    doc = (f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W_NS}">'
           f"<w:body>{body}</w:body></w:document>")
    return _zip({
        "[Content_Types].xml": _ct({"word/document.xml": "application/vnd.openxmlformats-"
                                     "officedocument.wordprocessingml.document.main+xml"}),
        "_rels/.rels": _rels("officeDocument", "word/document.xml"),
        "word/document.xml": doc,
    })


def ho_slides_pptx() -> bytes:
    """Three slides: title only, notes with an answer-bearing fact, and a code-ish body."""
    def slide(shapes: list[str]) -> str:
        return ('<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.'
                'openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats'
                '.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/'
                'officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr '
                'id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
                + "".join(shapes) + "</p:spTree></p:cSld></p:sld>")

    def shape(name: str, text: str) -> str:
        paras = "".join(f"<a:p><a:r><a:t>{t}</a:t></a:r></a:p>" for t in text.split("\n"))
        return (f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
                f"<p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp>")

    notes = ('<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:a="http://schemas.'
             'openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/'
             'presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" '
             'name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr>'
             '<p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody>'
             "<a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Speaker note fact: the depot lease expires "
             "1 June and the fare uplift was deferred.</a:t></a:r></a:p></p:txBody></p:sp>"
             "</p:spTree></p:cSld></p:notes>")

    s1 = slide([shape("Title", "Fleet Transition Review"),
                shape("Blank", "")])          # a shape with no text: silent visual content
    s2 = slide([shape("Body", "Route closures:\n- Morne-Rouge suspended\n- Zürich West doubled")])
    s3 = slide([shape("Code", "SELECT line_id FROM fleet WHERE depot = 'Nord';"),
                shape("Body", "Étiquette: dépôt  日本語: 車庫")])

    slide_parts = {f"ppt/slides/slide{i}.xml": s for i, s in enumerate([s1, s2, s3], start=1)}
    slide_rels = {f"ppt/slides/_rels/slide{i}.xml.rels": _rels(
        "notesSlide", f"../notesSlides/notesSlide{i}.xml") for i in (2,)}
    pres = ('<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.'
            'openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats'
            '.org/officeDocument/2006/relationships"><p:sldIdLst>'
            '<p:sldId id="256" r:id="rIdS1"/><p:sldId id="257" r:id="rIdS2"/>'
            '<p:sldId id="258" r:id="rIdS3"/></p:sldIdLst></p:presentation>')
    pres_rels = _rels("slide", "slides/slide1.xml", [
        ("rIdS2", f"{A_NS}/slide", "slides/slide2.xml"),
        ("rIdS3", f"{A_NS}/slide", "slides/slide3.xml")])
    content_types = _ct({f"ppt/slides/slide{i}.xml": "application/vnd.openxmlformats-"
                         "officedocument.presentationml.slide+xml" for i in (1, 2, 3)}
                        | {"ppt/presentation.xml": "application/vnd.openxmlformats-officedocument."
                           "presentationml.presentation.main+xml",
                           "ppt/notesSlides/notesSlide2.xml": "application/vnd.openxmlformats-"
                           "officedocument.presentationml.notesSlide+xml"})
    return _zip({
        "[Content_Types].xml": content_types,
        "_rels/.rels": _rels("officeDocument", "ppt/presentation.xml"),
        "ppt/presentation.xml": pres,
        "ppt/_rels/presentation.xml.rels": pres_rels,
        "ppt/notesSlides/notesSlide2.xml": notes,
        "ppt/notesSlides/_rels/notesSlide2.xml.rels": _rels("slide", "../slides/slide2.xml"),
        **slide_parts,
        **slide_rels,
    })


def empty_pdf() -> bytes:
    """A valid PDF with no text layer at all: the honest answer is 'nothing extracted'."""
    return pdf_bytes([b"", b""])


BUILDERS = {
    "ho-hydro.pdf": ho_hydro_pdf,
    "ho-negate.pdf": ho_negate_pdf,
    "ho-empty.pdf": empty_pdf,
    "ho-inventory.xlsx": ho_inventory_xlsx,
    "ho-corrupt.xlsx": ho_corrupt_xlsx,
    "ho-badxml.xlsx": ho_badxml_xlsx,
    "ho-catalog.docx": ho_catalog_docx,
    "ho-slides.pptx": ho_slides_pptx,
}


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, build in BUILDERS.items():
        data = build()
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(data)
        print(f"{name}: {len(data)} bytes")


if __name__ == "__main__":
    main()
