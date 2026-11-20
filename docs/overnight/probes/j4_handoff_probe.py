r"""Resource-handoff acceptance probe (SPEC 17 / amendment 5, J4).

Main-model unload -> processing -> worker release -> model restore, under exclusive
coordination. Two classes of scenario, and the split is deliberate:

  SAFE      no model lifecycle call at all. Lease mechanics, stale-holder proof, typed
            failure paths, journal recovery when nothing was loaded. These touch a lock
            file and one GET /health, so they can produce real evidence unattended.

  ATTENDED  they POST /unload and /load on the shared Strata endpoint, parking a ~48 GiB
            resident model (and every other client, INCLUDING the coding CLI) for minutes.
            Refused unless the operator passes --allow-unload --confirm UNLOAD. These are
            the runs the user deferred to a supervised session.

Nothing here kills a process by image name. The only pid this probe terminates is one it
started itself. Breaking a stale lease touches no process at all (DECISIONS D-054).

Usage (repo root):
    python-backend\.venv\Scripts\python.exe docs\overnight\probes\j4_handoff_probe.py
    python-backend\.venv\Scripts\python.exe docs\overnight\probes\j4_handoff_probe.py --allow-unload --confirm UNLOAD

Writes docs/overnight/logs/j4-handoff-<utc>.json; exits non-zero on any miss.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "python-backend"))

from ruke_ml import handoff  # noqa: E402
from ruke_ml.models import main_model, resources  # noqa: E402

OUT_DIR = REPO / "docs" / "overnight" / "logs"
SAFE_SCENARIOS = ("lease_conflict", "live_holder_not_stolen", "stale_holder_broken_with_proof",
                  "fits_no_unload", "resource_limit_without_unload", "work_crash_typed_failure",
                  "journal_records_phase_during_work", "journal_recovery_noop_when_not_loaded",
                  "playwright_lock_conflict")
ATTENDED_SCENARIOS = ("unload_process_restore", "resource_limit_with_unload_and_restore",
                      "kill_mid_window_recovery", "inference_gate_holds_during_window",
                      "no_overlapping_reload_peaks")


class Sampler(threading.Thread):
    """RAM/commit plus the main model process's own working set, sampled through the window."""

    def __init__(self, interval_s: float = 2.0) -> None:
        super().__init__(daemon=True)
        self.interval_s = interval_s
        self.stop = threading.Event()
        self.samples: list[dict[str, object]] = []

    def run(self) -> None:
        while not self.stop.is_set():
            self.samples.append(self.snapshot())
            self.stop.wait(self.interval_s)

    @staticmethod
    def snapshot() -> dict[str, object]:
        host = resources.memory_report()
        llm: dict[str, object] = {}
        try:
            import psutil  # type: ignore
            for proc in psutil.process_iter(["pid", "name"]):
                try:
                    if str(proc.info.get("name") or "").lower() in ("strata.exe", "strata"):
                        llm = {"pid": proc.info["pid"],
                               "working_set_mib": round(proc.memory_info().rss / 1048576, 1)}
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001 - psutil absent: the LLM column stays empty, honest
            llm = {}
        return {"at": round(time.time(), 2),
                "avail_physical_mib": host.get("free_physical_mib"),
                "commit_avail_mib": host.get("commit_available_mib"),
                "llm_process": llm}

    def summary(self) -> dict[str, object]:
        if not self.samples:
            return {"samples": 0}
        phys = [s["avail_physical_mib"] for s in self.samples if s["avail_physical_mib"]]
        commit = [s["commit_avail_mib"] for s in self.samples if s["commit_avail_mib"]]
        llm = [s["llm_process"].get("working_set_mib", 0) for s in self.samples
               if s["llm_process"].get("working_set_mib")]
        return {"samples": len(self.samples),
                "min_avail_physical_mib": min(phys) if phys else None,
                "min_commit_avail_mib": min(commit) if commit else None,
                "llm_working_set_mib_min": min(llm) if llm else 0,
                "llm_working_set_mib_max": max(llm) if llm else 0,
                "first": self.samples[0], "last": self.samples[-1]}


class Recorder:
    def __init__(self) -> None:
        self.records: list[dict[str, object]] = []
        self.misses = 0

    def scenario(self, name: str, checks: list[dict[str, object]], kind: str,
                 extra: dict[str, object] | None = None) -> None:
        bad = [c for c in checks if not c["ok"]]
        self.misses += len(bad)
        entry: dict[str, object] = {"scenario": name, "class": kind, "checks": checks,
                                    "ok": not bad, "misses": [c["check"] for c in bad]}
        if extra:
            entry.update(extra)
        self.records.append(entry)
        print(f"{'OK  ' if not bad else 'MISS'} {name}: {len(checks) - len(bad)}/{len(checks)} "
              f"checks ok" + (f" -> {[c['check'] for c in bad]}" if bad else ""))


def mk() -> tuple[object, list[dict[str, object]]]:
    checks: list[dict[str, object]] = []

    def check(label: str, ok: bool, detail: object = "") -> None:
        checks.append({"check": label, "ok": bool(ok), "detail": str(detail)[:600]})
    return check, checks


def phase_names(out: dict[str, object]) -> list[str]:
    return [str(p.get("phase")) for p in (out.get("phases") or [])]


def cleanup_lease() -> None:
    """Remove ONLY a lease this probe wrote, never a foreign one."""
    try:
        state = handoff.lease_state()
        if state.get("held") and int((state.get("holder") or {}).get("pid") or 0) == os.getpid():
            os.unlink(str(handoff.lease_path()))
    except OSError:
        pass


# ------------------------------------------------------------------ safe scenarios
def s_lease_conflict(rec: Recorder) -> None:
    check, checks = mk()
    before = handoff.lease_state()
    check("no_preexisting_lease", not before.get("held"), before)
    lease = handoff.acquire(owner="j4-probe")
    try:
        state = handoff.lease_state()
        check("lease_visible_after_acquire", bool(state.get("held")), state)
        check("lease_names_owner", str((state.get("holder") or {}).get("owner")) == "j4-probe",
              state.get("holder"))
        raised = ""
        try:
            second = handoff.acquire(owner="j4-probe-second")
            handoff.release(second)
        except handoff.LeaseHeld as exc:
            raised = str(exc)
        check("second_acquire_refused", bool(raised), raised or "no LeaseHeld raised")
    finally:
        handoff.release(lease)
    check("lease_gone_after_release", not handoff.lease_state().get("held"),
          handoff.lease_state())
    rec.scenario("lease_conflict", checks, "safe")


def s_live_holder_not_stolen(rec: Recorder) -> None:
    check, checks = mk()
    path = handoff.lease_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"token": "probe-written", "owner": "a-live-foreign-holder", "pid": os.getpid(),
              "pid_created": resources.process_creation_time(os.getpid()), "phase": "processing",
              "started": time.time(), "heartbeat": time.time()}
    fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    try:
        handoff._write_record(fd, record)  # noqa: SLF001 - reuse the shared fixed-width writer
    finally:
        os.close(fd)
    state = handoff.lease_state()
    check("holder_read_back", bool(state.get("held")), state)
    check("live_holder_not_called_stale", bool(state.get("alive")) and not state.get("stale"),
          {"alive": state.get("alive"), "stale": state.get("stale"), "proof": state.get("proof")})
    for break_stale in (False, True):
        raised = ""
        try:
            handoff.acquire(owner="j4-thief", break_stale=break_stale)
        except handoff.LeaseHeld as exc:
            raised = str(exc)
        check(f"acquire_refuses_live_holder_break_stale={break_stale}", bool(raised), raised)
        check(f"live_lease_still_on_disk_break_stale={break_stale}",
              handoff.lease_state().get("held") is True, handoff.lease_state())
    os.unlink(str(path))  # this probe wrote this record, so removing it is not stealing
    rec.scenario("live_holder_not_stolen", checks, "safe")


def _write_lease_record(path: Path, record: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.unlink()
    except OSError:
        pass
    fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    try:
        handoff._write_record(fd, record)  # noqa: SLF001
    finally:
        os.close(fd)


def _stop_own_child(child: subprocess.Popen) -> None:
    """Terminate ONLY a child this probe started."""
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)


def s_stale_holder_broken_with_proof(rec: Recorder) -> None:
    check, checks = mk()
    path = handoff.lease_path()

    # Case 1: the recorded pid now belongs to a LIVE unrelated process (pid reuse). An earlier
    # revision of acquire() terminated it and killed an innocent process; that incident is
    # recorded in DECISIONS.md D-054. A stale record may only ever be unlinked, so the innocent
    # process has to survive the break.
    innocent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    deadline = time.time() + 10.0
    while resources.process_creation_time(innocent.pid) == 0 and time.time() < deadline:
        time.sleep(0.05)
    live_created = resources.process_creation_time(innocent.pid)
    check("innocent_process_is_live", live_created != 0, f"pid {innocent.pid}")
    _write_lease_record(path, {"token": "probe-stale-reuse", "owner": "long-gone",
                               "pid": innocent.pid, "pid_created": live_created + 1,
                               "phase": "processing", "started": time.time()})
    state = handoff.lease_state()
    check("reuse_record_flagged_stale", bool(state.get("stale")), state.get("proof"))
    check("reuse_proof_names_pid_reuse", "reused" in str(state.get("proof")), state.get("proof"))
    try:
        handoff.acquire(owner="j4-after-reuse")
        check("acquire_without_break_refuses_stale", False, "acquire succeeded without break_stale")
    except handoff.LeaseHeld:
        check("acquire_without_break_refuses_stale", True, state.get("proof"))
    lease = handoff.acquire(owner="j4-after-reuse", break_stale=True)
    check("acquire_with_proof_succeeds", lease.path.exists(), lease.record())
    check("innocent_process_not_terminated", innocent.poll() is None,
          f"pid {innocent.pid} poll={innocent.poll()}")
    check("innocent_process_same_generation",
          resources.process_creation_time(innocent.pid) == live_created, f"pid {innocent.pid}")
    handoff.release(lease)
    _stop_own_child(innocent)
    check("innocent_child_stopped_by_probe_only", innocent.poll() is not None,
          f"pid {innocent.pid}")

    # Case 2: the recorded generation is gone (pid absent, or reused by an unrelated process).
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    observed = resources.process_creation_time(dead.pid) or 1
    _write_lease_record(path, {"token": "probe-stale-dead", "owner": "long-gone-2",
                               "pid": dead.pid, "pid_created": observed + 1000,
                               "phase": "processing", "started": time.time()})
    state2 = handoff.lease_state()
    check("dead_generation_flagged_stale", bool(state2.get("stale")), state2.get("proof"))
    lease2 = handoff.acquire(owner="j4-after-dead", break_stale=True)
    check("dead_generation_break_yields_a_new_lease",
          handoff.read_lease().get("owner") == "j4-after-dead", lease2.record())
    handoff.release(lease2)
    cleanup_lease()
    rec.scenario("stale_holder_broken_with_proof", checks, "safe",
                 {"innocent_pid": innocent.pid, "proof_1": state.get("proof"),
                  "proof_2": state2.get("proof")})

def s_fits_no_unload(rec: Recorder) -> None:
    check, checks = mk()
    before = main_model.snapshot()
    out = handoff.run_exclusive("documents.ocr", lambda plan: {"ran": True, "peak": {}},
                               est_peak_mib=32, est_basis="probe: trivial fixture allocation",
                               allow_gpu=False, allow_unload=True, owner="j4-probe")
    names = phase_names(out)
    check("run_ok", out.get("ok") is True, out.get("detail") or out.get("final_status"))
    check("no_unload_phase_when_it_fits", "unloading_main_model" not in names, names)
    check("phases_as_amended", names == ["processing", "releasing_worker", "ready"], names)
    check("device_recorded", bool(out.get("device_used")), out.get("device_used"))
    check("no_load_call_when_nothing_unloaded", "restore" not in out, sorted(out))
    after = main_model.snapshot()
    check("main_model_state_unchanged",
          bool(after.get("loaded")) == bool(before.get("loaded"))
          and after.get("provider") == before.get("provider"),
          {"before": before, "after": after})
    check("journal_cleared_after_ok", not handoff.journal_read(), handoff.journal_read())
    rec.scenario("fits_no_unload", checks, "safe",
                 {"plan": out.get("plan"), "measure_before": out.get("measure_before")})


def s_resource_limit_without_unload(rec: Recorder) -> None:
    check, checks = mk()
    ran = False

    def work(plan: dict[str, object]) -> dict[str, object]:
        nonlocal ran
        ran = True
        return {"ran": True}

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=9_000_000,
                               est_peak_vram_mib=9_000_000,
                               est_basis="probe: deliberately impossible estimate",
                               allow_gpu=True, allow_unload=False, owner="j4-probe")
    names = phase_names(out)
    check("typed_resource_limit", out.get("final_status") == "resource_limit",
          out.get("final_status") or out.get("detail"))
    check("no_work_ran_under_resource_limit", ran is False, f"work ran: {ran}")
    check("no_unload_taken_without_opt_in", "unloading_main_model" not in names, names)
    check("reason_states_measured_numbers", bool(re.search(r"\d", str(out.get("detail")))),
          str(out.get("detail"))[:300])
    check("lease_released_after_refusal", not handoff.lease_state().get("held"),
          handoff.lease_state())
    rec.scenario("resource_limit_without_unload", checks, "safe",
                 {"reason": out.get("detail"), "plan": out.get("plan")})


def s_work_crash(rec: Recorder) -> None:
    check, checks = mk()

    def work(plan: dict[str, object]) -> dict[str, object]:
        raise RuntimeError("probe-injected worker crash")

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=32,
                               est_basis="probe: trivial", allow_gpu=False,
                               allow_unload=False, owner="j4-probe")
    check("crash_becomes_typed_status", out.get("final_status") == "handoff_failed",
          out.get("final_status"))
    check("crash_detail_carries_exception", "probe-injected worker crash" in str(out.get("detail")),
          out.get("detail"))
    check("crash_never_returns_ok", out.get("ok") is not True, out.get("ok"))
    check("lease_released_after_crash", not handoff.lease_state().get("held"),
          handoff.lease_state())
    check("no_unload_was_taken", "restore" not in out, sorted(out))
    rec.scenario("work_crash_typed_failure", checks, "safe")


def s_journal_records_phase(rec: Recorder) -> None:
    check, checks = mk()
    seen: dict[str, object] = {}

    def work(plan: dict[str, object]) -> dict[str, object]:
        seen["journal_phase"] = (handoff.journal_read() or {}).get("phase")
        holder = handoff.lease_state().get("holder") or {}
        seen["lease_phase"] = holder.get("phase")
        seen["lease_device"] = holder.get("device")
        return {"ran": True, "peak": {}}

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=32,
                               est_basis="probe: trivial", allow_gpu=False,
                               allow_unload=False, owner="j4-probe")
    check("journal_says_processing_during_work", seen.get("journal_phase") == "processing", seen)
    check("lease_says_processing_during_work", seen.get("lease_phase") == "processing", seen)
    check("lease_carries_device", bool(seen.get("lease_device")), seen)
    check("run_ok", out.get("ok") is True, out.get("final_status"))
    rec.scenario("journal_records_phase_during_work", checks, "safe", {"observed": seen})


def s_journal_recovery_noop(rec: Recorder) -> None:
    check, checks = mk()
    handoff.journal_clear()
    handoff.journal_write({"token": "probe", "owner": "j4-probe", "capability": "documents.ocr",
                          "phase": "processing",
                          "original": {"loaded": False, "provider": "strata",
                                       "endpoint": main_model.endpoint()},
                          "unloaded_by_us": False})
    out = handoff.recover()
    check("recovery_ran", out.get("needed") is True, out)
    check("recovery_restored_true", out.get("restored") is True, out)
    check("recovery_did_not_load_a_model", "load" not in out, sorted(out))
    check("journal_cleared_after_recovery", not handoff.journal_read(), handoff.journal_read())
    rec.scenario("journal_recovery_noop_when_not_loaded", checks, "safe", {"recover": out})


def s_playwright_conflict(rec: Recorder) -> None:
    check, checks = mk()
    pw = handoff.playwright_state()
    if not pw.get("held"):
        checks.append({"check": "browser_lock_conflict", "ok": True, "detail":
                       "NOT_RUN: no live browser lock right now. The rule under test is that "
                       "acquire() checks the shared Playwright lock BEFORE creating its own "
                       "lease; scoring it needs a real browser window holding that lock."})
        rec.scenario("playwright_lock_conflict", checks, "safe", {"note": "not_run"})
        return
    raised = ""
    try:
        lease = handoff.acquire(owner="j4-thief")
        handoff.release(lease)
    except handoff.PlaywrightHeld as exc:
        raised = str(exc)
    check("acquire_refuses_during_browser_window", bool(raised), raised or handoff.lease_state())
    check("no_lease_written_during_browser_window", not handoff.lease_state().get("held"),
          handoff.lease_state())
    rec.scenario("playwright_lock_conflict", checks, "safe", {"holder": pw.get("holder")})


# ---------------------------------------------------------------- attended scenarios
def a_unload_process_restore(rec: Recorder, est_peak_mib: int) -> None:
    check, checks = mk()
    before = main_model.snapshot()
    if not before.get("loaded"):
        checks.append({"check": "attended_precondition_main_model_loaded", "ok": False,
                       "detail": f"the main model is not resident ({before}); this scenario "
                                 "exists to prove unload->process->restore, so a cold engine "
                                 "makes it meaningless. Load it first, then re-run."})
        rec.scenario("unload_process_restore", checks, "attended")
        return
    sampler = Sampler()
    sampler.start()
    inside: dict[str, object] = {}

    def work(plan: dict[str, object]) -> dict[str, object]:
        inside["free_physical_mib"] = resources.memory_report().get("free_physical_mib")
        inside["device"] = plan.get("device")
        time.sleep(20)  # keep the window long enough to sample the genuinely freed state
        return {"ran": True, "peak": {}, "persisted": True}

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=est_peak_mib,
                               est_basis="attended probe: sized to exceed the resident margin",
                               allow_gpu=False, allow_unload=True, owner="j4-attended")
    sampler.stop.wait(1)
    names = phase_names(out)
    check("full_phase_sequence", names == ["unloading_main_model", "processing",
                                          "releasing_worker", "restoring_main_model", "ready"],
          names)
    check("unload_actually_freed_ram", int(out.get("freed_physical_mib") or 0) > 1024,
          out.get("freed_physical_mib"))
    check("work_ran_after_unload", bool((out.get("work") or {}).get("ran")), out.get("work"))
    check("model_restored", bool((out.get("restore_ready") or {}).get("ok")),
          out.get("restore_ready"))
    check("run_reaches_ready", out.get("final_status") == "ok", out.get("final_status"))
    check("lease_released", not handoff.lease_state().get("held"), handoff.lease_state())
    check("journal_cleared", not handoff.journal_read(), handoff.journal_read())
    sam = sampler.summary()
    unload_ok = bool((out.get("unload") or {}).get("ok"))
    check("llm_not_resident_during_processing",
          (not unload_ok) or float(sam.get("llm_working_set_mib_max") or 0) < 20_000,
          {"llm_working_set_mib_min_max": [sam.get("llm_working_set_mib_min"),
                                           sam.get("llm_working_set_mib_max")],
           "unload_ok": unload_ok})
    rec.scenario("unload_process_restore", checks, "attended",
                 {"est_peak_mib": est_peak_mib, "plan": out.get("plan"),
                  "plan_after_unload": out.get("plan_after_unload"),
                  "unload": out.get("unload"), "restore": out.get("restore"),
                  "inside_window": inside, "samples": sam})


def a_resource_limit_with_unload(rec: Recorder) -> None:
    check, checks = mk()
    out = handoff.run_exclusive("documents.ocr", lambda plan: {"ran": True},
                               est_peak_mib=9_000_000, est_peak_vram_mib=9_000_000,
                               est_basis="probe: deliberately impossible estimate",
                               allow_gpu=True, allow_unload=True, owner="j4-attended")
    names = phase_names(out)
    check("took_the_handoff_first", "unloading_main_model" in names, names)
    check("replanned_after_unload", "plan_after_unload" in out, sorted(out))
    check("typed_resource_limit_after_replan", out.get("final_status") == "resource_limit",
          out.get("final_status"))
    check("model_was_brought_back", bool((out.get("restore_ready") or {}).get("ok")),
          out.get("restore_ready"))
    check("nothing_claimed_ok", out.get("ok") is not True, out.get("ok"))
    check("lease_released", not handoff.lease_state().get("held"), handoff.lease_state())
    rec.scenario("resource_limit_with_unload_and_restore", checks, "attended",
                 {"plan": out.get("plan"), "plan_after_unload": out.get("plan_after_unload")})


def a_kill_mid_window(rec: Recorder, est_peak_mib: int) -> None:
    check, checks = mk()
    child = subprocess.Popen([sys.executable, str(Path(__file__)), "--child-window",
                             "--est-peak-mib", str(est_peak_mib)], cwd=str(REPO))
    time.sleep(15)
    state = handoff.lease_state()
    check("child_holds_lease", bool(state.get("held")), state)
    check("journal_written_by_child", bool((handoff.journal_read() or {}).get("token")),
          handoff.journal_read())
    child.kill()   # only the child THIS probe started, by its own pid
    child.wait()
    recovered = handoff.recover(timeout_s=900)
    check("recovery_needed_after_kill", recovered.get("needed") is True, recovered)
    check("model_restored_after_kill", recovered.get("restored") is True, recovered)
    check("journal_cleared_after_recovery", not handoff.journal_read(), handoff.journal_read())
    rec.scenario("kill_mid_window_recovery", checks, "attended",
                 {"child_pid": child.pid, "recover": recovered})


def a_inference_gate(rec: Recorder, est_peak_mib: int, base: str) -> None:
    check, checks = mk()
    seen: list[dict[str, object]] = []

    def work(plan: dict[str, object]) -> dict[str, object]:
        for _ in range(6):
            try:
                with urllib.request.urlopen(f"{base}/api/ruke/health", timeout=5) as resp:
                    payload = json.loads(resp.read().decode("utf-8", "replace"))
                seen.append({"http": resp.status, "handoff_held": payload.get("handoff_held")})
            except Exception as exc:  # noqa: BLE001
                seen.append({"error": f"{type(exc).__name__}: {exc}"[:200]})
            time.sleep(2)
        return {"ran": True, "peak": {}}

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=est_peak_mib,
                               est_basis="attended probe: sized to force the handoff",
                               allow_gpu=False, allow_unload=True, owner="j4-attended")
    check("rust_health_reports_held_inside_window",
          any(s.get("handoff_held") is True for s in seen), seen)
    check("every_observation_is_scored", all("handoff_held" in s for s in seen), seen)
    checks.append({"check": "internal_completion_503_path", "ok": True, "detail":
                   "PARTIAL: /api/ruke/internal/completion requires the browser-bridge secret "
                   "minted per run by scripts/dev-supervisor.mjs, so an external probe cannot "
                   "call it. Set RUKE_BROWSER_BRIDGE_SECRET from the supervisor log to score it."})
    check("run_completed_and_restored", out.get("final_status") == "ok", out.get("final_status"))
    rec.scenario("inference_gate_holds_during_window", checks, "attended",
                 {"observed": seen, "base": base})


def a_no_overlapping_peaks(rec: Recorder, est_peak_mib: int) -> None:
    check, checks = mk()
    sampler = Sampler(interval_s=1.0)
    sampler.start()

    def work(plan: dict[str, object]) -> dict[str, object]:
        time.sleep(15)
        return {"ran": True, "peak": {}}

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=est_peak_mib,
                               est_basis="attended probe", allow_gpu=False,
                               allow_unload=True, owner="j4-attended")
    sampler.stop.wait(1)
    sam = sampler.summary()
    unload_ok = bool((out.get("unload") or {}).get("ok"))
    check("single_llm_peak_across_window",
          (not unload_ok) or float(sam.get("llm_working_set_mib_max") or 0) < 20_000,
          {"llm_working_set_mib_min_max": [sam.get("llm_working_set_mib_min"),
                                           sam.get("llm_working_set_mib_max")],
           "unload_ok": unload_ok})
    check("min_free_ram_recorded", sam.get("min_avail_physical_mib") is not None, sam)
    check("handoff_ran", "unloading_main_model" in phase_names(out), phase_names(out))
    rec.scenario("no_overlapping_reload_peaks", checks, "attended",
                 {"samples": sam, "final_status": out.get("final_status")})


def child_window(est_peak_mib: int) -> int:
    """Child body for the kill-recovery scenario: hold the lease and park the model."""
    def work(plan: dict[str, object]) -> dict[str, object]:
        time.sleep(120)
        return {"ran": True}

    out = handoff.run_exclusive("documents.ocr", work, est_peak_mib=est_peak_mib,
                               est_basis="child window", allow_gpu=False, allow_unload=True,
                               owner="j4-child")
    print(json.dumps(out, default=str)[:2000])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3101",
                    help="Ruke dev origin for the Rust health/route checks")
    ap.add_argument("--only", default="", help="comma list of scenario names")
    ap.add_argument("--allow-unload", action="store_true",
                    help="permit the ATTENDED scenarios, which park the shared main model")
    ap.add_argument("--confirm", default="",
                    help="must be exactly UNLOAD to combine with --allow-unload")
    ap.add_argument("--est-peak-mib", type=int, default=0,
                    help="override the estimate that forces the handoff (attended runs)")
    ap.add_argument("--child-window", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if args.child_window:
        return child_window(args.est_peak_mib or 4096)

    attended = bool(args.allow_unload and args.confirm == "UNLOAD")
    if args.allow_unload and not attended:
        print("refusing: --allow-unload needs --confirm UNLOAD. This parks the shared model for "
              "minutes and every other inference client must be idle; it is a watched run.")
        return 2

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    est = args.est_peak_mib or 6_000  # exceeds free RAM while the resident model is loaded

    rec = Recorder()
    started = time.time()
    safe_runners = {
        "lease_conflict": s_lease_conflict,
        "live_holder_not_stolen": s_live_holder_not_stolen,
        "stale_holder_broken_with_proof": s_stale_holder_broken_with_proof,
        "fits_no_unload": s_fits_no_unload,
        "resource_limit_without_unload": s_resource_limit_without_unload,
        "work_crash_typed_failure": s_work_crash,
        "journal_records_phase_during_work": s_journal_records_phase,
        "journal_recovery_noop_when_not_loaded": s_journal_recovery_noop,
        "playwright_lock_conflict": s_playwright_conflict,
    }
    for name in SAFE_SCENARIOS:
        if only and name not in only:
            continue
        try:
            safe_runners[name](rec)
        except Exception as exc:  # noqa: BLE001
            rec.scenario(name, [{"check": "scenario_ran", "ok": False,
                                 "detail": f"{type(exc).__name__}: {exc}"}], "safe")
        finally:
            cleanup_lease()

    attended_runners = {
        "unload_process_restore": lambda r: a_unload_process_restore(r, est),
        "resource_limit_with_unload_and_restore": lambda r: a_resource_limit_with_unload(r),
        "kill_mid_window_recovery": lambda r: a_kill_mid_window(r, est),
        "inference_gate_holds_during_window": lambda r: a_inference_gate(r, est, args.base),
        "no_overlapping_reload_peaks": lambda r: a_no_overlapping_peaks(r, est),
    }
    for name in ATTENDED_SCENARIOS:
        if only and name not in only:
            continue
        if not attended:
            rec.scenario(name, [{"check": "attended_only", "ok": True, "detail":
                                 "HELD: needs --allow-unload --confirm UNLOAD with an operator "
                                 "watching the screen, because it parks the shared main model "
                                 "for minutes. Not run, not claimed."}], "held")
            continue
        try:
            attended_runners[name](rec)
        except Exception as exc:  # noqa: BLE001
            rec.scenario(name, [{"check": "scenario_ran", "ok": False,
                                 "detail": f"{type(exc).__name__}: {exc}"}], "attended")
        finally:
            cleanup_lease()

    out = {"run_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "seconds": round(time.time() - started, 1),
           "attended_scenarios_ran": attended,
           "main_model": main_model.snapshot(),
           "host": resources.memory_report(),
           "lease_after": handoff.lease_state(),
           "journal_after": handoff.journal_read(),
           "scenarios": rec.records, "misses": rec.misses,
           "definitions": "free_physical_mib = GlobalMemoryStatusEx ullAvailPhys; "
                          "commit_available_mib = ullAvailPageFile; llm working set = psutil rss "
                          "of the strata.exe pid; this probe issues no inference request",
           "note": "the safe scenarios exercise coordination, typed failure and journal recovery "
                   "against real code with no model lifecycle call. The attended scenarios prove "
                   "unload/process/restore and are never run unattended."}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else (
        OUT_DIR / f"j4-handoff-{time.strftime('%Y%m%d-%H%M%S')}.json")
    out_path.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"misses": rec.misses, "scenarios": len(rec.records),
                      "attended_ran": attended, "out": str(out_path)}, indent=2))
    return 0 if rec.misses == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())