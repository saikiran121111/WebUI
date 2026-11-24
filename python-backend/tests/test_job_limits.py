"""Enforceable ceilings, not sampled ones (amendment 2, section 3).

The brief's memory rule is a hard maximum, and "we poll and notice" is not a maximum: the
allocation happens between samples. These tests therefore assert that an allocation inside
an owned child actually FAILS once the job is at its ceiling, and that the peak charge the
OS recorded is available as evidence afterwards.

Skips are only used where the mechanism does not exist at all (a non-Windows host) or where
the OS itself refused the ceiling; a refusal then names its win32 error instead of passing.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest

from ruke_ml.models import job_limits as jl

ALLOC_200MIB = "x = bytearray(200 << 20)\nprint('allocated', len(x))\n"


def _spawn_alloc_child() -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", ALLOC_200MIB],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


class JobObjectMechanism(unittest.TestCase):
    def setUp(self):
        if not jl.supported():
            self.skipTest("job objects are a Windows mechanism")

    def test_positive_limit_required(self):
        job, report = jl.create(0, name="ruke-test-zero")
        self.assertIsNone(job)
        self.assertFalse(report["enforced"])
        self.assertIn("positive", report["reason"])

    def test_ceiling_rejects_an_allocation_that_exceeds_it(self):
        """The whole point: the child's allocation fails, its work does not silently proceed."""
        job, report = jl.create(64 << 20, name="ruke-test-64mib")
        self.assertIsNotNone(job, report)
        assert job is not None
        self.assertTrue(report["enforced"])
        child = _spawn_alloc_child()
        try:
            attached = job.assign_popen(child)
            self.assertTrue(attached["assigned"], attached)
            out, err = child.communicate(timeout=60)
            self.assertNotEqual(child.returncode, 0, f"child succeeded: {out!r}")
            self.assertIn("MemoryError", err)
            self.assertNotIn("allocated", out)
        finally:
            if child.poll() is None:
                child.kill()
            peaks = job.peaks()
            job.close()
        self.assertTrue(peaks["available"])
        self.assertGreaterEqual(peaks["peak_job_commit_mib"], 60, peaks)

    def test_peak_evidence_is_reported_in_mib(self):
        job, _ = jl.create(64 << 20, name="ruke-test-peak")
        assert job is not None
        child = _spawn_alloc_child()
        try:
            self.assertTrue(job.assign_popen(child)["assigned"])
            child.communicate(timeout=60)
        finally:
            if child.poll() is None:
                child.kill()
            peaks = job.peaks()
            job.close()
        # The OS rounds a ceiling down to a page boundary, so assert the alignment rule
        # instead of a hand-computed byte count.
        self.assertLessEqual(peaks["limit_bytes"], 64 << 20)
        self.assertEqual(peaks["limit_bytes"] % 4096, 0, peaks)
        self.assertGreater(peaks["peak_process_commit_mib"], 0, peaks)

    def test_live_charge_is_measured_per_member(self):
        """The extended block reports the peak but no live value, so the live sum is measured."""
        job, _ = jl.create(2 << 30, name="ruke-test-live")
        assert job is not None
        child = subprocess.Popen([sys.executable, "-c",
                                  "import time\nx = bytearray(60 << 20)\ntime.sleep(4)\n"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(job.assign_popen(child)["assigned"])
            live = None
            for _ in range(80):
                live = job.current_commit()
                if live["available"] and live["commit_mib"] >= 40:
                    break
                if child.poll() is not None:
                    break
                import time as _t
                _t.sleep(0.05)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=20)
            job.close()
        self.assertTrue(live and live["available"], live)
        self.assertGreaterEqual(live["commit_mib"], 40, live)


class RuntimeTreeJob(unittest.TestCase):
    """Installing on the supervisor is what bounds a lazily spawned heavy child in advance.

    Children created by a job member join the job at create time, so unlike an assignment
    after CreateProcess there is no window in which the child can allocate past the ceiling.
    """

    def setUp(self):
        if not jl.supported():
            self.skipTest("job objects are a Windows mechanism")

    def test_self_assignment_reports_the_mechanism_honestly(self):
        report = jl.install_process_job()
        if not report.get("enforced"):
            # A refusal is an acceptance failure for the hard ceiling, and it must name why.
            self.assertIn("reason", report, report)
            self.assertIsNotNone(report.get("win32_error"), report)
            self.skipTest(f"OS refused the runtime-tree ceiling: {report}")
        self.assertEqual(report["mechanism"], "windows-job-object")
        # MEASURED law (B8): the default install derives the tree cap from the host at startup
        # - bounded by the exclusive-window ceiling, the widest window the policy allows - and
        # the report names the provenance; the number must sit inside the documented band.
        self.assertIn("measured exclusive-window", report.get("limit_source", ""))
        self.assertGreaterEqual(report["limit_bytes"], jl.CEILING_FLOOR_BYTES)
        self.assertLessEqual(report["limit_bytes"], jl.EXCLUSIVE_LIMIT_BYTES_DEFAULT)
        self.assertTrue(report["self_assigned"])
        self.assertIn("outer_job", report)
        self.assertTrue(jl.status()["enforced"])

    def test_install_is_idempotent_and_children_inherit(self):
        first = jl.install_process_job()
        second = jl.install_process_job()
        self.assertEqual(first["limit_bytes"], second["limit_bytes"])
        if not first.get("enforced"):
            self.skipTest(f"OS refused the runtime-tree ceiling: {first}")
        # A grandchild of a job member must hit the same ceiling without any further attach.
        grand, report = jl.create(64 << 20, name="ruke-test-inherit")
        self.assertIsNotNone(grand, report)
        assert grand is not None
        child = _spawn_alloc_child()
        try:
            self.assertTrue(grand.assign_popen(child)["assigned"])
            _, err = child.communicate(timeout=60)
            self.assertIn("MemoryError", err)
        finally:
            if child.poll() is None:
                child.kill()
            grand.close()

    def test_attach_child_needs_a_job_or_a_limit(self):
        class Fake:
            pid = os.getpid()

        saved, jl._INSTALLED = jl._INSTALLED, None
        try:
            report = jl.attach_child(Fake())
        finally:
            jl._INSTALLED = saved
        if report.get("enforced"):
            self.skipTest("unsupported-host path not applicable on this host")
        self.assertIn("reason", report, report)

    def test_limits_match_the_agreed_budget(self):
        """The MEASURED law's constants, pinned as numbers (B8 final decision 2026-11-22).

        AGGREGATE_LIMIT_BYTES survives as the documented fallback for an unmeasurable host,
        not as the operating ceiling; the normal window's configured maximum is an operator
        cap (7 GB) whose band keeps a bad environment value from disabling protection.
        """
        self.assertEqual(jl.AGGREGATE_LIMIT_BYTES, 5_000_000_000)
        self.assertEqual(jl.NORMAL_LIMIT_BYTES_DEFAULT, 7_000_000_000)
        self.assertEqual(jl.NORMAL_LIMIT_ENV, "RUKE_LIMIT_BYTES")
        self.assertEqual(jl.NORMAL_LIMIT_CONFIG_MIN, 1 << 30)
        self.assertEqual(jl.NORMAL_LIMIT_CONFIG_MAX, 12_000_000_000)
        self.assertLess(jl.NORMAL_LIMIT_CONFIG_MIN, jl.NORMAL_LIMIT_BYTES_DEFAULT)
        self.assertGreater(jl.NORMAL_LIMIT_CONFIG_MAX, jl.NORMAL_LIMIT_BYTES_DEFAULT)
        self.assertEqual(jl.CEILING_FLOOR_BYTES, 256 << 20)
        self.assertEqual(jl.SYSTEM_RESERVE_BYTES_DEFAULT, 2 * (1 << 30))
        job, _ = jl.create(jl.AGGREGATE_LIMIT_BYTES, name="ruke-test-aggregate")
        assert job is not None
        try:
            ceiling = job.peaks()["limit_bytes"]
        finally:
            job.close()
        # Measured on this host: the OS keeps the page-aligned part of the requested ceiling
        # (5,000,000,000 -> 4,999,999,488), i.e. it never rounds upward.
        self.assertLessEqual(ceiling, jl.AGGREGATE_LIMIT_BYTES)
        self.assertGreater(ceiling, jl.AGGREGATE_LIMIT_BYTES - 4096)
        self.assertEqual(jl.TARGET_LIMIT_BYTES, 4_000_000_000)
        self.assertLess(jl.TARGET_LIMIT_BYTES, jl.AGGREGATE_LIMIT_BYTES)


if __name__ == "__main__":
    unittest.main()


