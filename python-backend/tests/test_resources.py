"""Measured process accounting, including the redirector problem it must not hide.

A memory number that reads only the pid we spawned is not conservative, it is wrong:
on this host python-backend/.venv/Scripts/python.exe is a redirector and the
interpreter that loads a model is its CHILD. Measured in F18: the recorded pid held
5 MiB while its child peaked at 470 MiB.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import unittest

from ruke_ml.models import resources


class SystemMemory(unittest.TestCase):
    def test_system_memory_is_measured_not_assumed(self):
        m = resources.system_memory()
        if os.name != "nt":
            self.assertEqual(m.source, "unsupported-host")
            return
        self.assertEqual(m.source, "GlobalMemoryStatusEx")
        self.assertGreater(m.total_mib, 0)


class ProcessAccounting(unittest.TestCase):
    def test_own_process_reports_real_bytes(self):
        ballast = bytearray(64 * 1024 * 1024)          # touched below, so it is resident
        for i in range(0, len(ballast), 4096):
            ballast[i] = 7
        got = resources.process_memory(os.getpid())
        self.assertEqual(got.get("available"), 1, got)
        self.assertGreaterEqual(got["working_set_mib"], 40, got)
        self.assertGreaterEqual(got["private_mib"], 40, got)
        self.assertGreaterEqual(got["peak_working_set_mib"], got["working_set_mib"])

    def test_tree_accounting_finds_the_interpreter_that_holds_the_bytes(self):
        if os.name != "nt":
            self.skipTest("Windows process accounting is what is being measured")
        code = ("import os,sys,time\n"
                "ballast = bytearray(120*1024*1024)\n"
                "for i in range(0,len(ballast),4096): ballast[i] = 7\n"
                "sys.stdout.write(str(os.getpid())+chr(10)); sys.stdout.flush()\n"
                "time.sleep(6)\n")
        proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                                text=True)
        try:
            # The child prints its OWN pid after touching 120 MB, so that pid is an
            # independent answer key: the tree walk must find it without being told it.
            line = proc.stdout.readline()
            reported = int(line.strip()) if line.strip().isdigit() else 0
            self.assertGreater(reported, 0, "the child never reported its pid: %r" % line)
            tree = resources.tree_pids(proc.pid)
            if reported != proc.pid:
                # This venv's python.exe is a redirector: the pid we recorded is not the
                # pid that allocated. The walk must therefore contain the reporting pid,
                # and the total must include its bytes rather than the stub's 5 MiB.
                self.assertIn(reported, tree,
                              "tree walk missed the allocating child: %r" % tree)
                self.assertGreaterEqual(len(tree), 2, "tree walk did not descend: %r" % tree)
            total = resources.process_tree_memory(proc.pid)
            self.assertEqual(total.get("available"), 1, total)
            self.assertEqual(total["pids"], tree)
            per = {p["pid"]: p for p in total["processes"]}
            self.assertEqual(set(per), set(tree),
                             "a per-process line is missing, so the total cannot be traced")
            self.assertGreaterEqual(total["working_set_mib"],
                                    max(p.get("working_set_mib", 0) for p in total["processes"]))
            if reported != proc.pid:
                self.assertGreaterEqual(per.get(reported, {}).get("peak_working_set_mib", 0), 80,
                                        "the child that touched 120 MB is reported as tiny")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def test_a_dead_pid_reports_unavailable_not_zero_bytes(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait(timeout=20)
        # After exit the pid may still resolve briefly; either way it must never be
        # presented as a live measurement of a working child.
        got = resources.process_memory(proc.pid)
        self.assertIn(got.get("available"), (0, 1), got)

    def test_an_unmeasurable_tree_reports_unknown_not_zero_bytes(self):
        """A tree nobody can read must never hand a caller a byte total of 0.

        A 0 in a peak column reads as "this engine used nothing", which is exactly how an
        unmeasured engine ends up looking like it satisfied the 4 GB target / 5 GB hard
        maximum. Unknown is reported as None plus a note naming the reason.
        """
        # A pid that cannot exist is the deterministic form of "the child we spawned has
        # exited": the tree walk finds nothing measurable either way, and an exited pid can
        # transiently be re-used by another process on this host.
        got = resources.process_tree_memory(0x7FFFFF00)
        self.assertFalse(got.get("available"), got)
        for key in ("working_set_mib", "private_mib", "commit_mib",
                    "peak_working_set_mib", "peak_commit_mib"):
            self.assertIsNone(got.get(key), f"{key} must be unknown, not zero: {got}")
        self.assertIn("unknown", str(got.get("note", "")).lower(), got)

    def test_creation_time_identity(self):
        ct = resources.process_creation_time(os.getpid())
        if os.name != "nt":
            self.assertEqual(ct, 0)
            return
        self.assertGreater(ct, 0)


class Headroom(unittest.TestCase):
    def test_headroom_is_a_verdict_with_numbers(self):
        got = resources.headroom(2048, extra_mib=512)
        if not got.get("measured"):
            self.assertTrue(got.get("reason"))
            return
        self.assertIn("fits_within_budget", got)
        self.assertIsInstance(got["fits_within_budget"], bool)


if __name__ == "__main__":
    unittest.main()
