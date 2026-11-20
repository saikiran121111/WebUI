"""Owned worker processes: lazy start, queue reuse, TTL unload, bounded termination.

Process exit is the memory-reclamation mechanism. A worker is a child of the supervisor;
the pool never touches a pid it did not create and verify.
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import ENV_PARENT_PID, LIMITS, child_env
from ..contracts import JobRequest, JobResult, ModelIdentity, StructuredError
from ..security import egress_blocked_for_workers
from . import job_limits
from . import resources
from .registry import catalog


# Capabilities whose HEAVY engine is admitted by the caller's own engine-aware planner rather
# than by this pool. `documents.ocr` is in this set because the cascade, not the worker, decides
# whether a given document needs no weights at all, the measured Tesseract recovery tree, or the
# 2 GiB PaddleOCR-VL primary (which has its own device plan and optional exclusive handoff). The
# pool still applies the model-backed free-RAM floor, so a saturated host still gets a typed
# refusal instead of a page-stall.
CALLER_GATED_ADMISSION = frozenset({"documents.ocr"})

# The commit ceiling is derived from a MEASURED commit peak (see `_ceiling_bytes`). Processing
# allocates on top of the load, so the ceiling is the demand plus headroom: 1.5x the demand,
# floored at demand + 256 MiB so that "headroom" never degenerates to zero for a small load.
COMMIT_CEILING_FACTOR_NUM, COMMIT_CEILING_FACTOR_DEN = 3, 2
COMMIT_CEILING_MARGIN_MIB = 256


def _popen(argv: list[str], **kw: Any) -> subprocess.Popen:
    """Single seam for spawning an owned child (also the point a test can substitute)."""
    return subprocess.Popen(argv, **kw)


def _close_stream(stream: object) -> None:
    """Close one pipe end that belongs to a worker whose stream has reached end-of-stream.

    Races are expected: the child may have exited and the other reader thread may already
    have closed it, so OSError/ValueError are not errors here. Without this, every
    spawn/reap cycle leaked three CRT descriptors (visible as "ResourceWarning: unclosed
    file"), and a long-lived supervisor eventually reaps workers until a spawn can no
    longer create a pipe.
    """
    close = getattr(stream, "close", None)
    if close is None or not callable(close):
        return
    try:
        close()
    except (OSError, ValueError):
        pass


def _mib(value: Any) -> str:
    """Render a memory figure inside a human sentence without inventing one.

    A quantity that was never read says UNKNOWN. A bare `0` in that slot is a measurement
    claiming "this held nothing", so formatting an absent figure as `0 MiB` is how an
    unmeasured host turns into a fabricated number that a later report quotes as evidence.
    documents/ocr_cascade.py already follows this law for engine child peaks (_engine_child_peak
    / _operation_peak); this closes the same class in the admission and ceiling paths.
    """
    if value is None or value == "" or value == []:
        return "UNKNOWN"
    return f"{value} MiB"


@dataclass(slots=True)
class Owned:
    capability: str
    proc: subprocess.Popen
    created: int            # process creation time, identity proof against PID reuse
    last_used: float
    heavy: bool
    resident: list[str]
    # A slots dataclass needs a real default: without one, _spawn raised TypeError and no
    # worker could ever be created (found by the worker round-trip test).
    lines: "queue.Queue[object]" = field(default_factory=queue.Queue)
    # Worker stderr is captured, not thrown away: "process died" and "process died with
    # this traceback" are not the same diagnostic, and DEVNULL hid the reader-thread crash.
    stderr_text: str = ""
    # Set once the stderr reader thread reaches end-of-stream. A crash path waits on this
    # (bounded) so the traceback the child printed is actually in `stderr_text` before the
    # supervisor quotes it; otherwise the most useful diagnostic is the one that is missing.
    drained: threading.Event = field(default_factory=threading.Event)
    # What the worker is doing right now and what it last finished. The worker really
    # does emit {"kind":"progress"} lines; the pool used to read them and throw them
    # away, so any claim that the UI could show real job stages was false. These fields
    # are what makes "we report the actual stage" true rather than aspirational.
    current: str = ""
    current_note: str = ""
    last_state: str = ""
    last_detail: str = ""
    progress_seq: int = 0
    # A job handed to this worker is IN FLIGHT until the read loop returns it. Without
    # this, `last_used` is the only staleness signal and the idle reaper terminates a
    # worker while it is still working: measured at 125.3s/125.7s against
    # `idle_ttl_s = 120`, which surfaced as "worker closed its output stream mid-job"
    # and `deadline_exceeded` for jobs that were simply still running.
    job_id: str = ""
    job_started: float = 0.0
    job_deadline_at: float = 0.0
    # What the worker imported before its handshake, and how long that took. This is the
    # cold-load evidence for a heavy dependency: "the model library costs X ms and Y MiB
    # to load" has to be measured per worker, not assumed.
    prelude: dict[str, Any] = field(default_factory=dict)
    # The enforceable ceiling this worker was placed under (a Windows job object, or an
    # explicit "the OS refused" report). The handle is held here so the peak is still
    # queryable when the worker is reaped, which is the evidence the memory report needs.
    job: Any = None
    ceiling: dict[str, Any] = field(default_factory=dict)


class WorkerPool:
    def __init__(self) -> None:
        self._lock = threading.Lock()          # one heavy worker at a time
        self._io = threading.Lock()            # serialise upstream-style heavy stages
        self._workers: dict[str, Owned] = {}
        self._counter = 0
        self._stop = threading.Event()
        self._last_spawn_error = ""
        # Bounded history of ceiling evidence, newest last, collected when a worker is reaped.
        self._ceiling_evidence: list[dict[str, Any]] = []
        # How many heavy workers were unloaded early because the host ran out of free RAM.
        # A cold start costs seconds; a pagefile spiral costs the whole machine.
        self._pressure_releases = 0
        threading.Thread(target=self._reap_idle, daemon=True).start()

    # ---------- ownership ----------
    def _owned_identity_ok(self, o: Owned) -> bool:
        if o.proc.poll() is not None:
            return False
        return resources.process_creation_time(o.proc.pid) == o.created

    def owned_pids(self) -> list[int]:
        return [o.proc.pid for o in self._workers.values()]

    @staticmethod
    def _worker_stderr(o: Owned, wait_s: float = 0.5, limit: int = 1200) -> str:
        """Bounded tail of what the worker printed to stderr, after its pipe is drained."""
        o.drained.wait(timeout=max(0.0, wait_s))
        tail = o.stderr_text[-limit:].strip()
        return tail.replace("\r\n", "\n").replace("\r", "\n")

    def _terminate(self, o: Owned, why: str) -> None:
        """Bounded escalation: ask, terminate, kill. Only ever our own child."""
        # "exit" asks a clean shutdown (idle/teardown); "cancel" is used while a job is
        # in flight, where the point is to stop work, not to lose the process.
        ask = "shutdown" if why in ("idle_ttl", "memory_pressure", "supervisor shutdown",
                                    "write_failed") else "cancel"
        try:
            if o.proc.poll() is None:
                try:
                    o.proc.stdin.write(json.dumps({"kind": ask, "reason": why}) + "\n")
                    o.proc.stdin.flush()
                except (OSError, ValueError):
                    pass
                deadline = time.time() + LIMITS.terminate_grace_s
                while o.proc.poll() is None and time.time() < deadline:
                    time.sleep(0.05)
                if o.proc.poll() is None:
                    o.proc.terminate()
                    kill_at = time.time() + LIMITS.terminate_grace_s
                    while o.proc.poll() is None and time.time() < kill_at:
                        time.sleep(0.05)
                if o.proc.poll() is None:
                    o.proc.kill()
                    o.proc.wait(timeout=LIMITS.terminate_grace_s)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            catalog().mark_worker_stopped()
            for mid in o.resident:
                catalog().mark_released(mid)
            self._release_ceiling(o)
            self._workers.pop(o.capability, None)
            # `_terminate` is the one place the pool stops using a worker, so it is also the
            # place its request pipe is released. Closing it earlier (from the stdout reader)
            # turned a still-consumable worker into "worker pipe failed" and made the pool
            # lose the worker's own typed diagnosis.
            _close_stream(o.proc.stdin)

    def stop_all(self) -> None:
        self._stop.set()
        for cap in list(self._workers):
            self._terminate(self._workers[cap], "supervisor shutdown")

    def _reap_idle(self) -> None:
        while not self._stop.wait(1.0):
            now = time.time()
            pressure = self._under_pressure()
            for cap, o in list(self._workers.items()):
                if not self._owned_identity_ok(o):
                    self._workers.pop(cap, None)
                    catalog().mark_worker_stopped()
                    continue
                if o.job_id:
                    # Never unload a worker that is executing a job: killing it mid-job
                    # destroys work and looks to its owner like a crash. The read loop in
                    # `_dispatch` owns the job deadline; this is only a defensive backstop
                    # for a worker whose owner vanished without clearing the in-flight flag.
                    if now > o.job_deadline_at + 30.0:
                        self._terminate(o, "job_overdue")
                    continue
                idle = now - o.last_used
                if idle > LIMITS.idle_ttl_s or (pressure and o.heavy and idle > 2):
                    self._terminate(o, "idle_ttl" if not pressure else "memory_pressure")

    def _under_pressure(self) -> bool:
        h = resources.headroom(LIMITS.mem_budget_mib)
        if bool(h.get("measured")) and not h.get("fits_within_budget", True):
            return True
        # Commit headroom is not the only thing that runs out here. When physical RAM is
        # nearly gone, an idle heavy worker is holding the difference, and it is the one
        # thing we can take back without touching output quality.
        m = resources.system_memory()
        return (m.source == "GlobalMemoryStatusEx"
                and m.available_mib < resources.FLOOR_FREE_PHYSICAL_MIB)

    # ---------- enforceable ceilings ----------
    def _ceiling_bytes(self, capability: str, heavy: bool) -> tuple[int, dict[str, Any]]:
        """Per-worker commit ceiling, derived from the quantity the ceiling is expressed in.

        A private job per heavy worker is what stops one capability from consuming the whole
        aggregate allowance and then starving the next one.

        THE UNIT MATTERS, and getting it wrong is a production bug, not a rounding error. A
        Windows job object caps COMMIT charge; `est_peak_mib` is a RESIDENT working-set
        measurement. For the pinned whisper snapshot those measured 388 MiB resident against
        1,276 MiB commit, so a ceiling of 2 x 388 = 776 MiB of commit killed the load inside
        oneMKL ("mkl_malloc: failed to allocate memory") and the caller was told
        "model_unavailable: prepare the pinned asset". Measured and reproduced on this host:
        docs/overnight/logs/f54-g26-asr-default-1.log (fails at 776 MiB) against
        f54-g26-asr-raised-1.log (same job, real transcription at 3,072 MiB). So:

          * when the row carries a MEASURED commit peak, that is the number the ceiling must
            clear, and the processing headroom is added on top of it (never below it);
          * when it does not, the old resident x2 rule is used and the note says in words
            that commit was never measured, so no report can call it a measurement;
          * either way the result is then clamped to what the host can hold RIGHT NOW, and if
            that clamp pushes the ceiling under a KNOWN commit demand the worker is refused
            typed by `_admission_refusal` instead of being squeezed into a ceiling it cannot
            load under. Squeezing is the failure mode this replaces.
        """
        specs = [s for s in catalog().for_capability(capability) if s.adapter]
        measured = max((int(s.est_peak_mib) for s in specs if int(s.est_peak_mib) > 0), default=0)
        commit_known = max((int(getattr(s, "est_peak_commit_mib", 0) or 0) for s in specs
                            if int(getattr(s, "est_peak_commit_mib", 0) or 0) > 0), default=0)
        commit_basis = next((str(getattr(s, "est_peak_commit_basis", "") or "") for s in specs
                             if int(getattr(s, "est_peak_commit_mib", 0) or 0) == commit_known
                             and commit_known > 0), "")
        if commit_known > 0:
            # 1.5x the measured demand, and never less than demand + 256 MiB. The multiplier
            # is for processing on top of the load (a real page, an audio window); the floor
            # is what makes "headroom" mean a non-zero amount for a small measured demand.
            base = max(commit_known + COMMIT_CEILING_MARGIN_MIB,
                       (commit_known * COMMIT_CEILING_FACTOR_NUM) // COMMIT_CEILING_FACTOR_DEN,
                       measured * 2)
        else:
            base = measured * 2 if measured else LIMITS.light_worker_ceiling_mib
        ceiling = int(base * 1 << 20)
        if not heavy:
            # Light workers carry no model weights, so the small cap applies. It stays above
            # every commit demand ever measured for a non-heavy row (the native readers peak
            # in the tens of MiB), and the shortfall rule below refuses rather than squeezes.
            ceiling = min(ceiling, LIMITS.light_worker_ceiling_mib << 20)
        note: dict[str, Any] = {"measured_load_peak_mib": measured,
                                "estimate": "measured" if measured else "unmeasured",
                                "measured_commit_peak_mib": commit_known,
                                "commit_estimate": "measured" if commit_known else "unmeasured",
                                "commit_basis": commit_basis or (
                                    "commit charge has never been measured for this capability; "
                                    "the ceiling falls back to 2x the resident peak, which is a "
                                    "floor and is not presented as a measurement")}
        m = resources.system_memory()
        if m.source == "GlobalMemoryStatusEx":
            avail_cap = (m.available_mib - resources.FLOOR_FREE_PHYSICAL_MIB) << 20
            if avail_cap <= 0:
                # Under the floor the smallest useful ceiling still applies: it is enough for
                # a native reader (measured 22 MiB peak commit on a real PDF parse) and it is
                # what stops a runaway allocation finishing the host. A model-backed worker
                # here is refused by the admission gate, not squeezed into 256 MiB - and the
                # shortfall flag below is what makes that sentence true for commit as well.
                avail_cap = 256 << 20
            if avail_cap < ceiling:
                note["clamped_from_bytes"] = ceiling
                note["clamped_to_free_physical_mib"] = m.available_mib
                note["clamped_by"] = ("free physical RAM minus the floor: commit charge is at "
                                      "least the resident set, so this cap is what keeps a "
                                      "growing worker from paging the resident model")
                ceiling = avail_cap
        ceiling = max(256 << 20, min(ceiling, LIMITS.mem_ceiling_bytes))
        # The refusal condition, recorded where the spawn path can see it. A ceiling under the
        # measured demand is not "tight but workable": the load fails inside the engine's
        # allocator and the error text arrives as an unrelated-looking engine crash.
        if commit_known > 0 and (ceiling >> 20) < commit_known + COMMIT_CEILING_MARGIN_MIB:
            note["ceiling_below_measured_commit_demand"] = True
            note["commit_shortfall_mib"] = (commit_known + COMMIT_CEILING_MARGIN_MIB
                                            - (ceiling >> 20))
            note["refuse_reason"] = ("the commit ceiling this host can give right now ("
                                     + str(ceiling >> 20) + " MiB) is under the "
                                     + str(commit_known) + " MiB this capability was measured "
                                     "needing, so the load would fail inside the engine's "
                                     "allocator rather than run")
        return ceiling, note

    def _apply_ceiling(self, o: Owned) -> dict[str, Any]:
        """Put a freshly spawned worker under an OS-enforced commit ceiling, as early as we can.

        The unavoidable gap between CreateProcess and this call is recorded, not hidden: for
        children the supervisor itself spawns it is a first-kilobytes window, which is why the
        runtime-tree job is installed on the supervisor at startup (children then join it at
        create time with no window at all).
        """
        limit, policy = self._ceiling_bytes(o.capability, o.heavy)
        report = job_limits.attach_child(o.proc, limit)
        job = report.pop("job", None)
        o.job = job
        record = {k: v for k, v in report.items()}
        record["estimated"] = limit
        record["ceiling_policy"] = policy
        if isinstance(job, job_limits.JobLimit):
            record["limit_bytes"] = job.peaks().get("limit_bytes", limit)
        o.ceiling = record
        return record

    def _release_ceiling(self, o: Owned) -> None:
        """Record what the ceiling actually observed, then close the handle. Only our own job."""
        job = o.job
        o.job = None
        if job is None or not isinstance(job, job_limits.JobLimit):
            return
        try:
            peaks = job.peaks()
        finally:
            job.close()
        if not peaks.get("available"):
            return
        self._ceiling_evidence.append({
            "capability": o.capability, "pid": o.proc.pid,
            # A missing figure stays missing. `0` would be read as "this worker charged
            # nothing", which is a measurement claim about a quantity that was never read.
            "limit_bytes": peaks.get("limit_bytes"),
            "peak_job_commit_mib": peaks.get("peak_job_commit_mib"),
            "peak_process_commit_mib": peaks.get("peak_process_commit_mib"),
            "at": time.time(),
        })
        del self._ceiling_evidence[:-24]

    def ceiling_evidence(self) -> list[dict[str, Any]]:
        return list(self._ceiling_evidence)

    def pressure_releases(self) -> int:
        """Count of heavy workers unloaded early to give RAM back to the host."""
        return self._pressure_releases

    def _release_if_pressure(self, capability: str) -> int:
        """Return a finished heavy worker's RAM immediately, instead of holding it.

        The idle TTL is 120 s and the reaper only runs between dispatches. On a host that is
        down to a few GiB free, keeping a heavy worker resident for two minutes AFTER its job
        ended is a memory tax paid by everything else on the machine, and it buys nothing:
        the next job reloads the worker anyway. Freeing it is a cold-start cost, never a
        quality cost, and it is the cheapest lever available on a saturated host.
        """
        if not self._under_pressure():
            return 0
        o = self._workers.get(capability)
        if o is None or not o.heavy or o.job_id:
            return 0
        self._terminate(o, "memory_pressure_release")
        self._pressure_releases += 1
        return 1

    def _unload_other_heavy(self, keep: str) -> list[str]:
        """Free the physical RAM another idle heavy worker is holding before loading a new one.

        Heavy jobs are already serialised, so keeping several heavy workers resident only
        multiplies the resident set; unloading them costs cold-start time, never output
        quality. This is the cheap lever that keeps a document OCR run and a transcription
        from being resident at the same time on a host that cannot hold both.
        """
        dropped: list[str] = []
        for cap, other in list(self._workers.items()):
            if cap == keep or not other.heavy or other.job_id:
                continue
            self._terminate(other, "memory_pressure")
            dropped.append(cap)
        return dropped

    def _admission(self, capability: str) -> tuple[int, dict[str, Any]]:
        """Estimated load peak for a capability plus the host's answer about loading it.

        `est_peak_mib` is only ever a measured number (the registry records measured load
        peaks), so an unmeasured capability is reported as unmeasured rather than guessed at.

        The 1 GiB free-RAM floor is a gate on loading MODEL WEIGHTS, which is the expensive,
        avoidable thing. A worker whose adapters carry no asset (pypdf, the OOXML reader) reads
        a document with no weights at all: refusing it on a busy host would remove the cheap
        capability in order to protect RAM that its own measured 22 MiB peak does not use.
        Those are gated by their own measured need instead.

        `documents.ocr` is the other case, and it is the opposite direction: what it will load
        is not a property of the worker but of the engine the cascade picks for THIS document.
        The native path loads nothing, Tesseract recovery is a measured few-hundred-MiB tree,
        and only the PaddleOCR-VL primary is heavy. The cascade owns that decision because it is
        the only place that knows the engine, the device plan and whether the exclusive handoff
        is permitted, so the pool must not pre-empt it by charging the worker for a model it may
        never load - that would delete the recovery path along with the heavy one. What the pool
        still requires is the model-backing floor: on a genuinely saturated host the job is
        refused typed, exactly as before.
        """
        specs = [s for s in catalog().for_capability(capability) if s.adapter]
        model_backed = any(str(getattr(s, "asset", "") or "").strip() for s in specs)
        floor = resources.FLOOR_FREE_PHYSICAL_MIB if model_backed else 0
        # The basis travels with the number it describes: the spec that set the maximum also
        # says whether that maximum was measured here or estimated from weight bytes, and
        # `admission` uses that to decide how much margin the load must leave behind.
        caller_planned = capability in CALLER_GATED_ADMISSION
        est = max((int(s.est_peak_mib) for s in specs
                   if int(s.est_peak_mib) > 0
                   and not (caller_planned and not resources.estimate_is_measured(
                       str(getattr(s, "est_peak_basis", "") or "")))),
                  default=0)
        basis = next((str(getattr(s, "est_peak_basis", "") or "") for s in specs
                      if int(s.est_peak_mib or 0) == est and est > 0), "")
        return est, resources.admission(est, floor_mib=floor, est_basis=basis)

    def _commit_ceiling_shortfall(self, capability: str) -> dict[str, Any] | None:
        """Non-None when the ceiling this host can enforce is under the measured commit demand.

        Spawning anyway is the bug this exists to prevent: the worker starts, gets the job,
        and dies inside the engine's own allocator. The text that comes back is an engine
        string ("mkl_malloc: failed to allocate memory"), and the funnel flattened it into
        `model_unavailable`, whose human step told the user to re-download weights that were
        already on disk. Refusing first states the same fact in the reason the contract
        already reserves for it, with the remedy that actually applies.
        """
        limit, note = self._ceiling_bytes(capability, True)
        if not note.get("ceiling_below_measured_commit_demand"):
            return None
        out = dict(note)
        out["limit_bytes"] = int(limit)
        out["limit_mib"] = int(limit) >> 20
        return out

    def _admission_refusal(self, req: JobRequest) -> JobResult | None:
        """Refuse to load a heavy worker the host cannot hold - before it starts paging.

        This is the half a job object cannot do: the ceiling bounds commit charge, but
        resident physical RAM is what this host runs out of, and a worker that pages is not
        merely slow, it drags the resident model and every other process with it.

        The refusal is typed (`memory_pressure`, the reason the frozen contract already
        carries for this case), retryable, and states what would actually change the answer.
        Idle heavy workers are unloaded first, because freeing them costs cold-start time
        and never output quality.
        """
        est, adm = self._admission(req.capability)
        short = self._commit_ceiling_shortfall(req.capability)
        if (not adm.get("measured") or adm.get("fits")) and short is None:
            return None
        dropped = self._unload_other_heavy(req.capability)
        est, adm = self._admission(req.capability)
        short = self._commit_ceiling_shortfall(req.capability)
        if (adm.get("measured") and adm.get("fits")) and short is None:
            return None
        if short is not None:
            # Two different quantities, two different sentences. Free RAM may look ample while
            # the ceiling this host can offer a private job is still under the engine's own
            # measured commit demand - which is exactly the state that produced the ASR failure
            # in ruke_ml/allocations.py. Saying "free RAM" here would describe the wrong fact.
            detail = (f"the enforceable commit ceiling available to a private worker is "
                      f"{_mib(short.get('limit_mib'))}, under the "
                      f"{_mib(short.get('measured_commit_peak_mib'))} of commit this capability "
                      f"was MEASURED needing ({short.get('commit_basis', '')}); "
                      f"shortfall {_mib(short.get('commit_shortfall_mib'))}. Free physical RAM "
                      f"{_mib(adm.get('free_physical_mib'))}")
            step = ("free commit charge: close what is holding memory, or let the resource "
                    "coordinator take the unload/load handoff and retry. The weights are "
                    "already on disk - re-preparing them cannot help, and must not be "
                    "suggested as the remedy")
        else:
            detail = "; ".join(adm.get("reasons", [])) or "host memory accounting refused the load"
            step = ("close or unload what is holding RAM (the loaded model, another heavy "
                    "Ruke job), or run this capability through its cheaper engine: the "
                    "lighter CPU path stays available and is reported as the lighter path")
        return JobResult(
            job_id=req.job_id, capability=req.capability, state="failed",
            error=StructuredError(
                "memory_pressure",
                f"{req.capability} was not loaded: {detail}. Free physical RAM "
                f"{_mib(adm.get('free_physical_mib'))} of {_mib(adm.get('total_physical_mib'))}.",
                retryable=True, capability=req.capability,
                human_step=step,
            ),
            payload={"refused_for": ("commit_ceiling_below_measured_demand" if short is not None
                                     else "host_memory"),
                     "admission": adm, "commit_ceiling": short or {},
                     "unloaded_heavy_workers": dropped,
                     "policy": "resident physical RAM gate; the job-object ceiling bounds "
                               "commit charge, which is a different quantity; a ceiling under a "
                               "measured commit demand is refused rather than squeezed"},
        )

    # ---------- execution ----------
    def _spawn(self, capability: str, heavy: bool, budget_s: float) -> Owned | None:
        self._counter += 1
        # A capability worker gets no egress path: it operates on staged local inputs. Model
        # acquisition is a separate, explicit owner action, never a silent background download
        # from inside a parse/OCR/ASR process. (egress_blocked_for_workers used to be dead
        # code: declared and tested in isolation, but never actually applied to a child.)
        env = egress_blocked_for_workers(child_env(f"sup-{self._counter}"))
        env[ENV_PARENT_PID] = str(__import__("os").getpid())
        proc = _popen([sys.executable, "-m", "ruke_ml.workers.runner", capability],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, text=True,
                                encoding="utf-8", errors="replace", bufsize=1)
        ct = resources.process_creation_time(proc.pid)
        o = Owned(capability=capability, proc=proc, created=ct, last_used=time.time(), heavy=heavy, resident=[])
        self._apply_ceiling(o)
        threading.Thread(target=self._pump, args=(o,), daemon=True).start()
        threading.Thread(target=self._drain_stderr, args=(o,), daemon=True).start()
        self._workers[capability] = o
        if heavy:
            catalog().mark_worker_started(capability)
        # Handshake, bounded. A process that is alive but silent is NOT a worker we may
        # hand a job to: waiting a full job deadline for a control channel that is dead
        # is how one broken helper wedged an entire capability for 15 minutes.
        deadline = time.time() + min(LIMITS.worker_ready_timeout_s, max(1.0, budget_s))
        while time.time() < deadline:
            if proc.poll() is not None:
                self._workers.pop(capability, None)
                catalog().mark_worker_stopped()
                self._last_spawn_error = (f"worker exited rc={proc.returncode} before its handshake: "
                                          f"{o.stderr_text[-800:] or 'no stderr'}")
                return None
            try:
                line = o.lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:
                self._workers.pop(capability, None)
                catalog().mark_worker_stopped()
                self._last_spawn_error = f"worker closed its output stream before handshake: {o.stderr_text[-800:] or 'no stderr'}"
                return None
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                self._last_spawn_error = "worker emitted a non-JSON line before handshake"
                self._terminate(o, "protocol_error")
                return None
            if isinstance(obj, dict) and obj.get("kind") == "ready":
                if isinstance(obj.get("prelude"), dict):
                    o.prelude = dict(obj["prelude"])
                return o
        self._last_spawn_error = "worker never completed its ready handshake in time"
        self._terminate(o, "protocol_error")
        return None

    def run(self, req: JobRequest, deadline_s: float | None = None) -> JobResult:
        heavy = req.capability not in ("video.search_hints", "video.timeline")
        timeout = deadline_s or req.deadline_s or LIMITS.worker_deadline_s
        gate = self._lock if heavy else None
        if gate is not None:
            if not gate.acquire(timeout=max(1.0, timeout)):
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError("resource_busy", "another heavy capability holds the only heavy slot",
                                                       retryable=True, capability=req.capability,
                                                       human_step="wait for the running job, or lower concurrency"))
        try:
            with self._io:
                res = self._dispatch(req, timeout, heavy)
        finally:
            if gate is not None:
                gate.release()
        self._note_outcome(req.capability, res)
        if heavy:
            # A heavy job that has finished has already paid its load cost; keeping its
            # worker resident past that point only rents RAM on a host that has none.
            self._release_if_pressure(req.capability)
        return res

    def _note_outcome(self, capability: str, res: JobResult) -> None:
        """Record the terminal state of a job on the worker that ran it (if it survived).

        A worker that crashed mid-job has already been removed from the map, so it has no
        row here: its failure is carried by the JobResult instead of being invented here.
        """
        with self._io:
            o = self._workers.get(capability)
        if o is None:
            return
        o.current = ""
        o.current_note = ""
        o.last_state = res.state
        o.last_detail = (res.error.message if res.error is not None else "")[:300]

    def _dispatch(self, req: JobRequest, timeout: float, heavy: bool) -> JobResult:
        o = self._workers.get(req.capability)
        if o is not None and not self._owned_identity_ok(o):
            self._workers.pop(req.capability, None)
            o = None
        if heavy and o is None:
            # Cold-loading a heavy model is where RAM is actually spent, so the gate sits
            # here rather than in `run()`: an already-resident worker is never refused.
            refusal = self._admission_refusal(req)
            if refusal is not None:
                return refusal
        if o is None:
            try:
                o = self._spawn(req.capability, heavy, timeout)
            except OSError as exc:
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError("internal", f"worker could not start: {exc}",
                                                       retryable=True, capability=req.capability))
            if o is None:
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError("crash",
                                                       self._last_spawn_error or "worker failed its startup handshake",
                                                       retryable=True, capability=req.capability,
                                                       human_step="retry; the helper restarts on the next request"))
        o.last_used = time.time()
        o.job_id, o.job_started = req.job_id, time.time()
        o.job_deadline_at = time.time() + timeout
        try:
            return self._exchange(o, req, timeout)
        finally:
            # Clear the in-flight marker on every exit path; otherwise the idle reaper
            # would treat this worker as permanently busy and never unload it.
            o.job_id = ""
            o.last_used = time.time()

    def _exchange(self, o: Owned, req: JobRequest, timeout: float) -> JobResult:
        """Hand one request to an existing worker and read its answer until the deadline."""
        line = json.dumps(req.to_dict(), ensure_ascii=False)
        try:
            o.proc.stdin.write(line + "\n")
            o.proc.stdin.flush()
        except (OSError, ValueError) as exc:
            self._terminate(o, "write_failed")
            return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                             error=StructuredError("crash", f"worker pipe failed: {exc}", retryable=True,
                                                   capability=req.capability,
                                                   human_step="the job can be retried; the worker will restart"))
        deadline = time.time() + timeout
        while time.time() < deadline:
            if o.proc.poll() is not None:
                rc = o.proc.returncode
                catalog().mark_worker_stopped()
                self._workers.pop(req.capability, None)
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError(
                                     "crash",
                                     (f"worker exited rc={rc} mid-job: "
                                      f"{self._worker_stderr(o) or 'no stderr from the worker'}"),
                                     retryable=True, capability=req.capability,
                                     human_step="retry; the helper restarts on the next request"))
            try:
                line = o.lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:                      # worker closed its stdout mid-job
                self._workers.pop(req.capability, None)
                catalog().mark_worker_stopped()
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError(
                                     "crash",
                                     ("worker closed its output stream mid-job: "
                                      f"{self._worker_stderr(o) or 'no stderr from the worker'}"),
                                     retryable=True, capability=req.capability,
                                     human_step="retry; the helper restarts on the next request"))
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                self._terminate(o, "protocol_error")
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError("internal", "worker emitted a non-JSON line", retryable=False,
                                                       capability=req.capability))
            if not isinstance(obj, dict):
                continue                                     # not a protocol object: ignore, do not misread
            kind = obj.get("kind")
            if kind == "progress":
                # Capture, do not discard. An unlabelled progress frame (no job id, or the
                # watchdog's empty-id farewell) is not attributed to this job.
                state = str(obj.get("state", ""))
                if obj.get("job_id") == req.job_id and state:
                    o.progress_seq += 1
                    o.current = state
                    o.current_note = str(obj.get("note", ""))[:200]
                continue
            if kind == "control_channel_failed":
                # The worker reported that its own request loop is dead. Failing now is
                # honest; waiting out the deadline would pretend it might still answer.
                detail = str(obj.get("detail", ""))[:400]
                self._terminate(o, "protocol_error")
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError("crash", f"worker control channel failed: {detail}",
                                                       retryable=True, capability=req.capability,
                                                       human_step="retry; the helper restarts on the next request"))
            if kind == "ready":
                continue                                     # a duplicate handshake is not a job answer
            if obj.get("job_id") not in (None, "", req.job_id):
                continue                                     # an answer for another job is never misfiled here
            res = JobResult.from_dict(obj)
            for m in obj.get("residents", []) or []:
                o.resident.append(m)
                catalog().mark_resident(m)
            return res

        self._terminate(o, "deadline")
        return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                         error=StructuredError("deadline_exceeded", f"no result within {timeout:.0f}s",
                                               retryable=True, capability=req.capability,
                                               human_step="raise the deadline or narrow the input"))

    @staticmethod
    def _pump(o: Owned) -> None:
        """Reader thread per worker. On Windows select() only works on sockets, never
        on pipes, so blocking stdout reads live on their own thread and results travel
        through a queue. None is the end-of-stream sentinel."""
        try:
            while True:
                line = o.proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if line:
                    o.lines.put(line)
        except (OSError, ValueError):
            pass
        finally:
            o.lines.put(None)
            # The child is gone, so our read end is finished with. Closing it (and the
            # request pipe, which nobody can use any more) is what keeps a long-lived
            # supervisor from leaking three CRT descriptors per spawn/reap cycle: the
            # reaper legitimately recycles workers all day, and a leaked fd is a slow
            # leak that shows up much later as a spawn that cannot create a pipe.
            _close_stream(o.proc.stdout)
            # A closed output stream is not proof by itself that the child stopped consuming
            # stdin, so the request pipe is only released once the process is verifiably
            # gone; otherwise the pool would report a pipe error instead of the worker's own
            # failure (caught by the dead-control-channel test).
            if o.proc.poll() is not None:
                _close_stream(o.proc.stdin)

    @staticmethod
    def _drain_stderr(o: Owned) -> None:
        """Keep stderr drained and bounded (last 8 KB). DEVNULL hid the reader-thread
        crash that made every worker silently hang; an unread pipe can also deadlock
        a chatty child."""
        try:
            while True:
                line = o.proc.stderr.readline()
                if not line:
                    break
                o.stderr_text = (o.stderr_text + line)[-8000:]
        except (OSError, ValueError):
            pass
        finally:
            o.drained.set()
            _close_stream(o.proc.stderr)

    def report(self) -> dict[str, Any]:
        out = {}
        for cap, o in self._workers.items():
            out[cap] = {"pid": o.proc.pid, "created": o.created, "heavy": o.heavy,
                        "idle_s": round(time.time() - o.last_used, 1),
                        # The recorded pid is only the process we spawned. On this host the
                        # venv interpreter is a redirector, so the model weights live in its
                        # child; single-pid accounting reported 5 MiB for a worker holding
                        # hundreds. Tree accounting is the only honest number here.
                        "memory": resources.process_tree_memory(o.proc.pid),
                        "resident": list(o.resident),
                        "current_stage": o.current, "current_note": o.current_note,
                        "last_state": o.last_state, "last_detail": o.last_detail,
                        "progress_seq": o.progress_seq, "prelude": dict(o.prelude),
                        # The enforced ceiling, plus the peak the OS actually recorded while
                        # this worker ran. A memory claim is only worth its mechanism.
                        "ceiling": dict(o.ceiling),
                        "ceiling_peaks": (o.job.peaks()
                                          if isinstance(o.job, job_limits.JobLimit) else {})}
        return out
