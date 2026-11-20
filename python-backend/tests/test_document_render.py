"""The reader's own structure-preserving rendering, and the payload that ships it.

Frozen answer key, written from the measured defect: the wire payload carried every block
with its cell reference, merged area, table/row identity and heading level in `loc`, but a
caller joining `block.text` threw all of it away. The TS office merge then measured the
capability body as SMALLER than the TS reader's body (measured on f06-sheet.xlsx: 95
capability characters vs the TS reader's 224 for the SAME content) and kept the weaker
text, so the §3-C fidelity fixes never reached the user. A rendering is DERIVED text beside
the raw blocks, never a replacement, and it states only what the reader actually parsed.
"""
from __future__ import annotations

import os
import tempfile
import threading
import unittest
import zipfile

from ruke_ml.contracts import JobRequest
from ruke_ml.documents import parser, render
from ruke_ml.documents.structures import Block, DocCoverage, Document
from ruke_ml.workers.document_jobs import parse_job
from ruke_ml.workers.jobs import JobContext


def _blocks(*specs: tuple[str, str, dict]) -> list[Block]:
    return [Block(text, kind, "doc", "hash", loc) for kind, text, loc in specs]


def _doc(kind: str, specs: list[tuple[str, str, dict]], *, meta: dict | None = None,
         units_total: int = 1) -> Document:
    blocks = _blocks(*specs)
    return Document(
        source_id="doc", source_hash="hash", kind=kind, blocks=blocks,
        coverage=DocCoverage(units_total=units_total, units_extracted=units_total,
                             units_succeeded=list(range(1, units_total + 1)),
                             method="ruke-ml reader"),
        meta=meta or {},
    )


class Rendering(unittest.TestCase):
    def test_xlsx_rendering_keeps_coordinates_merged_ranges_and_worksheet_identity(self):
        doc = _doc("xlsx", [
            ("cell", "Revenue", {"cell": "A1", "sheet_index": 1, "sheet": "Margin",
                                 "merged": "A1:B2"}),
            ("cell", "", {"cell": "B1", "sheet_index": 1, "sheet": "Margin",
                          "merged": "A1:B2"}),          # empty member of the merge
            ("formula", "=A1*2 [cached 5]", {"cell": "C1", "sheet_index": 1}),
        ], meta={"sheets": ["Margin"], "merged_ranges": {"Margin": ["A1:B2"]}})

        out = render.render_units(doc)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["unit"], 1)
        self.assertEqual(out[0]["provenance"], "text-layer")
        self.assertEqual(out[0]["engine"], "ruke-ml reader")
        self.assertEqual(out[0]["truncated"], False)
        text = out[0]["text"]
        self.assertIn("### worksheet: Margin", text)
        self.assertIn("A1=Revenue [merged A1:B2]", text)
        # The formula text already carries its own "=", so the reference must not add a second
        # one: "C1==A1*2" is not spreadsheet syntax. (Expectation corrected, not relaxed: the
        # exact string is still asserted - see DECISIONS D-037.)
        self.assertIn("C1=A1*2 [cached 5]", text)
        self.assertNotIn("C1==", text)
        # The honest part: a merged region carries ONE value, and that must be said, so a
        # reader cannot silently read the blank members as zeros.
        self.assertIn("a merged block carries ONE value", text)
        self.assertIn("### merged cells (1): A1:B2", text)
        self.assertNotIn("B1=", text, "an empty member of a merged region is not content")

    def test_corrupt_cells_are_named_as_unread_never_as_blank(self):
        doc = _doc("xlsx", [("cell", "A", {"cell": "A1", "sheet_index": 1})],
                   meta={"sheets": ["S"], "corrupt_cells": ["B7", "C9"]})
        text = render.render_units(doc)[0]["text"]
        # Named BY REFERENCE, joined so a reference cannot blend into the next one, and the
        # tail says what they are NOT. A bare comma list was the old wording; the honesty
        # requirement is unchanged (never blank, never zero), see DECISIONS D-039.
        self.assertIn("### cells this reader could NOT read: B7; C9", text)
        self.assertIn("they are NOT blank and NOT zero", text)
        self.assertNotIn("{'", text, "a raw dict repr is reader plumbing, not document content")

    def test_corrupt_cells_named_as_dicts_render_as_reference_plus_reason(self):
        doc = _doc("xlsx", [("cell", "A", {"cell": "A1", "sheet_index": 1})], meta={
            "sheets": ["S"],
            "corrupt_cells": [
                {"sheet": "S", "cell": "A1", "why": "shared-string index '99' is outside the 1 entry table"},
                {"sheet": "S", "cell": "A3", "why": "cell holds an error value: #REF!"},
            ]})
        text = render.render_units(doc)[0]["text"]
        self.assertIn("A1: shared-string index '99' is outside the 1 entry table", text)
        self.assertIn("A3: cell holds an error value: #REF!", text)
        self.assertNotIn("{'sheet'", text)

    def test_docx_table_rows_keep_table_and_row_identity_and_headings_only_when_named(self):
        doc = _doc("docx", [
            ("heading", "Quarterly", {"section": "Heading 2"}),
            ("heading", "Untyped title", {"section": "Title"}),
            ("table_row", "Payments | Ana", {"table": 1, "row": 1, "cells": ["Payments", "Ana"]}),
            ("table_row", "Ledger | 99.9", {"table": 1, "row": 2, "cells": ["Ledger", "99.9"]}),
            ("table_row", "Totals | 3", {"table": 2, "row": 1, "cells": ["Totals", "3"]}),
        ])
        text = render.render_units(doc)[0]["text"]
        self.assertIn("## Quarterly", text)
        self.assertNotIn("## Untyped title", text, "an unnamed style is not a heading level")
        self.assertIn("[style: Title]", text)
        self.assertIn("| Payments | Ana | [table 1 row 1 of 2 cell(s)]", text)
        self.assertIn("| Ledger | 99.9 | [table 1 row 2 of 2 cell(s)]", text)
        self.assertIn("| Totals | 3 | [table 2 row 1 of 2 cell(s)]", text)
        self.assertIn("### tables in this document: 2", text)

    def test_a_reader_that_knows_what_it_missed_says_so(self):
        doc = _doc("docx", [("paragraph", "body", {})],
                   meta={"not_extracted": ["images", "embedded objects"]})
        text = render.render_units(doc)[0]["text"]
        self.assertIn("### this reader did NOT extract: images, embedded objects", text)

    def test_pptx_slide_identity_and_speaker_notes_stay_apart(self):
        doc = _doc("pptx", [
            ("paragraph", "Slide body", {"slide": 2}),
            ("note", "Say the margin figure", {"slide": 2, "part": "notes"}),
            ("code", "x = 1", {"slide": 2}),
            ("list_item", "first", {"slide": 2}),
        ], units_total=2)
        out = render.render_units(doc)
        # Slide 1 has no text blocks, but the reader KNOWS the slide exists (units_total=2).
        # It is rendered with its identity header and no content, rather than vanishing: a
        # silently missing slide is how "the deck has 2 slides" becomes "the deck has 1".
        self.assertEqual([u["unit"] for u in out], [1, 2])
        self.assertEqual(out[0]["blocks"], 0)
        self.assertEqual(out[0]["text"], "### slide 1")   # identity only, nothing invented
        text = out[1]["text"]
        self.assertIn("### slide 2", text)
        self.assertIn("[notes] Say the margin figure", text)
        self.assertIn("[code] x = 1", text)
        self.assertIn("- first", text)

    def test_pdf_pages_are_not_rendered_because_the_page_unit_already_is_the_text(self):
        doc = _doc("pdf", [("page_text", "native page text", {"page": 1})])
        self.assertEqual(render.render_units(doc), [])

    def test_ocr_only_unit_is_labelled_ocr_and_a_mixed_unit_is_not(self):
        ocr_only = _doc("xlsx", [("ocr_text", "recognized", {"sheet_index": 1})])
        self.assertEqual(render.render_units(ocr_only)[0]["provenance"], "ocr")
        mixed = _doc("xlsx", [("ocr_text", "recognized", {"sheet_index": 1}),
                              ("cell", "native", {"cell": "A1", "sheet_index": 1})])
        self.assertEqual(render.render_units(mixed)[0]["provenance"], "text-layer")

    def test_truncation_is_stated_never_silent(self):
        doc = _doc("xlsx", [("cell", "x" * (render.MAX_UNIT_CHARS + 10),
                             {"cell": "A1", "sheet_index": 1})])
        out = render.render_units(doc)[0]
        self.assertTrue(out["truncated"])
        self.assertIn("truncated at", out["text"])
        self.assertIn("block list still carries every extracted block", out["text"])

    def test_unit_ids_are_the_1_based_ids_coverage_and_citations_use(self):
        doc = _doc("xlsx", [
            ("cell", "one", {"cell": "A1", "sheet_index": 1}),
            ("cell", "three", {"cell": "A1", "sheet_index": 3}),
        ], units_total=3)
        self.assertEqual([u["unit"] for u in render.render_units(doc)], [1, 3])
        self.assertEqual(render.unit_of(Block("t", "cell", "d", "h", {"sheet_index": True})), 1,
                         "a boolean must never be read as unit 1-by-count")


XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


def _zip(path: str, members: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w") as z:
        for name, body in members.items():
            z.writestr(name, body)


def _docx_bytes(rows: list[tuple[str, str]]) -> str:
    # ONE table with one <w:tr> per row: two <w:tbl> elements would legitimately be two
    # tables, and the assertion below is about row identity inside a single table.
    body = "<w:tbl>" + "".join(
        f"<w:tr><w:tc><w:t>{a}</w:t></w:tc><w:tc><w:t>{b}</w:t></w:tc></w:tr>"
        for a, b in rows) + "</w:tbl>"
    return XMLDECL + (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>")


class ParsePayloadCarriesTheRendering(unittest.TestCase):
    """The rendering must reach the wire, beside the blocks, for the real job."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ruke-render-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _ctx(self, name: str) -> JobContext:
        return JobContext(
            req=JobRequest(request_id="r", run_id="run", job_id="j", capability="documents.parse",
                           payload={"path": os.path.join(self.dir, name), "root": self.dir}),
            cancel=threading.Event(), progress=lambda state, note: None)

    def test_docx_job_ships_rendered_units_and_keeps_blocks_as_raw_evidence(self):
        _zip(os.path.join(self.dir, "notes.docx"), {
            "[Content_Types].xml": XMLDECL + "<Types/>",
            "word/document.xml": _docx_bytes([("Payments", "Ana"), ("Ledger", "99.9")]),
        })
        res = parse_job(self._ctx("notes.docx"))
        self.assertEqual(res.state, "ready", getattr(res, "error", None) and res.error.message)
        self.assertTrue(res.payload["rendered_units"], "a docx parse must carry a rendering")
        rendered = res.payload["rendered_units"][0]["text"]
        self.assertIn("| Payments | Ana | [table 1 row 1 of 2 cell(s)]", rendered)
        self.assertIn("| Ledger | 99.9 | [table 1 row 2 of 2 cell(s)]", rendered)
        # the raw blocks are still there, untouched
        rows = [b for b in res.payload["document"]["blocks"] if b["kind"] == "table_row"]
        self.assertEqual(rows[0]["text"], "Payments | Ana")
        self.assertEqual(rows[0]["loc"]["row"], 1)
        self.assertIn("table-row identity", res.payload["rendering_note"])

    def test_a_pdf_job_ships_no_per_unit_rendering_and_says_so_instead(self):
        # A real PDF (pypdf is the reader's own pinned dependency): page units already
        # arrive as one text per page, and the payload must not pretend otherwise.
        from pypdf import PdfWriter
        writer = PdfWriter()
        writer.add_blank_page(width=300, height=200)
        with open(os.path.join(self.dir, "blank.pdf"), "wb") as fh:
            writer.write(fh)
        res = parse_job(self._ctx("blank.pdf"))
        self.assertEqual(res.state, "ready", getattr(res, "error", None) and res.error.message)
        self.assertEqual(res.payload["rendered_units"], [])
        self.assertIn("no per-unit rendering", res.payload["rendering_note"])
        self.assertEqual(res.payload["document"]["kind"], "pdf")
        self.assertFalse(res.payload["coverage_complete"],
                         "a blank page is an empty unit, not a read one")


if __name__ == "__main__":
    unittest.main()
