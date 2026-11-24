"""The resource window, the commit ceiling, and the typed answers around them.

Why this file exists: the primary OCR pipeline was killed INSIDE its own model load by a
job-object commit ceiling, and the parent could only report "the worker exited before reporting
ready (code None)". The engine then looked broken when the real fact was an arithmetic one: the
demand the pinned row declares did not fit the window the call ran in. Every test here pins one
of the three decisions that have to live in code rather than in an engine adapter:

  1. which ceiling applies (normal vs the separately configured exclusive window),
  2. whether that ceiling can hold the declared demand BEFORE a child is spawned,
  3. what a death at that ceiling is CALLED afterwards.

None of these tests load paddle. The one test that touches the OS allocates plain bytes, and it
says so when the OS did not actually attach a ceiling.
"""
from __future__ import annotations

import itertools
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml.documents import ocr_cascade, ocr_paddle, ocr_tesseract
from ruke_ml.documents import ocr_paddle_worker
from ruke_ml.documents.ocr_tesseract import OcrPage, OcrUnavailable
from ruke_ml.models import devices, job_limits, main_model, resources
from ruke_ml import allocations
from ruke_ml.workers import jobs

GIB = 1 << 30
MIB = 1 << 20


def mem(commit_avail_mib: int, available_mib: int = 8192,
        source: str = "GlobalMemoryStatusEx") -> resources.Memory:
    return resources.Memory(total_mib=65536, available_mib=available_mib,
                            commit_total_mib=131072, commit_avail_mib=commit_avail_mib,
                            source=source)


class ExclusiveBudgetArithmetic(unittest.TestCase):
    """The exclusive window is widened by arithmetic, never by removing protection."""

    def test_plenty_of_headroom_uses_the_configured_maximum(self):
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000)):
            limit, report = job_limits.exclusive_ceiling_bytes()
        self.assertEqual(limit, job_limits.EXCLUSIVE_LIMIT_BYTES_DEFAULT)
        self.assertTrue(report["measured"])
        self.assertTrue(report["widened_beyond_normal"])
        self.assertEqual(report["bound_by"], "the configured exclusive maximum")

    def test_a_low_commit_clamps_to_free_headroom_minus_the_reserve(self):
        """6,000 MiB free commit minus a 2 GiB reserve leaves 3,952 MiB, under the hard maximum.

        That is the honest signal that unloading the main model bought nothing usable, and it
        must be reported, not smoothed over by keeping the exclusive number.

        The exact figure, not a round number: 6,000 MiB = 6,291,456,000 B and 2 GiB =
        2,147,483,648 B, so the window is 4,143,972,352 B = 3,952 MiB - which is 144 MiB under
        the 4,768 MiB the normal budget already allows.
        """
        with mock.patch.object(resources, "system_memory", return_value=mem(6_000)):
            limit, report = job_limits.exclusive_ceiling_bytes(reserve_bytes=2 * GIB)
        self.assertEqual(limit, 3_952 * MIB)
        self.assertLess(limit, job_limits.AGGREGATE_LIMIT_BYTES)
        self.assertTrue(report.get("window_gained_nothing"))
        self.assertEqual(report["bound_by"], "free commit minus the system reserve")
        self.assertFalse(report["widened_beyond_normal"])

    def test_an_unmeasurable_host_keeps_the_normal_hard_maximum(self):
        """No commit reading must NOT open a wider window on a guess."""
        with mock.patch.object(resources, "system_memory",
                               return_value=resources.Memory(source="unsupported-host")):
            limit, report = job_limits.exclusive_ceiling_bytes()
        self.assertEqual(limit, job_limits.AGGREGATE_LIMIT_BYTES)
        self.assertFalse(report["measured"])
        self.assertIsNone(report["commit_available_bytes"])

    def test_an_absurd_configuration_is_clamped_into_the_documented_band(self):
        env = {job_limits.EXCLUSIVE_LIMIT_ENV: str(99 * GIB),
               job_limits.SYSTEM_RESERVE_ENV: str(512 * MIB)}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(resources, "system_memory", return_value=mem(30_000)):
            limit, report = job_limits.exclusive_ceiling_bytes()
        self.assertEqual(limit, job_limits.EXCLUSIVE_LIMIT_CONFIG_MAX)
        self.assertEqual(report["bounded_config_limit_bytes"],
                         job_limits.EXCLUSIVE_LIMIT_CONFIG_MAX)
        self.assertEqual(report["system_reserve_bytes"], 512 * MIB)

    def test_the_normal_window_never_widens_for_an_unload_that_did_not_happen(self):
        # Measured law (B8, 2026-11-22): on this mock the normal window is bounded HARDER than
        # the exclusive one - the resident main model consumes the physical RAM the exclusive
        # window gets back by unloading. The widening comes from the measured numbers after a
        # real release, never from an unexecuted unload.
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000, 30_000)):
            normal, _ = job_limits.normal_ceiling_bytes()
            exclusive, _ex = job_limits.exclusive_ceiling_bytes()
        self.assertLessEqual(normal, exclusive)
        self.assertEqual(_ex["window"], "exclusive")

    def test_the_normal_window_widens_for_an_unload_that_did_happen(self):
        # Same code path, the RAM genuinely released: free physical rises, so the measured
        # normal-window ceiling rises with it. "Strata stays loaded when the job fits" and
        # "unload only if it makes the job fit" are the same arithmetic read twice.
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000, 5_000)):
            tight, _ = job_limits.normal_ceiling_bytes()
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000, 30_000)):
            released, _ = job_limits.normal_ceiling_bytes()
        self.assertLess(tight, released)


class NormalBudgetArithmetic(unittest.TestCase):
    """B8 (final decision 2026-11-22): the fixed 5 GB ceiling is gone.

    The normal window's enforceable budget is MEASURED, like the exclusive window's:
    free commit minus the OS reserve, clamped by free physical RAM minus the 1 GiB
    floor and the reserve (the resident main model is what that physical clamp pays
    for - "Strata STAYS LOADED when the job fits"), and capped by the configured
    normal maximum. The fixed number survives only as the documented fallback for a
    host that cannot read its own commit charge, and that fallback must say so.
    """

    def test_plenty_of_headroom_uses_the_configured_maximum_not_5_gb(self):
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000, 30_000)):
            limit, report = job_limits.normal_ceiling_bytes()
        self.assertTrue(report["measured"])
        self.assertGreater(limit, job_limits.AGGREGATE_LIMIT_BYTES,
                           "a headroom-rich host must NOT be held to the old fixed 5 GB")
        self.assertEqual(limit, job_limits.NORMAL_LIMIT_BYTES_DEFAULT)
        self.assertEqual(report["bound_by"], "the configured normal maximum")

    def test_the_resident_main_model_clamps_the_window_by_free_physical_ram(self):
        """5,000 MiB free physical minus the 1,024 MiB floor minus the 2 GiB reserve = 1,928 MiB.

        Commit headroom is huge here, and it does not matter: the job object bounds commit,
        but commit is never below resident RAM, so a tree capped by commit alone would page
        the resident model. This is the reservation the final decision names.
        """
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000, 5_000)):
            limit, report = job_limits.normal_ceiling_bytes()
        self.assertEqual(limit, 1_928 * MIB)
        self.assertEqual(report["physical_budget_bytes"], 1_928 * MIB)
        self.assertIn("physical", report["bound_by"])
        self.assertLess(limit, job_limits.AGGREGATE_LIMIT_BYTES)

    def test_low_commit_headroom_bounds_the_window_by_the_same_arithmetic_as_exclusive(self):
        """6,000 MiB free commit minus the 2 GiB reserve = 3,952 MiB, the exclusive figure."""
        with mock.patch.object(resources, "system_memory", return_value=mem(6_000, 30_000)):
            limit, report = job_limits.normal_ceiling_bytes()
        self.assertEqual(limit, 3_952 * MIB)
        self.assertEqual(report["bound_by"], "free commit minus the system reserve")

    def test_a_host_that_cannot_read_its_commit_charge_uses_the_documented_fallback(self):
        with mock.patch.object(resources, "system_memory",
                               return_value=resources.Memory(source="unsupported-host")):
            limit, report = job_limits.normal_ceiling_bytes()
        self.assertEqual(limit, job_limits.AGGREGATE_LIMIT_BYTES)
        self.assertFalse(report["measured"])
        self.assertIsNone(report["commit_available_bytes"])
        self.assertIn("fallback", report["reason"])

    def test_no_headroom_under_the_reserve_yields_the_minimum_viable_ceiling_saying_so(self):
        with mock.patch.object(resources, "system_memory", return_value=mem(1_000, 1_000)):
            limit, report = job_limits.normal_ceiling_bytes()
        self.assertEqual(limit, job_limits.CEILING_FLOOR_BYTES)
        self.assertTrue(report["measured"])
        self.assertIn("reserve", report["reason"])

    def test_an_operator_cap_is_honoured_below_the_measured_budget(self):
        env = {job_limits.NORMAL_LIMIT_ENV: str(3 * GIB)}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(resources, "system_memory", return_value=mem(30_000, 30_000)):
            limit, report = job_limits.normal_ceiling_bytes()
        self.assertEqual(limit, 3 * GIB)
        self.assertEqual(report["bound_by"], "the configured normal maximum")
        self.assertEqual(report["configured_limit_bytes"], 3 * GIB)


class WorkerCeilingArithmetic(unittest.TestCase):
    """A ceiling under the declared demand is a typed refusal, not a tight fit."""

    def test_a_provisional_demand_is_charged_with_the_unmeasured_factor(self):
        # Deterministic host: 6,000 MiB free commit - 2 GiB reserve = 3,952 MiB normal window,
        # deliberately under the demand so the refusal path is what runs, not host luck.
        with mock.patch.object(resources, "system_memory", return_value=mem(6_000, 8_192)):
            _limit, report = job_limits.worker_ceiling_bytes(
                inside_window=False, declared_demand_bytes=3_300 * MIB,
                demand_basis="provisional: model weight bytes only")
        self.assertFalse(report["demand_is_measured"])
        self.assertEqual(report["charged_demand_bytes"],
                         int(3_300 * MIB * resources.UNMEASURED_ESTIMATE_FACTOR))
        self.assertEqual(report["margin_bytes"], resources.UNMEASURED_MARGIN_MIB * MIB)
        self.assertTrue(report["below_declared_demand"])
        self.assertIn("normal window", report["refuse_reason"])
        self.assertIn(str(report["minimum_viable_ceiling_bytes"]), report["refuse_reason"])

    def test_a_measured_demand_is_charged_as_itself_with_a_small_margin(self):
        _limit, report = job_limits.worker_ceiling_bytes(
            inside_window=True, declared_demand_bytes=3_300 * MIB,
            demand_basis="measured 2026-11-18: cold load peak of the pinned CPU pipeline")
        self.assertTrue(report["demand_is_measured"])
        self.assertEqual(report["charged_demand_bytes"], 3_300 * MIB)
        self.assertEqual(report["margin_bytes"], job_limits.CEILING_MARGIN_MEASURED_BYTES)
        self.assertFalse(report["below_declared_demand"])
        self.assertNotIn("refuse_reason", report)

    def test_an_explicit_ceiling_is_checked_by_the_same_arithmetic(self):
        # The window is a deterministic headroom-rich host (measured normal ceiling = the
        # configured normal maximum); the override arithmetic under test is host-independent.
        with mock.patch.object(resources, "system_memory", return_value=mem(30_000, 30_000)):
            ceiling, report = job_limits.worker_ceiling_bytes(
                inside_window=False, declared_demand_bytes=3_300 * MIB,
                demand_basis="provisional: weight bytes", ceiling_override_bytes=6_265 * MIB)
        self.assertEqual(ceiling, 6_265 * MIB)
        self.assertEqual(report["effective_limit_bytes"], 6_265 * MIB)
        self.assertEqual(report["window_derived_limit_bytes"],
                         job_limits.NORMAL_LIMIT_BYTES_DEFAULT)
        self.assertFalse(report["below_declared_demand"])
        # One notch under what the demand needs must refuse. The minimum viable ceiling is the
        # arithmetic, not a guess: a provisional 3,300 MiB demand is charged 1.5x (4,950 MiB)
        # plus the 1,024 MiB unmeasured margin = 5,974 MiB.
        self.assertEqual(report["minimum_viable_ceiling_bytes"], 5_974 * MIB)
        ceiling2, report2 = job_limits.worker_ceiling_bytes(
            inside_window=False, declared_demand_bytes=3_300 * MIB,
            demand_basis="provisional: weight bytes", ceiling_override_bytes=5_900 * MIB)
        self.assertEqual(ceiling2, 5_900 * MIB)
        self.assertLess(ceiling2, report["minimum_viable_ceiling_bytes"])
        self.assertTrue(report2["below_declared_demand"])
        self.assertEqual(report2["minimum_viable_ceiling_bytes"], 5_974 * MIB)
        # The refusal text quotes the byte figures it actually compared, so an operator can redo
        # the arithmetic instead of trusting the boolean.
        self.assertIn(str(5_900 * MIB), report2["refuse_reason"])
        self.assertIn(str(5_974 * MIB), report2["refuse_reason"])


class PeakHitLimitClassification(unittest.TestCase):
    """A ceiling kill must be distinguishable from a death whose cause is unknown."""

    def test_a_kernel_peak_at_the_limit_reads_as_reached(self):
        out = job_limits.peak_hit_limit({"available": 1, "limit_bytes": 4 * GIB,
                                         "peak_job_commit_mib": 4_090,
                                         "peak_process_commit_mib": 2_000})
        self.assertTrue(out["reached"])
        self.assertEqual(out["peak_commit_mib"], 4_090)

    def test_a_peak_short_of_the_ratio_reads_as_not_reached(self):
        """3,900 MiB against a 4,096 MiB ceiling is 95.2 %, under the 98 % ratio.

        This is the gap the classifier's third branch exists for: a single allocation larger
        than the remaining headroom is refused whole, so the kernel peak stops short of the
        ceiling and `reached` is honestly False. The worker-death classifier then labels the
        same death SUSPECTED resource limit rather than pretending the peak proved it.
        """
        verdict = job_limits.peak_hit_limit({"available": 1, "limit_bytes": 4 * GIB,
                                             "peak_job_commit_mib": 3_900})
        self.assertFalse(verdict["reached"])
        called = ocr_paddle.classify_worker_death(
            code=None, verdict=verdict, detail="nothing naming an exception",
            ceiling_bytes=4 * GIB, enforced_by_os=True, stage="load")
        self.assertEqual(called["kind"], "resource_limit")
        self.assertEqual(called["reason"], "suspected_under_attached_ceiling")
        self.assertIn("SUSPECTED", called["note"])

    def test_a_peak_far_below_the_limit_reads_as_not_reached(self):
        out = job_limits.peak_hit_limit({"available": 1, "limit_bytes": 4 * GIB,
                                         "peak_job_commit_mib": 900})
        self.assertFalse(out["reached"])

    def test_an_unreadable_peak_is_unknown_and_never_false(self):
        for peaks in ({}, {"available": 0, "limit_bytes": 4 * GIB},
                      {"available": 1, "limit_bytes": 4 * GIB}):
            out = job_limits.peak_hit_limit(peaks)
            self.assertIsNone(out["reached"], peaks)
        # A job with no ceiling attached cannot have been killed by one, but that is still not
        # evidence about what DID kill it.
        out = job_limits.peak_hit_limit({"available": 1, "limit_bytes": 0,
                                         "peak_job_commit_mib": 900})
        self.assertIsNone(out["reached"])


class CeilingIsDecidedBeforeTheChildExists(unittest.TestCase):
    """The refusal must happen before a spawn, so no model load is ever paid for a refusal."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f60-window-"))
        self.spawned: list[list[str]] = []

        def fake_popen(argv, **kwargs):
            self.spawned.append(list(argv))
            raise OSError("the ceiling check should have refused before this")

        self.fake_popen = fake_popen
        self.state = {"runtime": {"found": True, "interpreter": sys.executable,
                                  "detail": "stub runtime for the ceiling test"},
                      "worker_present": True, "ready": True, "blockers": [],
                      "est_peak_mib": 3_300,
                      "est_peak_basis": "provisional: weight bytes only, no measured peak",
                      "fault": ""}
        patches = [mock.patch.object(ocr_paddle, "engine_state", return_value=self.state),
                   mock.patch.object(ocr_paddle, "_model_dirs",
                                     return_value=(str(self.tmp), str(self.tmp))),
                   mock.patch.object(ocr_paddle.subprocess, "Popen", fake_popen),
                   mock.patch.dict(os.environ, {ocr_paddle.FAULT_ENV: ""}, clear=False)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_the_normal_window_refuses_without_spawning(self):
        # The refusal law is pinned with the adapter's OWN ceiling seam, not the live machine's
        # free RAM: an unmeasured 3,300 MiB demand is charged with the estimate factor + margin,
        # so a 2 GiB explicit ceiling is below the minimum viable ceiling deterministically.
        # (The pre-2026-11-23 version relied on the host's normal window being under the demand
        # at run time — true on the memory-constrained nightly box, false on an idle one, where
        # the ceiling is ~6.7 GiB and the spawn is legitimately allowed.) The exclusive-window
        # twin below is unchanged: the ONLY difference stays the window the caller declares.
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages("missing.pdf", [1], language="eng", device="cpu",
                                     per_worker_limit_bytes=2 * GIB)
        self.assertEqual(caught.exception.kind, "resource_limit")
        self.assertIn("refusing to spawn", str(caught.exception))
        self.assertEqual(self.spawned, [], "a refused job must not have spawned a child")

    def test_an_exclusive_window_holds_the_same_demand_and_reaches_the_spawn(self):
        # Same declared demand, wider window: the ONLY difference is which window the caller said
        # it runs in, which is exactly the flag the handoff states rather than the adapter guessing.
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages("missing.pdf", [1], language="eng", device="cpu",
                                     inside_window=True)
        self.assertEqual(caught.exception.kind, "engine_spawn_failed")
        self.assertEqual(len(self.spawned), 1)


class CeilingDemandIsChargedFromTheCommitPeak(unittest.TestCase):
    """The job object bounds COMMIT, so the ceiling demand is charged from the row's measured
    COMMIT peak when it records one. A CUDA build's resident working set never shows the DLL
    and CUDA mappings, and charging from it squeezes the worker into a ceiling the load dies
    under (measured 2026-11-23: charged from the 2,620 MiB working set, the spawn was admitted
    under a 6,675 MiB ceiling and the pipeline load died mid-model with 0xC0000409; the row's
    measured kernel commit peak is 10,327 MiB)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f129-commit-"))
        self.spawned: list[list[str]] = []

        def fake_popen(argv, **kwargs):
            self.spawned.append(list(argv))
            raise OSError("the ceiling check should have refused before this")

        self.state = {"runtime": {"found": True, "interpreter": sys.executable,
                                  "detail": "stub runtime for the commit-peak test"},
                      "worker_present": True, "ready": True, "blockers": [],
                      "est_peak_mib": 2_620,
                      "est_peak_basis": "measured 2026-11-22 on this host: GPU worker cold-load "
                                        "+ one page, owned-tree resident working-set peak 2620 MiB",
                      "est_peak_commit_mib": 10_327,
                      "est_peak_commit_basis": "measured 2026-11-22 on this host: kernel job "
                                               "COMMIT peak 10327 MiB during the GPU worker "
                                               "cold-load + one page",
                      "fault": ""}
        patches = [mock.patch.object(ocr_paddle, "engine_state", return_value=self.state),
                   mock.patch.object(ocr_paddle, "_model_dirs",
                                     return_value=(str(self.tmp), str(self.tmp))),
                   mock.patch.object(ocr_paddle.subprocess, "Popen", fake_popen),
                   mock.patch.dict(os.environ, {ocr_paddle.FAULT_ENV: ""}, clear=False)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_window_fitting_the_working_set_but_not_the_commit_peak_refuses(self):
        # 6,675 MiB: above the working-set demand and its margin, under the commit peak. This
        # is exactly the ceiling the 2026-11-23 acceptance batch's exclusive window offered,
        # the ceiling the real load died under mid-model.
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages("missing.pdf", [1], language="eng", device="cpu",
                                     inside_window=True, per_worker_limit_bytes=6_675 * MIB)
        self.assertEqual(caught.exception.kind, "resource_limit")
        self.assertIn("kernel job COMMIT peak", str(caught.exception),
                      "the refusal must name the commit figure it charged, not the working set")
        self.assertEqual(self.spawned, [], "a refused job must not have spawned a child")

    def test_the_window_that_clears_the_commit_peak_reaches_the_spawn(self):
        # 11,444 MiB = the 12e9 band-max clamp of the 2026-11-23 acceptance batch: it clears
        # this fixture's 10,327 + 256 demand, so admission passes and the spawn itself is
        # reached (the stub popen raises, which the adapter reports as engine_spawn_failed).
        # (The same ceiling proved thin against IMPORT-stage variance - see the third test.)
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages("missing.pdf", [1], language="eng", device="cpu",
                                     inside_window=True, per_worker_limit_bytes=11_444 * MIB)
        self.assertEqual(caught.exception.kind, "engine_spawn_failed")
        self.assertEqual(len(self.spawned), 1)

    def test_the_exclusive_default_clears_the_pinned_rows_commit_demand(self):
        # The window's configured maximum must clear the row it exists to host, measured
        # demand plus the measured margin - otherwise the default guarantees the refusal the
        # window was built to prevent.
        from ruke_ml.models import registry
        row = [s for s in registry.catalog().all_specs()
               if s.capability == "documents.ocr" and s.provider == "paddle"][0]
        self.assertGreater(int(row.est_peak_commit_mib), 0,
                           "the pinned OCR row must record its measured commit peak")
        self.assertGreaterEqual(job_limits.EXCLUSIVE_LIMIT_BYTES_DEFAULT,
                                (int(row.est_peak_commit_mib) + 256) * MIB,
                                "the exclusive default must clear the commit demand + margin")
        # The 256 MiB margin bounds the STEADY per-page variance; the import stage adds CUDA
        # mapping variance on top. Measured 2026-11-23: under the 12e9 band max (11,444 MiB)
        # the same worker died at import (paddle bf16 op-support enumeration, bad allocation)
        # with the quiet-window peak at 10,406 MiB - the in-run import variance exceeded the
        # 1,038 MiB headroom. The default must therefore clear demand + a 2 GiB import-stage
        # allowance, not just demand + margin.
        self.assertGreaterEqual(job_limits.EXCLUSIVE_LIMIT_BYTES_DEFAULT,
                                (int(row.est_peak_commit_mib) + 2_048) * MIB,
                                "the exclusive default must also clear the measured import-stage "
                                "variance, not only the steady-state margin")


ALLOCATING_WORKER = '''"""A stub worker: reads the header, then commits memory until the ceiling answers."""
import json
import sys
import time

sys.stdin.readline()
sys.stderr.write("stub worker: header read, now committing 800 MiB in 64 KiB strides\\n")
sys.stderr.flush()
try:
    buf = bytearray(800 * 1024 * 1024)
    for index in range(0, len(buf), 65536):
        buf[index] = 1
except MemoryError:
    sys.stderr.write("stub worker: the allocator refused, exiting\\n")
    sys.stderr.flush()
    sys.exit(1)
sys.stderr.write("stub worker: no ceiling stopped me; sleeping\\n")
sys.stderr.flush()
time.sleep(30)
'''


class OsCeilingKillIsClassifiedAsResourceLimit(unittest.TestCase):
    """Real child, real job object, real allocation refusal. No paddle involved."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f60-kill-"))
        self.worker = self.tmp / "allocating_worker.py"
        self.worker.write_text(ALLOCATING_WORKER, encoding="utf-8")
        state = {"runtime": {"found": True, "interpreter": sys.executable,
                             "detail": "stub runtime for the ceiling-kill test"},
                 "worker_present": True, "ready": True, "blockers": [],
                 "est_peak_mib": 0, "est_peak_basis": "", "fault": ""}
        patches = [mock.patch.object(ocr_paddle, "engine_state", return_value=state),
                   mock.patch.object(ocr_paddle, "_model_dirs",
                                     return_value=(str(self.tmp), str(self.tmp))),
                   mock.patch.object(ocr_paddle, "WORKER_FILE", self.worker),
                   mock.patch.dict(os.environ, {ocr_paddle.FAULT_ENV: ""}, clear=False)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_child_killed_at_its_ceiling_reports_resource_limit_not_an_engine_fault(self):
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages("missing.pdf", [1], language="eng", device="cpu",
                                     load_timeout_s=90.0,
                                     per_worker_limit_bytes=300 * MIB)
        kind = caught.exception.kind
        detail = str(caught.exception)
        self.assertIn(kind, ("resource_limit",), detail)
        self.assertIn("commit ceiling", detail)


class CascadeStatesWhichWindowItRunsIn(unittest.TestCase):
    """The lease holder states whether IT released the model; the cascade passes that down."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f60-cascade-"))
        self.pdf = self.tmp / "in.pdf"
        self.pdf.write_bytes(b"%PDF-1.4\n")
        patcher = mock.patch.dict(os.environ, {
            "RUKE_OCR_RESULT_DIR": str(self.tmp / "results"), "RUKE_OCR_RESUME": "",
            "RUKE_OCR_INJECT_FAILURE_PAGE": "", "RUKE_OCR_FAULT": "",
            "RUKE_OCR_PRIMARY": "", "RUKE_OCR_ALLOW_GPU": ""}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _state(self):
        return {"engine": ocr_paddle.ENGINE, "ready": True, "blockers": [],
                "runtime": {"found": True}, "assets": [],
                "estimate": {"est_peak_mib": 3_300, "est_peak_basis": "measured",
                             "est_peak_vram_mib": 0, "est_vram_basis": "unmeasured"}}

    def _capturing_primary(self, seen: dict):
        def _fake(pdf, units, **kwargs):
            seen.update(kwargs)
            return ocr_paddle.PaddleRun(
                [OcrPage(page=int(u), state="recognised", text="t%d" % u,
                         engine=ocr_paddle.ENGINE) for u in units],
                {"peak_working_set_mib": 900})
        return mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_fake)

    def _planner(self):
        plan = devices.DevicePlan("documents.ocr", "cpu", True, False, "stub plan", {})
        return (mock.patch.object(devices, "device_plan", return_value=plan),
                mock.patch.object(main_model, "snapshot", return_value={"loaded": True}))

    def test_a_lease_with_no_unload_keeps_the_normal_window(self):
        seen: dict = {}
        p1, p2 = self._planner()
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state()), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3_300,
                                                "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0,
                                                "est_vram_basis": "unmeasured"}), \
                p1, p2, self._capturing_primary(seen):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200,
                                             device_override="cpu", inside_handoff=True)
        self.assertFalse(seen.get("inside_window"),
                         "inside_handoff alone must not claim the exclusive ceiling")
        self.assertFalse(report["cascade"]["resource_window"]["inside_window"])

    def test_a_lease_that_released_the_model_passes_the_exclusive_window_down(self):
        seen: dict = {}
        p1, p2 = self._planner()
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state()), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3_300,
                                                "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0,
                                                "est_vram_basis": "unmeasured"}), \
                p1, p2, self._capturing_primary(seen):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200,
                                             device_override="cpu", inside_handoff=True,
                                             inside_window=True)
        self.assertTrue(seen.get("inside_window"))
        self.assertTrue(report["cascade"]["resource_window"]["inside_window"])

    def test_an_unexpected_adapter_error_still_recovers_per_unit(self):
        """A raising adapter used to fail the whole job: no recovery, nothing persisted."""
        boom_calls: list[list[int]] = []

        def _boom(pdf, units, **kwargs):
            boom_calls.append(list(units))
            raise RuntimeError("unexpected adapter defect")
        calls: list[list[int]] = []

        def _fallback(pdf, units, **kwargs):
            calls.append(list(units))
            return [OcrPage(page=int(u), state="recognised", text="recovered %d" % u,
                            engine="tesseract-5.5.3") for u in units]
        p1, p2 = self._planner()
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state()), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3_300,
                                                "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0,
                                                "est_vram_basis": "unmeasured"}), \
                p1, p2, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_boom), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=_fallback):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertTrue(casc["primary"]["run_refused"].startswith("adapter_crash"), casc)
        self.assertIn("RuntimeError", casc["primary"].get("adapter_traceback", ""))
        self.assertEqual(calls, [[1, 2]], "recovery must run for every unit")
        self.assertEqual([p.state for p in pages], ["recognised", "recognised"])
        self.assertTrue(casc["persisted"].get("ok"), casc["persisted"])
        self.assertEqual(len(boom_calls), 1,
                         "F136 near miss: an engine defect is NOT the paging-file transient - "
                         "no settle-retry, the fact is recorded on the first death")
        self.assertNotIn("loader_retry", casc["primary"])

    def test_f136_a_paging_file_loader_death_gets_one_settled_retry_on_the_same_device(self):
        # accept-12's F91.1 evidence: the CPU-Paddle attempt died inside libpaddle's import
        # mid pagefile-collapse and the cascade answered with Tesseract-only pages. The
        # collapse settles within ~15 s (f91-host.csv) and the post-collapse headroom fits
        # the plan, so the SAME engine on the SAME device retries ONCE after settling; the
        # pages must then be Paddle pages, not Tesseract recovery.
        attempts: list[str] = []
        slept: list[float] = []

        def _die_then_run(pdf, units, **kwargs):
            attempts.append(str(kwargs.get("device")))
            if len(attempts) == 1:
                raise OSError("[WinError 1455] The paging file is too small for this "
                              "operation to complete. 'libpaddle_common.dll'")
            return ocr_paddle.PaddleRun(
                [OcrPage(page=int(u), state="recognised", text="paddle %d" % u,
                         engine=ocr_paddle.ENGINE) for u in units],
                {"peak_working_set_mib": 900, "device_used": str(kwargs.get("device"))})

        p1, p2 = self._planner()
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state()), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3_300,
                                                "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0,
                                                "est_vram_basis": "unmeasured"}), \
                p1, p2, \
                mock.patch.object(ocr_cascade, "_sleep", slept.append), \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_die_then_run), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages",
                                  side_effect=AssertionError("recovery must not run")):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(attempts, ["cpu", "cpu"],
                         "one settled retry on the SAME device; no engine substitution")
        self.assertEqual(slept, [1.0] * int(ocr_cascade._LOADER_SETTLE_S),
                         "the retry waited the settle out (seam-patched, 1 s cancel checks)")
        self.assertEqual(casc["primary"]["loader_retry"]["device"], "cpu")
        self.assertIn("WinError 1455", casc["primary"]["loader_retry"]["reason"])
        self.assertNotIn("run_refused", casc["primary"],
                         "the settled retry ANSWERED: no refusal stands")
        self.assertEqual([p.engine for p in pages], [ocr_paddle.ENGINE, ocr_paddle.ENGINE],
                         "the delivered pages are PADDLE pages - F91.1's failing assertion")
        self.assertEqual(casc["fallback"]["attempted"], [])

    def test_f136_a_loader_death_that_dies_again_records_the_fact_and_recovers(self):
        # The near miss: the collapse does not clear (accept-11's host). ONE settle-retry,
        # then the recorded fact plus per-unit Tesseract recovery - never an endless loop.
        attempts: list[int] = []
        slept: list[float] = []

        def _die(pdf, units, **kwargs):
            attempts.append(1)
            raise OSError("[WinError 1455] The paging file is too small for this "
                          "operation to complete. 'libpaddle_common.dll'")

        def _fallback(pdf, units, **kwargs):
            return [OcrPage(page=int(u), state="recognised", text="recovered %d" % u,
                            engine="tesseract-5.5.3") for u in units]

        p1, p2 = self._planner()
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state()), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3_300,
                                                "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0,
                                                "est_vram_basis": "unmeasured"}), \
                p1, p2, \
                mock.patch.object(ocr_cascade, "_sleep", slept.append), \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_die), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=_fallback):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(len(attempts), 2, "exactly ONE settle-retry, then the fact stands")
        self.assertEqual(slept, [1.0] * int(ocr_cascade._LOADER_SETTLE_S),
                         "exactly ONE settle")
        self.assertIn("loader_retry", casc["primary"])
        self.assertTrue(casc["primary"]["run_refused"].startswith("adapter_crash"), casc)
        self.assertIn("WinError 1455", casc["primary"]["run_refused"])
        self.assertEqual([p.engine for p in pages], ["tesseract-5.5.3", "tesseract-5.5.3"])
        self.assertIn("WinError 1455", casc["fallback"]["reason"],
                      "the recovery reason carries the OS fact, not a generic label")

    ESTIMATE_FITS = {"est_peak_mib": 3_300, "est_peak_basis": "measured",
                     "est_peak_commit_mib": 10_406, "est_peak_commit_basis": "measured",
                     "est_peak_vram_mib": 0, "est_vram_basis": "unmeasured"}

    def _run_loader_death_fit(self, probe, slept, die_once=True, recovery="forbid",
                              deadline_at=0.0):
        """Shared driver for the F137 fixtures: CPU-Paddle loader death, patched
        fit-probe stream, seam-patched sleeps. Returns (pages, report, attempts)."""
        attempts: list[str] = []

        def _die_then_run(pdf, units, **kwargs):
            attempts.append(str(kwargs.get("device")))
            # die_once=True: only the FIRST attempt is inside the collapse (the settled
            # retry succeeds). die_once=False: the host never refits, so the settled
            # retry dies too and the fact stands.
            if len(attempts) == 1 or not die_once:
                raise OSError("[WinError 1455] The paging file is too small for this "
                              "operation to complete. 'libpaddle_common.dll'")
            return ocr_paddle.PaddleRun(
                [OcrPage(page=int(u), state="recognised", text="paddle %d" % u,
                         engine=ocr_paddle.ENGINE) for u in units],
                {"peak_working_set_mib": 900, "device_used": str(kwargs.get("device"))})

        def _fallback(pdf, units, **kwargs):
            return [OcrPage(page=int(u), state="recognised", text="recovered %d" % u,
                            engine="tesseract-5.5.3") for u in units]

        p1, p2 = self._planner()
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state()), \
                mock.patch.object(ocr_paddle, "estimate", return_value=dict(self.ESTIMATE_FITS)), \
                p1, p2, \
                mock.patch.object(ocr_cascade, "_sleep", slept.append), \
                mock.patch.object(ocr_cascade, "_free_commit_mib", probe), \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_die_then_run), \
                mock.patch.object(
                    ocr_tesseract, "ocr_pdf_pages",
                    side_effect=_fallback if recovery == "allow"
                    else AssertionError("recovery must not run")):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200,
                                            deadline_at=deadline_at)
        return pages, report, attempts

    def test_f137_the_settle_waits_until_free_commit_fits_the_import(self):
        # accept-13's shape: post-collapse steady commit (~18.8-20.5 GB) sits UNDER the
        # pinned row's import demand (2 x 10,406 + 256 = 21,068 MiB, the gate's own
        # formula) for ~90 s. The F136 fixed 20 s settle retried inside that shortage;
        # F137 waits for the gate's probe to READ the fit: 1 s samples, 10 consecutive.
        slept: list[float] = []
        stream = iter([18_000, 19_000] + [21_100] * 30)
        pages, report, attempts = self._run_loader_death_fit(lambda: next(stream), slept)
        casc = report["cascade"]
        self.assertEqual(attempts, ["cpu", "cpu"], "one settled retry, SAME device")
        self.assertEqual(slept, [1.0] * 11,
                         "the wait is fit-driven (3 shortage samples + 10 consecutive fit "
                         "samples, sleep before each non-terminal sample), NOT the fixed 20 s")
        rec = casc["primary"]["loader_retry"]
        self.assertEqual(rec["required_commit_mib"], 21_068,
                         "the wait is sized from the pinned row's own commit demand, "
                         "the same import_required formula the handoff gate enforces")
        self.assertEqual(rec["free_commit_mib_at_retry"], 21_100,
                         "the retry records the headroom it actually measured")
        self.assertLess(rec["settle_s"], 20.0,
                        "settle_s is the MEASURED fit wait, not the F136 constant")
        self.assertEqual([p.engine for p in pages], [ocr_paddle.ENGINE, ocr_paddle.ENGINE])

    def test_f137_a_momentary_dip_defers_the_retry_to_the_next_stable_window(self):
        # accept-13 proved deaths at instants the 16 s grid read as 19-25 GB: the fit
        # must be CONSECUTIVE samples, so a dip in the middle restarts the stability
        # count instead of sending the retry into a fresh 1455.
        slept: list[float] = []
        stream = iter([21_100] * 5 + [18_000] + [21_100] * 30)
        pages, report, attempts = self._run_loader_death_fit(lambda: next(stream), slept)
        self.assertEqual(attempts, ["cpu", "cpu"])
        self.assertEqual(slept, [1.0] * 15,
                         "5 fit samples + the dip (count resets) + 10 consecutive fit "
                         "samples: 15 sleeps, the dip cost stability not a death")

    def test_f137_an_unreadable_probe_keeps_the_fixed_settle(self):
        # The near miss: a host whose commit charge cannot be read must NOT get an
        # invented number - the F136 fixed settle stands, unchanged.
        slept: list[float] = []
        pages, report, attempts = self._run_loader_death_fit(lambda: None, slept)
        casc = report["cascade"]
        self.assertEqual(attempts, ["cpu", "cpu"])
        self.assertEqual(slept, [1.0] * int(ocr_cascade._LOADER_SETTLE_S),
                         "probe unreadable -> exactly the F136 fixed settle")
        rec = casc["primary"]["loader_retry"]
        self.assertEqual(rec["required_commit_mib"], 21_068,
                         "the demand is still recorded as the law, even unmeasurable")
        self.assertNotIn("free_commit_mib_at_retry", rec,
                         "no headroom claim without a measurement")

    def test_f137_the_cap_expires_and_the_retry_records_its_own_death(self):
        # The host never refits inside the cap: the retry runs anyway (the F136 law -
        # the death is a recorded fact) and recovery proceeds; the wait is bounded.
        slept: list[float] = []
        with mock.patch.object(ocr_cascade, "_LOADER_FIT_CAP_S", 2.0):
            pages, report, attempts = self._run_loader_death_fit(
                itertools.repeat(18_000).__next__, slept, die_once=False, recovery="allow")
        casc = report["cascade"]
        self.assertEqual(len(attempts), 2, "exactly one settle-retry at the cap")
        rec = casc["primary"]["loader_retry"]
        self.assertEqual(rec["required_commit_mib"], 21_068)
        self.assertLess(rec["settle_s"], 20.0,
                        "the cap (2 s patched) bounded the wait, not the 20 s constant")
        self.assertTrue(casc["primary"]["run_refused"].startswith("adapter_crash"), casc)
        self.assertEqual([p.engine for p in pages], ["tesseract-5.5.3", "tesseract-5.5.3"],
                         "the dead retry falls to recovery with the facts recorded")

    def test_f140_the_loader_fit_poll_stops_at_the_job_deadline(self):
        # F140 (accept-15): this wait runs INSIDE the exclusive window; the document
        # job's 90 s wall clock must bound it. At the CLAMPED cap the retry law is
        # unchanged (F136): it runs anyway and records its own death, so the job ends
        # typed, the cascade record is written, and the lease is released - never a
        # fit poll spinning past the client's exit while the lease is held.
        slept: list[float] = []
        with mock.patch.object(ocr_cascade.time, "time", lambda: 1000.0):
            pages, report, attempts = self._run_loader_death_fit(
                itertools.repeat(18_000).__next__, slept, die_once=False,
                recovery="allow", deadline_at=1003.0)
        casc = report["cascade"]
        self.assertEqual(len(attempts), 2, "the retry ran at the clamped cap (F136 law)")
        self.assertLess(casc["primary"]["loader_retry"]["settle_s"], 4.0,
                        "the 3 s job budget - not the 120 s constant - bounded the poll")
        self.assertTrue(casc["primary"]["run_refused"].startswith("adapter_crash"), casc)
        self.assertEqual([p.engine for p in pages], ["tesseract-5.5.3", "tesseract-5.5.3"],
                         "the dead retry falls to recovery with the facts recorded")

    def test_f140_an_unreadable_probe_still_respects_the_job_deadline(self):
        # The fixed F136 settle is bounded by the same law: a probe-less host with 3 s
        # of job budget sleeps 3 s, not 20 - the window hands the machine back.
        slept: list[float] = []
        with mock.patch.object(ocr_cascade.time, "time", lambda: 1000.0):
            pages, report, attempts = self._run_loader_death_fit(
                lambda: None, slept, die_once=False, recovery="allow",
                deadline_at=1003.0)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(slept, [1.0] * 3,
                         "the fixed settle is clamped to the remaining job budget")


class WorkerDeathIsClassifiedOnceAtEverySite(unittest.TestCase):
    """One classifier, ordered by strength of evidence, at every site that notices a death.

    Why this class exists: the same dead child used to be called a load failure, an engine fault,
    or a resource limit depending on WHICH site noticed it and whether the kernel peak happened to
    be readable. Each test below pins one evidence tier, and the last two pin the tier boundaries
    so a later edit cannot quietly promote a suspicion into a fact.
    """

    CEILING = 4 * GIB

    def _call(self, **kwargs):
        kwargs.setdefault("ceiling_bytes", self.CEILING)
        kwargs.setdefault("verdict", {"reached": None})
        kwargs.setdefault("detail", "")
        kwargs.setdefault("enforced_by_os", True)
        return ocr_paddle.classify_worker_death(**kwargs)

    def test_a_protocol_marker_names_the_refusal_and_dominates_everything_else(self):
        # A readable kernel peak that did NOT reach the ceiling must not argue with the engine
        # naming its own refused allocation.
        called = self._call(code=None, verdict={"reached": False, "available": True},
                            detail="loading model.safetensors",
                            event_marker="can't allocate", stage="load")
        self.assertEqual(called["kind"], "resource_limit")
        self.assertEqual(called["reason"], "allocation_named_by_engine")
        self.assertIn("can't allocate", called["why"])

    def test_a_refusal_named_only_in_the_log_tail_gets_the_same_label(self):
        called = self._call(
            code=1, detail=("DefaultCPUAllocator: can't allocate memory of size 3837018112 "
                            "bytes; MKL_malloc failed"), stage="page")
        self.assertEqual(called["kind"], "resource_limit")
        self.assertEqual(called["reason"], "allocation_named_by_engine")

    def test_a_kernel_peak_at_the_ceiling_is_proven_by_the_os(self):
        verdict = job_limits.peak_hit_limit({"available": 1, "limit_bytes": self.CEILING,
                                             "peak_job_commit_mib": 4_090})
        called = self._call(code=None, verdict=verdict, stage="load")
        self.assertEqual(called["kind"], "resource_limit")
        self.assertEqual(called["reason"], "kernel_peak_reached_ceiling")
        self.assertIn("measured by the kernel", called["note"])

    def test_an_unbounded_abnormal_death_is_a_resource_limit_with_an_unknown_cause(self):
        called = self._call(code=None, enforced_by_os=False, stage="load")
        self.assertEqual(called["kind"], "resource_limit")
        self.assertEqual(called["reason"], "abnormal_death_unbounded")
        self.assertIn("UNKNOWN", called["note"])
        self.assertFalse(called["ceiling_enforced_by_os"])

    def test_a_clean_exit_with_no_ceiling_evidence_stays_a_load_failure(self):
        called = self._call(code=1, detail="ModuleNotFoundError: No module named 'paddle'",
                            enforced_by_os=True)
        # A named exception is an engine fault no matter what the ceiling could have done, but a
        # clean non-zero exit that names NOTHING and has no peak evidence is not promoted either.
        self.assertEqual(called["kind"], "engine_death")
        self.assertEqual(called["reason"], "engine_reported_failure")
        called_plain = self._call(code=1, detail="worker gave up while reading weights",
                                  enforced_by_os=True)
        self.assertEqual(called_plain["kind"], "load_failed")

    def test_the_stage_only_changes_the_non_resource_label(self):
        load = self._call(code=3, detail="exit with no exception", enforced_by_os=False)
        page = self._call(code=3, detail="exit with no exception", enforced_by_os=False,
                          stage="page")
        self.assertEqual(load["kind"], "load_failed")
        self.assertEqual(page["kind"], "engine_death")
        # The resource tiers ignore the stage entirely.
        for stage in ("load", "page"):
            got = self._call(code=None, enforced_by_os=True, stage=stage)
            self.assertEqual(got["reason"], "suspected_under_attached_ceiling", stage)

    def test_every_site_that_notices_a_death_calls_the_same_classifier(self):
        """Structural pin: the adapter must not grow a fourth local verdict."""
        source = Path(ocr_paddle.__file__).read_text(encoding="utf-8")
        self.assertGreaterEqual(source.count("classify_worker_death("), 3,
                                "the load handshake, the load error event and the mid-page death "
                                "must all route through the one classifier")
        self.assertIn('"kind": "resource_limit"', source)
        # The same human step at every resource site, and it must say what NOT to do, because the
        # default advice for a dead model process is "re-prepare the weights", which here would
        # destroy a valid 1.9 GB asset while the actual condition is RAM.
        step = ocr_paddle.RESOURCE_LIMIT_STEP
        self.assertTrue(step.startswith("the demand declared for this pipeline"), step)
        self.assertIn("resource limit rather than an engine fault", step)
        self.assertIn("do NOT raise the hard maximum", step)
        self.assertIn("already valid", step)
        # 1 definition + 1 per resource site (pre-spawn refusal, load death, load error event).
        self.assertGreaterEqual(source.count("RESOURCE_LIMIT_STEP"), 4,
                                "a resource-limit refusal must not invent its own human step")


class TheAllocationClassifierIsOneAuthorityAcrossProcessBoundaries(unittest.TestCase):
    """The child process is told what a refusal looks like; it does not guess its own list."""

    def test_the_child_fallback_list_equals_the_parent_authority(self):
        self.assertEqual(set(ocr_paddle_worker.DEFAULT_MEMORY_REFUSAL_MARKERS),
                         set(allocations.ALLOCATED_REFUSED_MARKERS))

    def test_the_header_markers_are_installed_and_the_source_is_echoed(self):
        self.addCleanup(lambda: ocr_paddle_worker.set_memory_markers(None))
        # 1. A header list REPLACES the builtin list: the child obeys the parent, and a list that
        #    only contains what the parent sent cannot match anything else.
        self.assertEqual(ocr_paddle_worker.set_memory_markers(["Out Of Memory "]), "header")
        self.assertEqual(ocr_paddle_worker.MEMORY_REFUSAL_MARKERS, ("out of memory",))
        self.assertEqual(ocr_paddle_worker.memory_refusal_signal("MKL_malloc failed"), "")
        self.assertEqual(ocr_paddle_worker.memory_refusal_signal("ran OUT OF MEMORY here"),
                         "out of memory")
        # 2. With the parent's real list installed, the engine's own CPU refusal wording matches.
        self.assertEqual(
            ocr_paddle_worker.set_memory_markers(list(allocations.ALLOCATED_REFUSED_MARKERS)),
            "header")
        self.assertEqual(ocr_paddle_worker.memory_refusal_signal("DefaultCPUAllocator: "
                                                                 "can't allocate memory"),
                         "can't allocate")
        self.assertEqual(ocr_paddle_worker.memory_refusal_signal("MKL_malloc: 0x8007000e"),
                         "mkl_malloc")
        # 3. A header that carried no list degrades to the builtin copy, visibly.
        self.assertEqual(ocr_paddle_worker.set_memory_markers(None), "builtin fallback")
        self.assertEqual(ocr_paddle_worker.MEMORY_REFUSAL_MARKERS,
                         ocr_paddle_worker.DEFAULT_MEMORY_REFUSAL_MARKERS)

    def test_the_parent_sends_that_list_in_the_header(self):
        source = Path(ocr_paddle.__file__).read_text(encoding="utf-8")
        self.assertIn('"memory_refusal_markers": list(allocations.ALLOCATED_REFUSED_MARKERS)',
                      source)

    def test_a_resource_limit_refusal_maps_to_a_real_reason_code_for_the_callers(self):
        # workers/jobs.py turns a worker kind into the reason a caller sees. A kind with no row
        # falls through to `internal`, which would send an operator after the code instead of RAM.
        row = jobs.KIND_TO_REASON.get("resource_limit")
        self.assertIsNotNone(row, "resource_limit has no reason mapping in workers/jobs.py")
        self.assertEqual(row[0], "memory_pressure")
        self.assertTrue(row[1], "a resource limit is retryable, unlike a corrupt input")


if __name__ == "__main__":
    unittest.main()
