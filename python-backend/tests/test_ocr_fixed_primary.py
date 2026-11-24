"""The B5 fixed-primary law for the OCR cascade (final decision 2026-11-22).

The release froze OCR to EXACTLY two named choices:
  * PaddleOCR (recommended, the default): the pinned pipeline, with the per-page
    automatic Tesseract fallback;
  * Tesseract only: the Paddle pipeline is NEVER probed and never loaded.

Laws pinned here:
  * selection resolves through the app-side chain settings.json > env: the user's
    Settings choice wins over RUKE_OCR_PRIMARY, and RUKE_OCR_PRIMARY is normalised
    to the SAME two choices — an arbitrary engine/repository pin (the removed
    model-manager surface) is reported and falls back to the fixed default;
  * Tesseract-only means ZERO Paddle probes: ocr_paddle.engine_state() must not be
    called by run(), status_report() or main() (proven by monkeypatching it to raise);
  * the readiness exit answers the SELECTED engine, and the persisted record
    self-describes the selected primary, not the release default.

Nothing here loads a real engine: the Paddle probes are patched to raise (zero-probe
proofs) or to fixed dicts, and the Tesseract runner is patched to fixed pages.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml.documents import ocr_cascade, ocr_paddle, ocr_tesseract
from ruke_ml.documents.ocr_tesseract import OcrPage

PRIMARY = ocr_cascade.PRIMARY
FALLBACK = ocr_cascade.FALLBACK


def _paddle_probe_forbidden(*_args, **_kwargs):
    raise AssertionError("ZERO Paddle probes: engine_state() must not be called for "
                         "a Tesseract-only selection")


class FixedPrimarySelection(unittest.TestCase):
    """policy(): the two fixed choices, resolved through settings.json > env."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ruke-ocr-fixed-"))
        self._saved_root = os.environ.get("RUKE_REPO_ROOT")
        self._saved_primary = os.environ.get("RUKE_OCR_PRIMARY")
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp)
        os.environ.pop("RUKE_OCR_PRIMARY", None)
        self.addCleanup(self._restore)

    def _restore(self):
        if self._saved_root is None:
            os.environ.pop("RUKE_REPO_ROOT", None)
        else:
            os.environ["RUKE_REPO_ROOT"] = self._saved_root
        if self._saved_primary is None:
            os.environ.pop("RUKE_OCR_PRIMARY", None)
        else:
            os.environ["RUKE_OCR_PRIMARY"] = self._saved_primary

    def _settings(self, payload) -> None:
        path = self.tmp / "settings.json"
        if isinstance(payload, str):  # raw file content, e.g. corrupt JSON
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload), encoding="utf-8")

    def test_unset_means_the_fixed_paddleocr_default(self):
        for payload in ({}, {"ocr_engine": ""}, {"ocr_engine": "paddle"}):
            self._settings(payload)
            pol = ocr_cascade.policy()
            self.assertEqual(pol["primary"], PRIMARY, f"{payload} is the PaddleOCR default")
            self.assertEqual(pol["ocr_selection"], "paddle")
        self.assertEqual(ocr_cascade.policy()["fixed_choices"], [PRIMARY, FALLBACK])
        self.assertIn("FIXED", ocr_cascade.policy()["fixed_primary_law"])

    def test_settings_tesseract_selects_tesseract_only(self):
        self._settings({"ocr_engine": "tesseract"})
        pol = ocr_cascade.policy()
        self.assertEqual(pol["primary"], FALLBACK)
        self.assertEqual(pol["ocr_selection"], "tesseract")
        self.assertIn("settings.json", pol["selection_source"])

    def test_the_settings_choice_wins_over_the_env_override(self):
        # The app-side chain is settings.json > env; the cascade must not invert it.
        self._settings({"ocr_engine": "tesseract"})
        os.environ["RUKE_OCR_PRIMARY"] = "paddle"
        self.assertEqual(ocr_cascade.policy()["ocr_selection"], "tesseract")
        self.assertIn("settings.json", ocr_cascade.policy()["selection_source"])

    def test_env_override_is_normalised_to_the_two_fixed_choices(self):
        self._settings({})
        for raw in ("", "paddle", "paddleocr", "paddleocr-vl", PRIMARY):
            os.environ["RUKE_OCR_PRIMARY"] = raw
            self.assertEqual(ocr_cascade.policy()["primary"], PRIMARY, f"{raw!r} is the paddle choice")
        os.environ["RUKE_OCR_PRIMARY"] = "tesseract"
        self.assertEqual(ocr_cascade.policy()["primary"], FALLBACK)
        self.assertEqual(ocr_cascade.policy()["ocr_selection"], "tesseract")

    def test_an_arbitrary_engine_pin_is_reported_and_not_honoured(self):
        # The removed model-manager surface allowed a repo pin; one smuggled in via env
        # must be VISIBLE in the evidence and must not select an arbitrary engine.
        self._settings({})
        os.environ["RUKE_OCR_PRIMARY"] = "SomeOrg/some-ocr-repo"
        pol = ocr_cascade.policy()
        self.assertEqual(pol["primary"], PRIMARY, "the release default applies")
        self.assertIn("not a fixed engine choice", pol["selection_source"])
        self.assertIn("someorg/some-ocr-repo", pol["selection_source"])

    def test_a_junk_settings_value_falls_back_to_the_default_and_says_so(self):
        self._settings({"ocr_engine": "Systran/faster-whisper-base"})
        pol = ocr_cascade.policy()
        self.assertEqual(pol["primary"], PRIMARY)
        self.assertIn("not a named engine", pol["selection_source"])

    def test_a_corrupt_settings_file_is_unset_not_an_error(self):
        self._settings("{ not json")
        pol = ocr_cascade.policy()
        self.assertEqual(pol["primary"], PRIMARY, "an OCR job must not die on a corrupt settings file")

    def test_gpu_placement_is_preferred_by_default_and_never_borrows_the_llm_device(self):
        # B5 final decision (2026-11-22): "GPU preferred for Paddle+Parakeet". The default
        # changed from False (the pinned wheel was the CPU build) to True (the pinned wheel is
        # the CUDA 12.6 build). This is only the GATE that lets GPU placement be CONSIDERED:
        # devices.device_plan still places on CPU whenever measured free VRAM does not fit,
        # so a default of True can never borrow the resident main model's device.
        self._settings({})
        with mock.patch.dict(os.environ, {"RUKE_OCR_ALLOW_GPU": ""}, clear=False):
            pol = ocr_cascade.policy()
        self.assertTrue(pol["allow_gpu"], "the default is GPU-preferred placement")
        self.assertIn("preferred", pol["allow_gpu_default_reason"].lower())
        self.assertIn("measured", pol["allow_gpu_default_reason"].lower())
        self.assertIn("never enabled by borrowing", pol["allow_gpu_default_reason"])
        with mock.patch.dict(os.environ, {"RUKE_OCR_ALLOW_GPU": "0"}, clear=False):
            self.assertFalse(ocr_cascade.policy()["allow_gpu"],
                             "the operator can still close the GPU gate")


class TesseractOnlyZeroPaddleProbes(unittest.TestCase):
    """Tesseract-only selects recovery as the engine and touches Paddle ZERO times."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ruke-ocr-tess-"))
        (self.tmp / "settings.json").write_text(json.dumps({"ocr_engine": "tesseract"}),
                                                encoding="utf-8")
        self.pdf = self.tmp / "doc.pdf"
        self.pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
        env = {"RUKE_REPO_ROOT": str(self.tmp),
               "RUKE_OCR_RESULT_DIR": str(self.tmp / "results"),
               "RUKE_OCR_RESUME": "", "RUKE_OCR_INJECT_FAILURE_PAGE": "", "RUKE_OCR_FAULT": "",
               "RUKE_OCR_PRIMARY": ""}
        patcher = mock.patch.dict(os.environ, env, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _fake_tesseract(self, pdf_path, pages, **_kwargs):
        return [OcrPage(page=int(p), state="recognised", text=f"page {p} text",
                        detail="fake", engine=FALLBACK, language_code="eng") for p in pages]

    def test_run_reads_every_unit_by_tesseract_with_zero_paddle_calls(self):
        with mock.patch.object(ocr_paddle, "engine_state", _paddle_probe_forbidden), \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", _paddle_probe_forbidden), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", self._fake_tesseract):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2, 3], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual([p.page for p in pages], [1, 2, 3])
        self.assertEqual(casc["engines_used"], [FALLBACK])
        self.assertEqual(casc["units_read"], 3)
        self.assertEqual(casc["units_unresolved"], [])
        self.assertFalse(casc["primary"]["probed"], "the Paddle block must report NOT probed")
        self.assertFalse(casc["primary"]["ready"])
        self.assertIn("Tesseract-only", casc["selection_note"])
        # The reason says the user CHOSE this engine, not that the pipeline was unavailable.
        self.assertIn("the user chose Tesseract only", casc["fallback"]["reason"])
        self.assertNotIn("primary pipeline unavailable", casc["fallback"]["reason"])
        self.assertEqual(casc["policy"]["ocr_selection"], "tesseract")

    def test_the_persisted_record_self_describes_the_selected_primary(self):
        with mock.patch.object(ocr_paddle, "engine_state", _paddle_probe_forbidden), \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", _paddle_probe_forbidden), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", self._fake_tesseract):
            ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        records = list((self.tmp / "results").glob("*.json"))
        self.assertEqual(len(records), 1, "the cascade must durably write exactly one record")
        payload = json.loads(records[0].read_text(encoding="utf-8"))
        self.assertEqual(payload["pipeline"]["primary_engine"], FALLBACK,
                         "a Tesseract-only record must not self-describe Paddle as its primary")
        self.assertEqual(payload["pipeline"]["engines_used"], [FALLBACK])

    def test_status_report_and_exit_answer_the_selected_engine(self):
        ready = {"status": "available", "detail": "fake", "languages": ["eng"],
                 "languages_source": "fake", "quality": "fake", "human_step": ""}
        gone = dict(ready, status="not_installed")
        quiet = contextlib.redirect_stdout(io.StringIO())
        with mock.patch.object(ocr_paddle, "engine_state", _paddle_probe_forbidden), \
                mock.patch.object(ocr_tesseract, "ocr_status", lambda: ready), \
                mock.patch.object(ocr_tesseract, "rasterizer_state", lambda: {"ok": True}):
            report = ocr_cascade.status_report()
            self.assertFalse(report["primary"]["probed"])
            self.assertFalse(report["primary_engine"].get("ready"))
            with quiet:
                self.assertEqual(ocr_cascade.main([]), 0,
                                 "Tesseract IS the selected engine: its availability is the answer")
        with mock.patch.object(ocr_paddle, "engine_state", _paddle_probe_forbidden), \
                mock.patch.object(ocr_tesseract, "ocr_status", lambda: gone), \
                mock.patch.object(ocr_tesseract, "rasterizer_state", lambda: {"ok": True}):
            with quiet:
                self.assertEqual(ocr_cascade.main([]), 1, "Tesseract missing must fail the exit")


class PaddleDefaultStillProbes(unittest.TestCase):
    """The default selection keeps the measured Paddle readiness it always had."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ruke-ocr-paddle-"))
        (self.tmp / "settings.json").write_text(json.dumps({}), encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"RUKE_REPO_ROOT": str(self.tmp),
                                               "RUKE_OCR_PRIMARY": ""}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.probe = {"engine": PRIMARY, "ready": True, "blockers": [], "runtime": {},
                      "recognition_asset": {}, "layout_asset": {},
                      "est_peak_mib": 1, "est_peak_basis": "test",
                      "est_peak_vram_mib": 0, "est_vram_basis": "test"}

    def test_status_report_probes_paddle_and_main_exits_on_its_readiness(self):
        tess = {"status": "available", "detail": "fake", "languages": ["eng"],
                "languages_source": "fake", "quality": "fake", "human_step": ""}
        with mock.patch.object(ocr_paddle, "engine_state", return_value=dict(self.probe)) as probe, \
                mock.patch.object(ocr_tesseract, "ocr_status", lambda: dict(tess)), \
                mock.patch.object(ocr_tesseract, "rasterizer_state", lambda: {"ok": True}):
            report = ocr_cascade.status_report()
            self.assertTrue(probe.called, "the default selection keeps the measured probe")
            self.assertTrue(report["primary"]["ready"])
            self.assertNotIn("probed", report["primary"])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ocr_cascade.main([]), 0)
        with mock.patch.object(ocr_paddle, "engine_state",
                               return_value=dict(self.probe, ready=False, blockers=["no snapshot"])), \
                mock.patch.object(ocr_tesseract, "ocr_status", lambda: dict(tess)), \
                mock.patch.object(ocr_tesseract, "rasterizer_state", lambda: {"ok": True}):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ocr_cascade.main([]), 1,
                                 "under the default, recovery being available is NOT a pass")


if __name__ == "__main__":
    unittest.main()
