"""F78 Family E: PDF language detection and drawn-content (chart) visual routing.

Reproduced defects (audit 2026-11-21, F78 brief):
  * mixed.pdf p92 is an UNDECLARED scan holding "4,18,25,000 rupees": /Lang is absent,
    the language law refused with needs_language, and the page stayed unread forever.
    The refusal is honest - but there was no route to answer.
  * plot-a/plot-b: the bar-height fact (98px vs 31px) lives ONLY in the drawn vector
    rectangles. The text layer is a title plus two labels, and assess() flagged nothing,
    so a chart question received no evidence from any reader.

The laws this fix encodes:
  * language detection is the ENGINE's own script analysis (OSD) at a page raster,
    mapped through a general script table, gated by a verification OCR pass at bounds
    measured from the genuine scan page on this host. It is never a silent default:
    every unverified outcome keeps the typed needs_language refusal with its reason.
  * the visual flag counts PAINT OPERATIONS in the page's own content streams (rect
    fills smaller than the page, Bezier curves) - never a filename, marker word, topic
    or phrase. Chart pages get rendered page images (visual_pages -> frames).
  * a chart page never drives language detection (its labels verify nothing), and a
    scan page never gets vector frames (its content is an image, not paint ops).

Fixtures: docs/overnight/fixtures/f78 (untrusted inputs; probes run under -I).
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python-backend"))

FIX = REPO / "docs" / "overnight" / "fixtures" / "f78" / "review-complex-1121"
PLOT_A = FIX / "plot-a.pdf"
PLOT_B = FIX / "plot-b.pdf"
MIXED = FIX / "mixed.pdf"

from ruke_ml.documents import ocr_tesseract, parser, pdf as pdf_mod  # noqa: E402
from ruke_ml.workers import document_jobs as dj  # noqa: E402


def _fixtures_ready() -> bool:
    return PLOT_A.is_file() and PLOT_B.is_file() and MIXED.is_file()


def _tesseract_ready() -> bool:
    return bool(ocr_tesseract.binaries.path_for(ocr_tesseract.BINARY))


# OSD output measured verbatim on this host (2026-11-21, tesseract v5.5.3.20260724):
# this build reports a SCRIPT estimate with confidence, no language estimate.
OSD_MEASURED = ("Page number: 0\r\nOrientation in degrees: 0\r\nRotate: 0\r\n"
                "Orientation confidence: 9.55\r\nScript: Latin\r\nScript confidence: 3.89\r\n")


class VisualFlagIsContentDerived(unittest.TestCase):
    """The paint-operation scan flags DRAWN pages, from the page's own content streams."""

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_chart_pages_are_flagged(self):
        for chart in (PLOT_A, PLOT_B):
            doc = parser.load_document(chart)
            visual = doc.meta.get("pages_with_visual") or {}
            self.assertEqual(list(visual), [1], f"{chart.name}: page 1 is the drawn chart")
            self.assertGreaterEqual(visual[1], 2,
                                    f"{chart.name}: two bars are two content fills")

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_text_and_scan_pages_are_not_flagged(self):
        # mixed.pdf: 141 pages of text layers plus one IMAGE scan (p92). An image draw is
        # not a paint operation: the page gets OCR eligibility, not vector frames.
        doc = parser.load_document(MIXED)
        self.assertEqual(doc.meta.get("pages_with_visual") or {}, {},
                         "no page of the book is drawn content")

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_full_page_background_is_not_content(self):
        # plot-a's page also fills the whole page (background) and a larger clip rect;
        # only the two bars counted (ops == 2), so the page-size bound works.
        doc = parser.load_document(PLOT_A)
        self.assertEqual((doc.meta.get("pages_with_visual") or {}).get(1), 2,
                         "background fill and clip rect must not count as content")


class VisualPagesPayload(unittest.TestCase):
    """Flagged pages are rendered on demand, bounded, as base64 PNG."""

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_chart_page_ships_a_rendered_png(self):
        doc = parser.load_document(PLOT_A)
        out = dj._visual_pages(doc, PLOT_A)
        self.assertEqual(len(out["pages"]), 1)
        page = out["pages"][0]
        self.assertEqual(page["page"], 1)
        self.assertGreaterEqual(page["ops"], 2)
        self.assertTrue(page["png_base64"].startswith("iVBORw0KGgo"),
                        "the payload must be PNG bytes (base64), the format frames use")
        self.assertGreater(page["width"], 100)
        self.assertGreater(page["height"], 100)
        self.assertEqual(page["dpi"], dj.VISUAL_DPI)
        self.assertIn("1-based", out["note"])

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_a_page_that_fails_to_render_is_omitted_not_replaced(self):
        doc = parser.load_document(PLOT_A)
        doc.meta["pages_with_visual"] = {"1": 2, "99": 5}  # page 99 is outside the document
        out = dj._visual_pages(doc, PLOT_A)
        self.assertEqual([p["page"] for p in out["pages"]], [1],
                         "a failed render must drop the page, never substitute anything")

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_caps_are_enforced(self):
        doc = parser.load_document(PLOT_A)
        doc.meta["pages_with_visual"] = {str(i): 2 for i in range(1, 30)}
        with mock.patch.object(dj, "MAX_VISUAL_PAGES", 3):
            out = dj._visual_pages(doc, PLOT_A)
        self.assertLessEqual(len(out["pages"]), 3)
        with mock.patch.object(dj, "MAX_VISUAL_PAGE_B64", 100):
            out = dj._visual_pages(doc, PLOT_A)
        self.assertEqual(out["pages"], [],
                         "a page over the per-page byte cap is dropped, not truncated")

    @unittest.skipUnless(_fixtures_ready(), "F78 fixtures missing")
    def test_non_pdf_gets_nothing(self):
        doc = parser.load_document(PLOT_A)
        doc.kind = "docx"
        self.assertEqual(dj._visual_pages(doc, PLOT_A), {"pages": [], "note": ""})


class OsdParsing(unittest.TestCase):
    def test_measured_output_parses(self):
        self.assertEqual(ocr_tesseract.parse_osd(OSD_MEASURED), ("latin", 3.89))

    def test_unparsable_output_is_none(self):
        self.assertIsNone(ocr_tesseract.parse_osd("no script here"))
        self.assertIsNone(ocr_tesseract.parse_osd(""))
        self.assertIsNone(ocr_tesseract.parse_osd("Script: Latin\r\nScript confidence: abc"))

    def test_script_map_is_general_not_per_document(self):
        self.assertEqual(ocr_tesseract.SCRIPT_TO_TESSERACT["latin"], "eng")
        self.assertEqual(ocr_tesseract.SCRIPT_TO_TESSERACT["thai"], "tha")
        self.assertEqual(ocr_tesseract.SCRIPT_TO_TESSERACT["cyrillic"], "rus")
        for key in ocr_tesseract.SCRIPT_TO_TESSERACT:
            self.assertFalse(key.endswith(".pdf"), "keys are scripts, never file names")


class DetectLanguageIsVerified(unittest.TestCase):
    """Detection: OSD script -> general map -> addressable pack -> verification OCR pass.
    Every failure path is a reason, never a default."""

    def _patches(self, *, osd=("latin", 3.89), lines=None, addressable=(True, "eng", "ok")):
        if lines is None:
            lines = [{"text": "Chapter eleven records the award", "confidence": 0.96},
                     {"text": "of 14 November 2021 ordering payment", "confidence": 0.96}] * 3
        return (
            mock.patch.object(ocr_tesseract, "render_page_png",
                              return_value=(b"\x89PNG fake", {"page": 92, "dpi": 200,
                                                              "width": 1240, "height": 1754})),
            mock.patch.object(ocr_tesseract, "run_osd", return_value=osd),
            mock.patch.object(ocr_tesseract, "language_is_addressable", return_value=addressable),
            mock.patch.object(ocr_tesseract, "ocr_png", return_value=(lines, "eng")),
        )

    def test_verification_pass_verifies_the_mapped_language(self):
        r, o, a, c = self._patches()
        with r, o, a, c:
            out = ocr_tesseract.detect_language("x.pdf", 92)
        self.assertTrue(out["verified"], out["reason"])
        self.assertEqual(out["language"], "eng")
        self.assertEqual(out["script"], "latin")
        self.assertGreaterEqual(out["glyphs"], ocr_tesseract.DETECT_MIN_GLYPHS)

    def test_low_script_confidence_refuses(self):
        r, o, a, c = self._patches(osd=("latin", 0.4))
        with r, o, a, c:
            out = ocr_tesseract.detect_language("x.pdf", 92)
        self.assertFalse(out["verified"])
        self.assertIn("below the validated bound", out["reason"])
        self.assertNotIn("language", out)

    def test_unmapped_script_refuses(self):
        r, o, a, c = self._patches(osd=("runic", 9.0))
        with r, o, a, c:
            out = ocr_tesseract.detect_language("x.pdf", 92)
        self.assertFalse(out["verified"])
        self.assertIn("no general language naming", out["reason"])

    def test_script_without_engine_pack_refuses(self):
        r, o, a, c = self._patches(osd=("thai", 9.0), addressable=(False, "", "no tha data"))
        with r, o, a, c:
            out = ocr_tesseract.detect_language("x.pdf", 92)
        self.assertFalse(out["verified"])
        self.assertIn("cannot run", out["reason"])

    def test_failed_verification_refuses(self):
        r, o, a, c = self._patches(lines=[{"text": "x", "confidence": 0.1}])
        with r, o, a, c:
            out = ocr_tesseract.detect_language("x.pdf", 92)
        self.assertFalse(out["verified"])
        self.assertIn("quality bounds", out["reason"])

    def test_unparsable_osd_refuses(self):
        r, o, a, c = self._patches(osd=None)
        with r, o, a, c:
            out = ocr_tesseract.detect_language("x.pdf", 92)
        self.assertFalse(out["verified"])
        self.assertIn("no parsable result", out["reason"])

    @unittest.skipUnless(_tesseract_ready() and MIXED.is_file(),
                         "validated tesseract and the F78 mixed fixture are required")
    def test_real_engine_verifies_the_genuine_scan_page(self):
        out = ocr_tesseract.detect_language(MIXED, 92)
        self.assertTrue(out["verified"], out["reason"])
        self.assertEqual(out["script"], "latin")
        self.assertEqual(out["language"], "eng")

    @unittest.skipUnless(_tesseract_ready() and PLOT_A.is_file(),
                         "validated tesseract and the F78 plot fixture are required")
    def test_real_engine_refuses_to_let_a_chart_page_drive_language(self):
        # The chart page has 4 label words: real, measured, below every verification
        # bound. Language never comes from a page that cannot be verified.
        out = ocr_tesseract.detect_language(PLOT_A, 1)
        self.assertFalse(out["verified"])
        self.assertIn("quality bounds", out["reason"])


class JobBoundaryDetection(unittest.TestCase):
    """documents.parse: an undeclared language now gets a VALIDATED detection attempt
    before the refusal; the refusal itself stays typed and unchanged when detection
    refuses. Engines are stubbed: this pins the JOB contract, not the engine."""

    def setUp(self):
        from ruke_ml.models.registry import catalog
        if not catalog().executable_for("documents.ocr"):
            self.skipTest("documents.ocr not executable in this environment")
        if not MIXED.is_file():
            self.skipTest("F78 mixed fixture missing")
        self._tmp = tempfile.TemporaryDirectory(prefix="ruke-f78e-")
        import os
        self._saved = {v: os.environ.get(v) for v in
                       ("RUKE_OCR_RESULT_DIR", "RUKE_OCR_ALLOW_UNLOAD", "RUKE_LLM_AUTOMATIC_HANDOFF")}
        os.environ["RUKE_OCR_RESULT_DIR"] = self._tmp.name
        os.environ["RUKE_OCR_ALLOW_UNLOAD"] = "0"
        os.environ["RUKE_LLM_AUTOMATIC_HANDOFF"] = "0"

    def tearDown(self):
        import os
        for var, value in self._saved.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
        self._tmp.cleanup()

    def _dispatch(self, language: str = "") -> dict:
        from ruke_ml.contracts import JobRequest
        from ruke_ml.workers import runner
        payload = {"path": str(MIXED), "root": str(FIX)}
        if language:
            payload["language"] = language
        res = runner.dispatch(JobRequest("r1", "run-f78e", "j-f78e", "documents.parse", payload))
        self.assertEqual(res.state, "ready", f"job state: {res.to_dict()}")
        return res.to_dict()

    def _stub_cascade(self):
        page = ocr_tesseract.OcrPage(
            page=92, state="recognised",
            text="Chapter eleven records that the arbitration award of 14 November 2021 "
                 "ordered the defendant to pay 4,18,25,000 rupees within ninety days.",
            engine="stub-engine", language_code="eng", raster={"dpi": 200})
        return mock.patch(
            "ruke_ml.documents.ocr_cascade.run",
            return_value=([page], {"cascade": {"engines_used": ["stub-engine"],
                                               "primary": {"ready": True}}}))

    def test_verified_detection_drives_the_cascade_and_is_named_as_detected(self):
        det = {"verified": True, "language": "eng", "script": "latin",
               "reason": "verification passed: 3 lines, mean line confidence 0.964"}
        with mock.patch("ruke_ml.documents.ocr_tesseract.detect_language", return_value=det), \
                self._stub_cascade() as cascade:
            out = self._dispatch()
        rep = out["payload"]["ocr"]
        self.assertTrue(rep["ran"], "a verified detection must let the cascade run")
        self.assertEqual(rep["language"], "eng")
        self.assertTrue(rep["language_source"].startswith("detected"),
                        f"the source must say where the language came from: {rep['language_source']}")
        self.assertEqual(rep["recognized"], 1)
        self.assertIn("4,18,25,000", json.dumps(out["payload"]["document"]))
        called_units = cascade.call_args[0][1]
        self.assertIn(92, [int(u) for u in called_units], "p92 is the flagged unit")

    def test_failed_detection_keeps_the_typed_refusal_and_names_both_reasons(self):
        det = {"verified": False, "script": "latin",
               "reason": "verification did not reach the quality bounds (glyphs 5/80)"}
        with mock.patch("ruke_ml.documents.ocr_tesseract.detect_language", return_value=det), \
                self._stub_cascade() as cascade:
            out = self._dispatch()
        rep = out["payload"]["ocr"]
        self.assertFalse(rep["ran"], "an unverified detection must NOT run the engine")
        cascade.assert_not_called()
        self.assertTrue(rep.get("needs_language"), "the refusal stays typed, not prose")
        self.assertIn("never defaulted to English", rep["reason"])
        self.assertIn("verification did not reach the quality bounds", rep["reason"],
                      "the detection failure reason must reach the coverage note")
        self.assertIn("OCR NOT run", json.dumps(out))

    def test_explicit_language_skips_detection_entirely(self):
        with mock.patch("ruke_ml.documents.ocr_tesseract.detect_language") as detect, \
                self._stub_cascade():
            out = self._dispatch(language="en-US")
        detect.assert_not_called()
        rep = out["payload"]["ocr"]
        self.assertEqual(rep["language"], "en-US")
        self.assertEqual(rep["language_source"], "requested")

    def test_detection_raster_failure_is_a_reason_not_a_crash(self):
        with mock.patch("ruke_ml.documents.ocr_tesseract.detect_language",
                        side_effect=ocr_tesseract.OcrUnavailable(
                            "rasterizer_missing", "pypdfium2 unusable")), \
                self._stub_cascade():
            out = self._dispatch()
        rep = out["payload"]["ocr"]
        self.assertFalse(rep["ran"])
        self.assertTrue(rep.get("needs_language"))
        self.assertIn("rasterizer_missing", rep["reason"])


@unittest.skipUnless(_tesseract_ready() and MIXED.is_file(),
                     "validated tesseract and the F78 mixed fixture are required")
class UndeclaredScanEndToEnd(unittest.TestCase):
    """The audit's headline case, through the real job: mixed.pdf page 92, an undeclared
    English scan, delivers "4,18,25,000 rupees" with the language named as detected.
    The cascade owns engine choice (PaddleOCR primary, tesseract recovery); this asserts
    the DELIVERY, and records which engine did it - a mock never passes here."""

    def setUp(self):
        import os
        self._tmp = tempfile.TemporaryDirectory(prefix="ruke-f78e-e2e-")
        self._saved = {v: os.environ.get(v) for v in
                       ("RUKE_OCR_RESULT_DIR", "RUKE_OCR_ALLOW_UNLOAD", "RUKE_LLM_AUTOMATIC_HANDOFF")}
        os.environ["RUKE_OCR_RESULT_DIR"] = self._tmp.name
        os.environ["RUKE_OCR_ALLOW_UNLOAD"] = "0"
        os.environ["RUKE_LLM_AUTOMATIC_HANDOFF"] = "0"

    def tearDown(self):
        import os
        for var, value in self._saved.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
        self._tmp.cleanup()

    def test_p92_fact_arrives_with_detected_language(self):
        from ruke_ml.contracts import JobRequest
        from ruke_ml.workers import runner
        res = runner.dispatch(JobRequest("r1", "run-f78e-e2e", "j-f78e-e2e", "documents.parse",
                                         {"path": str(MIXED), "root": str(FIX)}))
        self.assertEqual(res.state, "ready", f"job state: {res.to_dict()}")
        out = res.to_dict()
        rep = out["payload"]["ocr"]
        self.assertTrue(rep["ran"], f"OCR must run on the verified language: {rep['reason']}")
        self.assertTrue(rep["language_source"].startswith("detected"), rep["language_source"])
        self.assertEqual(rep["language"], "eng")
        p92 = [p for p in rep["pages"] if p["page"] == 92]
        self.assertEqual(len(p92), 1)
        self.assertEqual(p92[0]["state"], "recognised", p92[0]["detail"])
        self.assertTrue(p92[0]["engine"], "the report must name the engine that read the page")
        blob = json.dumps(out["payload"]["document"])
        self.assertIn("4,18,25,000", blob, "the scan fact must reach the delivered blocks")
        # The text layer of the other pages is untouched by the merge:
        self.assertIn("141", json.dumps(out["payload"]["document"]["coverage"]["units_total"]))


if __name__ == "__main__":
    unittest.main()
