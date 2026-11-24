"""F122 (user brief 2026-11-23): the OCR setting must be HONOURED, per job.

Laws pinned here, all with mocked engines (zero real engine work):
  * a Paddle-selected job whose exclusive window is BUSY (coordination_held) stays
    waiting/retryable: the units stay unread and the Tesseract fallback is NOT run.
    A busy lease is not a reason to switch engines, and this is exactly the hole
    through which a Paddle-selected scan answered all its pages by Tesseract;
  * Tesseract-only produces ZERO Strata unloads for that job (no window is requested);
  * Paddle-selected runs the Paddle engine first (here: the CPU placement), and
    Tesseract recovers ONLY the pages Paddle genuinely failed, with the producing
    engine + reason recorded per page INTO the persisted record;
  * the persisted cache is attributable to the OCR selection that produced it: a
    cached Tesseract result cannot certify a Paddle-selected job (and the reverse),
    across a setting change on identical bytes.

Nothing here loads a real engine: the adapters are patched to fake pages, and the
fallback/primary paths that must NOT run are patched to raise AssertionError.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml import handoff
from ruke_ml.documents import ocr_cascade, ocr_paddle, ocr_tesseract
from ruke_ml.documents.ocr_tesseract import OcrPage
from ruke_ml.models import devices, main_model
from ruke_ml.workers import document_jobs

PRIMARY = ocr_cascade.PRIMARY          # "paddleocr-vl-1.6" (pinned pipeline id)
FALLBACK = ocr_cascade.FALLBACK        # "tesseract"


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f122-ocr-"))
        self.pdf = self.tmp / "doc.pdf"
        self.pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
        env = {"RUKE_REPO_ROOT": str(self.tmp),
               "RUKE_OCR_RESULT_DIR": str(self.tmp / "results"),
               "RUKE_OCR_PRIMARY": "", "RUKE_OCR_ALLOW_GPU": "", "RUKE_OCR_ALLOW_UNLOAD": "",
               "RUKE_OCR_RESUME": "", "RUKE_OCR_INJECT_FAILURE_PAGE": "", "RUKE_OCR_FAULT": ""}
        patcher = mock.patch.dict(os.environ, env, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _settings(self, payload) -> None:
        (self.tmp / "settings.json").write_text(json.dumps(payload), encoding="utf-8")

    def _state(self, ready: bool, blockers=()):
        return {"engine": ocr_paddle.ENGINE, "ready": ready, "blockers": list(blockers),
                "runtime": {"found": ready}, "assets": [],
                "estimate": {"est_peak_mib": 3300, "est_peak_basis": "measured",
                             "est_peak_vram_mib": 0, "est_vram_basis": "unmeasured"}}

    def _estimate(self):
        return mock.patch.object(
            ocr_paddle, "estimate",
            return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                          "est_peak_vram_mib": 0, "est_vram_basis": "u"})

    def _planner(self, fits: bool, device="cpu"):
        plan = devices.DevicePlan("documents.ocr", device if fits else "none", fits, not fits,
                                  "stub plan", {})
        return (mock.patch.object(devices, "device_plan", return_value=plan),
                mock.patch.object(main_model, "snapshot",
                                  return_value={"loaded": True, "provider": "strata",
                                                "endpoint": "http://127.0.0.1:9"}))

    def _primary_forbidden(self):
        return mock.patch.object(ocr_paddle, "ocr_pdf_pages",
                                 side_effect=AssertionError("the Paddle engine must not run here"))

    def _fallback_forbidden(self):
        return mock.patch.object(ocr_tesseract, "ocr_pdf_pages",
                                 side_effect=AssertionError(
                                     "F122: the Tesseract fallback must not run — this job is "
                                     "waiting for the window, not switching engines"))


class BusyLeaseStaysWaiting(_Base):
    """coordination_held = waiting/retryable. The fallback engine must NOT run."""

    def setUp(self):
        super().setUp()
        self._settings({})  # the PaddleOCR default

    def test_busy_lease_leaves_units_waiting_with_no_engine_substitution(self):
        p1, p2 = self._planner(False)
        refused = {"ok": False, "reason": "coordination_held",
                   "detail": "handoff lease is held by owner=playwright"}
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                self._estimate(), p1, p2, \
                mock.patch.object(handoff, "run_exclusive", return_value=refused), \
                self._primary_forbidden(), self._fallback_forbidden():
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2, 3], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(casc["handoff"]["reason"], "coordination_held")
        self.assertTrue(casc["waiting"]["retryable"],
                        "the job must be reported retryable, not failed-with-fallback")
        self.assertEqual(casc["engines_used"], [], "NO engine may be recorded as having read pages")
        self.assertNotIn("attempted", casc.get("fallback", {}),
                         "a busy lease must not send any unit to Tesseract recovery")
        self.assertEqual([p.state for p in pages], ["skipped"] * 3)
        self.assertIn("waiting for the exclusive window", pages[0].detail)
        self.assertIn("coordination_held", casc["primary"]["run_refused"])

    def test_worker_maps_the_waiting_state_to_retryable_resource_busy(self):
        """The OCR capability's wire answer for a busy window is resource_busy + retryable,
        the same mapping the ASR dispatcher uses — never a fallback answer."""
        ctx = mock.Mock()
        ctx.req.payload = {"pages": [1]}
        ctx.cancel.is_set.return_value = False
        ctx.deadline_at.return_value = 0.0
        skipped = OcrPage(page=1, state="skipped", engine="none", language_code="eng",
                          detail="the job is waiting for the exclusive window")
        report = {"cascade": {"waiting": {"reason": "coordination_held",
                                          "detail": "held by playwright", "retryable": True},
                              "engines_used": [], "operation": {}}}
        with mock.patch.object(document_jobs, "_resolve", return_value=self.pdf), \
                mock.patch.object(document_jobs, "_ocr_language", return_value=("eng", "test")), \
                mock.patch.object(ocr_cascade, "run", return_value=([skipped], report)), \
                mock.patch.object(ocr_tesseract, "engine_state", return_value={"version": "stub"}):
            document_jobs.ocr_job(ctx)
        self.assertFalse(ctx.ready.called, "a waiting job must not be reported ready")
        args, kwargs = ctx.failed.call_args
        self.assertEqual(args[0], "resource_busy")
        self.assertTrue(kwargs["retryable"])


class TesseractOnlyZeroUnloads(_Base):
    """Tesseract-only: no Paddle probe, no Paddle run, and NO exclusive window for the job."""

    def setUp(self):
        super().setUp()
        self._settings({"ocr_engine": "tesseract"})

    def test_tesseract_only_requests_zero_unloads_and_zero_paddle(self):
        def _tess(pdf, units, **k):
            return [OcrPage(page=int(u), state="recognised", text=f"page {u}",
                            detail="fake", engine=FALLBACK, language_code="eng") for u in units]
        with mock.patch.object(ocr_paddle, "engine_state",
                               side_effect=AssertionError("ZERO Paddle probes")), \
                mock.patch.object(handoff, "run_exclusive",
                                  side_effect=AssertionError("a Tesseract-only job must never "
                                                             "unload the main model")), \
                self._primary_forbidden(), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=_tess):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual([p.engine for p in pages], [FALLBACK, FALLBACK])
        self.assertEqual(casc["engines_used"], [FALLBACK])
        self.assertEqual(casc["handoff"], {},
                         "no exclusive window may be requested (the report's handoff block "
                         "stays empty; the forbidden run_exclusive stub is the proof)")
        self.assertIn("the user chose Tesseract only", casc["fallback"]["reason"])


class PaddleSelectedPageAttribution(_Base):
    """Paddle first; Tesseract recovers ONLY the pages Paddle genuinely failed, and the
    producing engine + reason survive into the PERSISTED record."""

    def setUp(self):
        super().setUp()
        self._settings({})

    def test_cpu_placement_and_per_page_engine_provenance_in_the_record(self):
        seen: dict = {}

        def _paddle(pdf, units, **k):
            seen.update(k)
            pages = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE),
                     OcrPage(page=2, state="ocr_failed", detail="boom", engine=ocr_paddle.ENGINE)]
            return ocr_paddle.PaddleRun(pages, {"peak_working_set_mib": 1000})

        def _tess(pdf, units, **k):
            return [OcrPage(page=int(u), state="recognised", text=f"recovered {u}",
                            detail="read ok", engine="tesseract-5.5.3", language_code="eng")
                    for u in units]
        p1, p2 = self._planner(True, device="cpu")
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                self._estimate(), p1, p2, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_paddle), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=_tess):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        self.assertEqual(seen.get("device"), "cpu",
                         "the CPU placement must reach the primary engine")
        casc = report["cascade"]
        self.assertEqual(casc["fallback"]["attempted"], [2], "only the FAILED page recovers")
        by = {p.page: p for p in pages}
        self.assertEqual(by[1].engine, ocr_paddle.ENGINE, "a Paddle page stays Paddle")
        self.assertEqual(by[2].engine, "tesseract-5.5.3")
        record_path = Path(casc["persisted"]["path"])
        record = json.loads(record_path.read_text(encoding="utf-8"))
        units = {u["page"]: u for u in record["units"]}
        self.assertEqual(units[1]["engine"], ocr_paddle.ENGINE)
        self.assertEqual(units[2]["engine"], "tesseract-5.5.3")
        self.assertIn("recovery after primary failure", units[2]["detail"])
        self.assertEqual(record["pipeline"]["primary_engine"], PRIMARY,
                         "the record self-describes the SELECTED primary, not the fallback")


class CacheIsAttributableToTheSelection(_Base):
    """A cached Tesseract result cannot certify a new Paddle job (and the reverse), on
    identical bytes, across a setting change."""

    def _tess_pages(self, pdf, units, **k):
        return [OcrPage(page=int(u), state="recognised", text=f"tess {u}",
                        detail="fake", engine=FALLBACK, language_code="eng") for u in units]

    def _paddle_pages(self, pdf, units, **k):
        return ocr_paddle.PaddleRun(
            [OcrPage(page=int(u), state="recognised", text=f"paddle {u}",
                     engine=ocr_paddle.ENGINE) for u in units],
            {"peak_working_set_mib": 1000})

    def test_tesseract_record_is_invisible_to_a_paddle_resume(self):
        self._settings({"ocr_engine": "tesseract"})
        with mock.patch.object(ocr_paddle, "engine_state",
                               side_effect=AssertionError("ZERO Paddle probes")), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=self._tess_pages):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        tess_record = Path(report["cascade"]["persisted"]["path"])
        self.assertTrue(tess_record.is_file())

        # Same bytes, same request, setting changed to Paddle; resume may NOT reuse the
        # Tesseract evidence — the Paddle adapter must really run.
        self._settings({})
        ran: list[int] = []

        def _paddle(*a, **k):
            ran.append(1)
            return self._paddle_pages(*a, **k)

        p1, p2 = self._planner(True, device="cpu")
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                self._estimate(), p1, p2, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_paddle), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages",
                                  side_effect=AssertionError("Paddle-read units must not re-OCR")):
            pages, report2 = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200,
                                             resume=True)
        self.assertEqual(ran, [1], "the Paddle job must EXECUTE Paddle; cached Tesseract "
                                   "evidence cannot certify it")
        casc2 = report2["cascade"]
        self.assertNotIn("resumed_from", casc2)
        self.assertIn("resume_rejected", casc2)
        self.assertEqual(pages[0].engine, ocr_paddle.ENGINE)
        self.assertNotEqual(casc2["persisted"]["path"], str(tess_record),
                            "the two selections persist under separate keys")

    def test_stored_selection_mismatch_is_rejected_as_not_attributable(self):
        """Defense in depth: a record whose key matches but whose stored pipeline says a
        different selection is refused with an explicit not-attributable reason."""
        self._settings({})
        p1, p2 = self._planner(True, device="cpu")
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                self._estimate(), p1, p2, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=self._paddle_pages), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages",
                                  side_effect=AssertionError("nothing to recover")):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        record_path = Path(report["cascade"]["persisted"]["path"])
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["pipeline"]["policy"]["ocr_selection"] = FALLBACK
        record_path.write_text(json.dumps(record), encoding="utf-8")
        read = ocr_cascade._read_result(str(self.pdf), [1], language="eng", dpi=200,
                                        rotations=None, ocr_selection="paddle")
        self.assertFalse(read["usable"])
        self.assertIn("NOT attributable", read["detail"])


if __name__ == "__main__":
    unittest.main()
