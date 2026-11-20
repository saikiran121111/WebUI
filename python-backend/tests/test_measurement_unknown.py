"""A missing measurement is reported as unknown, never as a zero.

WHY THESE TESTS EXIST (amendment 12, review finding 6, and the sweep across the rest of
the class): the resource ledger kept answering questions it was never asked. A process
that could not be queried summed as 0 MiB used; a GPU row that answered memory.total but
not memory.used produced a confident "0 MiB free"; a subtraction against an unreadable
sample printed "freed 0 MiB", which reads as "the unload accomplished nothing"; and an
admission check that could not read the host reported a requirement of 0 MiB. Each of
those zeros then fed a budget claim, a placement decision or a report line.

Every rule below is the same rule: a quantity is either a measurement or it is None with
a sentence saying why. Provisional estimates stay labelled provisional.
"""
from __future__ import annotations

import os
import subprocess as _subprocess
import threading
import unittest
from unittest import mock

from ruke_ml import handoff
from ruke_ml.documents import ocr_paddle
from ruke_ml.models import devices, job_limits, resources


class SummingReportedRows(unittest.TestCase):
    def test_only_rows_that_reported_are_summed(self):
        rows = [{"pid": 1, "commit_mib": 10}, {"pid": 2, "commit_mib": 25}, {"pid": 3}]
        total, missing = resources.sum_reported_mib(rows, "commit_mib")
        self.assertEqual(total, 35, "the total covers the two rows that reported")
        self.assertEqual(missing, 1, "the row that did not report is counted, not zeroed")

    def test_no_reporting_row_is_unknown_not_zero(self):
        total, missing = resources.sum_reported_mib([{"pid": 1}, {"pid": 2}], "commit_mib")
        self.assertIsNone(total, "nothing was measured, so the answer is unknown")
        self.assertEqual(missing, 2)

    def test_tree_total_names_the_field_that_went_unmeasured(self):
        """A readable tree with one unreadable counter must not fold a 0 into the total."""
        rows = [{"available": 1, "working_set_mib": 120, "private_mib": 130,
                 "peak_working_set_mib": 140, "commit_mib": 150, "peak_commit_mib": 160},
                {"available": 1, "working_set_mib": 80, "private_mib": 90,
                 "peak_working_set_mib": 100}]
        with mock.patch.object(resources, "tree_pids", return_value=[11, 12]), \
                mock.patch.object(resources, "process_memory", side_effect=rows):
            got = resources.process_tree_memory(11)
        self.assertTrue(got["available"])
        self.assertEqual(got["working_set_mib"], 200)
        self.assertEqual(got["commit_mib"], 150, "the total covers the row that reported")
        self.assertEqual(got["peak_commit_mib"], 160)
        self.assertEqual(got["unmeasured_rows"], {"commit_mib": 1, "peak_commit_mib": 1})
        self.assertIn("UNKNOWN", got["note"])

    def test_unreadable_tree_still_reports_unknown(self):
        with mock.patch.object(resources, "tree_pids", return_value=[7]), \
                mock.patch.object(resources, "process_memory", return_value={"available": 0}):
            got = resources.process_tree_memory(7)
        self.assertFalse(got["available"])
        for field in resources.PEAK_FIELDS:
            self.assertIsNone(got[field])


class FoldingPeaks(unittest.TestCase):
    def test_an_unreported_field_is_counted_not_folded_as_zero(self):
        rec = {field: None for field in resources.PEAK_FIELDS}
        resources.fold_peak_sample(rec, {"working_set_mib": 500})
        self.assertEqual(rec["working_set_mib"], 500)
        self.assertIsNone(rec["commit_mib"], "no commit sample means no commit peak")
        self.assertEqual(rec["commit_mib_unmeasured_samples"], 1)
        self.assertTrue(rec["measured"])

    def test_maxima_never_degrade_and_never_invent(self):
        rec = {field: None for field in resources.PEAK_FIELDS}
        resources.fold_peak_sample(rec, {"working_set_mib": 900, "commit_mib": 1200})
        resources.fold_peak_sample(rec, {"working_set_mib": 300, "commit_mib": 400})
        self.assertEqual((rec["working_set_mib"], rec["commit_mib"]), (900, 1200))
        resources.fold_peak_sample(rec, {})
        self.assertEqual((rec["working_set_mib"], rec["commit_mib"]), (900, 1200))

    def test_a_sample_that_reported_nothing_leaves_the_stage_unmeasured(self):
        rec = {field: None for field in resources.PEAK_FIELDS}
        resources.fold_peak_sample(rec, {"available": 1})
        self.assertFalse(rec["measured"], "an attempted sample is not a measurement")

    def test_ocr_child_monitor_reports_unknown_not_zero(self):
        stop = threading.Event()
        samples = [{"available": 1, "pids": [5], "working_set_mib": 640, "commit_mib": 1500},
                   {"available": 1, "pids": [5], "working_set_mib": 700}]

        def fake_tree(pid: int) -> dict:
            sample = samples[min(len(samples) - 1, fake_tree.n)]
            fake_tree.n += 1
            if fake_tree.n >= len(samples):
                stop.set()
            return sample

        fake_tree.n = 0
        out: dict = {}
        with mock.patch.object(resources, "process_tree_memory", side_effect=fake_tree):
            ocr_paddle._monitor(5, stop, out)
        self.assertEqual(out["peak_working_set_mib"], 700)
        self.assertEqual(out["peak_commit_mib"], 1500, "a real sample is still kept")
        self.assertEqual(out["unmeasured_field_samples"], {"commit_mib": 1})
        self.assertIsNone(out["last_tree"]["commit_mib"],
                          "the last snapshot answered nothing for that field, so it shows unknown")


class GpuRowsThatHalfAnswer(unittest.TestCase):
    def test_a_field_the_driver_refused_to_answer_is_None(self):
        class Done:
            returncode = 0
            stdout = "NVIDIA GeForce RTX 5070, [N/A], 9483\n"

        with mock.patch.object(resources.subprocess, "run", return_value=Done()):
            rows = resources.vram()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["total_mib"], "[N/A] is not zero bytes of VRAM")
        self.assertEqual(rows[0]["used_mib"], 9483)

    def test_no_readable_row_means_VRAM_is_unknown(self):
        devices.clear_cache()
        rows = [{"name": "gpu0", "total_mib": None, "used_mib": 4096}]
        with mock.patch.object(resources, "vram", return_value=rows):
            state = devices.vram_state(force=True)
        devices.clear_cache()
        self.assertFalse(state.available)
        self.assertEqual(state.source, "nvidia-smi-unreadable")
        self.assertIn("unknown, not zero", state.detail)
        self.assertIsNone(state.as_dict()["free_mib"])

    def test_a_partial_row_is_never_ranked_as_a_free_amount(self):
        devices.clear_cache()
        rows = [{"name": "contradictory", "total_mib": 12288, "used_mib": 9999999},
                {"name": "real", "total_mib": 12288, "used_mib": 9483}]
        with mock.patch.object(resources, "vram", return_value=rows):
            state = devices.vram_state(force=True)
        devices.clear_cache()
        self.assertTrue(state.available)
        self.assertEqual(state.free_mib, 2805)
        self.assertEqual(state.detail.split(";")[0], "1 of 2 GPU row(s) readable",
                         "a row whose figures contradict each other is not evidence of 0 MiB free")
        self.assertIsNone(state.devices[0]["free_mib"])
        self.assertEqual(state.devices[1]["free_mib"], 2805)


class PlacementEvidence(unittest.TestCase):
    def test_an_unreadable_host_does_not_claim_a_zero_ram_requirement(self):
        unreadable = resources.Memory(total_mib=0, available_mib=0, commit_total_mib=0,
                                      commit_avail_mib=0, source="unreadable")
        devices.clear_cache()
        with mock.patch.object(resources, "system_memory", return_value=unreadable), \
                mock.patch.object(devices, "vram_state",
                                  return_value=devices.VramState(False, 0, [], "unknown", "x")):
            plan = devices.device_plan("documents.ocr", est_peak_mib=3300,
                                       est_peak_vram_mib=6000, est_basis="measured")
        self.assertFalse(plan.evidence["ram"]["measured"])
        self.assertIsNone(plan.evidence["charged"]["required_ram_mib"],
                          "an unreadable host has no known requirement, and 0 would read as "
                          "this job needing nothing")
        self.assertFalse(plan.fits)

    def test_a_measured_host_still_reports_the_number_it_needs(self):
        mem = resources.Memory(total_mib=65299, available_mib=9000, commit_total_mib=100115,
                               commit_avail_mib=27000, source="GlobalMemoryStatusEx")
        devices.clear_cache()
        with mock.patch.object(resources, "system_memory", return_value=mem), \
                mock.patch.object(devices, "vram_state",
                                  return_value=devices.VramState(True, 9000, [], "ok")):
            plan = devices.device_plan("documents.ocr", est_peak_mib=3300,
                                       est_peak_vram_mib=6000, est_basis="measured",
                                       est_vram_basis="measured")
        self.assertIsInstance(plan.evidence["charged"]["required_ram_mib"], int)
        self.assertGreaterEqual(plan.evidence["charged"]["required_ram_mib"], 3300)


class LiveJobCharge(unittest.TestCase):
    def test_a_member_that_cannot_be_queried_gives_unknown_not_zero(self):
        job, created = job_limits.create(2 << 30, name="ruke-unknown-live")
        self.assertIsNotNone(job, "this host supports job objects; the ceiling is enforceable")
        try:
            job.members.append(4243)          # walked by the sampler, never assigned to the job
            with mock.patch.object(resources, "tree_pids", return_value=[999999]), \
                    mock.patch.object(resources, "process_memory",
                                      return_value={"available": 0}):
                got = job.current_commit()
            self.assertFalse(got["available"])
            self.assertIsNone(got["commit_mib"], "unknown live charge, never 0 MiB")
            self.assertIn("UNKNOWN", got["note"])
        finally:
            job.close()

    def test_a_partly_readable_tree_marks_the_total_a_lower_bound(self):
        job, _ = job_limits.create(2 << 30, name="ruke-partial-live")
        self.assertIsNotNone(job)
        rows = [{"available": 1, "working_set_mib": 50, "commit_mib": 80},
                {"available": 1, "working_set_mib": 30}]
        try:
            job.members.append(4242)          # walked, never assigned to the kernel job
            with mock.patch.object(resources, "tree_pids", return_value=[1, 2]), \
                    mock.patch.object(resources, "process_memory", side_effect=rows):
                got = job.current_commit()
            self.assertTrue(got["available"])
            self.assertEqual(got["commit_mib"], 80)
            self.assertEqual(got["working_set_mib"], 80)
            self.assertEqual(got["unmeasured_rows"]["commit_mib"], 1)
            self.assertEqual(got["measured_rows"], 2)
        finally:
            job.close()


class HandoffFreedAmounts(unittest.TestCase):
    def test_two_real_samples_give_the_difference(self):
        before = {"free_physical_mib": 4000, "free_vram_mib": 200}
        after = {"free_physical_mib": 55079, "free_vram_mib": 9683}
        self.assertEqual(handoff._freed_physical_mib(before, after), (51079, ""))
        self.assertEqual(handoff._freed_vram_mib(before, after)[0], 9483)

    def test_an_unreadable_sample_makes_the_freed_amount_unknown(self):
        before = {"free_physical_mib": 4000, "free_vram_mib": 200}
        after = {"free_physical_mib": None, "free_vram_mib": None}
        freed, why = handoff._freed_physical_mib(before, after)
        self.assertIsNone(freed)
        self.assertIn("UNKNOWN", why)
        self.assertIn("after sample", why)
        self.assertIsNone(handoff._freed_vram_mib(None, after)[0])
        vwhy = handoff._freed_vram_mib(before, after)[1]
        self.assertIn("free VRAM", vwhy)


if __name__ == "__main__":
    unittest.main()
