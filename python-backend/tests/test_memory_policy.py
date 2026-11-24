"""The memory policy that keeps Ruke from evicting the resident model.

Measured on 2026-11-16: this host has 63.8 GiB physical RAM with the main LLM holding
50.6 GiB resident, and 27 GiB of commit still free. Physical RAM runs out while the pagefile
is barely used, so the policy has to act on free PHYSICAL RAM, not on commit alone. These
tests pin the three levers that came out of that measurement, and each one states the quality
cost it does NOT impose.
"""
from __future__ import annotations

import unittest
from unittest import mock

from ruke_ml.contracts import JobRequest
from ruke_ml.models import provider_config, resources
from ruke_ml.models.lifecycle import WorkerPool


def fake_memory(available_mib: int, total_mib: int = 63 * 1024,
                commit_avail_mib: int = 27 * 1024) -> resources.Memory:
    return resources.Memory(total_mib=total_mib, available_mib=available_mib,
                            commit_total_mib=total_mib + commit_avail_mib,
                            commit_avail_mib=commit_avail_mib,
                            source="GlobalMemoryStatusEx")


class Admission(unittest.TestCase):
    """A weight-loading worker is refused before it can start paging."""

    def setUp(self):
        self.pool = WorkerPool()
        self.addCleanup(self.pool.stop_all)

    def _memory(self, available_mib: int, commit_avail_mib: int = 27 * 1024):
        patch = mock.patch.object(resources, "system_memory",
                                  return_value=fake_memory(available_mib, commit_avail_mib=commit_avail_mib))
        patch.start()
        self.addCleanup(patch.stop)

    def test_a_model_backed_capability_is_refused_on_a_saturated_host(self):
        self._memory(500)                       # 500 MiB free: the state the user reported
        est, adm = self.pool._admission("speech.asr")
        self.assertFalse(adm["fits"], adm["reasons"])
        self.assertEqual(adm["floor_free_physical_mib"], resources.FLOOR_FREE_PHYSICAL_MIB)
        self.assertIn("free physical RAM", "; ".join(adm["reasons"]))

    def test_a_native_reader_is_not_refused_for_ram_it_does_not_use(self):
        """Refusing a 22 MiB PDF parse to protect RAM is a self-inflicted regression."""
        self._memory(500)
        est, adm = self.pool._admission("documents.parse")
        self.assertTrue(adm["fits"], adm["reasons"])
        self.assertEqual(adm["floor_free_physical_mib"], 0,
                         "adapters with no asset carry no weights, so the weight floor must not apply")

    def test_a_measured_peak_bigger_than_the_free_ram_is_refused(self):
        self._memory(3000)
        strict = resources.admission(6000, est_basis="measured: g05 probe tree")
        self.assertFalse(strict["fits"], strict["reasons"])
        self.assertIn("measured load peak", "; ".join(strict["reasons"]))
        self.assertEqual(strict["estimate"], "measured")
        self.assertEqual(strict["required_mib"], 6256)

    def test_a_number_without_provenance_is_labelled_provisional_not_measured(self):
        """The word "measured" is earned by a basis string, never by a number being non-zero.

        Reported state (amendment 7, defect 6): the `estimate` field said "measured" for any
        non-zero estimate, so a provisional weight-byte bound appeared in evidence as if it had
        been measured on this host.
        """
        self._memory(3000)
        declared = resources.admission(3300)
        self.assertEqual(declared["estimate"], "provisional-estimate", declared)
        self.assertEqual(declared["estimate_basis"], "provisional", declared)
        self.assertNotIn("measured load peak", "; ".join(declared["reasons"]))
        nothing = resources.admission(0)
        self.assertEqual(nothing["estimate"], "unmeasured", nothing)
        self.assertEqual(nothing["estimate_basis"], "not declared", nothing)

    def test_a_provisional_estimate_is_charged_wider_than_a_measured_one(self):
        """The trust rule that keeps an unverified 3300 MiB from loading beside a 50 GiB model.

        Measured on 2026-11-17: with the main LLM resident this host had 3,829-3,943 MiB free.
        A provisional 3,300 MiB estimate plus 256 MiB of margin "fits" with ~270 MiB to spare -
        and the estimate has never been measured, so that fit is a guess with a green light on it.
        """
        self._memory(3900)
        provisional = resources.admission(3300, est_basis="provisional: pinned weight bytes")
        self.assertFalse(provisional["fits"],
                         "an unmeasured estimate must not be admitted with measured-grade slack")
        self.assertIn("provisional load peak", "; ".join(provisional["reasons"]))
        self.assertNotIn("measured load peak", "; ".join(provisional["reasons"]),
                         "an estimate nobody measured must never read as a measurement")
        self.assertEqual(provisional["est_peak_mib"], 3300, "the declared number is not rewritten")
        self.assertEqual(provisional["est_peak_mib_charged"], 4950)
        self.assertEqual(provisional["required_mib"], 4950 + resources.UNMEASURED_MARGIN_MIB)
        measured = resources.admission(3300, est_basis="measured: cold-load peak 3300 MiB")
        self.assertTrue(measured["fits"], measured["reasons"])
        self.assertEqual(measured["required_mib"], 3556,
                         "a measured peak is charged as declared - this is not a blanket refusal")

    def test_the_ocr_job_is_not_refused_for_a_model_the_cascade_may_never_load(self):
        """Charging the worker for the primary engine would also delete Tesseract recovery."""
        self._memory(3900)
        est, adm = self.pool._admission("documents.ocr")
        self.assertEqual(est, 0, "the pool plans the worker, not the engine the cascade picks")
        self.assertTrue(adm["fits"], adm["reasons"])
        self.assertEqual(adm["floor_free_physical_mib"], resources.FLOOR_FREE_PHYSICAL_MIB,
                         "a model-backed capability still cannot load on a starved host")
        self._memory(500)
        _, refused = self.pool._admission("documents.ocr")
        self.assertFalse(refused["fits"], "saturation is still refused, engine choice or not")

    def test_commit_exhaustion_is_a_separate_reason(self):
        # Pinned on a pool-charged capability: since the F91 deferral (2026-11-23) the
        # pool charges NO engine estimate to a caller-gated capability (the cascade and
        # the ASR dispatcher own that decision), so the commit-exhaustion distinction
        # lives where the pool still does the charging. The gated path's commit law is
        # the dispatcher's own ceiling guard - test_asr_dispatch.Placement.
        self._memory(20000, commit_avail_mib=100)
        _, adm = self.pool._admission("rerank")
        self.assertFalse(adm["fits"])
        self.assertIn("commit charge", "; ".join(adm["reasons"]))

    def test_the_asr_and_ocr_callers_are_the_admission_gated_pair(self):
        from ruke_ml.models.lifecycle import CALLER_GATED_ADMISSION
        self.assertEqual(CALLER_GATED_ADMISSION, frozenset({"documents.ocr", "speech.asr"}),
                         "the gate is exactly the two callers that plan their own device, "
                         "engine and window; a new entry must name its dispatcher first")

    def test_the_asr_commit_shortfall_is_deferred_while_a_wider_window_exists(self):
        """F91 law, measured batch state 2026-11-23: 2,073 MiB free physical, the reserve
        floors the normal window to 256 MiB, under the ASR rows' measured commit demand.
        Pre-F91 the pool refused the worker BEFORE the dispatcher saw the job, so the
        exclusive window - the state the shortage is meant to trigger - never ran, and
        fr-U1 settled for the retained whisper fallback. With automatic handoff ON the
        shortfall must be DEFERRED, not refused, while saturation of free RAM itself
        stays a refusal (test_refusal_is_typed_retryable...)."""
        self._memory(2073)
        with mock.patch.object(provider_config, "load",
                               return_value=mock.Mock(automatic_handoff=True)):
            short = self.pool._commit_ceiling_shortfall("speech.asr")
            self.assertIsNotNone(short,
                                 "this host state must genuinely carry the shortfall - "
                                 "otherwise the deferral test below is tautological")
            req = JobRequest(request_id="m2", run_id="run", job_id="job-m2",
                             capability="speech.asr",
                             payload={"path": "a.mp3", "root": "."})
            self.assertIsNone(self.pool._admission_refusal(req),
                              "the dispatcher owns the placement; a normal-window ceiling "
                              "must not delete the exclusive window it can take")

    def test_with_the_handoff_policy_off_the_commit_shortfall_is_still_refused(self):
        """The deferral is sound only while a wider window can exist. With automatic
        handoff OFF the only placement left is the CPU squeeze inside the tight ceiling,
        so the typed pre-spawn refusal stands, naming the policy as the reason."""
        self._memory(2073)
        with mock.patch.object(provider_config, "load",
                               return_value=mock.Mock(automatic_handoff=False)):
            req = JobRequest(request_id="m3", run_id="run", job_id="job-m3",
                             capability="speech.asr",
                             payload={"path": "a.mp3", "root": "."})
            res = self.pool._admission_refusal(req)
        self.assertIsNotNone(res)
        assert res is not None
        assert res.error is not None
        self.assertEqual(res.error.reason, "memory_pressure")
        self.assertTrue(res.error.retryable)
        self.assertEqual(res.payload["refused_for"], "commit_ceiling_below_measured_demand")
        self.assertIn("automatic-handoff policy is off",
                      res.payload["commit_ceiling"]["refuse_reason"])
        self.assertIn("already on disk", res.error.human_step,
                      "the remedy is freeing commit charge, never re-downloading weights")

    def test_refusal_is_typed_retryable_and_names_what_would_change_it(self):
        self._memory(400)
        req = JobRequest(request_id="m1", run_id="run", job_id="job-m1", capability="speech.asr",
                         payload={"path": "a.mp4", "root": "."})
        res = self.pool._admission_refusal(req)
        self.assertIsNotNone(res)
        assert res is not None
        self.assertEqual(res.state, "failed")
        assert res.error is not None
        self.assertEqual(res.error.reason, "memory_pressure")   # the frozen contract's reason
        self.assertTrue(res.error.retryable)
        self.assertTrue(res.error.human_step)
        # D-073: the speech.asr row now carries a MEASURED commit peak (1,276 MiB), so on a
        # saturated host the precise cause is that the commit ceiling this host can offer is
        # under that demand. Both tags are the same typed reason; what this test pins is that
        # the refusal names a cause a human can act on, and when the commit cause is the one
        # reported the remedy must NOT be "re-prepare the asset".
        self.assertIn(res.payload["refused_for"],
                      ("host_memory", "commit_ceiling_below_measured_demand"))
        if res.payload["refused_for"] == "commit_ceiling_below_measured_demand":
            self.assertIn("already on disk", res.error.human_step)
            self.assertIn("commit_ceiling", res.payload)
        self.assertIn("unloaded_heavy_workers", res.payload)


class Ceilings(unittest.TestCase):
    """A worker's commit ceiling is clamped to RAM that actually exists."""

    def setUp(self):
        self.pool = WorkerPool()
        self.addCleanup(self.pool.stop_all)

    def _memory(self, available_mib: int):
        patch = mock.patch.object(resources, "system_memory", return_value=fake_memory(available_mib))
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_ceiling_is_clamped_to_free_ram_minus_the_floor_and_reserve(self):
        """B8 measured law: the worker ceiling cannot exceed the measured normal window, and
        that window pays the 1,024 MiB free-physical floor AND the 2 GiB system reserve.

        3,572 MiB free physical leaves 3,572 - 1,024 - 2,048 = 500 MiB of window: under the
        1,536 MiB demand-derived ceiling, so 500 MiB is what the worker gets. (The old law
        clamped to free-minus-floor only, 2,548 MiB here, which was the fiction B8 retired.)
        """
        self._memory(1024 + 2048 + 500)
        limit, note = self.pool._ceiling_bytes("documents.parse", heavy=True)
        self.assertEqual(limit, 500 << 20, note)
        self.assertEqual(note["window_ceiling_bytes"], 500 << 20)
        self.assertIn("physical", note["window_bound_by"])

    def test_below_the_floor_the_ceiling_is_the_smallest_useful_one(self):
        self._memory(300)
        limit, note = self.pool._ceiling_bytes("documents.parse", heavy=True)
        self.assertEqual(limit, 256 << 20, note)

    def test_ample_ram_keeps_the_measured_ceiling(self):
        self._memory(30000)
        limit, note = self.pool._ceiling_bytes("documents.parse", heavy=True)
        self.assertNotIn("clamped_from_bytes", note)
        self.assertEqual(limit, 1536 << 20, "the unmeasured light default, labelled unmeasured")
        self.assertEqual(note["estimate"], "unmeasured")


class WorkerResidency(unittest.TestCase):
    """Warm workers are kept when the host has room and released when it does not."""

    def setUp(self):
        self.req = JobRequest(request_id="m2", run_id="run", job_id="job-m2", capability="rerank",
                              payload={"query": "C++ move semantics", "chunks": [
                                  {"chunk_id": "a", "text": "C++ move semantics and rvalue references",
                                   "source_id": "s", "source_hash": "h"}]})

    def test_a_healthy_host_keeps_the_worker_warm(self):
        pool = WorkerPool()
        self.addCleanup(pool.stop_all)
        with mock.patch.object(pool, "_under_pressure", return_value=False):
            res = pool.run(self.req, deadline_s=60)
            self.assertEqual(res.state, "ready", res.to_dict())
            self.assertIn("rerank", pool.report(), "warm reuse is a latency win with no quality cost")
            self.assertEqual(pool.pressure_releases(), 0)

    def test_a_saturated_host_gets_the_ram_back_immediately_after_the_job(self):
        pool = WorkerPool()
        self.addCleanup(pool.stop_all)
        with mock.patch.object(pool, "_under_pressure", return_value=True):
            res = pool.run(self.req, deadline_s=60)
            self.assertEqual(res.state, "ready", res.to_dict())
            self.assertNotIn("rerank", pool.report(),
                             "a finished heavy worker must not rent RAM on a starved host")
            self.assertEqual(pool.pressure_releases(), 1)
            self.assertTrue(pool.ceiling_evidence(), "its peak commit must still be recorded")


class Definitions(unittest.TestCase):
    def test_the_health_report_keeps_the_two_quantities_apart(self):
        with mock.patch.object(resources, "system_memory", return_value=fake_memory(1500)):
            rep = resources.memory_report()
        self.assertTrue(rep["measured"])
        self.assertEqual(rep["free_physical_mib"], 1500)
        self.assertEqual(rep["commit_available_mib"], 27 * 1024)
        self.assertNotEqual(rep["free_physical_mib"], rep["commit_available_mib"])
        self.assertIn("definitions", rep, "an aggregate without definitions is how this was missed")

    def test_pressure_is_decided_from_free_physical_ram_too(self):
        pool = WorkerPool()
        self.addCleanup(pool.stop_all)
        with mock.patch.object(resources, "system_memory", return_value=fake_memory(900)):
            self.assertTrue(pool._under_pressure(), "1024 MiB floor: 900 MiB free is pressure")
        with mock.patch.object(resources, "system_memory", return_value=fake_memory(4000)):
            self.assertFalse(pool._under_pressure(), "4 GiB free is not pressure; workers stay warm")


if __name__ == "__main__":
    unittest.main()
