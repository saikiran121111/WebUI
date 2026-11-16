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
from . import resources
from .registry import catalog


def _popen(argv: list[str], **kw: Any) -> subprocess.Popen:
    """Single seam for spawning an owned child (also the point a test can substitute)."""
    return subprocess.Popen(argv, **kw)


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
    # What the worker is doing right now and what it last finished. The worker really
    # does emit {"kind":"progress"} lines; the pool used to read them and throw them
    # away, so any claim that the UI could show real job stages was false. These fields
    # are what makes "we report the actual stage" true rather than aspirational.
    current: str = ""
    current_note: str = ""
    last_state: str = ""
    last_detail: str = ""
    progress_seq: int = 0


class WorkerPool:
    def __init__(self) -> None:
        self._lock = threading.Lock()          # one heavy worker at a time
        self._io = threading.Lock()            # serialise upstream-style heavy stages
        self._workers: dict[str, Owned] = {}
        self._counter = 0
        self._stop = threading.Event()
        self._last_spawn_error = ""
        threading.Thread(target=self._reap_idle, daemon=True).start()

    # ---------- ownership ----------
    def _owned_identity_ok(self, o: Owned) -> bool:
        if o.proc.poll() is not None:
            return False
        return resources.process_creation_time(o.proc.pid) == o.created

    def owned_pids(self) -> list[int]:
        return [o.proc.pid for o in self._workers.values()]

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
            self._workers.pop(o.capability, None)

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
                idle = now - o.last_used
                if idle > LIMITS.idle_ttl_s or (pressure and o.heavy and idle > 2):
                    self._terminate(o, "idle_ttl" if not pressure else "memory_pressure")

    def _under_pressure(self) -> bool:
        h = resources.headroom(LIMITS.mem_budget_mib)
        return bool(h.get("measured")) and not h.get("fits_within_budget", True)

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
                                encoding="utf-8", bufsize=1)
        ct = resources.process_creation_time(proc.pid)
        o = Owned(capability=capability, proc=proc, created=ct, last_used=time.time(), heavy=heavy, resident=[])
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
                                 error=StructuredError("crash", f"worker exited rc={rc} mid-job", retryable=True,
                                                       capability=req.capability,
                                                       human_step="retry; the helper restarts on the next request"))
            try:
                line = o.lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:                      # worker closed its stdout mid-job
                self._workers.pop(req.capability, None)
                catalog().mark_worker_stopped()
                return JobResult(job_id=req.job_id, capability=req.capability, state="failed",
                                 error=StructuredError("crash", "worker closed its output stream mid-job",
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

    def report(self) -> dict[str, Any]:
        out = {}
        for cap, o in self._workers.items():
            out[cap] = {"pid": o.proc.pid, "created": o.created, "heavy": o.heavy,
                        "idle_s": round(time.time() - o.last_used, 1),
                        "memory": resources.process_memory(o.proc.pid), "resident": list(o.resident),
                        "current_stage": o.current, "current_note": o.current_note,
                        "last_state": o.last_state, "last_detail": o.last_detail,
                        "progress_seq": o.progress_seq}
        return out
