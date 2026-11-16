"""Index publishing is transactional, identity survives normalization, extraction keeps structure.

These are the Python mirrors of the F09/F12 laws: a crash never leaves a mixed generation,
C++ never collapses into C, and a formula is not replaced by its cached value.
"""
from __future__ import annotations

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

    def test_model_backends_are_refused_until_pinned(self):
        for mode in ("qwen3", "bge-m3", "minilm"):
            with self.assertRaises(ValueError, msg=mode):
                embeddings.embed_texts(["x"], quality_mode=mode)
        with self.assertRaises(ValueError):
            reranker.rerank("q", chunking.chunk_blocks([Block("q", "paragraph", "s", "h")], 8, 0), mode="neural")

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
        self.assertEqual(st["status"], "evaluation_required")
        self.assertTrue(st["human_step"])

    def test_archive_guard_runs_before_parsing(self):
        p = self._path("bomb.xlsx")
        _zip(p, {"xl/worksheets/sheet1.xml": "<x>" + ("A" * (3 << 20)) + "</x>",
                 "xl/workbook.xml": "<workbook/>"})
        with self.assertRaises(Exception):
            parser.load_document(p)


if __name__ == "__main__":
    unittest.main()
