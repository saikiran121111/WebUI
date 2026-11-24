"""F78 family D: office-format content laws for the file-reading release.

Every assertion is a ground-truth fact from the audit fixtures
(docs/overnight/fixtures/f78/) that the OLD readers demonstrably lost: tracked
deletions, OMML equations, PPTX display order, speaker notes, chart cached
values, ODS sheet identity, ODT list text, ODP presenter notes, EPUB spine
order, RTF hidden groups, legacy DOC/PPT/XLS/MAT content, and the typed
refusals that replace the old silent byte-scan flattening.

A passing upload badge proves nothing here: each test loads the real fixture
through the production `load_document` and asserts the FACT and the STRUCTURE
(unit id, cell ref, kind) the delivery layer cites.
"""
from __future__ import annotations

import os
import unittest
import zipfile
import io

from ruke_ml.documents import parser, render

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
F78 = os.path.join(REPO, "docs", "overnight", "fixtures", "f78")
RD = os.path.join(F78, "review-docs")
AR = os.path.join(F78, "all-readers")


def load(subdir: str, name: str):
    path = os.path.join(subdir, name)
    assert os.path.exists(path), f"fixture missing: {path}"
    return parser.load_document(path)


def body(doc) -> str:
    rendered = render.render_units(doc)
    if rendered:
        return "\n".join(u["text"] for u in rendered)
    return doc.as_text()


def blocks_at(doc, **loc):
    return [b for b in doc.blocks
            if all(str(b.loc.get(k)) == str(v) for k, v in loc.items())]


class DocxLaws(unittest.TestCase):
    def test_tracked_deletion_kept_inline_with_landing_text(self):
        doc = load(RD, "policy.docx")
        text = body(doc)
        self.assertIn("[deleted revision: 910 seats]", text)
        self.assertIn("307 seats", text)
        self.assertIn("73 tonnes", text)
        self.assertIn("17 June 2031", text)
        self.assertIn("Cedar", text)
        self.assertGreaterEqual(doc.meta.get("revision_paragraphs", 0), 1)
        self.assertGreaterEqual(len(doc.meta.get("side_parts", [])), 1)

    def test_omml_equation_linearized(self):
        doc = load(RD, "equation.docx")
        self.assertIn("(u+7)/(v-4)", body(doc))
        self.assertTrue(any("OMML" in str(x) for x in doc.meta.get("not_extracted", [])),
                        f"equation loss must be disclosed: {doc.meta}")


class PptxLaws(unittest.TestCase):
    def test_display_order_is_slide_id_lst_not_filename(self):
        doc = load(RD, "deck.pptx")
        self.assertIn("p:sldIdLst display order", str(doc.meta.get("unit_numbering", "")))
        for slide, title in ((1, "Inspection image"), (2, "Opening summary"),
                             (3, "Reservoir yield")):
            hits = blocks_at(doc, slide=slide)
            self.assertTrue(any(b.text == title for b in hits),
                            f"slide {slide} must be {title!r}; got {[b.text for b in hits]}")

    def test_speaker_note_lands_on_its_display_slide(self):
        doc = load(RD, "deck.pptx")
        notes = [b for b in doc.blocks if b.kind == "note" and "61 litres" in b.text]
        self.assertEqual([b.loc.get("slide") for b in notes], [3],
                         "the 61-litres note belongs to display slide 3")

    def test_chart_cached_values_reach_the_body(self):
        doc = load(AR, "sample.pptx")
        charts = [b for b in doc.blocks if "chart" in str(b.loc.get("chart", ""))]
        self.assertTrue(charts, f"chart1.xml series missing; blocks={[b.text for b in doc.blocks]}")
        self.assertIn("East=83, West=42", charts[0].text)
        self.assertEqual(charts[0].loc.get("slide"), 3)
        self.assertIn("East=83, West=42", body(doc))

    def test_scatter_xval_yval_points_reach_the_body(self):
        """F64: scatter charts cache under c:xVal/c:yVal, NOT c:cat/c:val.

        The audit deck (deck-4.pptx) showed the model ONLY the slide words
        "My/Scatter/Chart": a cat/val-only chart reader skips every scatter
        series, so "Sales" and its largest value 8.2 never reach the answer.
        """
        doc = load(AR, "scatter.pptx")
        charts = [b for b in doc.blocks if str(b.loc.get("chart", ""))]
        self.assertTrue(charts, f"scatter series missing; blocks={[b.text for b in doc.blocks]}")
        self.assertIn('series "Sales"', charts[0].text)
        self.assertIn("(1st Qtr, 8.2", charts[0].text)   # cached float noise kept
        self.assertIn("(4th Qtr, 1.2)", charts[0].text)
        self.assertIn("Sales", body(doc))

    def test_unresolvable_sldid_refs_fall_back_to_filename_order(self):
        """An sldIdLst whose r:id has no relationship must NOT silently move slides."""
        def slide(text: str) -> str:
            return ('<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.'
                    'openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.'
                    'openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>'
                    '<p:sp><p:txBody><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p>'
                    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
        rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.'
                'openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rIdS2" Type="x/slide" Target="slides/slide2.xml"/>'
                '</Relationships>')  # rIdS1 deliberately absent
        pres = ('<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.'
                'openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.'
                'openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>'
                '<p:sldId id="256" r:id="rIdS1"/><p:sldId id="257" r:id="rIdS2"/>'
                '</p:sldIdLst></p:presentation>')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("ppt/presentation.xml", pres)
            zf.writestr("ppt/_rels/presentation.xml.rels", rels)
            zf.writestr("ppt/slides/slide1.xml", slide("Title slide"))
            zf.writestr("ppt/slides/slide2.xml", slide("Body slide"))
        path = os.path.join(os.environ.get("TEMP", "/tmp"), "f78-broken-order.pptx")
        with open(path, "wb") as fh:
            fh.write(buf.getvalue())
        try:
            doc = parser.load_document(path)
            self.assertTrue(any(b.text == "Title slide" and b.loc.get("slide") == 1
                                for b in doc.blocks),
                            f"title slide moved off slide 1: {[(b.text, b.loc) for b in doc.blocks]}")
            self.assertIn("unresolvable", str(doc.meta.get("unit_numbering", "")))
        finally:
            os.remove(path)


class OpenDocumentLaws(unittest.TestCase):
    def test_ods_sheet_identity_and_formula_cache(self):
        doc = load(RD, "structured.ods")
        self.assertEqual(doc.meta.get("sheets"), ["Cash", "Debt"])
        d41 = [b for b in doc.blocks if b.loc.get("cell") == "D41"]
        self.assertEqual([(b.loc.get("sheet"), b.text) for b in d41], [("Cash", "89")])
        self.assertEqual(d41[0].loc.get("sheet_index"), 1)
        e41 = [b for b in doc.blocks if b.loc.get("cell") == "E41"]
        self.assertEqual(e41[0].kind, "formula")
        self.assertIn("178", e41[0].text)
        self.assertIn("of:=[.D41]*2", str(e41[0].loc.get("formula")))
        a1 = [b for b in doc.blocks if b.loc.get("cell") == "A1"]
        self.assertEqual([(b.loc.get("sheet"), b.text) for b in a1], [("Debt", "12")])
        text = body(doc)
        self.assertIn("### worksheet: Cash", text)
        self.assertIn("### worksheet: Debt", text)

    def test_odt_body_headings_and_list_items(self):
        doc = load(RD, "structured.odt")
        text = body(doc)
        self.assertIn("Temporary limit 37 bars", text)
        self.assertIn("41 bars", text)
        delta = [b for b in doc.blocks if "Delta" in b.text]
        self.assertTrue(delta, "list-item text must not be dropped")
        self.assertEqual(delta[0].kind, "list_item")

    def test_odp_pages_named_and_presenter_notes_kept(self):
        doc = load(RD, "structured.odp")
        self.assertEqual(doc.meta.get("page_names"), {"1": "Intake", "2": "Return"})
        gate76 = [b for b in doc.blocks if "76" in b.text]
        self.assertEqual(gate76[0].kind, "note")
        self.assertEqual(gate76[0].loc.get("page"), 1)
        gate52 = [b for b in doc.blocks if "52" in b.text]
        self.assertEqual(gate52[0].kind, "note")
        self.assertEqual(gate52[0].loc.get("page"), 2)
        self.assertIn("### page 1: Intake", body(doc))


class EpubRtfLaws(unittest.TestCase):
    def test_epub_spine_reading_order(self):
        doc = load(RD, "manual.epub")
        self.assertEqual(doc.meta.get("chapters"), {"1": "EPUB/z.xhtml", "2": "EPUB/a.xhtml"})
        text = body(doc)
        self.assertLess(text.index("Arrival"), text.index("Calibration"),
                        "spine order must be the reading order")
        self.assertIn("341 volts", text)
        self.assertIn("### chapter 1 (spine reading order)", text)

    def test_rtf_visible_text_only(self):
        doc = load(RD, "sample.rtf")
        text = body(doc)
        self.assertIn("Visible price 42.", text)
        self.assertIn("Café Nord.", text)  # unicode escape, not the cp1252 fallback
        self.assertNotIn("918", text)      # hidden \v group stays excluded
        self.assertGreaterEqual(doc.meta.get("hidden_groups_excluded", 0), 1)
        self.assertIn("EXCLUDED by design", text)


class LegacyBinaryLaws(unittest.TestCase):
    def test_doc_word97_text(self):
        doc = load(AR, "simple.doc")
        self.assertEqual(doc.kind, "doc")
        self.assertIn("Word 97-SR2", body(doc))

    def test_ppt_legacy_text_and_notes(self):
        doc = load(AR, "SampleShow.ppt")
        self.assertEqual(doc.kind, "ppt")
        text = body(doc)
        self.assertIn("Title of the first slide", text)

    def test_ppt_basic_test_measured_reality(self):
        doc = load(AR, "basic_test_ppt_file.ppt")
        self.assertEqual((doc.coverage.units_total, doc.coverage.units_extracted), (5, 3))
        self.assertEqual(doc.coverage.units_empty, [4, 5])
        self.assertFalse(doc.coverage.complete)
        text = body(doc)
        self.assertIn("This is the title on page 2", text)
        self.assertIn("These are the notes for page 1", text)

    def test_xls_solver_seven_sheets_biff8(self):
        doc = load(AR, "solver.xls")
        self.assertEqual(len(doc.meta.get("sheets", [])), 7)
        self.assertIn("Quick Tour", doc.meta["sheets"])
        self.assertEqual(doc.coverage.method, "biff8-cells")
        b18 = [b for b in doc.blocks if b.loc.get("cell") == "B18"
               and b.loc.get("sheet") == "Quick Tour"]
        self.assertEqual(b18[0].text, "40")
        self.assertIn("### worksheet: Quick Tour", body(doc))

    def test_mat_v4_dimensions_and_values(self):
        doc = load(AR, "sample.mat")
        self.assertEqual(doc.meta.get("variables"), ["yields"])
        cells = {(b.loc.get("row"), b.loc.get("col")): b.text for b in doc.blocks
                 if b.loc.get("row") is not None}
        self.assertEqual(cells[(1, 1)], "yields[1,1] = 12.25")
        self.assertEqual(cells[(2, 1)], "yields[2,1] = 98.75")  # column-major
        self.assertEqual(cells[(1, 2)], "yields[1,2] = 63.5")
        self.assertEqual(cells[(2, 2)], "yields[2,2] = 440.125")
        dims = [b for b in doc.blocks if b.loc.get("dims")]
        self.assertEqual(dims[0].loc["dims"], [2, 2])
        self.assertIn("column-major", body(doc))

    def test_malformed_ole_is_a_typed_refusal(self):
        for name in ("smoke.doc", "smoke.xls", "smoke.ppt"):
            with self.subTest(fixture=name):
                doc = load(AR, name)
                self.assertEqual(doc.kind, "unsupported")
                self.assertEqual((doc.coverage.units_total, doc.coverage.units_extracted), (0, 0))
                self.assertIn("malformed legacy binary", doc.coverage.note)
                self.assertEqual(render.render_units(doc), [])


class MalformedPackageLaws(unittest.TestCase):
    def test_non_zip_package_claim_is_a_typed_refusal(self):
        import tempfile
        for suffix in (".odt", ".docx", ".epub", ".xlsx"):
            with self.subTest(suffix=suffix):
                with tempfile.TemporaryDirectory() as tmp:
                    path = os.path.join(tmp, f"claim{suffix}")
                    with open(path, "wb") as fh:
                        fh.write(b"definitely not a zip container")
                    doc = parser.load_document(path)
                    self.assertEqual(doc.kind, "unsupported",
                                     f"{suffix} must refuse typed, not raise")
                    self.assertIn("not a readable", doc.coverage.note)


class MacroOoxmlLaws(unittest.TestCase):
    """F71: macro-enabled OOXML is the SAME container plus a vbaProject.bin part.

    The structured reader must parse .docm/.pptm (and macro-enabled .xlsm)
    through the identical part paths as the plain format; the refusal "no
    parser is configured for .docm" is what pushed the live upload into the
    archive byte-dump path.
    """

    def test_docm_parses_as_the_wordprocessing_body(self):
        doc = load(AR, "macro-word.docm")
        self.assertEqual(doc.kind, "docx")
        text = body(doc)
        self.assertIn("Section alpha reports 118 and 271 as the pair.", text)
        self.assertIn("The macro-bearing body text ends here.", text)
        self.assertTrue(doc.blocks, "body paragraphs must be real blocks")
        self.assertTrue(all("vbaProject" not in b.text for b in doc.blocks))

    def test_pptm_parses_as_the_presentation_body(self):
        doc = load(AR, "macro-deck.pptm")
        self.assertEqual(doc.kind, "pptx")
        self.assertIn("Slide one carries the value 90210.", body(doc))

    def test_xlsm_parses_as_the_workbook(self):
        doc = load(AR, "sample.xlsm")
        self.assertNotEqual(doc.kind, "unsupported",
                            "the workbook reader must serve macro-enabled workbooks")


if __name__ == "__main__":
    unittest.main()
