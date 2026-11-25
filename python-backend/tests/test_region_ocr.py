"""F152: the region-inspection law for embedded rasters and standalone images.

The brief's demand, asserted here: an image count, a character threshold, a filename
or a topic must NEVER decide the OCR route - only the inspected pixels and the native
text do. Every region answers with a record (state, reason, probe features, engine,
exact invocation counts), and the heavyweight work rides the EXISTING cascade.

The live Paddle/Tesseract engines are never loaded by these tests: settings.json pins
the primary and WINS over RUKE_OCR_PRIMARY (proven 2026-11-23), so env overrides are
not an escape hatch - the cascade itself is mocked, and the probe/render/wrap/decision/
report/coverage layers below it are the real production code. The deck.pptx fixture is
the reproduced finding: slide 1's display image (ppt/media/image-3-1.png) carries the
label "AMBER CLOSE"; the old readers returned only "Inspection image" and zero regions.
"""
from __future__ import annotations

import contextlib
import importlib.util
import os
import shutil
import struct
import tempfile
import threading
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest import mock

from ruke_ml import handoff
from ruke_ml.contracts import JobRequest
from ruke_ml.documents import ocr, ocr_cascade, ocr_paddle, ocr_tesseract, parser, region_ocr
from ruke_ml.documents import pdf as pdf_mod
from ruke_ml.documents.ocr_tesseract import OcrPage, OcrUnavailable
from ruke_ml.workers import document_jobs as jobs_doc
from ruke_ml.workers.jobs import JobContext

REPO = Path(__file__).resolve().parents[2]
DECK = REPO / "docs" / "overnight" / "fixtures" / "f78" / "review-docs" / "deck.pptx"
UNSEEN = REPO / "docs" / "overnight" / "fixtures" / "f152" / "kappa9-chart-legend.png"


# ---------------------------------------------------------------- raster builders

def _rows_rgb(w: int, h: int, fn) -> bytes:
    return b"".join(b"".join(bytes([fn(x, y)]) * 3 for x in range(w)) for y in range(h))


def _png(w: int, h: int, fn) -> bytes:
    return ocr_tesseract.encode_png(w, h, 3, _rows_rgb(w, h, fn))


def _blank_png() -> bytes:
    return _png(120, 80, lambda x, y: 255)


def _label_png() -> bytes:
    """Eight isolated white bars on black: glyph-shaped strokes on a quiet ground."""
    def px(x, y):
        for bx in range(8):
            if 10 + bx * 24 <= x < 16 + bx * 24 and 20 <= y < 30:
                return 255
        return 0
    return _png(200, 60, px)


def _noise_png() -> bytes:
    """Deterministic pseudo-random noise: photographic texture, zero glyph structure."""
    return _png(200, 60, lambda x, y: (x * 73856093 ^ y * 19349663) & 0xFF)


def _gradient_png() -> bytes:
    """Smooth vertical ramp: quiet, not blank, no strokes - the honest ambiguous band."""
    return _png(160, 100, lambda x, y: min(255, (y * 255) // 99))


def _interlaced_png() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (len(data).to_bytes(4, "big") + tag + data
                + (zlib.crc32(tag + data) & 0xFFFFFFFF).to_bytes(4, "big"))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 1))  # interlace=1
            + chunk(b"IDAT", zlib.compress(b"\x00" * 24))
            + chunk(b"IEND", b""))


def _gif_bytes() -> bytes:
    return b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"


def _recognised(text: str, engine: str = "paddleocr-vl-1.6") -> tuple:
    """The cascade answer shape: ([OcrPage], {"cascade": report})."""
    return ([OcrPage(page=1, state="recognised", text=text, confidence=0.91,
                     raster={"dpi": 200}, engine=engine, language_code="eng")],
            {"cascade": {"fallback": {"attempted": []}}})


def _inspect(target: Path, kind: str, regions: list[dict], **kw) -> dict:
    return region_ocr.inspect_regions(str(target), kind, regions, **kw)


def _standalone(tmp: str, name: str, data: bytes) -> Path:
    p = Path(tmp) / name
    p.write_bytes(data)
    return p


# ------------------------------------------------------------------ probe features

class RasterFeatureLaws(unittest.TestCase):
    def test_blank_render_is_blank(self):
        png, _ = ocr_tesseract.render_page_png(self._wrap(_blank_png()), 1, dpi=150)
        feats = region_ocr.raster_features(png)
        self.assertTrue(feats["measurable"])
        self.assertTrue(feats["blank"], f"uniform raster must be blank: {feats}")
        self.assertFalse(feats["text_structure"])

    def test_stripped_label_is_text_bearing(self):
        png, _ = ocr_tesseract.render_page_png(self._wrap(self._deck_image()), 1, dpi=150)
        feats = region_ocr.raster_features(png)
        self.assertFalse(feats["blank"])
        self.assertTrue(feats["text_structure"],
                        f"the AMBER CLOSE legend must read as text structure: {feats}")

    def test_photo_noise_is_photo_like_not_text(self):
        png, _ = ocr_tesseract.render_page_png(self._wrap(_noise_png()), 1, dpi=150)
        feats = region_ocr.raster_features(png)
        self.assertFalse(feats["blank"])
        self.assertFalse(feats["text_structure"])
        self.assertTrue(feats["photo_like"], f"noise must read as photographic: {feats}")

    def _wrap(self, raster: bytes) -> str:
        pdf, _ = region_ocr.regionpdf.wrap_raster(raster)
        import tempfile as tf
        d = tf.mkdtemp(prefix="ruke-feat-")
        self.addCleanup(shutil.rmtree, d, True)
        p = Path(d) / "w.pdf"
        p.write_bytes(pdf)
        return str(p)

    def _deck_image(self) -> bytes:
        import zipfile
        with zipfile.ZipFile(DECK) as zf:
            return zf.read("ppt/media/image-3-1.png")


# ------------------------------------------------------------------ region decisions

class RegionDecisionLaws(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ruke-region-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_blank_region_zero_engine_calls(self):
        p = _standalone(self.tmp, "blank.png", _blank_png())
        with mock.patch.object(ocr_cascade, "run") as cascade:
            out = _inspect(p, "image", [{"unit": 1, "part": "blank.png"}])
        cascade.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "skipped")
        self.assertIn("uniformly blank", rec["reason"])
        self.assertTrue(rec["png"], "the pixels are kept for visual questions")
        self.assertEqual(out["invocations"], {"probe": 1, "engine": 0, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_photo_region_zero_engine_calls_pixels_kept(self):
        p = _standalone(self.tmp, "photo.png", _noise_png())
        with mock.patch.object(ocr_cascade, "run") as cascade:
            out = _inspect(p, "image", [{"unit": 1, "part": "photo.png"}])
        cascade.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "skipped")
        self.assertIn("photographic", rec["reason"])
        self.assertTrue(rec["probe"]["photo_like"])
        self.assertTrue(rec["png"])
        self.assertEqual(out["invocations"], {"probe": 1, "engine": 0, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_label_region_rides_the_cascade_exactly_once(self):
        p = _standalone(self.tmp, "label.png", _label_png())
        with mock.patch.object(ocr_cascade, "run", return_value=_recognised("AMBER CLOSE")) as cascade:
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}],
                           requested_language="eng")
        cascade.assert_called_once()
        kw = cascade.call_args.kwargs
        self.assertEqual(cascade.call_args.args[1], [1], "exactly this region page")
        self.assertEqual(kw["language"], "eng")
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["text"], "AMBER CLOSE")
        self.assertEqual(rec["engine"], "paddleocr-vl-1.6")
        self.assertEqual(rec["invocations"], {"probe": 1, "cascade": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertEqual(out["invocations"], {"probe": 1, "engine": 1, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_fallback_attempt_counts_two_engine_calls(self):
        p = _standalone(self.tmp, "label.png", _label_png())
        pages = _recognised("AMBER CLOSE", engine="tesseract")[0]
        casc = {"cascade": {"fallback": {"attempted": [1]}}}
        with mock.patch.object(ocr_cascade, "run", return_value=(pages, casc)):
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}],
                           requested_language="eng")
        self.assertEqual(out["regions"][0]["invocations"], {"probe": 1, "cascade": 2, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertEqual(out["invocations"], {"probe": 1, "engine": 2, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_paddle_selected_takeover_records_reason_and_region(self):
        # F152 Part 5 engine law, region level: the cascade ran the selected
        # Paddle primary, Paddle handed THIS region over, Tesseract read it.
        # The takeover reason and the producing engine must ride on the REGION
        # record — the durable cascade file is not read at answer time, so a
        # record naming "tesseract" with an empty reason is un-attributable.
        p = _standalone(self.tmp, "label.png", _label_png())
        pages = [OcrPage(page=1, state="recognised", text="AMBER CLOSE", confidence=0.88,
                         raster={"dpi": 200}, engine="tesseract-5.5.3", language_code="eng")]
        casc = {"cascade": {
            "primary": {"engine": "paddleocr-vl-1.6"},
            "fallback": {"attempted": [1],
                         "reason": "the primary engine refused the page: model load refused (loader)"},
            "engines_used": ["paddleocr-vl-1.6", "tesseract-5.5.3"]}}
        with mock.patch.object(ocr_cascade, "run", return_value=(pages, casc)):
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}],
                           requested_language="eng")
        rec = out["regions"][0]
        self.assertEqual(rec["region"], "image:1:label.png", "the takeover is attributable to a region id")
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["text"], "AMBER CLOSE")
        self.assertEqual(rec["engine"], "tesseract-5.5.3",
                         "the record names the engine that ACTUALLY read the region, not the selected primary")
        self.assertEqual(rec["fallback_reason"],
                         "the primary engine refused the page: model load refused (loader)",
                         "the real takeover reason travels on the region record")
        self.assertEqual(rec["invocations"], {"probe": 1, "cascade": 2, "probe_recognitions": 0, "cascade_recognitions": 0},
                         "primary + fallback = two engine attempts on this region")
        self.assertEqual(out["invocations"], {"probe": 1, "engine": 2, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_tesseract_selected_region_touches_paddle_zero_times(self):
        # F152 Part 5 engine law, region level: with settings.json pinning
        # Tesseract, NOTHING below the region stage touches Paddle. The proof
        # is the booby-trap: the Paddle probe/run entry points and the
        # exclusive-window handoff raise on contact — this test passing IS the
        # zero-contact proof (settings wins over RUKE_OCR_PRIMARY, so the
        # cascade itself is mocked; env is not an escape hatch).
        p = _standalone(self.tmp, "label.png", _label_png())
        pages = [OcrPage(page=1, state="recognised", text="AMBER CLOSE", confidence=0.91,
                         raster={"dpi": 200}, engine="tesseract-5.5.3", language_code="eng")]
        casc = {"cascade": {
            "primary": {"engine": "tesseract-5.5.3"},
            "fallback": {"attempted": [], "reason": "the user chose Tesseract only"},
            "engines_used": ["tesseract-5.5.3"],
            "handoff": {}}}
        with mock.patch.object(ocr_cascade, "run", return_value=(pages, casc)) as cascade, \
             mock.patch.object(ocr_paddle, "engine_state",
                               side_effect=AssertionError("ZERO Paddle probes")), \
             mock.patch.object(ocr_paddle, "ocr_pdf_pages",
                               side_effect=AssertionError("ZERO Paddle runs")), \
             mock.patch.object(handoff, "run_exclusive",
                               side_effect=AssertionError("a Tesseract-only job must never "
                                                          "unload the main model")):
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}],
                           requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["engine"], "tesseract-5.5.3")
        self.assertEqual(rec["fallback_reason"], "the user chose Tesseract only",
                         "the SELECTION reason rides on the record; nothing was handed over")
        self.assertEqual(rec["invocations"], {"probe": 1, "cascade": 1, "probe_recognitions": 0, "cascade_recognitions": 0},
                         "a Tesseract-selected region is one engine attempt, never a Paddle probe first")
        self.assertEqual(out["invocations"], {"probe": 1, "engine": 1, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_decode_failure_is_unreadable_retryable_with_reason(self):
        p = _standalone(self.tmp, "anim.gif", _gif_bytes())
        with mock.patch.object(ocr_cascade, "run") as cascade:
            out = _inspect(p, "image", [{"unit": 1, "part": "anim.gif"}])
        cascade.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "unreadable")
        self.assertTrue(rec["retryable"])
        self.assertIn("only PNG and JPEG rasters are wrapped", rec["reason"])
        self.assertEqual(out["invocations"], {"probe": 0, "engine": 0, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_interlaced_png_is_unreadable_retryable(self):
        p = _standalone(self.tmp, "inter.png", _interlaced_png())
        out = _inspect(p, "image", [{"unit": 1, "part": "inter.png"}])
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "unreadable")
        self.assertTrue(rec["retryable"])
        self.assertIn("interlaced", rec["reason"].lower())

    def test_ambiguous_band_without_language_refuses_never_defaults(self):
        p = _standalone(self.tmp, "ramp.png", _gradient_png())
        with mock.patch.object(ocr_cascade, "run") as cascade, \
             mock.patch.object(ocr_tesseract, "detect_language",
                               side_effect=OcrUnavailable("engine_missing", "osd data absent")):
            out = _inspect(p, "image", [{"unit": 1, "part": "ramp.png"}])
        cascade.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "needs_language")
        self.assertTrue(rec["retryable"])
        self.assertIn("no validated language", rec["reason"])
        self.assertNotIn("default", rec["reason"].lower())

    def test_ambiguous_band_with_language_probe_words_promote(self):
        p = _standalone(self.tmp, "ramp.png", _gradient_png())
        with mock.patch.object(ocr_cascade, "run", return_value=_recognised("ramp label")) as cascade, \
             mock.patch.object(ocr_tesseract, "ocr_png",
                               return_value=([{"text": "ramp label"}], "ramp label")):
            out = _inspect(p, "image", [{"unit": 1, "part": "ramp.png"}],
                           requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["probe"]["probe_words"], 2)
        self.assertEqual(rec["probe"]["language_source"], "requested")
        self.assertEqual(rec["invocations"], {"probe": 1, "cascade": 1, "probe_recognitions": 0, "cascade_recognitions": 0})

    def _policy(self, choice: str):
        """Pin the engine policy at the production seam the code reads (the
        machine's settings.json pins Paddle, so an unpinned test inherits it)."""
        return mock.patch.object(ocr_cascade, "policy", return_value={
            "ocr_selection": choice, "selection_source": "test: pinned policy"})

    def test_ambiguous_band_probe_zero_words_skips_paddle_selected(self):
        # F152 audit: with Paddle selected the probe's word recognition goes
        # through the cascade — the SELECTED primary gets the first eligible
        # attempt; Tesseract is not touched for the probe. Zero words from the
        # selected engine skips honestly, pixels kept.
        p = _standalone(self.tmp, "ramp.png", _gradient_png())
        empty = ([OcrPage(page=1, state="empty", text="", confidence=0.0,
                          raster={"dpi": region_ocr.PROBE_DPI},
                          engine="paddleocr-vl-1.6", language_code="eng")],
                 {"cascade": {"fallback": {"attempted": []}}})
        with self._policy("paddle"), \
             mock.patch.object(ocr_cascade, "run", return_value=empty) as cascade, \
             mock.patch.object(ocr_tesseract, "ocr_png") as tesseract:
            out = _inspect(p, "image", [{"unit": 1, "part": "ramp.png"}],
                           requested_language="eng")
        cascade.assert_called_once()
        tesseract.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "skipped")
        self.assertIn("zero words", rec["reason"])
        self.assertEqual(rec["probe"]["engine_policy"], "paddle")
        self.assertTrue(len(rec.get("png") or b"") > 0, "pixels kept for visual questions")

    def test_ambiguous_band_probe_zero_words_skips_tesseract_selected(self):
        # With Tesseract-only selected, Tesseract reads the probe pixels and the
        # Paddle pipeline is never probed: the cascade entry point is booby-trapped.
        p = _standalone(self.tmp, "ramp.png", _gradient_png())

        def no_paddle(*args, **kwargs):
            raise AssertionError("a Tesseract-only selection must never probe Paddle")
        with self._policy("tesseract"), \
             mock.patch.object(ocr_cascade, "run", side_effect=no_paddle) as cascade, \
             mock.patch.object(ocr_tesseract, "ocr_png", return_value=([], "")):
            out = _inspect(p, "image", [{"unit": 1, "part": "ramp.png"}],
                           requested_language="eng")
        cascade.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "skipped")
        self.assertIn("zero words", rec["reason"])
        self.assertEqual(rec["probe"]["engine_policy"], "tesseract")

    def test_eligible_region_language_comes_from_validated_detection(self):
        p = _standalone(self.tmp, "label.png", _label_png())
        with mock.patch.object(ocr_cascade, "run", return_value=_recognised("AMBER CLOSE")) as cascade, \
             mock.patch.object(ocr_tesseract, "detect_language",
                               return_value={"verified": True, "language": "eng", "script": "Latin"}):
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}])
        self.assertEqual(cascade.call_args.kwargs["language"], "eng")
        self.assertEqual(out["regions"][0]["state"], "recognised")

    def test_eligible_region_without_validated_language_refuses(self):
        p = _standalone(self.tmp, "label.png", _label_png())
        with mock.patch.object(ocr_cascade, "run") as cascade, \
             mock.patch.object(ocr_tesseract, "detect_language",
                               side_effect=OcrUnavailable("engine_missing", "osd data absent")):
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}])
        cascade.assert_not_called()
        self.assertEqual(out["regions"][0]["state"], "needs_language")

    def test_busy_lease_is_waiting_retryable_no_substitution(self):
        p = _standalone(self.tmp, "label.png", _label_png())
        casc = {"cascade": {"waiting": True}}
        with mock.patch.object(ocr_cascade, "run", return_value=([], casc)) as cascade:
            out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}],
                           requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "waiting")
        self.assertTrue(rec["retryable"])
        self.assertIn("inference lease", rec["reason"])
        self.assertTrue(out["waiting"])


# --------------------------------------------------------------- the deck.pptx finding

class DeckFinding(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ruke-deck-")
        self.deck = Path(self.tmp) / "deck.pptx"
        shutil.copy(DECK, self.deck)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_assessment_offers_the_display_image_as_a_region(self):
        doc = parser.load_document(self.deck)
        a = ocr.assess(doc)
        self.assertEqual(a.route, ocr.LIGHT_OCR)
        parts = [r["part"] for r in a.regions]
        self.assertIn("ppt/media/image-3-1.png", parts,
                      "slide 1's display image must be an inspected region, not the whole deck")
        self.assertTrue(any("inspected" in r for r in a.reasons))

    def test_region_of_the_deck_is_read_once_with_exact_evidence(self):
        doc = parser.load_document(self.deck)
        regions = doc.meta["embedded_images"]
        with mock.patch.object(ocr_cascade, "run", return_value=_recognised("AMBER CLOSE")) as cascade:
            out = _inspect(self.deck, doc.kind, regions, requested_language="eng")
        cascade.assert_called_once()
        recs = {r["region"]: r for r in out["regions"]}
        rec = recs["pptx:1:ppt/media/image-3-1.png"]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["text"], "AMBER CLOSE")
        self.assertEqual(rec["engine"], "paddleocr-vl-1.6")
        self.assertEqual(rec["language"], "eng")
        self.assertEqual(rec["invocations"], {"probe": 1, "cascade": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertFalse(rec["probe"]["blank"])
        self.assertTrue(rec["probe"]["text_structure"])
        self.assertTrue(rec["png"])

    def test_parse_job_ships_the_fact_the_location_the_frame_and_the_coverage(self):
        with mock.patch.object(jobs_doc, "catalog") as cat, \
             mock.patch.object(ocr_cascade, "run", return_value=_recognised("AMBER CLOSE")):
            cat.return_value.executable_for.return_value = [object()]
            res = jobs_doc.parse_job(_ctx(self.deck, self.tmp, language="eng"))
        self.assertEqual(res.state, "ready", getattr(res, "error", None) and res.error.message)
        payload = res.payload
        self.assertEqual(payload["ocr_route"], "light_ocr")
        rep = payload["ocr"]
        self.assertTrue(rep["ran"])
        self.assertEqual(rep["recognized"], 1)
        self.assertEqual(rep["invocations"], {"probe": 1, "engine": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertEqual(rep["engines_recognised"], {"paddleocr-vl-1.6": 1})
        # The report record is png-free and carries the region id + state.
        rec = rep["regions"][0]
        self.assertNotIn("png", rec, "the report must not carry raster payloads")
        self.assertGreater(rec["png_bytes"], 0)
        self.assertEqual(rec["state"], "recognised")
        # The recovered fact lands as its own ocr_text block with its location.
        blocks = payload["document"]["blocks"]
        ocr_blocks = [b for b in blocks if b["kind"] == "ocr_text"]
        self.assertEqual(len(ocr_blocks), 1)
        loc = ocr_blocks[0]["loc"]
        self.assertEqual(ocr_blocks[0]["text"], "AMBER CLOSE")
        self.assertEqual(loc["region"], "pptx:1:ppt/media/image-3-1.png")
        self.assertEqual(loc["unit"], 1)
        self.assertEqual(loc["provenance"], "ocr")
        self.assertEqual(loc["engine"], "paddleocr-vl-1.6")
        # The pixels ride to the chat as a labelled frame on the slide axis.
        frames = payload["visual_pages"]
        self.assertTrue(frames, "the rendered region must ship as a visual frame")
        self.assertEqual(frames[0]["label"], "slide 1")
        self.assertEqual(frames[0]["region"], "pptx:1:ppt/media/image-3-1.png")
        self.assertEqual(frames[0]["page"], 1)
        self.assertTrue(frames[0]["png_base64"])
        # Coverage: the recognised unit is succeeded, not pending.
        self.assertIn(1, payload["units_succeeded"])
        self.assertNotIn(1, payload["units_needing_ocr"])


def _ctx(target: Path, root: str, **payload) -> JobContext:
    req = JobRequest(request_id="r", run_id="run", job_id="j", capability="documents.parse",
                     payload={"path": str(target), "root": root, **payload})
    return JobContext(req=req, cancel=threading.Event(), progress=lambda state, note: None)


# ------------------------------------------------------- stage-level report and coverage

class StageLaws(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ruke-stage-")
        self.deck = Path(self.tmp) / "deck.pptx"
        shutil.copy(DECK, self.deck)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _run_stage(self, cascade_result, language: str = "eng"):
        doc = parser.load_document(self.deck)
        report: dict = {"ran": False, "attempted": 0, "recognized": 0, "pages": [],
                        "summary": "", "reason": ""}
        req = JobRequest(request_id="r", run_id="run", job_id="j", capability="documents.parse",
                         payload={"language": language})
        ctx = JobContext(req=req, cancel=threading.Event(), progress=lambda s, n: None)
        with mock.patch.object(jobs_doc, "catalog") as cat, \
             mock.patch.object(ocr_cascade, "run", return_value=cascade_result):
            cat.return_value.executable_for.return_value = [object()]
            out = jobs_doc.run_region_ocr_stage(
                ctx, doc, self.deck, report, list(doc.meta["embedded_images"]))
        return doc, out

    def test_recognised_region_wires_block_frame_report_and_coverage(self):
        doc, rep = self._run_stage(_recognised("AMBER CLOSE"))
        self.assertEqual(rep["recognized"], 1)
        self.assertEqual(rep["attempted"], 1)
        self.assertIn("slide 1", [f["label"] for f in rep["region_frames"]])
        states = {r["state"] for r in rep["regions"]}
        self.assertEqual(states, {"recognised"})
        self.assertIn("AMBER CLOSE", [b.text for b in doc.blocks if b.kind == "ocr_text"])
        self.assertIn(1, doc.coverage.units_succeeded)
        self.assertNotIn(1, doc.coverage.units_needing_ocr)
        self.assertIn("region inspection", doc.coverage.note)

    def test_busy_lease_keeps_the_unit_pending_and_the_job_retryable(self):
        doc, rep = self._run_stage(([], {"cascade": {"waiting": True}}))
        self.assertTrue(rep["waiting"])
        self.assertTrue(rep["retryable"])
        self.assertIn("resource_busy", rep["reason"])
        self.assertEqual(rep["recognized"], 0)
        self.assertIn(1, doc.coverage.units_needing_ocr)
        # The pixels still ship: a visual question is answerable while the lease is busy.
        self.assertTrue(rep["region_frames"])

    def _run_stage_scoped(self, cascade_result, regions, language="eng", only=None):
        extra = {"regions": only} if only is not None else {}
        doc = parser.load_document(self.deck)
        report: dict = {"ran": False, "attempted": 0, "recognized": 0, "pages": [],
                        "summary": "", "reason": ""}
        req = JobRequest(request_id="r", run_id="run", job_id="j", capability="documents.parse",
                         payload={"language": language, **extra})
        ctx = JobContext(req=req, cancel=threading.Event(), progress=lambda s, n: None)
        with mock.patch.object(jobs_doc, "catalog") as cat, \
             mock.patch.object(ocr_cascade, "run", return_value=cascade_result) as cascade:
            cat.return_value.executable_for.return_value = [object()]
            out = jobs_doc.run_region_ocr_stage(ctx, doc, self.deck, report, regions)
        return doc, out, cascade

    def test_targeted_reread_runs_only_the_selected_region(self):
        # Two figures, one question: the reread payload names ONE region id and
        # exactly that region's inspection re-runs — the other region is not
        # even probed, so its cached evidence stands untouched.
        import zipfile
        with zipfile.ZipFile(self.deck, "a") as zf:
            zf.writestr("ppt/media/extra.png", _noise_png())  # photo-like: probe, zero cascade
        regions = list(parser.load_document(self.deck).meta["embedded_images"])
        regions.append({"unit": 2, "part": "ppt/media/extra.png"})
        self.assertEqual(len(regions), 2)
        target_id = "pptx:1:ppt/media/image-3-1.png"

        # Unfiltered control: BOTH regions are inspected (2 probes).
        _, rep_all, cascade_all = self._run_stage_scoped(_recognised("AMBER CLOSE"), regions)
        self.assertEqual(rep_all["attempted"], 2)
        self.assertEqual(cascade_all.call_count, 1)
        self.assertEqual(rep_all["invocations"]["probe"], 2)

        # Targeted: only the requested region is touched — 1 probe, 1 cascade,
        # and the skipped region is RECORDED, not silently dropped.
        doc, rep, cascade = self._run_stage_scoped(
            _recognised("AMBER CLOSE"), regions, only=[target_id])
        self.assertEqual(rep["attempted"], 1)
        self.assertEqual(cascade.call_count, 1)
        self.assertEqual(rep["invocations"]["probe"], 1)
        self.assertEqual(rep["regions_requested"], [target_id])
        self.assertEqual(rep["regions_skipped"], ["pptx:2:ppt/media/extra.png"])
        self.assertEqual(rep["regions_unknown"], [])
        self.assertIn("targeted: 1 of 2", rep["region_scope"])
        self.assertEqual(rep["recognized"], 1)
        blocks = [b for b in doc.blocks if b.kind == "ocr_text"]
        self.assertEqual([b.loc["region"] for b in blocks], [target_id])
        self.assertEqual([b.loc["unit"] for b in blocks], [1])

    def test_unknown_region_id_records_and_runs_nothing(self):
        # A reread request naming a region the document does not have must not
        # guess a substitute: zero probes, zero engine calls, recorded reason.
        regions = list(parser.load_document(self.deck).meta["embedded_images"])
        doc, rep, cascade = self._run_stage_scoped(
            _recognised("AMBER CLOSE"), regions, only=["pptx:9:ppt/media/nope.png"])
        self.assertEqual(rep["attempted"], 0)
        self.assertEqual(rep["recognized"], 0)
        self.assertEqual(cascade.call_count, 0)
        self.assertEqual(rep["regions_unknown"], ["pptx:9:ppt/media/nope.png"])
        self.assertEqual(rep["invocations"]["probe"], 0)

    def test_text_only_docx_never_reaches_the_stage(self):
        d = tempfile.mkdtemp(prefix="ruke-text-")
        self.addCleanup(shutil.rmtree, d, True)
        path = Path(d) / "notes.docx"
        import zipfile
        decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("[Content_Types].xml", decl + "<Types/>")
            zf.writestr("word/document.xml", decl + (
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                "<w:body><w:p><w:r><w:t>Payments settled at 910 seats.</w:t></w:r></w:p>"
                "<w:p><w:r><w:t>The ledger closes at 73 tonnes.</w:t></w:r></w:p>"
                "</w:body></w:document>"))
        doc = parser.load_document(path)
        a = ocr.assess(doc)
        self.assertEqual(a.route, ocr.TEXT_LAYER_OK,
                         "a selectable Word document with no rasters must not be routed to OCR")
        report: dict = {"ran": False, "attempted": 0, "recognized": 0, "pages": [],
                        "summary": "", "reason": ""}
        req = JobRequest(request_id="r", run_id="run", job_id="j", capability="documents.parse",
                         payload={})
        ctx = JobContext(req=req, cancel=threading.Event(), progress=lambda s, n: None)
        with mock.patch.object(ocr_cascade, "run") as cascade:
            out = jobs_doc.run_ocr_stage(ctx, doc, path, a)
        cascade.assert_not_called()
        self.assertFalse(out["ran"])
        self.assertIn("structured reader", out["reason"])

    def test_docx_with_an_embedded_raster_offers_that_paragraph_as_a_region(self):
        # The F78 policy.docx carries a real embedded PNG in the package; the new law
        # offers exactly that raster as an inspected region (the pixels are what the
        # structured reader cannot read), while the selectable prose stays native blocks.
        doc = parser.load_document(
            REPO / "docs" / "overnight" / "fixtures" / "f78" / "review-docs" / "policy.docx")
        a = ocr.assess(doc)
        self.assertEqual(a.route, ocr.LIGHT_OCR)
        self.assertEqual(len(a.regions), 1)
        self.assertTrue(a.regions[0]["part"].startswith("word/media/"))
        self.assertEqual(a.regions[0]["unit"], 11)


# ---------------------------------------------------------- F152 PDF region law

def _load_d1():
    """The d1 fixture generator (stdlib-only, no side effects at import): the proven
    minimal-PDF writer whose geometry F73/F74 measured. Reusing it keeps the F152
    mixed-page fixture honest - real text layer, real drawn raster, pypdf-visible."""
    spec = importlib.util.spec_from_file_location(
        "d1_ocr_docs", REPO / "docs" / "overnight" / "fixtures" / "d1" / "ocr_docs.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D1 = _load_d1()

PROSE = ("Quarterly throughput for the Kestrel line. Sediment salinity measured eleven "
         "point four ppt across the estuary survey stations, logged by the harbour office "
         "clerk and countersigned by the tide master.")


def _bars_gray() -> bytes:
    """Ten black bars on a white ground: printable glyph strokes on paper - the same
    shape class as the deck legend, at a size that survives the 150 dpi page probe."""
    w, h = 440, 120
    buf = bytearray(b"\xff" * (w * h))
    for k in range(10):
        x0 = 10 + 42 * k
        for y in range(40, 80):
            for x in range(x0, x0 + 26):
                buf[y * w + x] = 0
    return bytes(buf)


def _mixed_pdf(rotate: int = 0) -> bytes:
    """The F152 finding class: a page whose prose is selectable AND whose raster
    carries content the text layer does not - here the bar "legend". The d1
    compose_pdf draws the raster on the page (referenced-but-never-drawn renders
    blank, which the F73 generator measured)."""
    return D1.compose_pdf([{"stream": D1.text_stream([PROSE], top=760),
                            "rotate": rotate, "image": (440, 120, _bars_gray())}])


COVERED_WORDS = ("quarterly throughput kestrel line sediment salinity measured eleven point "
                 "four ppt across estuary survey stations logged harbour office clerk "
                 "countersigned tide master")


def _covered_ground() -> bytes:
    """A raster big enough to sit OVER the prose block: the words it renders are
    selectable native text at those very positions (the decorative-overlay class -
    a raster laid over the text, not beside it)."""
    w, h = 1560, 240
    buf = bytearray(b"\xff" * (w * h))
    for k in range(10):
        x0 = 200 + 120 * k
        for y in range(100, 140):
            for x in range(x0, x0 + 60):
                buf[y * w + x] = 0
    return bytes(buf)


def _covered_pdf(rotate: int = 0) -> bytes:
    """The covered half of the position law: the raster covers the text block
    (drawn first, text drawn over it), so a probe of the figure's pixels finds
    words the page ALREADY carries at each word's own position."""
    return D1.compose_pdf([{"stream": D1.text_stream([PROSE], top=70, lead=16),
                            "rotate": rotate, "image": (1560, 240, _covered_ground())}])


def _two_figure_pdf() -> bytes:
    """One page, TWO embedded rasters at SEPARATE rects (a chart top-left, a legend
    bottom-right) beside real prose - the amended brief's reread fixture: a targeted
    crop of one figure must never re-run or mix in the other."""
    def image_obj(w: int, h: int) -> bytes:
        gray = bytes((0 if (x // 20 + y // 20) % 2 else 255) for y in range(h) for x in range(w))
        comp = zlib.compress(gray, 6)
        return (f"<</Type/XObject/Subtype/Image/Width {w}/Height {h}/ColorSpace/DeviceGray"
                f"/BitsPerComponent 8/Filter/FlateDecode/Length {len(comp)}>>\nstream\n").encode() + comp + b"\nendstream"

    content = (b"q 144 0 0 72 56 600 cm /Im0 Do Q\n"
               b"q 108 0 0 36 320 120 cm /Im1 Do Q\n"
               + D1.text_stream([PROSE], top=500))
    # Object ids stay CONTIGUOUS from 1 (D1's measured law: pdfium maps xref row N
    # to object N, so a gap shifts every later reference and the page fails to load).
    objs = {
        1: b"<</Type/Catalog/Pages 2 0 R/Lang(en-US)>>",
        2: b"<</Type/Pages/Count 1/Kids[5 0 R]>>",
        3: b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
        4: (f"<</Length {len(content)}>>\nstream\n").encode() + content + b"\nendstream",
        5: (b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
            b"/Resources<</Font<</F1 3 0 R>>/XObject<</Im0 6 0 R/Im1 7 0 R>>>>"
            b"/Contents 4 0 R>>"),
        6: image_obj(400, 200),   # drawn 144 x 72 pt at (56, 600)
        7: image_obj(300, 150),   # drawn 108 x 36 pt at (320, 120)
    }
    order = sorted(objs)
    out = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"
    off: dict[int, int] = {}
    for ref in order:
        off[ref] = len(out)
        out += f"{ref} 0 obj\n".encode() + objs[ref] + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(order) + 1}\n".encode() + b"0000000000 65535 f \n"
    for ref in order:
        out += f"{off[ref]:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(order) + 1}/Root 1 0 R>>\nstartxref\n{start}\n%%EOF\n".encode()
    return out


class PdfRegionLaws(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ruke-pdfregion-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.pdf = Path(self.tmp) / "mixed.pdf"

    def _job(self, probe_text: str, rotate: int = 0, cascade_result=None,
             language: str = "eng", only=None, fixture=None, probe_lines=None,
             policy=None):
        """The FULL production path: parse_job over the mixed PDF with only the
        cascade and the per-region probe recognition mocked (engines absent).

        F152 audit: `policy` pins the engine policy at the production seam
        (ocr_cascade.policy, which region_ocr._policy_choice reads before the first
        recognition call) so the SAME fixture is proved under both release choices
        instead of inheriting this machine's settings.json."""
        self.pdf.write_bytes(fixture(rotate) if fixture else _mixed_pdf(rotate))
        extra = {"language": language}
        if only is not None:
            extra["regions"] = only
        req = JobRequest(request_id="r", run_id="run", job_id="j",
                         capability="documents.parse",
                         payload={"path": str(self.pdf), "root": self.tmp, **extra})
        ctx = JobContext(req=req, cancel=threading.Event(), progress=lambda s, n: None)
        stack = contextlib.ExitStack()
        casc = stack.enter_context(mock.patch.object(
            ocr_cascade, "run", return_value=cascade_result or _recognised("AMBER CLOSE")))
        cat = stack.enter_context(mock.patch.object(jobs_doc, "catalog"))
        stack.enter_context(mock.patch.object(
            ocr_tesseract, "ocr_png",
            return_value=(probe_lines or [{"text": probe_text}], probe_text)))
        if policy is not None:
            stack.enter_context(mock.patch.object(
                ocr_cascade, "policy",
                return_value={"ocr_selection": policy, "selection_source": "test: pinned policy"}))
        with stack:
            cat.return_value.executable_for.return_value = [object()]
            res = jobs_doc.parse_job(ctx)
        return res, casc

    def test_mixed_page_is_recorded_as_a_region_with_its_native_text(self):
        self.pdf.write_bytes(_mixed_pdf())
        doc = parser.load_document(self.pdf)
        regions = doc.meta["embedded_images"]
        self.assertEqual(len(regions), 1, "the F73-branch page's single raster is exactly one region")
        self.assertEqual(regions[0]["unit"], 1)
        self.assertEqual(regions[0]["part"], "page:1/image:0",
                         "regions are per EMBEDDED IMAGE, not per page (two figures = two regions)")
        self.assertEqual(regions[0]["rotation"], 0)
        self.assertEqual([round(v, 1) for v in regions[0]["bounds"]], [0.0, 0.0, 158.4, 43.2],
                         "the region carries the image's real placement rect (PDF points, y-up)")
        self.assertIn("Kestrel", regions[0]["native_text"],
                      "the page's own text layer rides with the region for the coverage law")
        # F73 two-flag honesty, unchanged: the page is read AND eligible.
        self.assertIn(1, doc.coverage.units_succeeded)
        self.assertIn(1, doc.coverage.units_needing_ocr)

    def test_pdfium_probe_handle_closes_on_every_exit_path(self):
        """F153 §3 pdfium cleanup MEASUREMENT (2026-11-24, Windows).

        Measured on HEAD: the bounds probe's pdfium PdfDocument keeps the OS
        file lock until close() — dropping the closure (refcount) and
        gc.collect() do NOT release it — so after any indexed load of a PDF
        with region candidates, os.remove/os.rename raised WinError 32 for the
        life of the process. An uploaded PDF's file must stay removable
        (chat deletion, re-upload overwrite, temp cleanup). The probe now
        closes deterministically on every exit path; on POSIX an open handle
        never blocks unlink, so the lock proof is Windows-strict while the
        close-on-every-path law holds everywhere.
        """
        self.pdf.write_bytes(_mixed_pdf())
        doc = parser.load_document(self.pdf)
        self.assertEqual([r["part"] for r in doc.meta["embedded_images"]], ["page:1/image:0"],
                         "the probe ran on this fixture (it opened pdfium)")
        for _ in range(3):
            parser.load_document(self.pdf)
        os.remove(self.pdf)  # HEAD: WinError 32 — locked for the process's life

        # Mid-loop failure: the probe opened, the page loop raised — the
        # finally-close must still release the handle.
        other = Path(self.tmp) / "mixed-raise.pdf"
        other.write_bytes(_mixed_pdf())
        with mock.patch.object(pdf_mod, "_visual_paint_ops", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                parser.load_document(other)
        os.remove(other)

    def test_image_only_legend_on_a_native_page_gets_read_once(self):
        # The finding class end-to-end: native prose + a raster-only label. The
        # probe finds words the text layer LACKS, so exactly one cascade call
        # reads exactly this page, rotated as declared, and the fact lands with
        # its location beside the intact native blocks.
        res, casc = self._job("AMBER CLOSE", rotate=90)
        self.assertEqual(res.state, "ready", getattr(res, "error", None) and res.error.message)
        casc.assert_called_once()
        self.assertEqual(casc.call_args.args[1], [1])
        self.assertNotEqual(casc.call_args.args[0], str(self.pdf))
        self.assertTrue(casc.call_args.args[0].endswith("_figure.pdf"),
                        "the cascade reads the FIGURE CROP, so page prose is never re-OCR'd")
        self.assertIsNone(casc.call_args.kwargs["rotations"],
                          "the crop burned in the page /Rotate: the cascade must not rotate twice")
        self.assertEqual(casc.call_args.kwargs["language"], "eng")
        rep = res.payload["ocr"]
        self.assertEqual(rep["recognized"], 1)
        self.assertEqual(rep["invocations"], {"probe": 1, "engine": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        rec = rep["regions"][0]
        self.assertEqual(rec["region"], "pdf:1:page:1/image:0")
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["probe"]["uncovered_words"], 2)
        self.assertEqual(rec["probe"]["coverage_mode"], "position",
                         "coverage is judged against native text at each probe line's own position")
        # pdfium get_bounds returns placement floats with drift (158.39999... not 158.4),
        # so the rect is asserted with a sub-pixel tolerance, not exact ints.
        crop = rec["crop"]
        for got, want in zip(crop, [0, 0, 98, 339]):
            self.assertLessEqual(abs(got - want), 1.5,
                                 f"the crop is the figure's rotated placement rect (+pad): {crop}")
        self.assertLess(crop[2] * crop[3], 1275 * 1650, "the crop is strictly smaller than the page")
        blocks = res.payload["document"]["blocks"]
        ocr_blocks = [b for b in blocks if b["kind"] == "ocr_text"]
        self.assertEqual([b["text"] for b in ocr_blocks], ["AMBER CLOSE"])
        loc = ocr_blocks[0]["loc"]
        self.assertEqual(loc["region"], "pdf:1:page:1/image:0")
        self.assertEqual(loc["unit"], 1)
        self.assertEqual(loc["engine"], "paddleocr-vl-1.6")
        self.assertEqual(loc["provenance"], "ocr")
        self.assertTrue([b for b in blocks if b["kind"] == "page_text"],
                        "the native prose survives next to the recovered fact")
        frames = [f for f in res.payload["visual_pages"] if f.get("region")]
        self.assertEqual([(f["label"], f["page"]) for f in frames], [("page 1, figure 1", 1)],
                         "a per-image frame label carries its figure ordinal: two figures on "
                         "one page must be nameable apart")
        self.assertNotIn(1, res.payload["units_needing_ocr"],
                         "the read page leaves the OCR-pending set")

    def _covered_lines(self, crop_w: int, crop_h: int, probe_text: str) -> list:
        return [{"text": probe_text, "bbox": [0, 0, crop_w, crop_h]}]

    def test_raster_fully_covered_by_the_text_layer_costs_zero_engine_calls(self):
        # The decorative-overlay half of the POSITION law, PROVEN UNDER ITS POLICY:
        # with Tesseract selected the cheap adapter probe answers coverage — ZERO
        # cascade calls, the page leaves the pending set (no phantom unread unit),
        # pixels stay for visual questions. A word printed in a paragraph beside a
        # chart would NOT cover the chart - that cascade fires.
        scale = region_ocr.PROBE_DPI / 72.0
        crop_w = round(1560 * 72.0 / D1.DPI * scale) + region_ocr.CROP_PAD_PX
        crop_h = round(240 * 72.0 / D1.DPI * scale) + region_ocr.CROP_PAD_PX
        res, casc = self._job(COVERED_WORDS, fixture=_covered_pdf, probe_lines=[
            {"text": COVERED_WORDS, "bbox": [0, 0, crop_w, crop_h]}], policy="tesseract")
        casc.assert_not_called()
        rep = res.payload["ocr"]
        rec = rep["regions"][0]
        self.assertEqual(rec["region"], "pdf:1:page:1/image:0")
        self.assertEqual(rec["state"], "skipped")
        self.assertIn("at that token's own position", rec["reason"])
        self.assertEqual(rec["probe"]["coverage_mode"], "position")
        self.assertEqual(rec["probe"]["engine_policy"], "tesseract")
        self.assertGreater(rec["probe"]["probe_words"], 5)
        self.assertEqual(rec["probe"]["uncovered_words"], 0)
        self.assertEqual(rep["invocations"], {"probe": 1, "engine": 0, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertGreater(rec["png_bytes"], 0, "pixels kept for visual questions")
        self.assertNotIn(1, res.payload["units_needing_ocr"])
        self.assertNotIn("ocr_text", [b["kind"] for b in res.payload["document"]["blocks"]])

    def test_raster_fully_covered_gets_the_selected_engine_exactly_once(self):
        # F152 audit, Paddle selected: the coverage probe's word recognition IS a
        # cascade dispatch (the primary gets the first eligible attempt), so the
        # fully covered raster pays EXACTLY ONE probe call - and the coverage law
        # then skips the region, so it never pays for a SECOND cascade. The result
        # of that one call is what judged the coverage; pixels stay for visual
        # questions and the page leaves the pending set.
        scale = region_ocr.PROBE_DPI / 72.0
        crop_w = round(1560 * 72.0 / D1.DPI * scale) + region_ocr.CROP_PAD_PX
        crop_h = round(240 * 72.0 / D1.DPI * scale) + region_ocr.CROP_PAD_PX
        casc_result = ([OcrPage(page=1, state="recognised", text=COVERED_WORDS,
                                confidence=0.9,
                                lines=self._covered_lines(crop_w, crop_h, COVERED_WORDS),
                                raster={"dpi": region_ocr.PROBE_DPI},
                                engine="paddleocr-vl-1.6", language_code="eng")],
                       {"cascade": {"fallback": {"attempted": []}}})
        res, casc = self._job(COVERED_WORDS, fixture=_covered_pdf,
                              cascade_result=casc_result, policy="paddle")
        casc.assert_called_once()
        rep = res.payload["ocr"]
        rec = rep["regions"][0]
        self.assertEqual(rec["region"], "pdf:1:page:1/image:0")
        self.assertEqual(rec["state"], "skipped")
        self.assertIn("at that token's own position", rec["reason"])
        self.assertEqual(rec["probe"]["coverage_mode"], "position")
        self.assertEqual(rec["probe"]["engine_policy"], "paddle")
        self.assertGreater(rec["probe"]["probe_words"], 5)
        self.assertEqual(rec["probe"]["uncovered_words"], 0)
        self.assertEqual(rep["invocations"], {"probe": 1, "engine": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertGreater(rec["png_bytes"], 0, "pixels kept for visual questions")
        self.assertNotIn(1, res.payload["units_needing_ocr"])
        self.assertNotIn("ocr_text", [b["kind"] for b in res.payload["document"]["blocks"]])

    def test_pdf_render_failure_is_unreadable_retryable_with_reason(self):
        self.pdf.write_bytes(_mixed_pdf())
        doc = parser.load_document(self.pdf)
        with mock.patch.object(ocr_cascade, "run") as cascade, \
             mock.patch.object(ocr_tesseract, "render_page_png",
                               side_effect=OcrUnavailable("raster_failed", "page 1 failed to render")):
            out = _inspect(self.pdf, "pdf", doc.meta["embedded_images"],
                           requested_language="eng")
        cascade.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "unreadable")
        self.assertTrue(rec["retryable"])
        self.assertIn("failed to render", rec["reason"])
        self.assertEqual(out["invocations"], {"probe": 0, "engine": 0, "probe_recognitions": 0, "cascade_recognitions": 0})

    def test_busy_lease_on_a_pdf_region_stays_waiting_retryable(self):
        self.pdf.write_bytes(_mixed_pdf())
        doc = parser.load_document(self.pdf)
        casc = {"cascade": {"waiting": True}}
        with mock.patch.object(ocr_cascade, "run", return_value=([], casc)) as cascade, \
             mock.patch.object(ocr_tesseract, "ocr_png",
                               return_value=([{"text": "AMBER CLOSE"}], "AMBER CLOSE")):
            out = _inspect(self.pdf, "pdf", doc.meta["embedded_images"],
                           requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "waiting")
        self.assertTrue(rec["retryable"])
        self.assertTrue(out["waiting"])

    def test_two_figures_on_one_page_reread_exactly_one(self):
        # The amended brief's reread law at python level: two figures, ONE page.
        # A targeted reread of one figure re-inspects EXACTLY that crop; the
        # neighbour is recorded skipped with ZERO invocations - its pictures and
        # words cannot leak into this answer.
        self.pdf.write_bytes(_two_figure_pdf())
        doc = parser.load_document(self.pdf)
        regions = doc.meta["embedded_images"]
        self.assertEqual([r["part"] for r in regions], ["page:1/image:0", "page:1/image:1"])
        self.assertEqual([round(v, 1) for v in regions[0]["bounds"]], [56.0, 600.0, 200.0, 672.0])
        self.assertEqual([round(v, 1) for v in regions[1]["bounds"]], [320.0, 120.0, 428.0, 156.0])

        def run(only):
            payload = {"language": "eng"}
            if only is not None:
                payload["regions"] = only
            req = JobRequest(request_id="r", run_id="run", job_id="j",
                             capability="documents.parse", payload=payload)
            ctx = JobContext(req=req, cancel=threading.Event(), progress=lambda s, n: None)
            report = {"ran": False, "attempted": 0, "recognized": 0, "pages": [],
                      "summary": "", "reason": ""}
            fresh = parser.load_document(self.pdf)   # a clean document per run: the block
            with mock.patch.object(jobs_doc, "catalog") as cat, \
                 mock.patch.object(ocr_cascade, "run",
                                   return_value=_recognised("AMBER CLOSE")) as casc, \
                 mock.patch.object(ocr_tesseract, "ocr_png",
                                   return_value=([{"text": "AMBER CLOSE"}], "AMBER CLOSE")):
                cat.return_value.executable_for.return_value = [object()]
                jobs_doc.run_region_ocr_stage(ctx, fresh, self.pdf, report, list(regions))
            return report, casc, fresh

        # Unscoped control: BOTH figures inspected (2 probes, 2 cascades).
        rep_all, casc_all, _ = run(None)
        self.assertEqual(rep_all["attempted"], 2)
        self.assertEqual(casc_all.call_count, 2)

        # Targeted: figure 1 only.
        rep, casc, fresh = run(["pdf:1:page:1/image:0"])
        self.assertEqual(rep["attempted"], 1)
        self.assertEqual(rep["recognized"], 1)
        self.assertEqual(casc.call_count, 1, "the neighbour figure ran ZERO engine work")
        self.assertTrue(casc.call_args.args[0].endswith("_figure.pdf"),
                        "the cascade reads the targeted figure's crop")
        self.assertEqual(rep["regions_skipped"], ["pdf:1:page:1/image:1"],
                         "the untouched figure is RECORDED, not silently dropped")
        by_id = {r["region"]: r for r in rep["regions"]}
        self.assertEqual(sorted(by_id), ["pdf:1:page:1/image:0"],
                         "the neighbour was never inspected: it carries NO invocation record")
        self.assertEqual(by_id["pdf:1:page:1/image:0"]["invocations"],
                         {"probe": 1, "cascade": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertEqual([b.loc["region"] for b in fresh.blocks if b.kind == "ocr_text"],
                         ["pdf:1:page:1/image:0"], "only the targeted figure's text joins the answer")

    def test_clean_one_word_native_page_costs_zero_ocr(self):
        # "OK" on a clean page: the native layer IS the content - no raster, no drawn
        # content - so weakness alone must not schedule an engine pass over pixels
        # that already are the text. (image_count == -1 stays eligible: unknown is
        # not evidence of absence - the F73 unknown-stays-put law.)
        ok = Path(self.tmp) / "ok.pdf"
        ok.write_bytes(D1.compose_pdf([{"stream": D1.text_stream(["OK"]), "rotate": 0}]))
        doc = parser.load_document(ok)
        self.assertIn(1, doc.coverage.units_succeeded, "the page IS read")
        self.assertNotIn(1, doc.coverage.units_needing_ocr,
                         "a one-word native page with no imagery has nothing left to recognise")
        self.assertEqual(doc.meta["embedded_images"], [])

    def test_primary_engine_failure_reason_travels_on_the_region_record(self):
        # The durable cascade file nobody reads at answer time is not enough: the
        # REAL reason the primary engine handed the region over rides the record.
        self.pdf.write_bytes(_mixed_pdf())
        doc = parser.load_document(self.pdf)
        casc = ([OcrPage(page=1, state="recognised", text="KAPPA 9", confidence=0.9,
                         raster={"dpi": 200}, engine="tesseract", language_code="eng")],
                {"cascade": {"primary": {"run_refused": "paddle model failed to load: libpaddle missing"},
                             "fallback": {"attempted": ["tesseract"],
                                          "reason": "paddle model failed to load: libpaddle missing"}}})
        with mock.patch.object(ocr_cascade, "run", return_value=casc), \
             mock.patch.object(ocr_tesseract, "ocr_png",
                               return_value=([{"text": "KAPPA 9"}], "KAPPA 9")):
            out = _inspect(self.pdf, "pdf", doc.meta["embedded_images"], requested_language="eng")
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertIn("libpaddle", rec["fallback_reason"])
        self.assertEqual(rec["invocations"]["cascade"], 2, "primary refusal + fallback ran")


class CoverageMatcherLaws(unittest.TestCase):
    def test_tokenizer_keeps_short_and_non_latin_tokens(self):
        # The old word-set matcher dropped short tokens and non-ASCII labels, so
        # the axis label "A", the tick "7", "pH", "42" and a non-Latin label were
        # "covered" by nothing. Under the position law every one is a token.
        self.assertEqual(region_ocr._words_of("pH 42 A 7 naïve KAPPA 9"),
                         {"ph", "42", "a", "7", "naïve", "kappa", "9"})
        self.assertTrue(region_ocr._covered("kap", {"kappa"}),
                        "a probe-OCR fragment of a native word is not uncovered content")

    def test_probe_recognitions_are_counted_at_the_adapter(self):
        # The amended brief: probes that run the engine are counted BY THE ENGINE'S
        # OWN LEDGER, not omitted by a caller's tally. This stub plays tesseract and
        # increments the adapter counter exactly as the real ocr_png does.
        def fake_ocr_png(*args, **kwargs):
            ocr_tesseract.RECOGNITIONS["tesseract_ocr_png"] += 1
            return ([{"text": "PH 42"}], "PH 42")
        tmp = tempfile.mkdtemp(prefix="ruke-adaptercount-")
        self.addCleanup(shutil.rmtree, tmp, True)
        # A quiet non-photo raster: the photo branch skips BEFORE the band probe, so
        # only content like this gradient reaches the probe whose pass the adapter counts.
        p = _standalone(tmp, "figure.png", _gradient_png())
        doc = parser.load_document(p)
        with mock.patch.object(ocr_cascade, "policy", return_value={
                                   "ocr_selection": "tesseract",
                                   "selection_source": "test: pinned policy"}), \
             mock.patch.object(ocr_cascade, "run", return_value=_recognised("PH 42")) as cascade, \
             mock.patch.object(ocr_tesseract, "ocr_png", side_effect=fake_ocr_png):
            out = _inspect(p, "image", doc.meta["embedded_images"], requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["probe"]["engine_policy"], "tesseract")
        self.assertEqual(rec["invocations"]["probe_recognitions"], 1,
                         "the band probe's real recognition is reported by the adapter count")
        self.assertEqual(out["invocations"]["probe_recognitions"], 1)
        self.assertEqual(out["invocations"]["cascade_recognitions"], 0,
                         "the mocked cascade ran no real adapter pass")

    def test_cascade_fallback_recognitions_are_counted_at_the_adapter(self):
        # F152 audit, Paddle selected: the probe dispatches the CASCADE, and the
        # Tesseract passes the cascade's PERMITTED FALLBACK runs are reported by
        # the adapter ledger attributed to this region's dispatch - never omitted
        # by a caller's tally. The reuse law holds: one cascade for the region.
        def fake_cascade(*args, **kwargs):
            ocr_tesseract.RECOGNITIONS["tesseract_ocr_png"] += 1  # the permitted fallback ran
            return ([OcrPage(page=1, state="recognised", text="PH 42", confidence=0.9,
                             raster={"dpi": region_ocr.PROBE_DPI},
                             engine="tesseract", language_code="eng")],
                    {"cascade": {"primary": {"run_refused": ""},
                                 "fallback": {"attempted": ["tesseract"],
                                              "reason": "paddle model failed to load: libpaddle missing"}}})
        tmp = tempfile.mkdtemp(prefix="ruke-cascadecount-")
        self.addCleanup(shutil.rmtree, tmp, True)
        p = _standalone(tmp, "figure.png", _gradient_png())
        doc = parser.load_document(p)
        with mock.patch.object(ocr_cascade, "policy", return_value={
                                   "ocr_selection": "paddle",
                                   "selection_source": "test: pinned policy"}), \
             mock.patch.object(ocr_cascade, "run", side_effect=fake_cascade) as cascade, \
             mock.patch.object(ocr_tesseract, "ocr_png") as tesseract:
            out = _inspect(p, "image", doc.meta["embedded_images"], requested_language="eng")
        cascade.assert_called_once()
        tesseract.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["probe"]["engine_policy"], "paddle")
        self.assertEqual(rec["invocations"]["probe_recognitions"], 0,
                         "the probe ran no direct Tesseract pass under the Paddle policy")
        self.assertEqual(rec["invocations"]["cascade_recognitions"], 1,
                         "the cascade's permitted-fallback recognition is reported by the adapter count")
        self.assertEqual(rec["invocations"]["cascade"], 2, "primary attempt + permitted fallback")
        self.assertIn("libpaddle", rec["fallback_reason"])
        self.assertEqual(rec["probe"]["recognizer"], "tesseract")
        self.assertEqual(out["invocations"]["probe_recognitions"], 0)
        self.assertEqual(out["invocations"]["cascade_recognitions"], 1)


# ------------------------------------------------- engine-policy probe laws (F152 audit)

class EnginePolicyProbeLaws(unittest.TestCase):
    """F152 audit (2026-11-24): the probe's word recognition is dispatched THROUGH
    the selected engine policy, resolved BEFORE the first recognition call. The
    adapter entry points are instrumented directly; the ordered calls, region IDs
    and fallback reasons are asserted, per the brief's proof list. The Tesseract-
    only booby-trap for the probe is in RegionDecisionLaws (zero-words twin); the
    eligible-path booby-trap is test_tesseract_selected_region_touches_paddle_zero_times."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ruke-policyp-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.pdf = Path(self.tmp) / "mixed.pdf"

    def _policy(self, choice: str):
        return mock.patch.object(ocr_cascade, "policy", return_value={
            "ocr_selection": choice, "selection_source": "test: pinned policy"})

    def _regions(self):
        self.pdf.write_bytes(_mixed_pdf())
        return parser.load_document(self.pdf).meta["embedded_images"]

    def test_probe_recognition_follows_the_selected_policy_in_order(self):
        regions = self._regions()
        calls: list[str] = []

        def casc(*args, **kwargs):
            calls.append("cascade")
            return _recognised("AMBER CLOSE")

        def png(*args, **kwargs):
            calls.append("tesseract")
            return ([{"text": "AMBER CLOSE"}], "AMBER CLOSE")

        with self._policy("paddle"), \
             mock.patch.object(ocr_cascade, "run", side_effect=casc) as c1, \
             mock.patch.object(ocr_tesseract, "ocr_png", side_effect=png) as t1:
            out = _inspect(self.pdf, "pdf", regions, requested_language="eng")
        self.assertEqual(calls, ["cascade"],
                         "with Paddle selected the primary gets the FIRST eligible recognition attempt")
        self.assertEqual(c1.call_count, 1,
                         "one recognition for the region - the probe cascade is REUSED, never re-run")
        rec = out["regions"][0]
        self.assertEqual(rec["region"], "pdf:1:page:1/image:0")
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["probe"]["engine_policy"], "paddle")
        calls.clear()
        with self._policy("tesseract"), \
             mock.patch.object(ocr_cascade, "run", side_effect=casc) as c2, \
             mock.patch.object(ocr_tesseract, "ocr_png", side_effect=png) as t2:
            out = _inspect(self.pdf, "pdf", regions, requested_language="eng")
        self.assertEqual(calls, ["tesseract", "cascade"],
                         "with Tesseract selected the probe reads the pixels; the eligible cascade path follows")
        self.assertEqual(out["regions"][0]["probe"]["engine_policy"], "tesseract")

    def test_busy_lease_at_the_probe_stays_waiting_and_is_never_rerun(self):
        regions = self._regions()
        casc = ([], {"cascade": {"waiting": True}})
        with self._policy("paddle"), \
             mock.patch.object(ocr_cascade, "run", return_value=casc) as c, \
             mock.patch.object(ocr_tesseract, "ocr_png") as t:
            out = _inspect(self.pdf, "pdf", regions, requested_language="eng")
        self.assertEqual(c.call_count, 1, "the region is queued, not retried inside the job")
        t.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "waiting")
        self.assertTrue(rec["retryable"])
        self.assertIn("no fallback engine ran", rec["reason"])
        self.assertTrue(len(rec.get("png") or b"") > 0, "pixels kept for visual questions")
        self.assertTrue(out["waiting"])

    def test_genuine_primary_failure_at_the_probe_records_the_real_takeover_reason(self):
        regions = self._regions()
        casc = ([OcrPage(page=1, state="recognised", text="AMBER CLOSE", confidence=0.88,
                         raster={"dpi": region_ocr.PROBE_DPI}, engine="tesseract",
                         language_code="eng")],
                {"cascade": {"primary": {"run_refused": "paddle model failed to load: libpaddle missing"},
                             "fallback": {"attempted": ["tesseract"],
                                          "reason": "paddle model failed to load: libpaddle missing"}}})
        with self._policy("paddle"), \
             mock.patch.object(ocr_cascade, "run", return_value=casc) as c, \
             mock.patch.object(ocr_tesseract, "ocr_png") as t:
            out = _inspect(self.pdf, "pdf", regions, requested_language="eng")
        self.assertEqual(c.call_count, 1, "the fallback is the cascade's own, not a second dispatch")
        t.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["engine"], "tesseract", "the PRODUCING engine rides the record")
        self.assertIn("libpaddle", rec["fallback_reason"])
        self.assertEqual(rec["probe"]["recognizer"], "tesseract")
        self.assertEqual(rec["invocations"]["cascade"], 2, "primary refusal + permitted fallback")

    def test_empty_probe_never_marks_a_glyph_bearing_region_covered(self):
        # The brief's law: an empty preliminary OCR result must NOT silently
        # classify a visibly text-bearing region as fully covered. Glyph structure
        # is evidence - the region keeps state "empty" (the engine ran, found
        # nothing) and stays pending; pixels ride for visual questions.
        self.pdf.write_bytes(_covered_pdf())
        regions = parser.load_document(self.pdf).meta["embedded_images"]
        casc = ([OcrPage(page=1, state="empty", text="", confidence=0.0,
                         raster={"dpi": region_ocr.PROBE_DPI},
                         engine="paddleocr-vl-1.6", language_code="eng")],
                {"cascade": {"fallback": {"attempted": []}}})
        with self._policy("paddle"), \
             mock.patch.object(ocr_cascade, "run", return_value=casc) as c, \
             mock.patch.object(ocr_tesseract, "ocr_png") as t:
            out = _inspect(self.pdf, "pdf", regions, requested_language="eng")
        self.assertEqual(c.call_count, 1)
        t.assert_not_called()
        rec = out["regions"][0]
        self.assertEqual(rec["region"], "pdf:1:page:1/image:0")
        self.assertTrue(rec["probe"]["glyph_evidence"])
        self.assertEqual(rec["state"], "empty")
        self.assertIn("empty of text", rec["reason"])
        self.assertNotIn("covered", rec["reason"])
        self.assertEqual(rec["probe"]["engine_policy"], "paddle")
        self.assertTrue(len(rec.get("png") or b"") > 0, "pixels kept for visual questions")

    def test_language_detection_verification_follows_the_policy(self):
        # The audited helper: detect_language's verification pass is Tesseract WORD
        # recognition, so it runs only when Tesseract is the SELECTED engine.
        # Under Paddle the script-level gate answers - no word recognition, and
        # the Paddle pipeline is never loaded by language detection.
        p = _standalone(self.tmp, "label.png", _label_png())
        for choice, want in (("paddle", False), ("tesseract", True)):
            with self.subTest(policy=choice), self._policy(choice), \
                 mock.patch.object(ocr_cascade, "run",
                                   return_value=_recognised("AMBER CLOSE")) as cascade, \
                 mock.patch.object(ocr_tesseract, "detect_language",
                                   return_value={"verified": True, "language": "eng",
                                                 "script": "Latin"}) as det:
                out = _inspect(p, "image", [{"unit": 1, "part": "label.png"}])
            self.assertEqual(det.call_args.kwargs["verify"], want)
            self.assertEqual(out["regions"][0]["state"], "recognised")
            self.assertEqual(cascade.call_args.kwargs["language"], "eng")


# ---------------------------------------------------------------- XLSX region row

def _xlsx_with_image(path: Path) -> None:
    """A minimal valid workbook: one numeric cell, one drawing anchored at C4 whose
    picture is a label-bearing PNG in xl/media - the inventory law's exact inputs."""
    decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    relns = ' xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", decl + "<Types/>")
        zf.writestr("xl/workbook.xml", decl + (
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/></sheets></workbook>'))
        zf.writestr("xl/_rels/workbook.xml.rels", decl + f"<Relationships{relns}>"
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                    'Target="worksheets/sheet1.xml"/></Relationships>')
        zf.writestr("xl/worksheets/sheet1.xml", decl + (
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData><row r="1"><c r="A1"><v>730</v></c></row></sheetData></worksheet>'))
        zf.writestr("xl/worksheets/_rels/sheet1.xml.rels", decl + f"<Relationships{relns}>"
                    '<Relationship Id="rIdD" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" '
                    'Target="../drawings/drawing1.xml"/></Relationships>')
        zf.writestr("xl/drawings/drawing1.xml", decl + (
            '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<xdr:twoCellAnchor>'
            '<xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff>'
            '<xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
            '<xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff>'
            '<xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
            '<xdr:pic><xdr:blipFill><a:blip r:embed="rIdImg"/></xdr:blipFill></xdr:pic>'
            '<xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>'))
        zf.writestr("xl/drawings/_rels/drawing1.xml.rels", decl + f"<Relationships{relns}>"
                    '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
                    'Target="../media/image1.png"/></Relationships>')
        zf.writestr("xl/media/image1.png", _label_png())


class XlsxRegionLaws(unittest.TestCase):
    def test_xlsx_embedded_raster_is_a_region_at_its_anchor_cell(self):
        tmp = tempfile.mkdtemp(prefix="ruke-xlsxregion-")
        self.addCleanup(shutil.rmtree, tmp, True)
        xlsx = Path(tmp) / "ledger.xlsx"
        _xlsx_with_image(xlsx)
        doc = parser.load_document(xlsx)
        self.assertEqual(doc.kind, "xlsx")
        self.assertIn("730", [b.text for b in doc.blocks],
                      "the workbook itself parses - an unparsed sheet would mask the inventory")
        regions = doc.meta["embedded_images"]
        self.assertEqual([(r["unit"], r["part"], r.get("anchor")) for r in regions],
                         [(1, "xl/media/image1.png", "C4")],
                         "the sheet ordinal and the twoCellAnchor cell are the region's location")
        with mock.patch.object(ocr_cascade, "run", return_value=_recognised("AMBER CLOSE")) as cascade:
            out = _inspect(xlsx, doc.kind, regions, requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["region"], "xlsx:1:xl/media/image1.png")
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["text"], "AMBER CLOSE")
        self.assertEqual(rec["anchor"], "C4")
        self.assertEqual(rec["invocations"], {"probe": 1, "cascade": 1, "probe_recognitions": 0, "cascade_recognitions": 0})
        self.assertEqual((rec["unit"], rec["anchor"]), (1, "C4"),
                         "the frame label (sheet {unit}, cell {anchor}) is built from these")


# ----------------------------------------------------------- standalone image kind

class StandaloneImageLaws(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ruke-image-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_standalone_png_loads_as_an_image_document_with_one_region(self):
        p = _standalone(self.tmp, "shot.png", _label_png())
        doc = parser.load_document(p)
        self.assertEqual(doc.kind, "image")
        self.assertEqual(doc.meta["embedded_images"],
                         [{"unit": 1, "part": "shot.png", "ext": ".png"}])
        a = ocr.assess(doc)
        self.assertEqual(a.route, ocr.LIGHT_OCR)
        self.assertEqual(len(a.regions), 1)

    def test_standalone_photo_is_assessed_then_skips_every_engine(self):
        p = _standalone(self.tmp, "photo.png", _noise_png())
        doc = parser.load_document(p)
        self.assertEqual(ocr.assess(doc).route, ocr.LIGHT_OCR,
                         "assessment inspects; the inspection - not the assessment - decides")
        with mock.patch.object(ocr_cascade, "run") as cascade:
            out = _inspect(p, "image", doc.meta["embedded_images"], requested_language="eng")
        cascade.assert_not_called()
        self.assertEqual(out["regions"][0]["state"], "skipped")
        self.assertTrue(out["regions"][0]["png"], "pixels kept for visual questions")


# ----------------------------------------------------------- unseen fixture (Part 5)

class UnseenFixtureLaw(unittest.TestCase):
    """ONE fixture never used during development: docs/overnight/fixtures/f152/
    kappa9-chart-legend.png — a pixel-only chart legend label ("KAPPA 9", 8
    characters, ONE image) built fresh from bar geometry the unit tests never
    used. The threshold question the brief asks: an 8-character label inside a
    single image named "chart-legend" sits BELOW any "image count / character
    threshold" heuristic - does the route still run? It must, because only the
    inspected pixels decide; and the registry-driven record must name the
    engine that ACTUALLY read it (here Tesseract, after the selected Paddle
    primary handed the region over) with the takeover reason and exact counts.
    """

    def test_unseen_pixel_label_runs_below_every_threshold_and_records_the_takeover(self):
        self.assertTrue(UNSEEN.exists(), "the unseen fixture ships with the tests")
        regions = [{"unit": 1, "part": UNSEEN.name}]
        pages = [OcrPage(page=1, state="recognised", text="KAPPA 9", confidence=0.9,
                         raster={"dpi": 200}, engine="tesseract-5.5.3", language_code="eng")]
        casc = {"cascade": {
            "primary": {"engine": "paddleocr-vl-1.6"},
            "fallback": {"attempted": [1],
                         "reason": "the primary engine refused the page: loader refused"},
            "engines_used": ["paddleocr-vl-1.6", "tesseract-5.5.3"]}}
        with mock.patch.object(ocr_cascade, "run", return_value=(pages, casc)) as cascade:
            out = _inspect(UNSEEN, "image", regions, requested_language="eng")
        cascade.assert_called_once()
        rec = out["regions"][0]
        self.assertEqual(rec["region"], f"image:1:{UNSEEN.name}")
        self.assertTrue(rec["probe"]["text_structure"],
                        "pixels, not the name or a count, promoted this region")
        self.assertFalse(rec["probe"]["blank"])
        self.assertEqual(rec["state"], "recognised")
        self.assertEqual(rec["text"], "KAPPA 9")
        self.assertEqual(rec["engine"], "tesseract-5.5.3")
        self.assertEqual(rec["fallback_reason"], "the primary engine refused the page: loader refused")
        self.assertEqual(rec["invocations"],
                         {"probe": 1, "cascade": 2, "probe_recognitions": 0, "cascade_recognitions": 0})


if __name__ == "__main__":
    unittest.main(verbosity=2)
