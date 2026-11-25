"""Index publishing is transactional, identity survives normalization, extraction keeps structure.

These are the Python mirrors of the F09/F12 laws: a crash never leaves a mixed generation,
C++ never collapses into C, and a formula is not replaced by its cached value.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
import zipfile

from ruke_ml.contracts import EmbeddingMeta, ModelIdentity
from ruke_ml.documents import ocr, parser
from ruke_ml.documents.structures import Block
from ruke_ml.retrieval import chunking, embeddings, reranker

_HAVE_PYPDF = importlib.util.find_spec("pypdf") is not None


def meta(dim=512):
    return EmbeddingMeta(model=ModelIdentity("ruke-lexical-hash", "builtin-v1", "builtin"),
                         dim=dim, normalization="l2")


class Identity(unittest.TestCase):
    def test_symbol_bearing_identifiers_survive(self):
        t = set(chunking.tokenize("C++ and C# are not C; rustc 1.83 vs Rust 2021"))
        self.assertEqual({"C++"} & t, {"C++"}, t)
        self.assertEqual({"C#"} & t, {"C#"}, t)
        self.assertEqual({"c"} & t, {"c"}, "bare C folds to c, but symbol-bearing identifiers must not")
        symb = {tok for tok in t if any(ch in tok for ch in "#+")}
        self.assertEqual(symb, {"C++", "C#"}, "symbol-bearing identifiers must survive intact")
        self.assertEqual(len([tok for tok in chunking.tokenize("C++ and C# are not C") if tok == "c"]), 1,
                         "the bare letter C must appear once, not be generated from C++ or C#")
        nums = set(chunking.tokenize("rustc 1.83 vs 2021"))
        self.assertIn("1.83", nums)
        self.assertIn("2021", nums)
        self.assertNotIn("1", nums, "numbers must not be split into prefixes")
        self.assertNotIn("1.8", nums, nums)
        self.assertEqual({x.lower() for x in chunking.tokenize("C++ vs c++")},
                         {"c++", "vs"}, "case must not fork an identifier into two different tokens")

    def test_case_and_script_folding_is_conservative(self):
        a = chunking.tokenize("Rust ownership")
        b = chunking.tokenize("rust ownership")
        self.assertEqual([x.lower() for x in a], b)
        self.assertTrue(any(tok for tok in chunking.tokenize("నేటి వార్తలు")), "Indic script must not vanish")
        self.assertTrue(any(tok for tok in chunking.tokenize("日本語のテキスト")), "CJK must not vanish")

    def test_block_boundaries_win(self):
        blocks = [Block("x " * 400, "paragraph", "s", "h", {"page": 1}),
                  Block("total = 5", "formula", "s", "h", {"sheet": "Q1", "cell": "B2"})]
        chunks = chunking.chunk_blocks(blocks, max_tokens=120, overlap_tokens=20)
        self.assertTrue(any("total = 5" in c.text and c.text.count("total = 5") == 1 for c in chunks))
        last = chunks[-1]
        self.assertTrue(last.block_ids, "chunks must carry block identities for recovery")


class Publish(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ruke-idx-")
        self.blocks = [Block("alpha report", "paragraph", "s1", "h1", {"page": 1}),
                       Block("beta invoice 42", "paragraph", "s1", "h1", {"page": 2})]
        self.chunks = chunking.chunk_blocks(self.blocks, max_tokens=64, overlap_tokens=0)

    def test_publish_then_load(self):
        vecs, m = embeddings.embed_texts([c.text for c in self.chunks])
        man = chunking.publish_generation(self.dir, self.chunks, vecs, m, "test-pipeline")
        loaded_man, loaded_chunks, loaded_vecs = chunking.load_current(self.dir)
        self.assertEqual(loaded_man["generation"], man["generation"])
        self.assertEqual(len(loaded_chunks), len(self.chunks))
        self.assertEqual(len(loaded_vecs), len(self.chunks))

    def test_ragged_and_mismatched_vectors_refused(self):
        with self.assertRaises(ValueError):
            chunking.publish_generation(self.dir, self.chunks, [[1.0], [1.0, 2.0]], meta(2), "p")
        with self.assertRaises(ValueError):
            chunking.publish_generation(self.dir, self.chunks, [[1.0, 2.0]] * len(self.chunks),
                                        meta(3), "p")
        with self.assertRaises(ValueError):
            chunking.publish_generation(self.dir, self.chunks, [[1.0, 2.0]], meta(2), "p")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "CURRENT.json")),
                         "a refused publish must not move the pointer")

    def test_crash_mid_publish_leaves_previous_generation_readable(self):
        vecs, m = embeddings.embed_texts([c.text for c in self.chunks])
        first = chunking.publish_generation(self.dir, self.chunks, vecs, m, "p1")
        # simulate a build that dies after staging some bytes but before the switch
        staging = os.path.join(self.dir, first["generation"] + ".crash.staging")
        os.makedirs(staging, exist_ok=True)
        with open(os.path.join(staging, "chunks.jsonl"), "w", encoding="utf-8") as fh:
            fh.write('{"partial": tru')
        man2, chunks2, _ = chunking.load_current(self.dir)
        self.assertEqual(man2["generation"], first["generation"])
        self.assertEqual(len(chunks2), len(self.chunks))
        removed = chunking.garbage_collect(self.dir, keep=2)
        self.assertFalse(os.path.exists(staging), "orphan staging dirs must be collected")
        self.assertNotIn(first["generation"], removed, "the live generation is never collected")

    def test_reindex_keeps_reader_consistent(self):
        vecs, m = embeddings.embed_texts([c.text for c in self.chunks])
        a = chunking.publish_generation(self.dir, self.chunks, vecs, m, "p1")
        more = self.chunks + chunking.chunk_blocks([Block("gamma new text", "paragraph", "s1", "h1", {"page": 3})],
                                                   max_tokens=64, overlap_tokens=0)
        vecs2, _ = embeddings.embed_texts([c.text for c in more])
        b = chunking.publish_generation(self.dir, more, vecs2, m, "p1")
        man, chunks_now, vecs_now = chunking.load_current(self.dir)
        self.assertEqual(man["generation"], b["generation"])
        self.assertNotEqual(a["generation"], b["generation"])
        self.assertEqual(len(vecs_now), len(chunks_now))
        # the old generation is still on disk, so a reader that had it open is not stranded
        self.assertTrue(os.path.isdir(os.path.join(self.dir, a["generation"])))

    def test_embeddings_reject_incompatible_vectors(self):
        va, ma = embeddings.embed_texts(["alpha"])
        vb, mb = embeddings.embed_texts(["alpha"], quality_mode="lexical")
        self.assertGreater(embeddings.cosine(va[0], vb[0], ma, mb), 0.99)
        other_meta = meta(dim=1024)
        with self.assertRaises(ValueError):
            embeddings.cosine(va[0], vb[0], ma, other_meta)
        with self.assertRaises(ValueError):
            embeddings.cosine(va[0], va[0][:10], ma, ma)

    def test_unpinned_backends_refuse_and_the_pinned_one_executes(self):
        # The refusal half of this test is the honest contract for anything still
        # unpinned. `minilm` was in that list until 2026-11-17, when the ONNX
        # checkpoint was fetched, hash-pinned and measured on this host; keeping it
        # here would now assert a false negative, so it moved to the execute half.
        for mode in ("qwen3", "bge-m3"):
            with self.assertRaises(ValueError, msg=mode):
                embeddings.embed_texts(["x"], quality_mode=mode)
        vectors, meta = embeddings.embed_texts(["quarterly revenue grew"], quality_mode="minilm")
        self.assertEqual(meta.model.id, "Xenova/all-MiniLM-L6-v2")
        self.assertEqual(meta.model.provider, "onnxruntime-cpu")
        self.assertEqual(len(vectors[0]), 384)
        scored, used = reranker.rerank(
            "q", chunking.chunk_blocks([Block("q", "paragraph", "s", "h")], 8, 0), mode="neural")
        self.assertEqual(used, "neural_biencoder_minilm")
        self.assertTrue(scored)

    def test_rerank_reports_the_mode_actually_used(self):
        chunks = chunking.chunk_blocks([Block("C++ move semantics", "paragraph", "s", "h", {"page": 1}),
                                        Block("C language history", "paragraph", "s", "h", {"page": 2})],
                                       max_tokens=64, overlap_tokens=0)
        scored, used = reranker.rerank("C++ move semantics", chunks, mode="lexical")
        self.assertEqual(used, "lexical")
        self.assertTrue(scored)
        self.assertIn("C++", scored[0].chunk.text)


def _zip(path: str, members: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w") as z:
        for name, body in members.items():
            z.writestr(name, body)


XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


class Extraction(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ruke-doc-")

    def _path(self, name: str) -> str:
        return os.path.join(self.dir, name)

    def test_xlsx_keeps_formula_and_cached_value(self):
        p = self._path("book.xlsx")
        _zip(p, {
            "[Content_Types].xml": XMLDECL + "<Types/>",
            "xl/workbook.xml": XMLDECL + (
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Margin" sheetId="1" r:id="rId1"/></sheets></workbook>'),
            "xl/_rels/workbook.xml.rels": XMLDECL + (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
            "xl/sharedStrings.xml": XMLDECL + (
                '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">'
                '<si><t>Revenue</t></si><si><t>gr&#252;&#223; \U0001F600</t></si></sst>'),
            "xl/worksheets/sheet1.xml": XMLDECL + (
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<mergeCells count="1"><mergeCell ref="A1"/></mergeCells>'
                '<sheetData><row r="1">'
                '<c r="A1" t="s"><v>0</v></c>'
                '<c r="A2" t="s"><v>1</v></c>'
                '<c r="B1"><f>A2*2+3</f><v>5</v></c>'
                '</row></sheetData></worksheet>'),
        })
        doc = parser.load_document(p)
        self.assertEqual(doc.kind, "xlsx")
        self.assertEqual(doc.coverage.units_total, 1)
        self.assertTrue(doc.coverage.complete)
        formulas = [b for b in doc.blocks if b.kind == "formula"]
        self.assertEqual(len(formulas), 1)
        self.assertIn("=A2*2+3", formulas[0].text)          # formula survives...
        self.assertIn("cached 5", formulas[0].text)          # ...alongside the cached value
        cells = {b.loc.get("cell"): b for b in doc.blocks}
        self.assertEqual(cells["A1"].text, "Revenue")
        self.assertEqual(cells["A1"].loc.get("sheet"), "Margin")
        self.assertIn("merged", cells["A1"].loc)
        # decimal entities AND a raw astral character both decode to one correct code point
        self.assertEqual(ord(cells["A2"].text[-1]), 0x1F600)
        self.assertIn("grüß", cells["A2"].text)

    def test_merged_spans_are_geometry_and_not_string_equality(self):
        # Kernel C: a cell reference (B2) never EQUALS a merge range string (A1:B2), so the
        # old membership test merged nothing. Containment is the law, and a merge whose
        # interior is empty is still structure the sheet declares.
        p = self._path("merged.xlsx")
        _zip(p, {
            "[Content_Types].xml": XMLDECL + "<Types/>",
            "xl/workbook.xml": XMLDECL + (
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Grid" sheetId="1" r:id="rId1"/></sheets></workbook>'),
            "xl/_rels/workbook.xml.rels": XMLDECL + (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
            "xl/worksheets/sheet1.xml": XMLDECL + (
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="C5:D6"/></mergeCells>'
                '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c>'
                '<c r="C1" t="inlineStr"><is><t>Outside</t></is></c></row>'
                '<row r="2"><c r="B2" t="inlineStr"><is><t>South-east corner</t></is></c></row>'
                '</sheetData></worksheet>'),
        })
        doc = parser.load_document(p)
        cells = {b.loc.get("cell"): b for b in doc.blocks}
        self.assertEqual(cells["A1"].loc.get("merged"), "A1:B2")
        self.assertEqual(cells["B2"].loc.get("merged"), "A1:B2",
                         "the far corner of a merged range must know it is inside it")
        self.assertNotIn("merged", cells["C1"].loc, "C1 is outside every declared range")
        # The empty C5:D6 region survives as sheet structure even though no cell mentions it.
        self.assertEqual(doc.meta["merged_ranges"]["Grid"], ["A1:B2", "C5:D6"])

    def test_cell_and_range_parsing_is_explicit(self):
        self.assertEqual(parser.cell_xy("A1"), (1, 1))
        self.assertEqual(parser.cell_xy("$AB$10"), (28, 10))
        self.assertEqual(parser.range_bounds("B2:A1"), (1, 1, 2, 2),
                         "a reversed range still describes the same rectangle")
        self.assertEqual(parser.range_bounds("C7"), (3, 7, 3, 7), "a single cell is a degenerate range")
        for bad in ("", "A", "0A1", "A0", "A1:B", "sheet1!A1", "AA A"):
            with self.assertRaises(parser.ExtractionRejected, msg=bad):
                parser.cell_xy(bad)

    def test_a_bad_shared_string_index_is_corruption_never_an_empty_cell(self):
        p = self._path("broken.xlsx")
        _zip(p, {
            "[Content_Types].xml": XMLDECL + "<Types/>",
            "xl/workbook.xml": XMLDECL + (
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Bad" sheetId="1" r:id="rId1"/></sheets></workbook>'),
            "xl/_rels/workbook.xml.rels": XMLDECL + (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
            "xl/sharedStrings.xml": XMLDECL + (
                '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">'
                '<si><t>Only entry</t></si></sst>'),
            "xl/worksheets/sheet1.xml": XMLDECL + (
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetData><row r="1"><c r="A1" t="s"><v>7</v></c>'
                '<c r="B1" t="e"><v>#N/A</v></c>'
                '<c r="C1"><v>12.5</v></c></row></sheetData></worksheet>'),
        })
        doc = parser.load_document(p)
        cells = {b.loc.get("cell"): b for b in doc.blocks}
        self.assertNotIn("A1", cells, "an index outside the string table must not become a blank")
        self.assertNotIn("B1", cells, "an error cell must not be read as a value")
        reasons = " ".join(c["why"] for c in doc.meta["corrupt_cells"])
        self.assertIn("shared-string index", reasons)
        self.assertIn("#N/A", reasons)
        self.assertEqual(cells["C1"].text, "12.5", "the healthy cells are still extracted")

    def test_two_tables_never_share_row_identity(self):
        p = self._path("twotables.docx")
        _zip(p, {
            "word/document.xml": XMLDECL + (
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc></w:tr>'
                '<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                '<w:p><w:r><w:t>between the tables</w:t></w:r></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>'
                '<w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                '</w:body></w:document>'),
        })
        doc = parser.load_document(p)
        rows = [b for b in doc.blocks if b.kind == "table_row"]
        self.assertEqual([(b.loc.get("table"), b.loc.get("row")) for b in rows],
                         [(1, 1), (1, 2), (2, 1)],
                         "a citation must be able to name which table a row came from")
        self.assertEqual(rows[2].loc.get("cells"), ["B1", "B2"])
        self.assertEqual(doc.meta.get("tables"), 2)
        self.assertEqual([b.kind for b in doc.blocks],
                         ["table_row", "table_row", "paragraph", "table_row"])

    def test_docx_keeps_headings_and_table_rows(self):
        p = self._path("doc.docx")
        _zip(p, {
            "word/document.xml": XMLDECL + (
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly</w:t></w:r></w:p>'
                '<w:p><w:r><w:t>Body text about margin.</w:t></w:r></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc>'
                '<w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>'
                '<w:tr><w:tc><w:p><w:r><w:t>Freight</w:t></w:r></w:p></w:tc>'
                '<w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                '</w:body></w:document>'),
        })
        doc = parser.load_document(p)
        kinds = [b.kind for b in doc.blocks]
        self.assertEqual(kinds, ["heading", "paragraph", "table_row", "table_row"])
        self.assertIn("Item | Amount", doc.blocks[2].text)
        self.assertEqual(doc.blocks[0].loc.get("section"), "Heading1")
        # Every unit id this reader emits is 1-based, and the document meta declares it.
        # A 0-based paragraph id beside a 1-based page/sheet/slide id silently shifts every
        # paragraph citation by one, so the convention is pinned, not documented only.
        declared = str(doc.meta.get("unit_numbering", ""))
        self.assertIn("1-based", declared)
        numbers = [b.loc["paragraph"] for b in doc.blocks if "paragraph" in b.loc]
        self.assertEqual(numbers, [1, 2], "paragraph ids start at 1 and count body order")
        self.assertEqual([b.loc["table"] for b in doc.blocks if b.kind == "table_row"], [1, 1])
        self.assertEqual([b.loc["row"] for b in doc.blocks if b.kind == "table_row"], [1, 2])

    def test_pptx_keeps_notes_apart_from_slide_text(self):
        p = self._path("deck.pptx")
        _zip(p, {
            "ppt/slides/slide1.xml": XMLDECL + (
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:sp><p:txBody>'
                '<a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:sld>'),
            "ppt/notesSlides/notesSlide1.xml": XMLDECL + (
                '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:sp><p:txBody>'
                '<a:p><a:r><a:t>Speaker note: cite the source</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:notes>'),
        })
        doc = parser.load_document(p)
        self.assertEqual([b.kind for b in doc.blocks], ["paragraph", "note"])
        self.assertEqual(doc.blocks[1].loc.get("part"), "notes")
        self.assertIn("cite the source", doc.blocks[1].text)

    def test_pptx_notes_exclude_managed_placeholder_text(self):
        """A notesSlide also holds the slide-number/footer/date placeholders the template
        fills in. Reading them as notes invents content (D-071): a deck with no notes at
        all reported "1", "2", "3" as note text, and a real note gained a trailing number."""
        notes = lambda body_shapes: XMLDECL + (
            '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld>'
            + body_shapes + '</p:cSld></p:notes>')
        shape = lambda ph, text: (
            '<p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/>'
            f'<p:nvPr><p:ph type="{ph}" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>'
            f'<a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>')
        slide = XMLDECL + (
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:sp><p:txBody>'
            '<a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:sld>')
        # A generated deck with authored notes PLUS the automatic slide-number field,
        # and a second slide whose notes part holds ONLY that automatic field.
        p = self._path("deck_placeholders.pptx")
        _zip(p, {
            "ppt/slides/slide1.xml": slide,
            "ppt/slides/slide2.xml": slide,
            "ppt/notesSlides/notesSlide1.xml": notes(
                shape("body", "Open with the pricing question.")
                + shape("sldNum", "1") + shape("ftr", "Confidential draft")
                + shape("dt", "2026-11-17") + shape("hdr", "Deck title")),
            "ppt/notesSlides/notesSlide2.xml": notes(
                shape("sldNum", "2") + shape("ftr", "Confidential draft")),
        })
        doc = parser.load_document(p)
        notes_blocks = [b for b in doc.blocks if b.kind == "note"]
        self.assertEqual(len(notes_blocks), 1,
                         "a notesSlide holding only managed placeholders is not authored notes")
        self.assertEqual(notes_blocks[0].text, "Open with the pricing question.")
        self.assertEqual(notes_blocks[0].loc.get("slide"), 1)
        for managed in ("Confidential draft", "2026-11-17", "Deck title", "1", "2"):
            self.assertNotIn(managed, notes_blocks[0].text)
        # The un-authored slide still counts as extracted: "no notes" is not a failure.
        self.assertTrue(doc.coverage.complete)
        self.assertEqual(doc.coverage.units_extracted, 2)

    def test_unsupported_format_is_honest_not_flattened(self):
        p = self._path("thing.xyz")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("some bytes")
        doc = parser.load_document(p)
        self.assertEqual(doc.kind, "unsupported")
        self.assertEqual(doc.blocks, [])
        self.assertFalse(doc.coverage.complete)
        self.assertIn("no parser", doc.coverage.note)

    def test_ocr_escalation_is_driven_by_measured_quality(self):
        from ruke_ml.documents.structures import DocCoverage, Document
        good = Document("s", "h", "pdf", [Block("x" * 400, "page_text", "s", "h", {"page": 1})],
                        DocCoverage(units_total=1, units_extracted=1, method="text-layer"))
        self.assertEqual(ocr.assess(good).route, ocr.TEXT_LAYER_OK)
        scanned = Document("s", "h", "pdf", [], DocCoverage(units_total=3, units_extracted=0,
                                                            units_needing_ocr=[1, 2, 3], method="text-layer"))
        a = ocr.assess(scanned)
        self.assertEqual(a.route, ocr.LIGHT_OCR)
        self.assertEqual(a.units, [1, 2, 3])
        self.assertFalse(scanned.coverage.complete, "non-empty text is not sufficient")
        mixed = Document("s", "h", "pdf", [Block("short", "page_text", "s", "h")],
                         DocCoverage(units_total=2, units_extracted=1, units_failed=[2], method="text-layer"))
        self.assertEqual(ocr.assess(mixed).route, ocr.LIGHT_OCR)
        st = ocr.ocr_status()
        # Truth law, not a status string: the answer comes from the real adapter (a validated
        # engine plus a working rasterizer), and `executable` must agree with `available`.
        # On a host with no engine the honest answer is not_installed plus the exact human
        # step; this test used to pin the decoration "evaluation_required" for an adapter
        # that is implemented and merely missing its external program (DECISIONS D-032).
        self.assertIn(st["status"], ("not_installed", "evaluation_required", "not_configured",
                                     "available"))
        if st["executable"]:
            self.assertEqual(st["status"], "available",
                             "an executable OCR adapter must not be reported as unavailable")
        else:
            self.assertNotEqual(st["status"], "available",
                                "a capability that cannot run here must never report available")
            self.assertTrue(st["human_step"], "an unavailable capability must name the next step")
        self.assertFalse(st["engine"]["languages"] and not st["engine"]["languages_source"],
                         "claimed OCR languages need provenance")

    def test_archive_guard_runs_before_parsing(self):
        p = self._path("bomb.xlsx")
        _zip(p, {"xl/worksheets/sheet1.xml": "<x>" + ("A" * (3 << 20)) + "</x>",
                 "xl/workbook.xml": "<workbook/>"})
        with self.assertRaises(Exception):
            parser.load_document(p)


def _pdf_bytes(pages: list[bytes], *, rotate: dict[int, int] | None = None) -> bytes:
    """A tiny, valid PDF: Helvetica text pages built to an explicit page order.

    Hand-built so the fixture cannot quietly depend on a writer that also does the
    extracting. `pages[i]` is the content stream of 1-based page i+1; an empty content
    stream models a scanned/blank page (no native text layer at all).
    """
    rotate = rotate or {}
    objects: dict[int, bytes] = {}
    total = len(pages)
    page_first = 4                       # 1 catalog, 2 page tree, 3 font, then pages+contents
    kids = " ".join(f"{page_first + 2 * i} 0 R" for i in range(total))
    objects[1] = b"<</Type/Catalog/Pages 2 0 R>>"
    objects[2] = f"<</Type/Pages/Kids[{kids}]/Count {total}>>".encode()
    objects[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"
    for i, content in enumerate(pages):
        pid = page_first + 2 * i
        extras = f" /Rotate {rotate[i + 1]}" if rotate.get(i + 1) else ""
        objects[pid] = (f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]{extras}"
                        f"/Resources<</Font<</F1 3 0 R>>>>/Contents {pid + 1} 0 R>>").encode()
        objects[pid + 1] = b"<</Length " + str(len(content)).encode() + b">>stream\n" + content + b"\nendstream"
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: dict[int, int] = {}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + objects[num] + b"\nendobj\n"
    start = len(out)
    count = len(offsets) + 1
    out += f"xref\n0 {count}\n".encode() + b"0000000000 65535 f \n"
    for num in sorted(offsets):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += (f"trailer<</Size {count}/Root 1 0 R>>\nstartxref\n{start}\n%%EOF\n").encode()
    return bytes(out)


def _text_stream(text: str) -> bytes:
    if not text:
        return b""
    lines = [f"BT /F1 12 Tf 72 {720 - 16 * i} Td ({line}) Tj ET"
             for i, line in enumerate(_wrap(text))]
    return "\n".join(lines).encode("ascii")


def _wrap(text: str, width: int = 70) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        if len(current) + len(word) + 1 > width:
            lines.append(current)
            current = word
        else:
            current = (current + " " + word).strip()
    if current:
        lines.append(current)
    return lines


@unittest.skipUnless(_HAVE_PYPDF, "the pdf backend (pypdf) is not installed")
class PdfReading(unittest.TestCase):
    """Kernel B at the source: the PDF path runs, and coverage names the pages it read."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ruke-pdf-")

    def _pdf(self, name: str, pages: list[bytes], **kw: object) -> str:
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(_pdf_bytes(pages, **kw))
        return path

    def test_native_pages_are_numbered_one_based_and_read_in_order(self):
        p = self._pdf("native.pdf", [
            _text_stream("Quarterly margin report for the freight ledger. " * 2),
            _text_stream("Middle page carries the depreciation schedule notes. " * 2),
            _text_stream("Final page: the late evidence token zephyr-9 lives here. " * 2),
        ])
        doc = parser.load_document(p)
        self.assertEqual(doc.kind, "pdf")
        self.assertEqual(doc.coverage.units_total, 3)
        self.assertEqual(doc.coverage.units_succeeded, [1, 2, 3])
        # Spans are one per SUCCEEDED page, never one merged prefix: a merged [0,3) would
        # hide which page produced nothing if page 2 were later removed from the list.
        self.assertEqual(doc.coverage.succeeded_spans(),
                         [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)])
        pages = {b.loc.get("page") for b in doc.blocks if b.kind == "page_text"}
        self.assertEqual(pages, {1, 2, 3})
        self.assertEqual(doc.meta["page_numbering"], "1-based")
        late = [b for b in doc.blocks if "zephyr-9" in b.text]
        self.assertTrue(late, "evidence near the END of a source must survive extraction")
        self.assertEqual(late[0].loc.get("page"), 3)

    def test_a_hole_in_the_middle_is_two_spans_never_a_contiguous_prefix(self):
        # Pages 1 and 3 have a text layer, page 2 has none. A prefix count would report
        # "2 of 3 examined" or "[0,2) covered", which is false in two different ways.
        p = self._pdf("hole.pdf", [
            _text_stream("First page text is present and long enough to count. " * 2),
            b"",
            _text_stream("Third page text is present and long enough to count. " * 2),
        ])
        doc = parser.load_document(p)
        self.assertEqual(doc.coverage.units_succeeded, [1, 3])
        self.assertIn(2, doc.coverage.units_empty)
        self.assertEqual(doc.coverage.succeeded_spans(), [(0.0, 1.0), (2.0, 3.0)],
                         "coverage must be derived from page IDS, not from a count")
        self.assertFalse(doc.coverage.complete)
        self.assertEqual(doc.coverage.uncovered_spans(), [(1.0, 2.0)])
        self.assertIn("not proof", doc.coverage.note)
        # A page with NO text layer and NO image is blank, not OCR-eligible: there is
        # nothing to recognise. It stays in units_empty and out of coverage either way,
        # and the inventory says why instead of leaving the reader guessing.
        self.assertEqual(doc.coverage.units_needing_ocr, [])
        self.assertEqual(doc.meta["pages_with_images"].get(2, 0), 0,
                         "a blank page must not be counted as having imagery")

    def test_rotation_is_recorded_and_not_silently_normalised(self):
        p = self._pdf("rot.pdf", [
            _text_stream("A landscape page that the viewer must rotate to read. " * 2),
        ], rotate={1: 90})
        doc = parser.load_document(p)
        self.assertEqual(doc.meta["rotated_pages"], {1: 90})
        text = [b for b in doc.blocks if b.kind == "page_text"]
        self.assertTrue(text)
        self.assertEqual(text[0].loc.get("rotation"), 90,
                         "a page/region reference must carry its rotation")

    def test_encrypted_input_is_a_typed_refusal_not_an_empty_document(self):
        from pypdf import PdfWriter
        plain = os.path.join(self.dir, "plain-source.pdf")
        with open(plain, "wb") as fh:
            fh.write(_pdf_bytes([_text_stream("Locked contract text that must not be faked. " * 2)]))
        writer = PdfWriter(clone_from=plain)
        writer.encrypt("user-secret")
        path = os.path.join(self.dir, "enc.pdf")
        with open(path, "wb") as fh:
            writer.write(fh)
        # The password is a runtime condition, not a code defect: with it, the same file reads.
        from ruke_ml.documents import pdf as pdf_mod
        opened = pdf_mod.load_pdf(path, password="user-secret")
        self.assertTrue(any("Locked contract text" in b.text for b in opened.blocks))
        try:
            doc = parser.load_document(path)          # no password supplied
        except parser.ExtractionRejected as exc:
            self.assertIn("encrypt", str(exc).lower())
        else:
            self.fail(f"an unencrypted fixture was accepted as if encrypted: {doc.blocks[:1]}")

    def test_corrupt_bytes_never_produce_a_confident_empty_answer(self):
        path = os.path.join(self.dir, "broken.pdf")
        with open(path, "wb") as fh:
            fh.write(b"%PDF-1.4\nthis is not a body at all \x00\x01\xff")
        with self.assertRaises(parser.ExtractionRejected) as caught:
            parser.load_document(path)
        self.assertTrue(str(caught.exception))

    def test_more_pages_than_the_bound_refuses_instead_of_dropping_the_tail(self):
        pages = [_text_stream("Page body with enough words to be a real text layer here. " * 2)
                 for _ in range(6)]
        p = self._pdf("many.pdf", pages)
        from ruke_ml.documents import pdf as pdf_mod
        with self.assertRaises(parser.ExtractionRejected) as caught:
            pdf_mod.load_pdf(p, max_pages=5)
        self.assertIn("silently dropping", str(caught.exception))

    def test_weak_native_page_without_imagery_is_read_not_ocr_scheduled(self):
        # F152 amendment of the old weak-layer law. A one-character page with NO raster
        # and NO drawn content has nothing an engine could find: rendering it and running
        # OCR spends a real pass on pixels that already ARE the text. The page is recorded
        # read (its block is delivered) and the WEAKNESS travels on the block's extraction
        # marker; OCR eligibility stays reserved for pages with imagery (see the F73
        # heading-over-raster test below), which is where the old law's real risk lived.
        p = self._pdf("mixed.pdf", [
            _text_stream("Native text page one for the mixed document case. " * 2),
            _text_stream("x"),
        ])
        doc = parser.load_document(p)
        self.assertIn(2, doc.coverage.units_succeeded, "the page's native text IS delivered")
        self.assertNotIn(2, doc.coverage.units_needing_ocr,
                         "a clean one-word native page costs zero engine work (F152)")
        page2 = [b for b in doc.blocks if b.loc.get("page") == 2]
        self.assertEqual([b.loc["extraction"] for b in page2], ["pypdf-plain-weak"],
                         "the weakness of the layer is RECORDED, not hidden behind 'read'")

    def test_a_heading_only_text_layer_over_a_raster_is_also_ocr_eligible(self):
        # F73 production (frozen fixture d1_mixed p1): the text layer carried only the page
        # heading while the page BODY lived in a raster image. The usable text layer made the
        # page "succeeded" and never offered the image to OCR, so a fact that exists only in
        # the imagery was undeliverable through the whole chat path. A page can be recorded
        # read AND stay OCR-eligible - the same two-flag honesty the weak-text branch above
        # already uses, now also when the usable layer is short relative to the imagery.
        fixture = os.path.abspath(os.path.join(
            os.path.dirname(__file__), os.pardir, os.pardir,
            "docs", "overnight", "fixtures", "d1", "pdfs", "d1_mixed.pdf"))
        if not os.path.isfile(fixture):
            self.skipTest("run docs/overnight/fixtures/d1/ocr_docs.py first")
        doc = parser.load_document(fixture)
        self.assertIn(1, doc.coverage.units_succeeded,
                      "the native heading must still count as read")
        self.assertGreater(doc.meta["pages_with_images"].get(1, 0), 0)
        self.assertIn(1, doc.coverage.units_needing_ocr,
                      "a page carrying imagery that was never read is not a fully-read page")
        self.assertIn(2, doc.coverage.units_needing_ocr, "the image-only page keeps the old path")
        self.assertNotIn(3, doc.coverage.units_needing_ocr,
                         "a native page with NO imagery must not be escalated on speculation")


if __name__ == "__main__":
    unittest.main()
