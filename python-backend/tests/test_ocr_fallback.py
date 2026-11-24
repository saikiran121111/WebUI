"""The OCR fallback contract, executed for real.

The contract under test is the one the operator's acceptance list demands:

  * a PRIMARY that cannot run at all must not fail the whole job. The worker is released first,
    then every unit the primary never read gets recovery;
  * a unit the primary DID read is never re-read by the fallback, so the primary's text is not
    silently replaced by a weaker engine's text;
  * a unit neither engine read stays in the result as an unresolved unit, never dropped and never
    reported as read;
  * a cancellation stops before any recovery starts;
  * an injected fault is labelled as injected wherever the report is read.

The recovery side is the REAL project-local Tesseract over a REAL fixture page. Nothing here loads
the 1.9 GB primary pipeline: `RUKE_OCR_FAULT=crash` makes the real worker process die on the first
page request without importing paddle, which is the cheapest way to exercise the actual
spawn -> handshake -> death -> release -> recovery sequence instead of a stand-in.
"""
from __future__ import annotations

import json
import os
import threading
import types
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml.documents import ocr_cascade, ocr_paddle, ocr_tesseract
from ruke_ml.documents.ocr_tesseract import OcrPage, OcrUnavailable

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "docs" / "overnight" / "fixtures" / "d1" / "pdfs"
SCANNED = FIXTURES / "d1_scanned.pdf"
ROTATED = FIXTURES / "d1_rotated_scan.pdf"
MIXED = FIXTURES / "d1_mixed.pdf"


def _tesseract_ready() -> bool:
    return bool(ocr_tesseract.engine_state().get("found"))


def _ready_state(fault: str = "") -> dict:
    return {"engine": ocr_cascade.PRIMARY, "ready": True, "blockers": [], "runtime": {},
            "assets": [], "estimate": {"est_peak_mib": 0, "est_peak_basis": "test",
                                       "est_peak_vram_mib": 0, "est_vram_basis": "test"},
            "fault": fault, "fault_note": ocr_paddle.fault_reason(fault)}


class FaultInjectionIsHonest(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(ocr_paddle.FAULT_ENV)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(ocr_paddle.FAULT_ENV, None)
        else:
            os.environ[ocr_paddle.FAULT_ENV] = self._saved

    def test_absent_or_unknown_mode_means_no_injection(self):
        for raw in (None, "", "  ", "maybe", "gpu"):
            if raw is None:
                os.environ.pop(ocr_paddle.FAULT_ENV, None)
            else:
                os.environ[ocr_paddle.FAULT_ENV] = raw
            self.assertEqual(ocr_paddle.fault_mode(), "", f"{raw!r} must not inject a fault")
            self.assertEqual(ocr_paddle.fault_reason(), "")

    def test_unavailable_clears_readiness_and_says_so(self):
        os.environ[ocr_paddle.FAULT_ENV] = "unavailable"
        self.assertEqual(ocr_paddle.fault_mode(), "unavailable")
        state = ocr_paddle.engine_state()
        self.assertFalse(state["ready"], "an injected unavailable must clear readiness")
        self.assertEqual(state["fault"], "unavailable")
        self.assertIn("fault-injected", state["fault_note"])
        self.assertTrue(any("fault-injected" in blocker for blocker in state["blockers"]),
                        f"the blocker list must name the injected fault: {state['blockers']}")

    def test_unavailable_refuses_a_direct_engine_run_as_a_typed_error(self):
        if not ocr_paddle.engine_state()["ready"]:
            self.skipTest("this host has no complete primary pipeline to poison")
        os.environ[ocr_paddle.FAULT_ENV] = "unavailable"
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages(str(SCANNED), [1], language="en")
        self.assertEqual(caught.exception.kind, "engine_unavailable")
        self.assertIn("fault-injected", str(caught.exception))

    def test_an_injected_crash_is_passed_to_the_real_child(self):
        os.environ[ocr_paddle.FAULT_ENV] = "crash"
        # Only the env construction is observed here; the process itself is exercised below.
        seen: dict = {}

        def fake_popen(argv, **kwargs):
            seen["argv"] = list(argv)
            seen["env"] = dict(kwargs.get("env") or {})
            raise OSError("stop here: the test only wants the child environment")

        with mock.patch.object(ocr_paddle.subprocess, "Popen", fake_popen):
            with self.assertRaises(OcrUnavailable) as caught:
                ocr_paddle.ocr_pdf_pages(str(SCANNED), [1], language="en")
        self.assertEqual(caught.exception.kind, "engine_spawn_failed")
        self.assertEqual(seen["env"].get(ocr_paddle.WORKER_FAULT_ENV), "crash")
        # And the fault must NOT reach the child when no fault was requested, otherwise a normal
        # upload would silently take the poisoned path.
        os.environ.pop(ocr_paddle.FAULT_ENV, None)
        seen.clear()
        seen2: dict = {}

        def fake_popen2(argv, **kwargs):
            seen2["env"] = dict(kwargs.get("env") or {})
            raise OSError("stop here: the test only wants the child environment")

        # The ceiling for this call is given explicitly and wide enough to hold the declared
        # demand, because this host's NORMAL ceiling legitimately refuses the spawn before the
        # child exists (the pinned CPU build loads float32 weights: measured 2026-11-18). The
        # demand is now charged from the row's measured COMMIT peak (10,327 MiB, 2026-11-23),
        # so "wide enough" means over that figure plus the 256 MiB margin. Without that, this
        # assertion would be about admission, not about the fault environment - and the
        # admission refusal has its own test in tests/test_ocr_resource_window.py.
        with mock.patch.object(ocr_paddle.subprocess, "Popen", fake_popen2):
            with self.assertRaises(OcrUnavailable) as second:
                ocr_paddle.ocr_pdf_pages(str(SCANNED), [1], language="en",
                                         per_worker_limit_bytes=12_000_000_000)
        self.assertEqual(second.exception.kind, "engine_spawn_failed",
                         "a ceiling that fits the declared demand must reach the spawn, not refuse it")
        self.assertIn("env", seen2, "the child environment was never observed")
        self.assertNotIn(ocr_paddle.WORKER_FAULT_ENV, seen2["env"])


class InjectedWorkerDeath(unittest.TestCase):
    """The real worker script, the real protocol, no weights."""

    def test_the_child_dies_on_the_first_page_without_loading_anything(self):
        env = {**os.environ, ocr_paddle.WORKER_FAULT_ENV: "crash",
               "PYTHONPATH": str(REPO / "python-backend")}
        os.environ.pop(ocr_paddle.FAULT_ENV, None)
        proc = subprocess.Popen([sys.executable, str(ocr_paddle.WORKER_FILE)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env,
                                cwd=str(REPO), bufsize=1, encoding="utf-8")
        try:
            assert proc.stdin and proc.stdout and proc.stderr
            proc.stdin.write(json.dumps({"header": {"device": "cpu",
                                                    "scratch_dir": str(REPO)}}) + "\n")
            proc.stdin.flush()
            ready = json.loads(proc.stdout.readline())
            self.assertEqual(ready.get("event"), "ready")
            self.assertEqual(ready.get("fault"), "crash")
            self.assertNotIn("text", ready, "a fault handshake must never carry a result")
            proc.stdin.write(json.dumps({"page": 1, "image": "does-not-matter.png",
                                         "language": "en"}) + "\n")
            proc.stdin.flush()
            rest = proc.stdout.read()
            self.assertEqual(rest.strip(), "", "the injected worker must emit no page result")
            proc.stdin.close()
            code = proc.wait(timeout=60)
            self.assertEqual(code, 9, f"the injected death must be a nonzero exit, got {code}")
            err = proc.stderr.read()
            self.assertIn("NOT loaded", err, "the child must say it never loaded the pipeline")
        finally:
            # Mirror what the production parent does on release: pipes close only after the
            # child is gone, and the handles must not outlive the test.
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=60)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe is not None:
                    pipe.close()

    def test_the_parent_marks_every_unread_page_failed_and_records_the_fault(self):
        if not ocr_paddle.engine_state()["ready"]:
            self.skipTest("this host has no validated isolated runtime + asset pair to spawn")
        os.environ[ocr_paddle.FAULT_ENV] = "crash"
        try:
            run = ocr_paddle.ocr_pdf_pages(str(SCANNED), [1, 2], language="en", device="cpu",
                                           per_page_timeout_s=30.0)
        finally:
            os.environ.pop(ocr_paddle.FAULT_ENV, None)
        self.assertEqual(run.stats.get("fault"), "crash")
        self.assertIn("fault-injected", run.stats.get("fault_note", ""))
        self.assertEqual([page.state for page in run.pages], ["ocr_failed", "ocr_failed"],
                         "a dead worker must leave every page failed, never silently empty")
        self.assertEqual(run.pages[0].engine, ocr_paddle.ENGINE)
        self.assertIn("died", run.pages[0].detail.lower())
        self.assertTrue(run.stats.get("worker_died_at_page"))
        self.assertNotIn("recognised", [page.state for page in run.pages])


@unittest.skipUnless(_tesseract_ready(), "no validated project-local Tesseract on this host")
@unittest.skipUnless(SCANNED.is_file(), "run docs/overnight/fixtures/d1/ocr_docs.py first")
class WholeRunFailureStillRecovers(unittest.TestCase):
    def test_a_primary_that_never_started_still_gets_real_recovery(self):
        def dying(*a, **k):
            raise OcrUnavailable("engine_spawn_failed", "simulated whole-run failure",
                                 "re-prepare the pinned runtime")

        with mock.patch.object(ocr_cascade, "_primary_state", lambda: _ready_state()), \
                mock.patch.object(ocr_paddle, "estimate", lambda: {
                    "est_peak_mib": 0, "est_peak_basis": "test", "est_peak_vram_mib": 0,
                    "est_vram_basis": "test", "model_id": "test"}), \
                mock.patch.object(ocr_cascade, "_paddle_run", dying):
            pages, report = ocr_cascade.run(str(SCANNED), [1], language="en", dpi=200)

        casc = report["cascade"]
        self.assertIn("engine_spawn_failed", str(casc["primary"].get("run_refused", "")),
                      "the whole-run failure must be recorded, not swallowed")
        self.assertTrue(casc["fallback"].get("ran"), "the units must still get recovery")
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0].state, "recognised", f"real Tesseract read: {pages[0].detail}")
        self.assertNotEqual(pages[0].engine, ocr_cascade.PRIMARY)
        self.assertIn("aquifer", pages[0].text.lower(),
                      "the recovered page must actually contain the fixture's own words")
        self.assertIn("simulated whole-run failure", casc["fallback"]["reason"])

    def test_a_primary_skipped_at_the_readiness_gate_still_reports_its_work(self):
        # The engine profile of a machine with NO primary runtime installed at all: the primary
        # attempt is skipped before any operation runs, recovery and the durable write happen in
        # the outer path, and the caller still reads the cascade's one operation account.
        # F73 measured bug: that path never set casc["operation"], so the handoff CLI reported
        # persisted_path "" and units_persisted 0 for a run whose recovered unit really WAS
        # persisted — the two lifecycles drifted on the exact profile they promise to report alike.
        if not _tesseract_ready():
            self.skipTest("project-local Tesseract is not installed here")
        state = _ready_state(fault="unavailable")
        state["ready"] = False
        state["blockers"] = ["the pinned primary runtime is not installed on this machine"]
        with tempfile.TemporaryDirectory() as out_dir, \
                mock.patch.object(ocr_cascade, "_primary_state", lambda: state), \
                mock.patch.dict(os.environ, {ocr_cascade.RESULT_DIR_ENV: out_dir}):
            pages, report = ocr_cascade.run(str(SCANNED), [1], language="en", dpi=200)
            persisted = report["cascade"].get("persisted") or {}
            record_path = str(persisted.get("path") or "")
            if record_path:
                with open(record_path, encoding="utf-8") as fh:
                    record = json.load(fh)
            else:
                record = {}

        casc = report["cascade"]
        self.assertTrue(casc["fallback"].get("ran"), "the unit must still get real recovery")
        self.assertEqual(pages[0].state, "recognised")
        info = casc["persisted"]
        self.assertTrue(info["ok"], info.get("detail"))
        op = casc.get("operation")
        self.assertIsNotNone(
            op, "the outer recovery+persist path must write the same operation account "
                "_operation writes; its absence makes the caller report a blank run")
        self.assertEqual(op["persisted_path"], info["path"])
        self.assertEqual(op["units_persisted"], 1)
        self.assertEqual(op["pages"], 1)
        self.assertEqual(op["recognised"], 1)
        self.assertEqual(op["unresolved"], [])
        self.assertEqual(op["device_used"], "cpu",
                         "the only engine that ran here is CPU-only Tesseract")

        # The record itself must not under-report what it stores. F73's frozen D1 scorer failed a
        # real Tesseract record (WER 0.000) because the cascade computed engines_used/units_read
        # AFTER _persist had already written the record, so every durable record declared
        # coverage.read 0 and engines_used [] while storing units recognised by a real engine.
        self.assertEqual(record["coverage"]["read"], 1,
                         "a durable record must declare the coverage its own units support")
        self.assertTrue(record["coverage"]["complete"])
        self.assertEqual(record["pipeline"]["engines_used"], [pages[0].engine],
                         "a durable record must name the engine that actually read its units")


class PerUnitRecovery(unittest.TestCase):
    def test_only_the_units_the_primary_missed_are_re_read(self):
        primary = [OcrPage(page=1, state="recognised", text="PRIMARY-TEXT page one",
                           engine=ocr_cascade.PRIMARY, language_code="en"),
                   OcrPage(page=2, state="ocr_failed", detail="region decode failed",
                           engine=ocr_cascade.PRIMARY, language_code="en")]
        asked: dict = {}

        def fake_paddle(*a, **k):
            return list(primary), {"peak_working_set_mib": 10, "peak_commit_mib": 12}

        def fake_tesseract(pdf_path, units, **k):
            asked["units"] = list(units)
            # Unit 3 is deliberately absent from the recovery result: a unit NEITHER engine
            # produced must stay visible as unresolved instead of vanishing from the report.
            return [OcrPage(page=int(u), state="recognised", text=f"RECOVERED page {u}",
                            engine="tesseract-5", language_code="en")
                    for u in units if int(u) != 3]

        with mock.patch.object(ocr_cascade, "_primary_state", lambda: _ready_state()), \
                mock.patch.object(ocr_paddle, "estimate", lambda: {
                    "est_peak_mib": 0, "est_peak_basis": "test", "est_peak_vram_mib": 0,
                    "est_vram_basis": "test", "model_id": "test"}), \
                mock.patch.object(ocr_cascade, "_paddle_run", fake_paddle), \
                mock.patch.object(ocr_cascade.ocr_tesseract, "ocr_pdf_pages", fake_tesseract):
            pages, report = ocr_cascade.run("in.pdf", [1, 2, 3], language="en", dpi=200)

        casc = report["cascade"]
        self.assertEqual(asked["units"], [2, 3],
                         f"page 1 was already read by the primary: {asked}")
        by_page = {page.page: page for page in pages}
        self.assertEqual(by_page[1].text, "PRIMARY-TEXT page one",
                         "the fallback must not overwrite a unit the primary already read")
        self.assertEqual(by_page[1].engine, ocr_cascade.PRIMARY)
        self.assertEqual(by_page[2].text, "RECOVERED page 2")
        self.assertIn("recovery after primary failure", by_page[2].detail)
        self.assertEqual(by_page[3].state, "skipped",
                         "a unit neither engine produced must stay visible, not vanish")
        self.assertEqual(casc["units_unresolved"], [3])
        self.assertEqual(sorted(casc["engines_used"]), sorted([ocr_cascade.PRIMARY, "tesseract-5"]))
        self.assertEqual(casc["units_read"], 2)

    def test_when_both_engines_fail_the_unit_stays_unresolved(self):
        def dying_paddle(*a, **k):
            return [OcrPage(page=1, state="ocr_failed", detail="region decode failed",
                            engine=ocr_cascade.PRIMARY)], {"peak_working_set_mib": 3}

        def dying_tesseract(pdf_path, units, **k):
            raise OcrUnavailable("engine_missing", "no validated tesseract copy",
                                 "install the engine")

        with mock.patch.object(ocr_cascade, "_primary_state", lambda: _ready_state()), \
                mock.patch.object(ocr_paddle, "estimate", lambda: {
                    "est_peak_mib": 0, "est_peak_basis": "test", "est_peak_vram_mib": 0,
                    "est_vram_basis": "test", "model_id": "test"}), \
                mock.patch.object(ocr_cascade, "_paddle_run", dying_paddle), \
                mock.patch.object(ocr_cascade.ocr_tesseract, "ocr_pdf_pages", dying_tesseract):
            pages, report = ocr_cascade.run("in.pdf", [1], language="en", dpi=200)

        casc = report["cascade"]
        self.assertEqual(casc["fallback"]["failed"]["kind"], "engine_missing")
        self.assertEqual([page.state for page in pages], ["ocr_failed"])
        self.assertEqual(casc["units_unresolved"], [1])
        self.assertEqual(casc["units_read"], 0)
        # What this actually guards: nothing may CLAIM a unit was read. It used to be a substring
        # scan of the whole report, which broke the moment the report grew honest counters named
        # "recognised" - a counter of 0 is not a claim of success, and hiding the counter would
        # have been the wrong way to keep the old assertion green.
        self.assertNotIn("recognised", [page.state for page in pages])
        self.assertEqual(casc["operation"]["recognised"], 0)
        self.assertEqual(casc["operation"]["units_persisted"], 0)
        # The source here is a name, not a file, so persistence must FAIL LOUDLY rather than
        # quietly "succeed" with nothing saved.
        self.assertFalse(casc["persisted"]["ok"])
        self.assertIn("identity", casc["persisted"]["detail"])

    def test_a_cancelled_job_starts_no_recovery(self):
        called: list = []

        def fake_paddle(*a, **k):
            return [OcrPage(page=1, state="skipped", detail="cancelled before this page",
                            engine="none")], {}

        def fake_tesseract(pdf_path, units, **k):
            called.append(list(units))
            return []

        with mock.patch.object(ocr_cascade, "_primary_state", lambda: _ready_state()), \
                mock.patch.object(ocr_paddle, "estimate", lambda: {
                    "est_peak_mib": 0, "est_peak_basis": "test", "est_peak_vram_mib": 0,
                    "est_vram_basis": "test", "model_id": "test"}), \
                mock.patch.object(ocr_cascade, "_paddle_run", fake_paddle), \
                mock.patch.object(ocr_cascade.ocr_tesseract, "ocr_pdf_pages", fake_tesseract):
            pages, report = ocr_cascade.run("in.pdf", [1, 2], language="en", dpi=200,
                                            cancel=lambda: True)
        self.assertEqual(called, [], "cancellation must not trigger an engine change")
        self.assertIn("skipped", report["cascade"]["fallback"])
        self.assertEqual([page.state for page in pages], ["skipped", "skipped"])

    def test_an_injected_fault_is_named_in_the_fallback_reason(self):
        def dying_paddle(*a, **k):
            return [OcrPage(page=1, state="ocr_failed", detail="the worker died",
                            engine=ocr_cascade.PRIMARY)], {"fault": "crash"}

        def fake_tesseract(pdf_path, units, **k):
            return [OcrPage(page=int(u), state="recognised", text="recovered",
                            engine="tesseract-5") for u in units]

        with mock.patch.object(ocr_cascade, "_primary_state", lambda: _ready_state("crash")), \
                mock.patch.object(ocr_paddle, "estimate", lambda: {
                    "est_peak_mib": 0, "est_peak_basis": "test", "est_peak_vram_mib": 0,
                    "est_vram_basis": "test", "model_id": "test"}), \
                mock.patch.object(ocr_cascade, "_paddle_run", dying_paddle), \
                mock.patch.object(ocr_cascade.ocr_tesseract, "ocr_pdf_pages", fake_tesseract):
            pages, report = ocr_cascade.run("in.pdf", [1], language="en", dpi=200)

        casc = report["cascade"]
        self.assertEqual(casc["primary"]["fault"], "crash")
        self.assertIn("fault-injected by RUKE_OCR_FAULT=crash", casc["fallback"]["reason"])
        self.assertEqual(pages[0].engine, "tesseract-5")


class MeasurementHonesty(unittest.TestCase):
    """Amendment 7 defect 6: an unmeasured quantity is reported as unknown, never as 0.

    Both halves of the defect are pinned here. The first is a PEAK of 0 reading as "this
    engine used nothing" when the sampler never got a usable sample. The second is a DECLARED
    number being labelled "measured" because it was non-zero, which is how a provisional
    weight-byte bound ends up quoted as a measured fact in a report.
    """

    def test_a_child_that_was_never_sampled_reports_unknown_peaks(self):
        stop = threading.Event()
        stop.set()                       # the loop must not even sample once
        out: dict = {}
        ocr_paddle._monitor(0x7FFFFF00, stop, out)
        self.assertEqual(out["samples_available"], 0, out)
        self.assertIsNone(out["peak_working_set_mib"], out)
        self.assertIsNone(out["peak_commit_mib"], out)

    def test_a_declared_peak_with_no_measurement_is_never_labelled_measured(self):
        row = types.SimpleNamespace(
            id="PaddleOCR-VL-1.6", capability="documents.ocr", provider="paddle",
            est_peak_mib=3300, est_peak_basis="", est_peak_vram_mib=6000,
            est_vram_basis="provisional: weights plus activations")
        with mock.patch.object(ocr_paddle.registry, "catalog",
                               lambda: types.SimpleNamespace(all_specs=lambda: [row])):
            est = ocr_paddle.estimate()
        self.assertEqual(est["estimate_kind"], "provisional", est)
        self.assertEqual(est["est_vram_kind"], "provisional", est)
        for key in ("est_peak_basis", "est_vram_basis"):
            self.assertNotEqual(est[key], "measured", est)
        # The RAM row declared a number and named no provenance at all, so the basis has to say
        # that out loud instead of defaulting to the word "measured".
        self.assertIn("no recorded measurement", est["est_peak_basis"], est)
        self.assertEqual(est["est_vram_basis"], "provisional: weights plus activations", est)
        measured_row = types.SimpleNamespace(**{**vars(row), "est_peak_basis":
                                               "measured: cold-load peak 3300 MiB"})
        with mock.patch.object(ocr_paddle.registry, "catalog",
                               lambda: types.SimpleNamespace(all_specs=lambda: [measured_row])):
            self.assertEqual(ocr_paddle.estimate()["estimate_kind"], "measured")

    def test_the_cascade_never_repairs_an_unknown_peak_into_zero(self):
        """The adapter said "unknown" while plenty of samples were taken. The cascade used to
        turn that into `int(None or 0)` and publish a 0 MiB peak as if it were a measurement.
        """
        stats = {"peak_working_set_mib": None, "peak_commit_mib": None,
                 "samples": 12, "samples_available": 12, "device_used": "cpu"}
        child = ocr_cascade._engine_child_peak(stats)
        self.assertEqual(child["samples"], 12, child)
        self.assertIsNone(child["working_set_mib"], child)
        self.assertIsNone(child["commit_mib"], child)
        self.assertFalse(child["measured"], child)
        self.assertIn("UNKNOWN", child.get("note", ""), child)
        self.assertFalse(ocr_cascade._engine_child_peak({})["measured"])


@unittest.skipUnless(_tesseract_ready(), "no validated project-local Tesseract on this host")
@unittest.skipUnless(ROTATED.is_file(), "run docs/overnight/fixtures/d1/ocr_docs.py first")
class DeclaredRotationIsAppliedOnce(unittest.TestCase):
    """F73 production delivered a /Rotate 90 page as upside-down garbage (frozen key d1-ocr-1).

    pdf.py records the declared /Rotate, the escalation forwards it as `rotations`, and
    render_page_png passed it straight to pypdfium2 - which has ALREADY applied the page's own
    /Rotate and treats its parameter as ADDITIONAL ("Additional rotation in degrees",
    pypdfium2 5.6.0 render docstring). 90 + 90 = 180: the engine saw a flipped page. The
    standalone ocr_job CLI passed no rotations at all, which is why the CLI run read the page
    correctly while production mangled it. The contract callers actually mean: `rotation=N`
    renders the page at N degrees as the page's VISIBLE orientation, exactly once.
    """

    def test_the_requested_orientation_is_not_applied_twice(self):
        _, default_info = ocr_tesseract.render_page_png(str(ROTATED), 1, dpi=200)
        _, declared_info = ocr_tesseract.render_page_png(str(ROTATED), 1, dpi=200, rotation=90)
        self.assertEqual(
            (declared_info["width"], declared_info["height"]),
            (default_info["width"], default_info["height"]),
            "a caller asking for the page's own declared /Rotate must get the raster pdfium "
            "produces on its own, not that raster turned a second time")
        self.assertEqual(declared_info["rotation"], 90,
                         "the delivery must still state the orientation it rendered FOR")

    def test_the_declared_rotation_still_lets_the_engine_read_the_page(self):
        pages = ocr_tesseract.ocr_pdf_pages(str(ROTATED), [1], language="eng", dpi=200,
                                            rotations={1: 90})
        self.assertEqual(pages[0].state, "recognised", pages[0].detail)
        words = " ".join((pages[0].text or "").split())
        self.assertIn("measured across eleven observation wells", words,
                      f"the frozen fixture sentence must survive the declared rotation; "
                      f"got: {words[:200]}")


@unittest.skipUnless(_tesseract_ready(), "no validated project-local Tesseract on this host")
@unittest.skipUnless(MIXED.is_file(), "run docs/overnight/fixtures/d1/ocr_docs.py first")
class MixedPageOneRasterLineIsNotOverprinted(unittest.TestCase):
    """F74 production: the frozen key demands OCR deliver "Section 4.2 Ground Water" from
    d1_mixed page 1, but the fixture drew its text-layer heading (text_stream default top=760)
    on the SAME baseline where the raster's first line prints. The render composites both, so
    the page carried one fused double-ink stroke there: every honest engine returns garbage at
    the overlap and drops the line (f74a content pass, f73-engine-d1_mixed.json - identical
    garble before and after the delivery fixes, proving the block is at the ink, not at merge).
    The generator must not print a second ink over raster lines the key requires recognition
    to deliver. Fixture geometry repaired (heading moved to the blank foot band); the answer
    key stayed byte-identical.
    """

    def test_forced_ocr_of_the_mixed_page_reads_the_raster_first_line(self):
        pages = ocr_tesseract.ocr_pdf_pages(str(MIXED), [1], language="eng", dpi=200)
        self.assertEqual(pages[0].state, "recognised", pages[0].detail)
        words = " ".join((pages[0].text or "").split())
        self.assertIn("Section 4.2 Ground Water", words,
                      f"the frozen fixture line must be physically readable on the rendered "
                      f"page; got: {words[:300]}")


class UndeclaredLanguageIsATypedRefusal(unittest.TestCase):
    """F74 measured: the D1 no-language case had NO job-boundary test at all.

    The frozen key demands that an undeclared language never becomes a silent English
    default. F78 extended the law's second route: the engine may ANSWER for an undeclared
    scan, validated - its own OSD script estimate, mapped, then required to pass a
    verification OCR at measured bounds - and only then does the cascade run, with
    language_source saying "detected". An unverified detection keeps this F74 refusal
    byte-recognizable: typed, actionable, engine never runs. Pinned at the real job
    boundary (documents.parse dispatch, real D1 fixtures):
    no language anywhere + detection unverified -> typed needs_language refusal, engine
    never runs; no language + detection verified -> the detected language drives
    recognition and is named as detected; a /Lang-declared scan with no requested
    language -> the declaration is used and named as such.

    Safety: an in-process documents.parse dispatch with no safety switches runs the REAL
    lifecycle - an unguarded repro acquired the handoff lease and unloaded/restored the main
    model on its own. A test must never touch the endpoint serving the coding session, so
    both switches (RUKE_OCR_ALLOW_UNLOAD=0, RUKE_LLM_AUTOMATIC_HANDOFF=0, the same ones the
    acceptance runner pins into every production boot) are forced on for the duration.
    """

    NOLANG = FIXTURES / "d1_scan_nolang.pdf"

    def setUp(self):
        from ruke_ml.models.registry import catalog
        if not catalog().executable_for("documents.ocr"):
            self.skipTest("documents.ocr not executable in this environment")
        # The tree's own per-run OCR result store must not leak into this test's evidence.
        self._saved_result_dir = os.environ.get("RUKE_OCR_RESULT_DIR")
        self._tmp = tempfile.TemporaryDirectory(prefix="ruke-nolang-")
        os.environ["RUKE_OCR_RESULT_DIR"] = self._tmp.name
        # Force the endpoint OFF-LIMITS (an empty value is falsy for the switches, "0" is too).
        self._saved_switches = {}
        for var in ("RUKE_OCR_ALLOW_UNLOAD", "RUKE_LLM_AUTOMATIC_HANDOFF"):
            self._saved_switches[var] = os.environ.get(var)
            os.environ[var] = "0"

    def tearDown(self):
        if self._saved_result_dir is None:
            os.environ.pop("RUKE_OCR_RESULT_DIR", None)
        else:
            os.environ["RUKE_OCR_RESULT_DIR"] = self._saved_result_dir
        for var, value in self._saved_switches.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
        self._tmp.cleanup()

    def _dispatch(self, name: str) -> dict:
        from ruke_ml.contracts import JobRequest
        from ruke_ml.workers import runner
        req = JobRequest("r1", "run-nolang-pin", "j-" + name, "documents.parse",
                         {"path": str(FIXTURES / name), "root": str(FIXTURES)})
        res = runner.dispatch(req)
        self.assertEqual(res.state, "ready", f"job state: {res.to_dict()}")
        return res.to_dict()

    @unittest.skipUnless(NOLANG.is_file(),
                         "run docs/overnight/fixtures/d1/ocr_docs.py first")
    def test_undeclared_language_with_unverified_detection_refuses_typed(self):
        # F74's refusal, kept exact when F78's validated detection does NOT verify:
        # typed, engine never runs, reason names both the law and the detection failure.
        with mock.patch("ruke_ml.documents.ocr_tesseract.detect_language", return_value={
                "verified": False, "script": "latin",
                "reason": "verification did not reach the quality bounds (glyphs 5/80)"}):
            out = self._dispatch("d1_scan_nolang.pdf")
        rep = out["payload"]["ocr"]
        self.assertFalse(rep["ran"], "OCR must not run at all without a verified language")
        self.assertTrue(rep.get("needs_language"), "the refusal must be typed, not prose")
        self.assertEqual(rep["language"], "", "no language may be invented")
        self.assertEqual(rep["language_source"], "")
        self.assertIn("never defaulted to English", rep["reason"])
        self.assertIn("verification did not reach the quality bounds", rep["reason"],
                      "the detection failure reason belongs in the coverage note")
        self.assertIn("OCR NOT run", json.dumps(out),
                      "the coverage note must carry the refusal, not hide it")

    @unittest.skipUnless(NOLANG.is_file() and _tesseract_ready(),
                         "run docs/overnight/fixtures/d1/ocr_docs.py first; needs validated tesseract")
    def test_undeclared_scan_is_answered_on_the_detected_language(self):
        # d1_scan_nolang is a genuine Latin-script English scan: the real engine's OSD +
        # verification pass verifies, the cascade runs, and the source names detection.
        out = self._dispatch("d1_scan_nolang.pdf")
        rep = out["payload"]["ocr"]
        self.assertTrue(rep["ran"], f"verified detection must drive recognition: {rep['reason']}")
        self.assertEqual(rep["language"], "eng")
        self.assertTrue(rep["language_source"].startswith("detected"),
                        f"the source must be explicit: {rep['language_source']}")

    @unittest.skipUnless(SCANNED.is_file(), "run docs/overnight/fixtures/d1/ocr_docs.py first")
    @unittest.skipUnless(_tesseract_ready(), "project-local tesseract missing")
    def test_declared_lang_is_used_and_named_as_declared(self):
        # d1_scanned.pdf carries /Lang(en-US); with NO requested language the declaration wins
        # and the report says where the language came from - the same honesty the key demands.
        out = self._dispatch("d1_scanned.pdf")
        rep = out["payload"]["ocr"]
        self.assertTrue(rep["ran"], "a declared language must actually drive recognition")
        self.assertEqual(rep["language"], "en-US")
        self.assertIn("/Lang", rep["language_source"])


if __name__ == "__main__":
    unittest.main()
