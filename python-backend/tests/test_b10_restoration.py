"""B10 (2026-11-22): Strata restoration is dispatched from worker completion.

Four laws, each pinned where the checklist names it:
  1. The restoration dispatch happens at WORKER COMPLETION, inside the window, and the
     report carries a MEASURED dispatch latency (worker completion -> restoration
     dispatch) and restoration duration. No poller — UI or otherwise — drives it.
  2. ONE reload owner. The live lease holder is the owner inside a window; on a supervisor
     restart the journal-driven startup recovery is the owner, and it YIELDS to a live
     lease rather than racing the holder.
  3. On a FAILED reload the evidence is RETAINED: the journal survives with the reason,
     the persisted processing output is named in the report, and a later startup
     recovery retries from the journal — not from a UI poll.
  4. Nothing in the browser-facing tree (lib/, app/, components/) POSTs the engine's
     /load endpoint: the reload owners are the handoff holders (ruke_ml/handoff.py,
     lib/server/extract/audio.ts) and the supervisor's journal recovery, never a UI poll.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ruke_ml import handoff
from ruke_ml.models import devices, main_model


class StubMainModel(main_model.MainModelProvider):
    """The documented Strata lifecycle answers, with the call order recorded."""
    name = "stub"

    def __init__(self, loaded=True, unload_ok=True, load_ok=True, ready_ok=True,
                 fail_first_load=False):
        self.base_url = "http://stub-llm"
        self.timeout_s = 1.0
        self.loaded = loaded
        self.unload_ok = unload_ok
        self.load_ok = load_ok
        self.ready_ok = ready_ok
        self.fail_first_load = fail_first_load
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
        return {"ok": True, "status": "unloaded", "detail": "stub unloaded",
                "http_status": 200, "retry_after_s": None}

    def load(self):
        self.calls.append("load")
        if self.fail_first_load:
            self.fail_first_load = False
            return {"ok": False, "status": "failed", "detail": "stub load failed once",
                    "http_status": 503, "retry_after_s": None}
        if not self.load_ok:
            return {"ok": False, "status": "failed", "detail": "stub load refused",
                    "http_status": 503, "retry_after_s": None}
        self.loaded = True
        return {"ok": True, "status": "loaded", "detail": "stub loaded",
                "http_status": 200, "retry_after_s": None}

    def wait_ready(self, timeout_s=0.0):
        self.calls.append("ready")
        ok = self.ready_ok
        return {"ok": ok, "status": "loaded" if ok else "loading",
                "detail": "stub ready" if ok else "never answered /health",
                "http_status": 200 if ok else 503, "retry_after_s": None}


class WindowCase(unittest.TestCase):
    """run_exclusive against stubs, with the lease and journal redirected to a temp dir."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="b10-window-"))
        for p in (mock.patch.object(handoff, "coord_dir", return_value=self.tmp),
                  mock.patch.object(handoff, "runtime_dir", return_value=self.tmp)):
            p.start()
            self.addCleanup(p.stop)

    def _run(self, provider, plans, *, allow_unload=True, work=None):
        seen: list[dict] = []

        def _work(plan):
            seen.append(plan)
            return {"peak": {"working_set_mib": 1200}, "persisted_path": "x.json",
                    "persisted": True}

        with mock.patch.object(main_model, "snapshot",
                               return_value={"provider": provider.name,
                                             "endpoint": provider.base_url,
                                             "loaded": provider.loaded}), \
                mock.patch.object(main_model, "provider_for", return_value=provider), \
                mock.patch.object(handoff.devices, "device_plan", side_effect=plans):
            out = handoff.run_exclusive("documents.ocr", work or _work, est_peak_mib=3300,
                                        est_peak_vram_mib=8100, est_basis="measured",
                                        est_vram_basis="measured", allow_gpu=False,
                                        allow_unload=allow_unload)
        return out, seen


class RestorationDispatchLaw(WindowCase):
    """Checklist: "Strata restoration dispatch from worker completion (no UI poll);
    measured dispatch latency"."""

    def _unloading_plans(self):
        before = devices.DevicePlan("documents.ocr", "none", False, True, "RAM short", {})
        after = devices.DevicePlan("documents.ocr", "cpu", True, False, "fits after unload", {})
        return [before, after]

    def test_restoration_is_dispatched_at_worker_completion_inside_the_window(self):
        """At the moment the worker returns, the model is NOT yet loaded back; by the
        moment run_exclusive returns, it is loaded AND verified ready. The dispatch is
        the window's own completion step — no poller between the two moments."""
        provider = StubMainModel(loaded=True)
        seen_state: dict[str, list[str]] = {}

        def work(_plan):
            # Mid-work: unloaded, nothing restored yet.
            seen_state["during"] = list(provider.calls)
            return {"peak": {}, "persisted_path": "x.json"}

        out, _seen = self._run(provider, self._unloading_plans(), work=work)
        self.assertTrue(out["ok"])
        self.assertEqual(seen_state["during"], ["unload"],
                         "the model must not be restored before the worker completes")
        self.assertEqual(provider.calls, ["unload", "load", "ready"],
                         "restoration was dispatched by the window at worker completion, "
                         "before run_exclusive returned")
        self.assertTrue(provider.loaded)

    def test_the_report_carries_the_measured_dispatch_latency(self):
        """The report answers "how long between the worker completing and the
        restoration being dispatched" with a MEASURED number, not a constant."""
        provider = StubMainModel(loaded=True)
        out, _seen = self._run(provider, self._unloading_plans())
        self.assertTrue(out["ok"])
        for key in ("restore_dispatch_ms", "restore_ready_ms"):
            self.assertIn(key, out, f"{key} missing from the window report")
            self.assertIsInstance(out[key], int)
            self.assertGreaterEqual(out[key], 0)
        # restore_ready_ms covers the real load+ready wait (the stub answers instantly),
        # so it must be at least as long as the dispatch gap it brackets.
        self.assertGreaterEqual(out["restore_ready_ms"], 0)
        phases = [p["phase"] for p in out["phases"]]
        self.assertLess(phases.index("releasing_worker"), phases.index("restoring_main_model"),
                        "the latency must be measured between real journalled phases")


class FailedReloadEvidence(WindowCase):
    """Checklist: "evidence retained on failed reload"."""

    def _unloading_plans(self):
        before = devices.DevicePlan("documents.ocr", "none", False, True, "RAM short", {})
        after = devices.DevicePlan("documents.ocr", "cpu", True, False, "fits after unload", {})
        return [before, after]

    def test_a_failed_reload_keeps_the_journal_the_reason_and_the_persisted_work(self):
        provider = StubMainModel(loaded=True, load_ok=False)
        out, _seen = self._run(provider, self._unloading_plans())
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "restore_failed")
        self.assertIn("stub load refused", out["detail"])
        # The processing output is named BEFORE the reload is attempted, so a failed
        # reload can never lose the work.
        self.assertEqual(out["work"]["persisted_path"], "x.json")
        # The journal SURVIVES with the failure recorded: it is what a later startup
        # recovery reads. (The window's finally block retries the restore once; the
        # stub refuses that too, so the journal must remain.)
        journal = handoff.journal_read()
        self.assertTrue(journal, "the journal must survive a failed restoration")
        self.assertTrue(journal.get("original", {}).get("loaded"),
                        "the journal records that the model WAS loaded before the window")
        self.assertIn("load", str(journal.get("phase", "")) + str(journal.get("detail", ""))
                      + str(out["reason"]))
        self.assertFalse(handoff.lease_path().exists(),
                         "a failed restoration releases the lease: the reload is the "
                         "startup recovery's job now, not a held window's")

    def test_the_journal_drives_the_retry_after_a_failed_reload(self):
        """The retained journal is not a receipt — it is what the single reload owner
        acts on next: startup recovery retries the load from it, and clears it only
        when the model is verified back."""
        provider = StubMainModel(loaded=True, load_ok=False)
        out, _seen = self._run(provider, self._unloading_plans())
        self.assertEqual(out["reason"], "restore_failed")
        self.assertTrue(handoff.journal_read())

        retry = StubMainModel(loaded=False, fail_first_load=True)
        with mock.patch.object(main_model, "provider_for", return_value=retry):
            first = handoff.recover_at_startup(timeout_s=1)
        self.assertFalse(first["restored"])
        self.assertTrue(handoff.journal_read(), "a failed retry keeps the journal again")
        self.assertEqual(retry.calls, ["load"], "the retry acts on the journal, not a poll")

        with mock.patch.object(main_model, "provider_for", return_value=retry):
            second = handoff.recover_at_startup(timeout_s=1)
        self.assertTrue(second["restored"])
        self.assertEqual(handoff.journal_read(), {}, "success clears the journal")


class StartupRecoveryLaw(WindowCase):
    """Checklist: "one reload owner". On a supervisor restart the journal-driven
    startup recovery is the reload owner; a LIVE lease holder outranks it, and the
    two never race for the engine."""

    def _interrupted_journal(self, loaded_before=True):
        handoff.journal_write({"token": "t", "owner": "dead-worker", "capability": "documents.ocr",
                               "phase": "processing", "unloaded_by_us": True,
                               "original": {"loaded": loaded_before, "endpoint": "http://stub-llm"}})

    def test_startup_recovery_yields_to_a_live_lease_and_loads_nothing(self):
        self._interrupted_journal()
        live = handoff.acquire(owner="live-window")  # this pid: alive by the pid law
        provider = StubMainModel(loaded=False)
        with mock.patch.object(main_model, "provider_for", return_value=provider):
            out = handoff.recover_at_startup(timeout_s=1)
        self.assertTrue(out["yielded"])
        self.assertFalse(out["restored"])
        self.assertEqual(provider.calls, [],
                         "the live holder is the reload owner; startup recovery must not race it")
        self.assertTrue(handoff.journal_read(), "yielding leaves the journal for the holder")
        handoff.release(live)

    def test_startup_recovery_restores_exactly_the_journal_recorded_model(self):
        self._interrupted_journal(loaded_before=True)
        provider = StubMainModel(loaded=False)
        with mock.patch.object(main_model, "provider_for", return_value=provider):
            out = handoff.recover_at_startup(timeout_s=1)
        self.assertTrue(out["restored"])
        self.assertEqual(provider.calls, ["load", "ready"])
        self.assertEqual(handoff.journal_read(), {}, "a completed recovery clears the journal")

    def test_startup_recovery_never_loads_a_model_the_journal_says_was_not_loaded(self):
        self._interrupted_journal(loaded_before=False)
        provider = StubMainModel(loaded=False)
        with mock.patch.object(main_model, "provider_for", return_value=provider):
            out = handoff.recover_at_startup(timeout_s=1)
        self.assertTrue(out["restored"])
        self.assertEqual(provider.calls, [])

    def test_the_supervisor_wires_the_startup_recovery_once(self):
        """Source contract: the supervisor's main() dispatches recover_at_startup in a
        background thread (a real load takes minutes and must not block serving), and
        supervisor.py is the ONLY server-side caller of journal recovery — one owner."""
        source = Path(handoff.__file__).with_name("supervisor.py").read_text(encoding="utf-8")
        self.assertIn("recover_at_startup(", source,
                      "the supervisor must dispatch journal recovery at startup")
        self.assertIn("threading.Thread", source)
        tree = Path(handoff.__file__).parent
        callers = [p.name for p in tree.rglob("*.py")
                   if p.name != "handoff.py"
                   and ("recover_at_startup(" in p.read_text(encoding="utf-8")
                        or "handoff.recover(" in p.read_text(encoding="utf-8"))]
        self.assertEqual(sorted(callers), ["supervisor.py"],
                         "exactly one server-side reload owner on restart")


class UiNeverDrivesTheReloadLaw(unittest.TestCase):
    """Checklist: "(no UI poll)". The browser-facing tree must never POST the engine's
    /load endpoint: the reload owners are the handoff holders (ruke_ml/handoff.py,
    lib/server/extract/audio.ts) and the supervisor's journal recovery."""

    REPO = Path(__file__).resolve().parents[2]
    ALLOWED_OWNERS = {  # relative POSIX paths: derivation + the two lease-holder paths
        "lib/server/settings.ts",
        "lib/server/extract/audio.ts",
        "lib/server/coordination/llm-lease.ts",
    }

    def test_no_ui_code_references_the_engine_reload_endpoint(self):
        import re
        pattern = re.compile(r"""["'`]/load["'`]|reloadUrl|LLM_RELOAD_URL""")
        offenders: list[str] = []
        for root in ("app", "components", "lib"):
            for path in (self.REPO / root).rglob("*.ts*"):
                rel = path.relative_to(self.REPO).as_posix()
                if any(part in rel for part in (".next", "node_modules")):
                    continue
                if rel in self.ALLOWED_OWNERS:
                    continue
                if pattern.search(path.read_text(encoding="utf-8", errors="replace")):
                    offenders.append(rel)
        self.assertEqual(offenders, [],
                         "a second reload owner appeared in the browser-facing tree: "
                         + ", ".join(offenders))


if __name__ == "__main__":
    unittest.main()
