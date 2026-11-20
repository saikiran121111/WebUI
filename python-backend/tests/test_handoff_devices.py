"""Mechanics tests for device placement, the LLM handoff lease and the OCR cascade.

SCOPE HONESTY: these tests prove DISPATCH MECHANICS - what gets chosen, what gets refused,
what gets recorded, and which typed reason a caller receives. The "primary engine" here is a
stub NDJSON worker, so NOTHING in this file establishes OCR quality or real paddle behaviour.
The one real-engine case is marked as such (real Tesseract recovery).
"""
from __future__ import annotations

import contextlib
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml import handoff
from ruke_ml.documents import ocr_cascade, ocr_paddle, ocr_tesseract
from ruke_ml.documents.ocr_tesseract import OcrPage, OcrUnavailable
from ruke_ml.models import devices, main_model, resources

from .test_retrieval_documents import _pdf_bytes, _text_stream

STUB_WORKER = '''"""Stub of ocr_paddle_worker.py: same NDJSON protocol, no paddle, no weights."""
import json
import sys
import time
from pathlib import Path

here = Path(__file__).resolve().parent
cfg_path = here / "stub_config.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.is_file() else {}
mode = cfg.get("mode", "ok")

header = json.loads(sys.stdin.readline() or "{{}}")
if mode == "load_error":
    print(json.dumps({{"event": "error", "detail": "stub refused to load"}}), flush=True)
    sys.exit(0)
if mode == "die_early":
    sys.stderr.write("stub died before ready\\n")
    sys.stderr.flush()
    sys.exit(3)
time.sleep(cfg.get("load_sleep", 0))
print(json.dumps({{"event": "ready", "device": cfg.get("device", "cpu"),
                   "cuda_compiled": cfg.get("cuda_compiled", False),
                   "paddle_version": "0.0.0-stub", "seconds": 0.01,
                   "dropped_kwargs": cfg.get("dropped_kwargs", []),
                   "header_seen": bool(header)}}), flush=True)

while True:
    line = sys.stdin.readline()
    if not line:
        break
    msg = json.loads(line)
    if msg.get("event") == "shutdown":
        break
    page = msg.get("page")
    image = str(msg.get("image") or "")
    if cfg.get("per_page_sleep"):
        time.sleep(cfg["per_page_sleep"])
    if cfg.get("fail_until_repair") and "repair" not in image:
        print(json.dumps({{"page": page, "state": "ocr_failed", "seconds": 0.01,
                           "detail": "stub failed on the first pass"}}), flush=True)
        continue
    states = cfg.get("page_states") or {{}}
    state = states.get(str(page), "recognised")
    text = "" if state != "recognised" else "stub text for page {{0}}".format(page)
    if cfg.get("crash_at_page") and str(page) == str(cfg["crash_at_page"]):
        sys.stderr.write("stub crashed\\n")
        sys.exit(7)
    print(json.dumps({{"page": page, "state": state, "text": text, "seconds": 0.01,
                       "confidence": cfg.get("confidence", 0.91),
                       "regions": [{{"text": "stub line", "bbox": [1, 2, 30, 12]}}],
                       "raw_json_path": cfg.get("raw_json_path", "")}}), flush=True)
'''


class FakeVram(devices.VramState):
    pass


def _vram(available: bool, free_mib: int = 0) -> devices.VramState:
    return devices.VramState(available, free_mib,
                             [{"name": "fake", "total_mib": 12288, "used_mib": 0,
                               "free_mib": free_mib}] if available else [],
                             "stub" if available else "stub: no gpu", "stub", 0.0)


def _ram(fits: bool, reasons: list[str] | None = None) -> dict:
    return {"measured": True, "fits": fits, "free_physical_mib": 4000 if fits else 700,
            "commit_available_mib": 20000, "reasons": reasons or ([] if fits
                                                                  else ["free physical RAM is "
                                                                        "700 MiB, under the floor"])}


class DevicePlacement(unittest.TestCase):
    """GPU needs measured VRAM evidence; CPU needs to pass its OWN RAM check."""

    def plan(self, *, ram_fits, free_vram, est_vram, allow_gpu=True, main_loaded=True):
        with mock.patch.object(resources, "admission", return_value=_ram(ram_fits)), \
                mock.patch.object(devices, "vram_state", return_value=_vram(True, free_vram)):
            return devices.device_plan(
                "documents.ocr", est_peak_mib=3300, est_peak_vram_mib=est_vram,
                est_basis="measured 2026-11-17", est_vram_basis="measured 2026-11-17",
                allow_gpu=allow_gpu, main_model={"loaded": main_loaded})

    def test_gpu_only_when_both_ram_and_vram_measurably_fit(self):
        plan = self.plan(ram_fits=True, free_vram=9000, est_vram=6000)
        self.assertEqual(plan.device, "gpu")
        self.assertTrue(plan.fits)
        self.assertFalse(plan.needs_handoff)

    def test_no_vram_estimate_never_guesses_the_gpu(self):
        plan = self.plan(ram_fits=True, free_vram=9000, est_vram=0)
        self.assertEqual(plan.device, "cpu")
        self.assertIn("no VRAM estimate", plan.reason)

    def test_insufficient_vram_falls_to_cpu_but_ram_still_decides(self):
        plan = self.plan(ram_fits=True, free_vram=2000, est_vram=6000)
        self.assertEqual(plan.device, "cpu")
        self.assertIn("free VRAM is 2000 MiB", plan.reason)

    def test_gpu_globally_disabled_is_stated_not_hidden(self):
        plan = self.plan(ram_fits=True, free_vram=9000, est_vram=6000, allow_gpu=False)
        self.assertEqual(plan.device, "cpu")
        self.assertIn("GPU execution is disabled", plan.reason)

    def test_cpu_fallback_that_does_not_fit_reports_handoff(self):
        """The point of amendment 5: CPU is not automatically cheaper on a RAM-starved host."""
        plan = self.plan(ram_fits=False, free_vram=9000, est_vram=6000)
        self.assertEqual(plan.device, "none")
        self.assertFalse(plan.fits)
        self.assertTrue(plan.needs_handoff)
        self.assertIn("main model is resident", plan.reason)

    def test_unmeasured_vram_basis_is_visible_in_the_evidence(self):
        with mock.patch.object(resources, "admission", return_value=_ram(True)), \
                mock.patch.object(devices, "vram_state", return_value=_vram(True, 9000)):
            plan = devices.device_plan("documents.ocr", est_peak_mib=3300, est_peak_vram_mib=6000)
        self.assertNotEqual(plan.evidence["est_vram_basis"], "measured",
                            "a declared number without a measurement is not evidence")
        self.assertIn("no recorded measurement", plan.evidence["est_vram_basis"])

    def test_provisional_estimates_are_charged_by_the_placement_too(self):
        """A provisional peak must not buy a GPU/CPU placement on measured-grade arithmetic.

        This is the shape production is actually in right now: ~3.9 GiB free while a 50 GiB
        model is resident, and a 3,300 MiB OCR estimate that has never been measured here.
        """
        mem = resources.Memory(total_mib=65299, available_mib=3943, commit_total_mib=100115,
                               commit_avail_mib=27000, source="GlobalMemoryStatusEx")
        with mock.patch.object(resources, "system_memory", return_value=mem), \
                mock.patch.object(devices, "vram_state", return_value=_vram(True, 2600)):
            plan = devices.device_plan(
                "documents.ocr", est_peak_mib=3300, est_peak_vram_mib=6000,
                est_basis="provisional: pinned weight bytes 1966 MiB + allowance",
                est_vram_basis="provisional: not yet a measured GPU peak",
                allow_gpu=False, main_model={"loaded": True, "endpoint": "http://127.0.0.1:8080"})
        self.assertEqual(plan.device, "none")
        self.assertFalse(plan.fits)
        self.assertTrue(plan.needs_handoff, "releasing the resident model is what would change it")
        self.assertIn("provisional load peak", plan.reason)
        self.assertEqual(plan.evidence["charged"]["ram_mib"], 4950)
        self.assertEqual(plan.evidence["charged"]["required_ram_mib"],
                         4950 + resources.UNMEASURED_MARGIN_MIB)
        # Same estimate, now actually measured beside the same resident model: it fits, and the
        # whole point is that the LLM stays loaded in that case.
        with mock.patch.object(resources, "system_memory", return_value=mem), \
                mock.patch.object(devices, "vram_state", return_value=_vram(True, 2600)):
            measured = devices.device_plan(
                "documents.ocr", est_peak_mib=3300, est_peak_vram_mib=6000,
                est_basis="measured: cold-load peak over the worker tree",
                est_vram_basis="measured: gpu peak", allow_gpu=False,
                main_model={"loaded": True, "endpoint": "http://127.0.0.1:8080"})
        self.assertEqual(measured.device, "cpu")
        self.assertTrue(measured.fits, measured.reason)
        self.assertFalse(measured.needs_handoff,
                         "a job that measurably fits must not trigger an unload")


class StubMainModel(main_model.MainModelProvider):
    name = "stub"

    def __init__(self, loaded=True, unload_ok=True, unload_status="unloaded"):
        self.base_url = "http://stub-llm"
        self.timeout_s = 1.0
        self.loaded = loaded
        self.unload_ok = unload_ok
        self.unload_status = unload_status
        self.calls: list[str] = []

    def inspect(self):
        return main_model.MainModelState(self.name, self.base_url, self.loaded,
                                         model="stub-model", reachable=True, detail="ok")

    def supports_lifecycle(self):
        return True, "stub lifecycle"

    def unload(self, wait_s=60.0):
        self.calls.append("unload")
        if not self.unload_ok:
            return {"ok": False, "status": "busy", "detail": "a turn is running",
                    "http_status": 409, "retry_after_s": None}
        self.loaded = False
        return {"ok": True, "status": self.unload_status, "detail": "stub unloaded",
                "http_status": 200, "retry_after_s": None}

    def load(self):
        self.calls.append("load")
        self.loaded = True
        return {"ok": True, "status": "loaded", "detail": "stub loaded", "http_status": 200,
                "retry_after_s": None}

    def wait_ready(self, timeout_s=0.0):
        self.calls.append("ready")
        return {"ok": True, "status": "loaded", "detail": "stub ready", "http_status": 200,
                "retry_after_s": None}


def _own_child(child: subprocess.Popen) -> None:
    """Terminate ONLY the child this test started, and wait for it."""
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)


class CoordinationRecordIntegrity(unittest.TestCase):
    """A coordination record must never be silently destroyed, and an
    unreadable one must never be read as "nobody is parked here".

    Amendment-7 defects 4 and 5 were exactly that: the writer truncated an
    oversized record into invalid JSON, and every reader (Python here, the Rust
    endpoint gate, the Node ASR path) reported "not held" for absent,
    unreadable AND malformed bytes alike. A truncated HELD lease therefore let
    inference walk into a window a heavyweight job had reserved.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f38-lease-"))
        for p in (mock.patch.object(handoff, "coord_dir", return_value=self.tmp),
                  mock.patch.object(handoff, "runtime_dir", return_value=self.tmp)):
            p.start()
            self.addCleanup(p.stop)

    def test_an_oversized_record_is_refused_and_never_truncated(self):
        lease = handoff.acquire(owner="writer")
        with self.assertRaises(handoff.RecordTooLarge):
            handoff._write_record(lease.fd, {"token": "x" * 4096, "owner": "y" * 1000})
        # The record on disk is still exactly one parseable object at width 512.
        raw = lease.path.read_bytes()
        self.assertEqual(len(raw), handoff.RECORD_WIDTH)
        self.assertEqual(json.loads(raw.split(b"\x00", 1)[0])["token"], lease.token)
        # Chatty diagnostics degrade to the identity core, they cannot corrupt it.
        handoff.heartbeat(lease, "processing", note="y" * 8000, device="cpu")
        state = handoff.lease_state()
        self.assertEqual(state["state"], "ok")
        self.assertEqual(state["holder"].get("phase"), "processing")
        self.assertEqual(state["holder"].get("owner"), "writer")
        self.assertEqual(len(lease.path.read_bytes()), handoff.RECORD_WIDTH)
        handoff.release(lease)

    def test_absent_unreadable_and_malformed_are_three_different_answers(self):
        absent = handoff.lease_state()
        self.assertEqual(absent["state"], "absent")
        self.assertFalse(absent["held"])

        (self.tmp / handoff.LEASE_NAME).write_bytes(b"not json at all" + b"\x00" * 400)
        malformed = handoff.lease_state()
        self.assertEqual(malformed["state"], "corrupt")
        self.assertTrue(malformed["held"], "a record we cannot parse proves nothing")
        self.assertTrue(malformed["uncertain"])

        (self.tmp / handoff.LEASE_NAME).unlink()
        (self.tmp / handoff.LEASE_NAME).mkdir()  # a directory cannot be read as a record
        unreadable = handoff.lease_state()
        self.assertEqual(unreadable["state"], "unreadable")
        self.assertTrue(unreadable["held"])
        self.assertTrue(unreadable["uncertain"])
        (self.tmp / handoff.LEASE_NAME).rmdir()

    def test_a_record_that_cannot_be_parsed_is_never_stolen(self):
        path = self.tmp / handoff.LEASE_NAME
        path.write_bytes(b'{"token": "abc", "owner": ' + b"\x00" * 480)  # cut JSON
        with self.assertRaises(handoff.LeaseHeld) as caught:
            handoff.acquire(owner="intruder")
        self.assertEqual(caught.exception.holder.get("owner"), "corrupt")
        self.assertIn("no holder can be ruled out", caught.exception.holder.get("detail", ""))
        self.assertTrue(path.is_file(), "a reader never deletes a record it did not write")

    def test_an_unverifiable_record_ages_out_on_its_own_age_and_only_when_asked(self):
        path = self.tmp / handoff.LEASE_NAME
        path.write_bytes(b"garbage-not-json" + b"\x00" * 400)
        past = time.time() - (handoff._stale_window_s() + 30.0)
        os.utime(str(path), (past, past))
        aged = handoff.lease_state()
        self.assertTrue(aged["abandoned"], "the file's own age is the only evidence here")
        self.assertFalse(aged["held"])
        with self.assertRaises(handoff.LeaseHeld):
            handoff.acquire(owner="default-client")
        recovered = handoff.acquire(owner="operator-break", break_stale=True)
        self.assertEqual(handoff.read_lease().get("owner"), "operator-break")
        handoff.release(recovered)

    def test_release_never_deletes_a_record_it_cannot_verify_as_ours(self):
        lease = handoff.acquire(owner="owner")
        lease.path.write_bytes(b"corrupted by someone else" + b"\x00" * 400)
        out = handoff.release(lease)
        self.assertFalse(out["released"])
        self.assertIn("could not be verified", out["detail"])
        self.assertTrue(lease.path.is_file(), "it ages out through the bounded window instead")

    def test_a_malformed_browser_lock_still_blocks_a_handoff(self):
        (self.tmp / handoff.PLAYWRIGHT_LOCK).write_bytes(b"heartbeat write torn" + b"\x00" * 400)
        with self.assertRaises(handoff.PlaywrightHeld):
            handoff.acquire(owner="ruke")


class LeaseAndHandoff(unittest.TestCase):
    """The lease is exclusive and never stolen; the handoff only unloads when it must."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f26-handoff-"))
        patches = [mock.patch.object(handoff, "coord_dir", return_value=self.tmp),
                   mock.patch.object(handoff, "runtime_dir", return_value=self.tmp),
                   mock.patch.object(handoff.devices, "vram_state", return_value=_vram(True, 2000))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    # ---- lease -----------------------------------------------------------------
    def test_second_acquirer_is_refused_without_touching_the_holder(self):
        lease = handoff.acquire(owner="first")
        with self.assertRaises(handoff.LeaseHeld) as caught:
            handoff.acquire(owner="second")
        self.assertEqual(caught.exception.holder.get("owner"), "first")
        self.assertEqual(handoff.read_lease().get("owner"), "first")
        self.assertEqual(handoff.release(lease).get("released"), True)

    def test_release_never_removes_a_foreign_lease(self):
        mine = handoff.acquire(owner="mine")
        other = handoff.Lease(mine.path, "not-my-token", "intruder", "waiting", 0.0, -1)
        out = handoff.release(other)
        self.assertFalse(out["released"])
        self.assertIn("not ours", out["detail"])
        self.assertTrue(mine.path.is_file())
        handoff.release(mine)

    def test_a_live_browser_window_outranks_the_handoff(self):
        (self.tmp / handoff.PLAYWRIGHT_LOCK).write_bytes(
            (json.dumps({"runId": "browser", "pid": os.getpid()}) + "\0" * 400).encode())
        with self.assertRaises(handoff.PlaywrightHeld):
            handoff.acquire(owner="ruke")

    def test_a_record_without_a_live_pid_is_provable_stale(self):
        # pid 1 is init/the System process: a different generation, so it is provable.
        (self.tmp / handoff.LEASE_NAME).write_bytes(
            (json.dumps({"owner": "dead", "pid": 1, "pid_created": 1, "phase": "processing"})
             + "\0" * 400).encode()[:512])
        state = handoff.lease_state()
        self.assertTrue(state["held"])
        self.assertFalse(state["holder"].get("pid_created") == 1 and state["alive"])
        lease = handoff.acquire(owner="recovered", break_stale=True)
        self.assertEqual(handoff.read_lease().get("owner"), "recovered")
        handoff.release(lease)

    def test_stale_by_pid_reuse_breaks_the_record_and_touches_no_process(self):
        # INCIDENT REGRESSION (DECISIONS.md D-054): an earlier acquire() terminated the pid
        # recorded in a stale lease. Staleness can be PROVEN BY PID REUSE, in which case that
        # number belongs to an unrelated live process, which is exactly what got killed. A stale
        # record must therefore only ever be unlinked.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(_own_child, child)
        deadline = time.time() + 10.0
        while resources.process_creation_time(child.pid) == 0 and time.time() < deadline:
            time.sleep(0.05)
        live_created = resources.process_creation_time(child.pid)
        self.assertNotEqual(live_created, 0, "the innocent process must be live")
        (self.tmp / handoff.LEASE_NAME).write_bytes(
            (json.dumps({"owner": "long-gone", "pid": child.pid,
                         "pid_created": live_created + 1, "phase": "processing"})
             + "\0" * 400).encode()[:512])
        state = handoff.lease_state()
        self.assertTrue(state["held"])
        self.assertTrue(state["stale"])
        self.assertIn("reused", str(state["proof"]))
        lease = handoff.acquire(owner="recovered-after-reuse", break_stale=True)
        try:
            self.assertEqual(handoff.read_lease().get("owner"), "recovered-after-reuse")
        finally:
            handoff.release(lease)
        self.assertIsNone(child.poll(),
                          "breaking a stale lease must never terminate the process holding its pid")
        self.assertEqual(resources.process_creation_time(child.pid), live_created)

    def test_the_lease_module_has_no_process_termination_path(self):
        # Locks in the D-054 fix: nothing in handoff.py may kill a process, so the class of
        # bug that killed an unrelated process cannot silently come back.
        src = Path(handoff.__file__).read_text(encoding="utf-8")
        for forbidden in ("TerminateProcess", "OpenProcess", "os.kill", "_terminate_holder",
                          "import ctypes"):
            self.assertNotIn(forbidden, src, f"handoff.py must not contain {forbidden!r}")

    # ---- state machine ---------------------------------------------------------
    def test_the_lease_heartbeat_advances_during_a_slow_unit_and_stops_cleanly(self):
        # WHY THIS EXISTS: the Rust shared-endpoint gate decides "is the
        # holder alive?" from the lease heartbeat. A single OCR page can run
        # for minutes, so a lease that only refreshes on phase changes would
        # look ABANDONED mid-page and let inference into the window.
        lease = handoff.acquire(owner="slow-holder", phase="processing")
        thread = handoff.start_heartbeat(lease, interval_s=0.05)
        try:
            first = handoff.read_lease().get("heartbeat")
            time.sleep(0.30)
            later = handoff.read_lease().get("heartbeat")
            self.assertGreater(later, first, "a live window must keep refreshing")
            self.assertEqual(handoff.read_lease().get("phase"), "processing",
                             "refreshing must not rewrite the phase")
            self.assertTrue(lease.path.is_file())
        finally:
            handoff.stop_heartbeat(thread)
        stopped = handoff.read_lease().get("heartbeat")
        time.sleep(0.20)
        self.assertEqual(handoff.read_lease().get("heartbeat"), stopped,
                         "no heartbeat write may land after the window stops")
        self.assertFalse(thread.is_alive())
        self.assertEqual(lease.phase, "processing")
        handoff.release(lease)

    def test_run_exclusive_refreshes_the_lease_and_stops_before_releasing_it(self):
        provider = StubMainModel(loaded=True)
        plan = devices.DevicePlan("documents.ocr", "cpu", True, False, "CPU fits", {})
        real_start, real_stop = handoff.start_heartbeat, handoff.stop_heartbeat
        threads: list = []
        order: list[str] = []

        def start(lease, interval_s=0.05):
            thread = real_start(lease, interval_s=interval_s)
            threads.append(thread)
            return thread

        def stop(thread):
            # At stop time the lease must STILL be ours: stopping after
            # release would let a stale write re-fresh a foreign lease.
            order.append(str(handoff.read_lease().get("owner")))
            real_stop(thread)

        observed: dict[str, bool] = {}

        def work(_plan):
            before = handoff.read_lease().get("heartbeat")
            time.sleep(0.30)
            observed["advanced"] = handoff.read_lease().get("heartbeat") > before
            return {"peak": {"working_set_mib": 900}, "persisted": True}

        with mock.patch.object(handoff, "start_heartbeat", start), \
                mock.patch.object(handoff, "stop_heartbeat", stop):
            out, _seen = self._run(provider, [plan], work=work)

        self.assertTrue(out["ok"])
        self.assertTrue(observed.get("advanced"),
                        "run_exclusive must heartbeat through a slow work unit")
        self.assertEqual(len(threads), 1, "exactly one heartbeat thread per window")
        self.assertEqual(order, ["ruke-python"],
                         "the heartbeat stops while our lease is still on disk")
        self.assertEqual([t for t in threads if t.is_alive()], [],
                         "no heartbeat thread may outlive the window")
        self.assertFalse(handoff.lease_path().exists(), "the lease was still released")

    def _run(self, provider, plans, *, allow_unload=False, work=None):
        seen: list[dict] = []

        def _work(plan):
            seen.append(plan)
            return {"peak": {"working_set_mib": 1200, "commit_mib": 1500}, "persisted": True}

        with mock.patch.object(main_model, "snapshot",
                               return_value={"provider": provider.name, "endpoint": provider.base_url,
                                             "loaded": provider.loaded}), \
                mock.patch.object(main_model, "provider_for", return_value=provider), \
                mock.patch.object(handoff.devices, "device_plan", side_effect=plans):
            out = handoff.run_exclusive("documents.ocr", work or _work, est_peak_mib=3300,
                                        est_peak_vram_mib=6000, est_basis="measured",
                                        est_vram_basis="measured", allow_gpu=False,
                                        allow_unload=allow_unload)
        return out, seen

    def test_no_unload_when_the_measured_fit_is_already_enough(self):
        provider = StubMainModel(loaded=True)
        plan = devices.DevicePlan("documents.ocr", "cpu", True, False, "CPU fits", {})
        out, seen = self._run(provider, [plan])
        self.assertTrue(out["ok"])
        self.assertEqual(out["final_status"], "ok")
        self.assertEqual(provider.calls, [])
        self.assertEqual([p["phase"] for p in out["phases"]][-3:],
                         ["processing", "releasing_worker", "ready"])
        self.assertEqual(seen[0]["device"], "cpu")
        self.assertEqual(out["work_peak"]["working_set_mib"], 1200)
        self.assertFalse(handoff.lease_path().exists())

    def test_resource_limit_is_typed_and_does_not_unload_without_permission(self):
        provider = StubMainModel(loaded=True)
        plan = devices.DevicePlan("documents.ocr", "none", False, True, "neither device fits", {})
        out, seen = self._run(provider, [plan], allow_unload=False)
        self.assertEqual(out["reason"], "resource_limit")
        self.assertNotIn("work", out)
        self.assertEqual(provider.calls, [])
        self.assertFalse(handoff.lease_path().exists())

    def test_unload_then_restore_when_the_handoff_is_authorised(self):
        provider = StubMainModel(loaded=True)
        before = devices.DevicePlan("documents.ocr", "none", False, True, "RAM short", {})
        after = devices.DevicePlan("documents.ocr", "cpu", True, False, "RAM fits after unload", {})
        out, seen = self._run(provider, [before, after], allow_unload=True)
        self.assertTrue(out["ok"])
        self.assertEqual(provider.calls, ["unload", "load", "ready"])
        self.assertIn("unloading_main_model", [p["phase"] for p in out["phases"]])
        self.assertIn("restoring_main_model", [p["phase"] for p in out["phases"]])
        self.assertEqual(seen[0]["device"], "cpu")
        self.assertTrue(out.get("measure_after_unload"))
        self.assertFalse(handoff.lease_path().exists())
        self.assertEqual(handoff.journal_read(), {}, "a clean handoff must clear its journal")

    def test_refused_unload_stops_the_job_and_is_reported(self):
        provider = StubMainModel(loaded=True, unload_ok=False)
        before = devices.DevicePlan("documents.ocr", "none", False, True, "RAM short", {})
        out, seen = self._run(provider, [before], allow_unload=True)
        self.assertEqual(out["reason"], "unload_refused")
        self.assertEqual(out["final_status"], "unload_refused")
        self.assertFalse(out["ok"], "a window that never ran the capability is not a success")
        self.assertEqual(provider.calls, ["unload"], "never load what was never unloaded")
        self.assertEqual(seen, [])
        self.assertFalse(handoff.lease_path().exists())

    def test_a_model_that_was_never_loaded_is_never_loaded_by_us(self):
        provider = StubMainModel(loaded=False)
        before = devices.DevicePlan("documents.ocr", "none", False, True, "RAM short", {})
        out, _seen = self._run(provider, [before], allow_unload=True)
        self.assertNotIn("unload", provider.calls)
        self.assertNotIn("load", provider.calls)
        self.assertEqual(out.get("reason"), "resource_limit")

    def test_worker_crash_still_restores_the_model_and_releases_the_lease(self):
        provider = StubMainModel(loaded=True)
        before = devices.DevicePlan("documents.ocr", "none", False, True, "RAM short", {})
        after = devices.DevicePlan("documents.ocr", "cpu", True, False, "fits", {})

        def boom(_plan):
            raise RuntimeError("worker exploded")

        out, _seen = self._run(provider, [before, after], allow_unload=True, work=boom)
        self.assertEqual(out["reason"], "handoff_failed")
        self.assertEqual(provider.calls, ["unload", "load", "ready"])
        self.assertTrue(out.get("interrupted_with_restore_ok"))
        self.assertFalse(handoff.lease_path().exists())

    def test_lease_is_refused_while_a_foreign_holder_is_live(self):
        held = handoff.acquire(owner="someone-else")
        provider = StubMainModel(loaded=True)
        plan = devices.DevicePlan("documents.ocr", "cpu", True, False, "fits", {})
        with mock.patch.object(main_model, "snapshot", return_value={"loaded": True}), \
                mock.patch.object(main_model, "provider_for", return_value=provider), \
                mock.patch.object(handoff.devices, "device_plan", return_value=plan):
            out = handoff.run_exclusive("documents.ocr", lambda p: {}, est_peak_mib=3300)
        self.assertEqual(out["reason"], "coordination_held")
        self.assertEqual(provider.calls, [])
        self.assertEqual(handoff.read_lease().get("owner"), "someone-else")
        handoff.release(held)

    def test_journal_recovery_only_loads_a_model_that_was_loaded(self):
        handoff.journal_write({"token": "t", "owner": "x", "capability": "documents.ocr",
                               "phase": "processing",
                               "original": {"loaded": True, "endpoint": "http://stub-llm"}})
        provider = StubMainModel(loaded=False)
        with mock.patch.object(main_model, "provider_for", return_value=provider):
            out = handoff.recover(timeout_s=1)
        self.assertTrue(out["restored"])
        self.assertEqual(provider.calls, ["load", "ready"])
        self.assertEqual(handoff.journal_read(), {})

        handoff.journal_write({"token": "t", "owner": "x", "capability": "documents.ocr",
                               "phase": "processing",
                               "original": {"loaded": False, "endpoint": "http://stub-llm"}})
        provider2 = StubMainModel(loaded=False)
        with mock.patch.object(main_model, "provider_for", return_value=provider2):
            out2 = handoff.recover(timeout_s=1)
        self.assertTrue(out2["restored"])
        self.assertEqual(provider2.calls, [])


class StrataHttpContract(unittest.TestCase):
    """The provider adapter against a stub that mimics Strata's documented answers."""

    def setUp(self):
        self.state = {"loaded": True, "unload_status": 200, "body": {"status": "unloaded"},
                      "seen_headers": [], "path": "/health"}
        outer = self.state

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):            # silence
                pass

            def _send(self, code, payload):
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                outer["seen_headers"].append(dict(self.headers))
                if outer["path"] == "/health":
                    self._send(200, {"status": "ok", "loaded": outer["loaded"],
                                     "model": "qwen-test", "busy": False})
                else:
                    self._send(404, {"error": "no such path"})

            def do_POST(self):
                outer["seen_headers"].append(dict(self.headers))
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                if self.path.startswith("/unload"):
                    self._send(outer["unload_status"], outer["body"])
                elif self.path.startswith("/load"):
                    self._send(200, {"status": "loaded"})
                else:
                    self._send(404, {"error": "no such path"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        # Cleanups run LIFO: registering server_close first means shutdown() runs first, which
        # is the documented order. Closing the socket first makes the selector raise WinError
        # 10038 in the serve thread and dumps a traceback that is not a product failure.
        self.addCleanup(self.server.server_close)
        self.addCleanup(self._stop_server)

    def _stop_server(self):
        self.server.shutdown()
        self.thread.join(timeout=5)

    def test_inspect_reports_the_resident_state(self):
        state = main_model.StrataProvider(self.base).inspect()
        self.assertTrue(state.reachable)
        self.assertTrue(state.resident())
        self.assertEqual(state.model, "qwen-test")

    def test_unload_statuses_are_typed_and_never_fabricated(self):
        prov = main_model.StrataProvider(self.base)
        self.assertTrue(prov.unload(5)["ok"])
        self.state.update(unload_status=409, body={"error": "a turn is running"})
        busy = prov.unload(5)
        self.assertEqual(busy["status"], "busy")
        self.assertFalse(busy["ok"])
        self.state.update(unload_status=404, body={"error": "nope"})
        self.assertEqual(prov.unload(5)["status"], "unsupported")
        self.state.update(unload_status=503, body={"error": "engine stuck"})
        self.assertEqual(prov.unload(5)["status"], "engine_stuck")

    def test_control_calls_send_json_and_never_a_browser_origin(self):
        prov = main_model.StrataProvider(self.base)
        prov.unload(5)
        headers = self.state["seen_headers"][-1]
        self.assertEqual(headers.get("Content-Type"), "application/json")
        self.assertIsNone(headers.get("Origin"))

    def test_wait_ready_polls_the_provider_s_own_answer(self):
        self.state["loaded"] = True
        out = main_model.StrataProvider(self.base).wait_ready(5)
        self.assertTrue(out["ok"])
        self.state["path"] = "/missing"
        out2 = main_model.StrataProvider(self.base, timeout_s=2).wait_ready(1)
        self.assertFalse(out2["ok"])
        self.assertEqual(out2["status"], "timeout")

    def test_provider_selection_by_the_server_s_own_answers(self):
        self.assertIsInstance(main_model.provider_for(self.base), main_model.StrataProvider)
        closed = main_model.provider_for("http://127.0.0.1:1")
        self.assertIsInstance(closed, main_model.UnreachableProvider)
        self.assertFalse(main_model.StrataProvider("http://127.0.0.1:1").inspect().reachable)
        ollama = main_model.OllamaProvider(self.base)
        can, why = ollama.supports_lifecycle()
        self.assertFalse(can)
        self.assertIn("no unload/load adapter has been validated", why)


class CascadeMechanics(unittest.TestCase):
    """Selection, fallback and coverage bookkeeping. Mocked engines: mechanics only."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f26-cascade-"))
        self.pdf = self.tmp / "doc.pdf"
        self.pdf.write_bytes(_pdf_bytes([_text_stream("first page text"), b"",
                                         _text_stream("third page text")]))
        env = {"RUKE_OCR_PRIMARY": "", "RUKE_OCR_ALLOW_GPU": "", "RUKE_OCR_ALLOW_UNLOAD": "",
               # Durable results are part of the cascade now, so a mechanics test must redirect
               # them into its own scratch directory instead of littering the project runtime dir.
               "RUKE_OCR_RESULT_DIR": str(self.tmp / "results"),
               "RUKE_OCR_RESUME": "", "RUKE_OCR_INJECT_FAILURE_PAGE": ""}
        patcher = mock.patch.dict(os.environ, env, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _state(self, ready: bool, blockers=()):
        return {"engine": ocr_paddle.ENGINE, "ready": ready, "blockers": list(blockers),
                "runtime": {"found": ready}, "assets": [],
                "estimate": {"est_peak_mib": 3300, "est_peak_basis": "measured",
                             "est_peak_vram_mib": 0, "est_vram_basis": "unmeasured"}}

    def _primary(self, pages: list[OcrPage], stats=None):
        def _fake(*a, **k):
            return ocr_paddle.PaddleRun(pages, stats or {"peak_working_set_mib": 1000})
        return mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_fake)

    def _fallback(self, pages: list[OcrPage], calls: list[list[int]]):
        def _fake(pdf, units, **k):
            calls.append(list(units))
            return pages
        return mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=_fake)

    def _planner(self, fits: bool, device="cpu"):
        plan = devices.DevicePlan("documents.ocr", device if fits else "none", fits, not fits,
                                  "stub plan", {})
        return (mock.patch.object(devices, "device_plan", return_value=plan),
                mock.patch.object(main_model, "snapshot", return_value={"loaded": True}))

    def test_primary_reads_all_and_no_fallback_runs(self):
        good = [OcrPage(page=p, state="recognised", text="t%d" % p, engine=ocr_paddle.ENGINE)
                for p in (1, 2, 3)]
        calls: list[list[int]] = []
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(good), self._fallback([], calls):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2, 3], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(calls, [], "a page the primary read must not be re-OCR'd")
        self.assertEqual(casc["units_read"], 3)
        self.assertEqual(casc["engines_used"], [ocr_paddle.ENGINE])
        self.assertEqual([p.engine for p in pages], [ocr_paddle.ENGINE] * 3)

    def test_only_unread_units_go_to_recovery_after_the_primary_is_released(self):
        pages_in = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE),
                    OcrPage(page=2, state="ocr_failed", detail="boom", engine=ocr_paddle.ENGINE),
                    OcrPage(page=3, state="empty", engine=ocr_paddle.ENGINE)]
        recovered = [OcrPage(page=2, state="recognised", text="two recovered",
                             engine="tesseract-5.5.3")]
        calls: list[list[int]] = []
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(pages_in), self._fallback(recovered, calls):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2, 3], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(calls, [[2]], "recognised and empty must not be retried")
        self.assertEqual(casc["fallback"]["attempted"], [2])
        self.assertIn("does NOT claim equivalent", casc["fallback"]["fidelity_note"])
        by = {p.page: p for p in pages}
        self.assertEqual(by[2].engine, "tesseract-5.5.3")
        self.assertIn("recovery after primary failure", by[2].detail)
        self.assertEqual(by[1].engine, ocr_paddle.ENGINE, "a good unit keeps its own engine")
        self.assertEqual(casc["engines_used"], sorted([ocr_paddle.ENGINE, "tesseract-5.5.3"]))
        self.assertEqual(casc["units_unresolved"], [])

    def test_unavailable_primary_sends_every_unit_to_recovery_with_the_reason(self):
        recovered = [OcrPage(page=p, state="recognised", text="r%d" % p, engine="tesseract")
                     for p in (1, 2, 3)]
        calls: list[list[int]] = []
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state",
                               return_value=self._state(False, ["recognition snapshot missing"])), \
                p1, p2, self._fallback(recovered, calls):
            primary_patch = mock.patch.object(ocr_paddle, "ocr_pdf_pages",
                                              side_effect=AssertionError("primary must not spawn"))
            with primary_patch:
                pages, report = ocr_cascade.run(str(self.pdf), [1, 2, 3], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(calls, [[1, 2, 3]])
        self.assertIn("primary pipeline unavailable", casc["fallback"]["reason"])
        self.assertEqual(casc["units_read"], 3)
        self.assertEqual(casc["engines_used"], ["tesseract"])

    def test_resource_limit_with_the_handoff_policy_off_refuses_the_primary(self):
        """Policy OFF is an operator configuration, not a script flag: RUKE_LLM_AUTOMATIC_HANDOFF=0
        must produce a typed resource_limit refusal and still send the unit to recovery."""
        calls: list[list[int]] = []
        recovered = [OcrPage(page=1, state="recognised", text="x", engine="tesseract")]
        p1, p2 = self._planner(False)
        handoff_patch = mock.patch.object(handoff, "run_exclusive",
                                          side_effect=AssertionError("must not unload with the "
                                                                     "configured policy switched off"))
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.dict(os.environ, {"RUKE_LLM_AUTOMATIC_HANDOFF": "0"}), \
                mock.patch.object(main_model, "snapshot",
                                  return_value={"loaded": True, "provider": "strata",
                                                "endpoint": "http://127.0.0.1:9"}), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, handoff_patch, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages",
                                  side_effect=AssertionError("must not run when it does not fit")), \
                self._fallback(recovered, calls):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertIn("resource_limit", casc["primary"]["run_refused"])
        self.assertIn("allow_unload=False", casc["primary"]["run_refused"])
        self.assertEqual(casc["fallback"]["attempted"], [1])

    def test_a_job_that_does_not_fit_asks_for_one_window_covering_the_whole_operation(self):
        """The configured default is the automatic handoff, and it wraps the ENTIRE operation:
        primary, recovery and the durable write. One lease, one admission, no nested window and
        no restoration of the main model before the recovery engine has finished."""
        calls: list[list[int]] = []
        recovered = [OcrPage(page=1, state="recognised", text="recovered", engine="tesseract")]
        p1, p2 = self._planner(False)
        windows: list[tuple[str, list[int]]] = []

        def fake_run_exclusive(name: str, operation, **kwargs):
            # The window is handed a placement and must run the whole operation inside it.
            operation({"device": "cpu"})
            windows.append((name, list(calls)))
            return {"ok": True, "status": "ready",
                    "plan": {"device": "cpu", "fits": True, "reason": "fits after the unload"},
                    "work_peak": {"commit_mib": 3300}}

        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(main_model, "snapshot",
                                  return_value={"loaded": True, "provider": "strata",
                                                "endpoint": "http://127.0.0.1:9"}), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, \
                mock.patch.object(handoff, "run_exclusive", side_effect=fake_run_exclusive), \
                self._primary([OcrPage(page=1, state="ocr_failed", text="", engine=ocr_paddle.ENGINE)]), \
                self._fallback(recovered, calls):
            pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual([name for name, _ in windows], ["documents.ocr"],
                         "exactly one exclusive window for the whole operation")
        self.assertEqual(windows[0][1], [[1]],
                         "recovery ran INSIDE the window, before the main model was restored")
        self.assertEqual(casc["handoff"]["ok"], True)
        self.assertEqual(casc["units_read"], 1)
        self.assertEqual(pages[0].engine, "tesseract")

    def test_inside_a_handoff_the_cascade_never_requests_a_nested_lease(self):
        calls: list[list[int]] = []
        p1, p2 = self._planner(False)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                mock.patch.dict(os.environ, {"RUKE_OCR_ALLOW_UNLOAD": "1"}), \
                p1, p2, \
                mock.patch.object(handoff, "run_exclusive",
                                  side_effect=AssertionError("nested lease would self-deadlock")), \
                self._primary([OcrPage(page=1, state="recognised", text="x",
                                       engine=ocr_paddle.ENGINE)]), \
                self._fallback([], calls):
            # inside_handoff + device_override: the lease holder already decided placement.
            pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200,
                                            device_override="cpu", inside_handoff=True)
        casc = report["cascade"]
        self.assertEqual(casc["inside_handoff"], True)
        self.assertEqual(casc["units_read"], 1)
        self.assertEqual(calls, [])

    def test_a_unit_no_engine_read_stays_visible_as_unresolved(self):
        calls: list[list[int]] = []
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, \
                self._primary([OcrPage(page=1, state="raster_failed", engine=ocr_paddle.ENGINE)]), \
                self._fallback([], calls):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(sorted(p.page for p in pages), [1, 2], "no unit may be dropped")
        # A unit that NEITHER engine produced is just as unresolved as one an engine failed on:
        # reporting it as resolved would overstate the document's actual coverage.
        self.assertEqual(casc["units_unresolved"], [1, 2])
        self.assertEqual(casc["units_not_read"], [2])
        self.assertEqual([p for p in pages if p.page == 2][0].state, "skipped")
        self.assertEqual(casc["fallback"]["attempted"], [1, 2])

    def test_cancellation_skips_the_fallback_entirely(self):
        pages_in = [OcrPage(page=1, state="ocr_failed", engine=ocr_paddle.ENGINE)]
        calls: list[list[int]] = []
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(pages_in), self._fallback([], calls):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200,
                                             cancel=lambda: True)
        self.assertIn("cancelled", report["cascade"]["fallback"]["skipped"])
        self.assertEqual(calls, [])

    def test_production_cancel_callable_reaches_the_real_tesseract_engine(self):
        """The worker hands the cascade a CALLABLE cancel; the engine takes an Event.

        This is the real-engine path: project-local Tesseract reads a real raster. It proves
        the wiring, not OCR quality.
        """
        st = ocr_tesseract.engine_state()
        if not st["found"]:
            self.skipTest("no project-local tesseract: %s" % st.get("detail"))
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages",
                                  return_value=ocr_paddle.PaddleRun(
                                      [OcrPage(page=1, state="ocr_failed", detail="simulated "
                                       "primary crash", engine=ocr_paddle.ENGINE)])), \
                mock.patch.object(ocr_cascade, "policy",
                                  return_value=dict(ocr_cascade.policy(), allow_unload=False)):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 3], language="eng", dpi=200,
                                            cancel=lambda: False)
        by = {p.page: p for p in pages}
        self.assertEqual(by[1].state, "recognised", "real Tesseract must have read the raster")
        self.assertIn("first page text", by[1].text.lower())
        self.assertIn("recovery after primary failure", by[1].detail)
        self.assertNotEqual(by[1].engine, ocr_paddle.ENGINE)
        self.assertEqual(report["cascade"]["fallback"]["recognized"], 2)

    # ---- one window, one operation, durable evidence --------------------------------------
    # These are the amendment-8 mechanics: the shape of the lifecycle, not OCR quality.

    def test_primary_and_recovery_both_run_inside_ONE_resource_window(self):
        """The defect this closes: the window used to wrap only the primary attempt.

        A window that closes before the recovery engine runs is wrong twice over: the recovery is
        charged against an admission that never included it, and the main model gets reloaded while
        a second engine is still starting. Production and the acceptance CLI must get the SAME
        single-window operation.
        """
        order: list[str] = []
        pages_in = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE),
                    OcrPage(page=2, state="ocr_failed", detail="boom", engine=ocr_paddle.ENGINE)]
        recovered = [OcrPage(page=2, state="recognised", text="two recovered",
                             engine="tesseract-5.5.3")]

        def _primary(*a, **k):
            order.append("primary")
            return ocr_paddle.PaddleRun(pages_in, {"peak_working_set_mib": 900})

        def _fallback(pdf, units, **k):
            order.append("fallback:%s" % ",".join(str(u) for u in units))
            return recovered

        def _window(capability, work_fn, **kw):
            order.append("window_open")
            out = work_fn({"device": "cpu"})
            order.append("window_close")
            return {"ok": True, "work": out, "work_peak": (out or {}).get("peak") or {},
                    "plan_after_unload": {"device": "cpu", "fits": True}}

        p1, p2 = self._planner(False)              # does NOT fit alongside the main model
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                mock.patch.dict(os.environ, {"RUKE_OCR_ALLOW_UNLOAD": "1"}), \
                p1, p2, \
                mock.patch.object(handoff, "run_exclusive", side_effect=_window) as window, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_primary), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages", side_effect=_fallback):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 2], language="eng", dpi=200)
        casc = report["cascade"]
        self.assertEqual(window.call_count, 1, "one window for the whole operation, not one per stage")
        self.assertEqual(order, ["window_open", "primary", "fallback:2", "window_close"],
                         "the recovery engine must finish before the window closes")
        self.assertEqual(casc["handoff"]["work"]["units_persisted"], 2)
        by = {p.page: p for p in pages}
        self.assertEqual(by[2].engine, "tesseract-5.5.3")
        # The durable write happened INSIDE that window, before any model could be restored.
        self.assertTrue(casc["persisted"]["ok"])
        self.assertTrue(Path(casc["persisted"]["path"]).is_file(),
                        "the extracted evidence must exist on disk before restoration")

    def test_the_result_is_durable_and_a_resume_reuses_it_without_an_engine(self):
        good = [OcrPage(page=p, state="recognised", text="text unit %d" % p,
                        engine=ocr_paddle.ENGINE) for p in (1, 3)]
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(good), self._fallback([], []):
            _pages, report = ocr_cascade.run(str(self.pdf), [1, 3], language="eng", dpi=200)
        saved = Path(report["cascade"]["persisted"]["path"])
        self.assertTrue(saved.is_file())
        record = json.loads(saved.read_text(encoding="utf-8"))
        self.assertEqual(record["schema"], ocr_cascade.RESULT_SCHEMA)
        self.assertEqual(record["coverage"]["requested"], 2)
        self.assertIn("sha256", record["source"], "identity is content, never a path name")

        # Resume: NEITHER engine may start. An AssertionError stub is the only way to prove
        # "did not run" without trusting a counter the code wrote about itself.
        p3, p4 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                p3, p4, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages",
                                  side_effect=AssertionError("resume must not spawn the primary")), \
                mock.patch.object(ocr_tesseract, "ocr_pdf_pages",
                                  side_effect=AssertionError("resume must not spawn the fallback")):
            pages, report2 = ocr_cascade.run(str(self.pdf), [1, 3], language="eng", dpi=200,
                                             resume=True)
        casc2 = report2["cascade"]
        self.assertEqual(casc2.get("resumed_from"), str(saved))
        self.assertEqual([p.state for p in pages], ["recognised", "recognised"])
        self.assertIn("no engine was re-run", pages[0].detail)
        self.assertEqual(casc2["units_read"], 2)
        self.assertNotIn("resume_rejected", casc2)
        # A run that only reused persisted units must not overwrite the peaks the engines measured.
        self.assertEqual(json.loads(saved.read_text(encoding="utf-8")), record)

    def test_a_corrupt_persisted_record_is_rejected_as_corrupt_not_as_absent(self):
        good = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE)]
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(good), self._fallback([], []):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        saved = Path(report["cascade"]["persisted"]["path"])
        text = saved.read_text(encoding="utf-8")
        self.assertGreater(len(text), 800, "the record must be big enough to truncate meaningfully")
        # A record cut short is the same failure mode the fixed-width lease writer produced. It
        # must read as CORRUPT (and re-run the engines), never as "nothing was saved".
        saved.write_text(text[:400], encoding="utf-8")
        read = ocr_cascade._read_result(str(self.pdf), [1], language="eng", dpi=200, rotations=None)
        self.assertFalse(read["usable"])
        self.assertFalse(read["absent"], "malformed must not collapse into absent")
        self.assertIn("malformed", read["detail"])

        ran: list[int] = []

        def _primary_again(*a, **k):
            ran.append(1)
            return ocr_paddle.PaddleRun(good)

        p3, p4 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p3, p4, \
                mock.patch.object(ocr_paddle, "ocr_pdf_pages", side_effect=_primary_again), \
                self._fallback([], []):
            pages2, report2 = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200,
                                              resume=True)
        self.assertEqual(ran, [1], "a corrupt record must not stop the engines from re-running")
        self.assertIn("malformed", report2["cascade"]["resume_rejected"])
        self.assertNotIn("no engine was re-run", pages2[0].detail)

    def test_changed_source_content_makes_the_persisted_units_a_different_question(self):
        good = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE)]
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(good), self._fallback([], []):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        self.assertTrue(Path(report["cascade"]["persisted"]["path"]).is_file())
        self.pdf.write_bytes(_pdf_bytes([_text_stream("the file was edited"), b"",
                                         _text_stream("third page text")]))
        read = ocr_cascade._read_result(str(self.pdf), [1], language="eng", dpi=200, rotations=None)
        self.assertFalse(read["usable"])
        self.assertTrue(read["absent"], "new content is a new key, not a corrupt record")

    def test_a_failed_unit_is_never_replayed_as_an_answer(self):
        rec = {"page": 4, "state": "ocr_failed", "text": "", "engine": ocr_paddle.ENGINE}
        self.assertIsNone(ocr_cascade._page_from_record(rec),
                          "a unit an engine failed on must be retried, never reused as an answer")
        ok = ocr_cascade._page_from_record({"page": 4, "state": "empty", "text": "",
                                            "engine": ocr_paddle.ENGINE, "provenance": "ocr"})
        self.assertIsNotNone(ok)
        self.assertEqual(ok.state, "empty")
        self.assertFalse(hasattr(ok, "provenance"),
                         "the extra to_dict() marker must not leak into the rebuilt page")

    def test_the_injected_fault_is_recovered_by_the_cascade_itself(self):
        """The CLI and the upload path both ask the cascade for the fault, so acceptance exercises
        the production recovery instead of a private copy of it."""
        good = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE),
                OcrPage(page=3, state="recognised", text="three", engine=ocr_paddle.ENGINE)]
        recovered = [OcrPage(page=3, state="recognised", text="three recovered",
                             engine="tesseract-5.5.3")]
        calls: list[list[int]] = []
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, self._primary(good), self._fallback(recovered, calls):
            pages, report = ocr_cascade.run(str(self.pdf), [1, 3], language="eng", dpi=200,
                                            inject_failure_unit=3)
        casc = report["cascade"]
        self.assertEqual(casc["primary"]["injected_failure_unit"], 3)
        self.assertEqual(calls, [[3]])
        self.assertIn("fault-injected by the operator", casc["fallback"]["reason"])
        by = {p.page: p for p in pages}
        self.assertEqual(by[3].engine, "tesseract-5.5.3")
        self.assertEqual(by[1].engine, ocr_paddle.ENGINE, "the untouched unit keeps its own engine")
        self.assertEqual(casc["units_unresolved"], [])

    def test_an_unmeasured_peak_is_reported_as_unknown_and_never_as_zero(self):
        good = [OcrPage(page=1, state="recognised", text="one", engine=ocr_paddle.ENGINE)]
        p1, p2 = self._planner(True)
        with mock.patch.object(ocr_cascade, "_primary_state", return_value=self._state(True)), \
                mock.patch.object(ocr_paddle, "estimate",
                                  return_value={"est_peak_mib": 3300, "est_peak_basis": "measured",
                                                "est_peak_vram_mib": 0, "est_vram_basis": "u"}), \
                p1, p2, \
                self._primary(good, {"peak_working_set_mib": 1000, "peak_commit_mib": 1500}), \
                self._fallback([], []):
            _pages, report = ocr_cascade.run(str(self.pdf), [1], language="eng", dpi=200)
        peaks = report["cascade"]["peaks"]
        child = peaks["primary_worker_child"]
        # The stub recorded peak NUMBERS but no usable sample, which is not the same claim.
        self.assertFalse(child["measured"])
        self.assertIsNone(child["working_set_mib"], "unknown must be None, never 0")
        self.assertIn("UNKNOWN", child["note"])
        self.assertIn("measured", peaks["owned_tree"],
                      "the owned-tree sampler states whether it actually measured")
        never_started = ocr_cascade._operation_peak(resources.PeakSampler(), {})
        self.assertIsNone(never_started["working_set_mib"])
        self.assertFalse(never_started["measured"],
                         "an operation with no samples has an unknown peak, not a free one")


    def test_the_operator_readiness_report_names_both_engines_and_never_claims_quality(self):
        # An acceptance wrapper has to ask "can the primary run here" without re-deriving
        # readiness, and must never mistake that answer for a quality result.
        report = ocr_cascade.status_report()
        for key in ("policy", "primary", "primary_engine", "recovery", "rasterizer",
                    "recovery_languages"):
            self.assertIn(key, report)
        self.assertEqual(report["primary"]["engine"], ocr_cascade.PRIMARY)
        self.assertEqual(report["primary"]["ready"],
                         bool(ocr_paddle.engine_state().get("ready")))
        self.assertIsInstance(report["recovery_languages"], list)
        joined = json.dumps(report).lower()
        for claim in ("accuracy", "wer=", "quality parity", "verified quality"):
            self.assertNotIn(claim, joined, "readiness must not read as a quality claim")

class PaddleWorkerProtocol(unittest.TestCase):
    """The parent/child NDJSON protocol, device proof, deadlines and the one repair pass."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="f26-prot-"))
        self.worker = self.tmp / "stub_worker.py"
        self.worker.write_text(STUB_WORKER.replace("{{", "{").replace("}}", "}"),
                               encoding="utf-8")
        self.cfg = self.tmp / "stub_config.json"
        (self.tmp / "models").mkdir()
        self.png = b"\x89PNG\r\n\x1a\n" + b"0" * 32

    def _stub(self, config: dict):
        self.cfg.write_text(json.dumps(config), encoding="utf-8")
        runtime = {"found": True, "interpreter": sys.executable, "detail": "stub runtime"}
        patches = [
            mock.patch.object(ocr_paddle, "engine_state",
                              return_value={"runtime": runtime, "worker_present": True,
                                            "ready": True, "blockers": []}),
            mock.patch.object(ocr_paddle, "_model_dirs",
                              return_value=(str(self.tmp / "models"), str(self.tmp / "models"))),
            mock.patch.object(ocr_paddle, "WORKER_FILE", self.worker),
            mock.patch.object(ocr_paddle, "render_page_png",
                              side_effect=lambda pdf, page, dpi=200, rotation=0: (
                                  self.png, {"page": page, "dpi": dpi, "rotation": rotation,
                                             "width_px": 4, "height_px": 4})),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _pdf(self) -> str:
        path = self.tmp / "in.pdf"
        path.write_bytes(_pdf_bytes([_text_stream("page one"), _text_stream("page two")]))
        return str(path)

    def test_round_trip_records_protocol_device_and_two_separate_peaks(self):
        self._stub({"device": "cpu"})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1, 2], language="eng", device="cpu",
                                       job_id="test.ocr")
        self.assertEqual([p.state for p in run.pages], ["recognised", "recognised"])
        self.assertEqual(run.pages[0].text, "stub text for page 1")
        self.assertEqual(run.pages[0].lines[0]["text"], "stub line")
        self.assertEqual(run.stats["device_used"], "cpu")
        self.assertEqual(run.stats["device_echo"]["device"], "cpu")
        self.assertEqual(run.stats["paddle_version"], "0.0.0-stub")
        self.assertEqual(run.stats["pages_attempted"], 2)
        for key in ("peak_working_set_mib", "peak_commit_mib", "peak_job_object_commit_mib",
                    "peak_basis", "samples"):
            self.assertIn(key, run.stats)
        self.assertIn("resident = max sampled working set", run.stats["peak_basis"])
        self.assertGreaterEqual(run.stats["samples"], 1)
        self.assertTrue(run.stats["exit"] is None or isinstance(run.stats["exit"], int))

    def test_a_child_whose_bytes_never_became_readable_reports_unknown_peaks(self):
        """Production path, not a hand-built dict: the sampler only ever sees an unreadable tree.

        Amendment 7 defect 6. A peak of 0 in this dict reads to the operator as "the primary
        engine fitted the 4 GB target", when the truthful answer is that nothing was measured.
        """
        self._stub({"device": "cpu"})
        unknown = {"available": 0, "pids": [], "processes": [], "working_set_mib": None,
                   "private_mib": None, "commit_mib": None, "peak_working_set_mib": None,
                   "peak_commit_mib": None,
                   "note": "no process in the owned tree could be measured"}
        with mock.patch.object(resources, "process_tree_memory", return_value=unknown):
            run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu",
                                           job_id="test.ocr")
        self.assertEqual([p.state for p in run.pages], ["recognised"], run.pages)
        self.assertIsNone(run.stats["peak_working_set_mib"], run.stats)
        self.assertEqual(run.stats["samples_available"], 0, run.stats)
        self.assertIn("A null means", run.stats["peak_basis"], run.stats)
        if run.stats["peak_commit_mib"] is None:
            self.assertFalse(run.stats["peak_measured"], run.stats)
            self.assertIn("unknown", str(run.stats.get("peak_unmeasured_reason", "")).lower(),
                          run.stats)

    def test_gpu_request_is_refused_before_anything_spawns(self):
        self._stub({})
        spawn = mock.patch.object(ocr_paddle.subprocess, "Popen",
                                  side_effect=AssertionError("must not spawn"))
        with spawn, self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="gpu",
                                     allow_gpu=False)
        self.assertEqual(caught.exception.kind, "gpu_placement_refused")

    def test_a_device_contradiction_is_refused_not_reported_as_success(self):
        self._stub({"device": "gpu:0", "cuda_compiled": True})
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu")
        self.assertEqual(caught.exception.kind, "gpu_placement_refused")
        self.assertIn("the plan said cpu", caught.exception.detail)

    def test_worker_that_never_loads_is_a_typed_load_failure(self):
        self._stub({"mode": "load_error"})
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu",
                                     load_timeout_s=30)
        self.assertEqual(caught.exception.kind, "load_failed")
        self.assertIn("stub refused to load", caught.exception.detail)

    def test_worker_that_dies_before_ready_reports_its_log(self):
        self._stub({"mode": "die_early"})
        with self.assertRaises(OcrUnavailable) as caught:
            ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu",
                                     load_timeout_s=30)
        self.assertEqual(caught.exception.kind, "load_failed")
        self.assertIn("stub died before ready", caught.exception.detail)

    def test_expired_deadline_stops_before_sending_more_pages(self):
        self._stub({})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1, 2], language="eng", device="cpu",
                                       deadline_at=time.time() - 1)
        self.assertEqual([p.state for p in run.pages], ["ocr_failed", "ocr_failed"])
        self.assertEqual(run.stats["deadline_reached_at_page"], 1)
        self.assertIn("deadline", run.pages[0].detail)

    def test_a_hung_page_is_killed_and_the_remaining_pages_are_marked(self):
        self._stub({"per_page_sleep": 5})
        started = time.time()
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1, 2], language="eng", device="cpu",
                                       per_page_timeout_s=1)
        self.assertLess(time.time() - started, 20)
        self.assertEqual(run.stats.get("killed_at_page"), 1)
        self.assertIn("deadline", run.pages[0].detail)
        self.assertEqual([p.state for p in run.pages], ["ocr_failed", "ocr_failed"])
        self.assertTrue(run.stats.get("exit") is not None, "the worker must have been reaped")

    def test_worker_crash_leaves_the_rest_unresolved_rather_than_empty_success(self):
        self._stub({"crash_at_page": 1})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1, 2], language="eng", device="cpu")
        self.assertEqual(run.stats.get("worker_died_at_page"), 1)
        self.assertEqual([p.state for p in run.pages], ["ocr_failed", "ocr_failed"])
        self.assertIn("died", run.pages[0].detail)

    def test_exactly_one_deterministic_repair_pass_is_allowed(self):
        self._stub({"fail_until_repair": True})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu", dpi=200)
        self.assertEqual(run.stats.get("repairs_attempted"), 1)
        self.assertEqual(run.stats.get("repairs_recovered"), 1)
        self.assertEqual(run.pages[0].state, "recognised")
        self.assertIn("single repair pass at 400 dpi", run.pages[0].detail)

    def test_repair_also_failing_is_recorded_on_the_failed_unit(self):
        self._stub({"fail_until_repair": True, "page_states": {"1": "ocr_failed"}})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu", dpi=200)
        self.assertEqual(run.pages[0].state, "ocr_failed")
        self.assertEqual(run.stats.get("repairs_attempted"), 1)
        self.assertIsNone(run.stats.get("repairs_recovered"))
        self.assertIn("also failed", run.pages[0].detail)

    def test_an_empty_page_is_an_answer_not_a_failure_to_retry(self):
        self._stub({"page_states": {"1": "empty"}})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu", dpi=200)
        self.assertEqual(run.pages[0].state, "empty")
        self.assertIsNone(run.stats.get("repairs_attempted"))

    def test_cancellation_before_a_page_is_distinct_from_a_backend_failure(self):
        self._stub({})
        run = ocr_paddle.ocr_pdf_pages(self._pdf(), [1, 2], language="eng", device="cpu",
                                       cancel=lambda: True)
        self.assertEqual([p.state for p in run.pages], ["skipped", "skipped"])
        self.assertEqual(run.stats.get("cancelled_at_page"), 1)

    def test_missing_pinned_assets_are_asset_failures_with_the_prepare_command(self):
        runtime = {"found": True, "interpreter": sys.executable, "detail": "stub runtime"}
        with mock.patch.object(ocr_paddle, "engine_state",
                               return_value={"runtime": runtime, "worker_present": True,
                                             "ready": False, "blockers": ["recognition snapshot"]}), \
                mock.patch.object(ocr_paddle, "_model_dirs",
                                  side_effect=OcrUnavailable(
                                      "asset_missing", "pinned recognition snapshot unusable",
                                      "python -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6")):
            with self.assertRaises(OcrUnavailable) as caught:
                ocr_paddle.ocr_pdf_pages(self._pdf(), [1], language="eng", device="cpu")
        self.assertEqual(caught.exception.kind, "asset_missing")
        self.assertIn("models.prepare", caught.exception.human_step)


if __name__ == "__main__":
    unittest.main()
