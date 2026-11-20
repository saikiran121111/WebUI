"""Enforceable memory ceilings for the processes this supervisor owns.

Why a job object and not a sampler: polling measures after the fact. Between two samples a
worker can commit hundreds of MiB, so a budget enforced only by sampling is a report, not a
bound. A Windows job object carries an aggregate charge (JOB_OBJECT_LIMIT_JOB_MEMORY): once
the job reaches its limit, the allocation inside the worker fails as MemoryError instead of
pushing the host into the pagefile. That is the difference between "we noticed" and "it could
not happen".

Two quantities stay separate in this module:

  * COMMIT charge (private bytes plus pagefile reserve) is what a job object limits;
  * RESIDENT physical RAM is what this host actually runs out of first, and a job object
    cannot bound it.

So a job object is paired with `resources.admission()`, which refuses a heavy worker before
it can consume the resident RAM. Neither mechanism is presented as the other.

If the OS refuses the ceiling, `install_process_job()` reports the refusal with its win32
error code and `status()` says `enforced: false`. A polled number is never dressed up as an
enforced limit.
"""
from __future__ import annotations

import ctypes
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any

from . import resources

# winjob.h limit flags.
JOB_LIMIT_ACTIVE_PROCESS = 0x0008
JOB_LIMIT_JOB_MEMORY = 0x0200
JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

JobObjectExtendedLimitInformation = 9

PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

ERROR_ACCESS_DENIED = 5
ERROR_INVALID_PARAMETER = 87

AGGREGATE_LIMIT_BYTES = 5_000_000_000   # hard maximum for the Ruke runtime tree
TARGET_LIMIT_BYTES = 4_000_000_000      # agreed target, below the hard ceiling

# ---- two explicit budgets, never one number pretending to cover both windows ----------
# Normal operation (nothing was unloaded) is bounded by the agreed 4 GB target / 5 GB hard
# maximum for the Ruke tree plus the children it owns. The coordinated EXCLUSIVE window is a
# different window: the main model has been released, so a heavy worker may be given more,
# but "more" is still a bounded number, not the absence of a limit. The effective exclusive
# ceiling is min(configured exclusive maximum, free commit - system reserve) and the arithmetic
# that produced it is recorded in the report, because "we ran with a bigger number" is only
# honest while the number and its provenance are on the page.
EXCLUSIVE_LIMIT_BYTES_DEFAULT = 7_000_000_000
EXCLUSIVE_LIMIT_CONFIG_MIN = AGGREGATE_LIMIT_BYTES    # below this the window gained nothing
EXCLUSIVE_LIMIT_CONFIG_MAX = 12_000_000_000           # above this the config is a mistake
SYSTEM_RESERVE_BYTES_DEFAULT = 2_000_000_000
EXCLUSIVE_LIMIT_ENV = "RUKE_EXCLUSIVE_LIMIT_BYTES"
SYSTEM_RESERVE_ENV = "RUKE_SYSTEM_RESERVE_BYTES"
CEILING_MARGIN_MEASURED_BYTES = 256 * (1 << 20)
MIB = 1 << 20

_REASON_BY_ERROR = {
    ERROR_ACCESS_DENIED: "the OS refused the assignment (access denied, or an outer job "
                         "disallows nesting)",
    ERROR_INVALID_PARAMETER: "the process had already exited",
}


def supported() -> bool:
    """A job object is a Windows mechanism; on another host the answer is simply no."""
    return os.name == "nt" and hasattr(ctypes, "windll")


def _k32() -> Any:
    return ctypes.windll.kernel32 if supported() else None  # type: ignore[attr-defined]


class _IoCounters(ctypes.Structure):
    _fields_ = [("Read", ctypes.c_uint64), ("Write", ctypes.c_uint64), ("Other", ctypes.c_uint64),
                ("ReadCount", ctypes.c_uint64), ("WriteCount", ctypes.c_uint64),
                ("OtherCount", ctypes.c_uint64)]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32)]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BasicLimitInformation),
                ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


def _query(handle: int) -> dict[str, int]:
    """Peak job/process commit for one job handle. Empty dict means the query failed."""
    k32 = _k32()
    if k32 is None or not handle:
        return {}
    info = _ExtendedLimitInformation()
    returned = ctypes.c_uint32(0)
    k32.QueryInformationJobObject.restype = ctypes.c_int
    k32.QueryInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                                              ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
    if not k32.QueryInformationJobObject(ctypes.c_void_p(handle), JobObjectExtendedLimitInformation,
                                         ctypes.byref(info), ctypes.sizeof(info),
                                         ctypes.byref(returned)):
        return {}
    return {"limit_bytes": int(info.JobMemoryLimit),
            "peak_job_commit_bytes": int(info.PeakJobMemoryUsed),
            "peak_process_commit_bytes": int(info.PeakProcessMemoryUsed)}


@dataclass
class JobLimit:
    """One job object with an aggregate commit ceiling, plus the pids assigned to it."""

    limit_bytes: int
    handle: int
    name: str
    members: list[int] = field(default_factory=list)
    flags: int = 0

    # ---- evidence -------------------------------------------------------------
    def peaks(self) -> dict[str, Any]:
        """Peak commit for the job as a whole and for its largest single member."""
        q = _query(self.handle)
        if not q:
            return {"available": 0, "limit_bytes": self.limit_bytes}
        return {"available": 1, "limit_bytes": q["limit_bytes"],
                "peak_job_commit_mib": q["peak_job_commit_bytes"] >> 20,
                "peak_process_commit_mib": q["peak_process_commit_bytes"] >> 20,
                "sampled_at": time.time()}

    def current_commit(self) -> dict[str, Any]:
        """Live commit charge over each member's process tree, same per-process API as elsewhere.

        The extended-limit block reports the PEAK but not the live value, so the live number
        is measured rather than back-derived from the peak.
        """
        # Members are walked as process TREES: the project venv's python.exe is a
        # redirector, so the pid we spawn is often not the interpreter holding the bytes.
        pids: list[int] = []
        for pid in self.members:
            for p in resources.tree_pids(pid):
                if p not in pids:
                    pids.append(p)
        rows = [{"pid": pid, **resources.process_memory(pid)} for pid in pids]
        live = [r for r in rows if r.get("available")]
        if not live:
            return {"available": 0, "commit_mib": None, "working_set_mib": None,
                    "members": rows,
                    "note": ("no member process could be measured, so the live charge over the "
                             "job is UNKNOWN and is reported as unknown rather than as zero")}
        commit, unknown_commit = resources.sum_reported_mib(live, "commit_mib")
        resident, unknown_resident = resources.sum_reported_mib(live, "working_set_mib")
        out = {"available": 1, "commit_mib": commit, "working_set_mib": resident,
               "measured_rows": len(live), "unreadable_rows": len(rows) - len(live),
               "members": rows}
        if unknown_commit or unknown_resident:
            # A member that answered the process query but not a counter is not a zero contributor:
            # the total is then a lower bound over the readable rows, and must say so.
            out["unmeasured_rows"] = {"commit_mib": unknown_commit,
                                      "working_set_mib": unknown_resident}
            out["note"] = ("the live totals cover only the member rows that reported the field; "
                           "a field with no reporting row is None, never 0")
        return out

    def as_dict(self) -> dict[str, Any]:
        return {"enforced": True, "mechanism": "windows-job-object", "name": self.name,
                "limit_bytes": self.limit_bytes, "limit_mib": self.limit_bytes >> 20,
                "flags": self.flags, "assigned_pids": list(self.members), **self.peaks()}

    # ---- assignment -----------------------------------------------------------
    def assign_pid(self, pid: int) -> dict[str, Any]:
        """Put an existing process in the job. Must be called as soon as it is spawned.

        There is an unavoidable window between CreateProcess and the assignment, so for an
        already-running process the ceiling bounds steady-state work, not its first
        kilobytes. Children the job's members later spawn inherit the job at create time and
        have no such window - which is why the runtime tree is capped by assigning the
        supervisor itself.
        """
        k32 = _k32()
        if k32 is None or not self.handle or pid <= 0:
            return {"assigned": False, "reason": "no-job-handle"}
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        proc = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                               0, ctypes.c_uint32(int(pid)))
        if not proc:
            return {"assigned": False, "pid": int(pid), "reason": "open-process-failed",
                    "win32_error": int(k32.GetLastError())}
        try:
            k32.AssignProcessToJobObject.restype = ctypes.c_int
            k32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            if not k32.AssignProcessToJobObject(ctypes.c_void_p(self.handle), ctypes.c_void_p(proc)):
                err = int(k32.GetLastError())
                return {"assigned": False, "pid": int(pid), "win32_error": err,
                        "reason": _REASON_BY_ERROR.get(err, "assignment failed")}
        finally:
            k32.CloseHandle(ctypes.c_void_p(proc))
        if int(pid) not in self.members:
            self.members.append(int(pid))
        return {"assigned": True, "pid": int(pid), "limit_bytes": self.limit_bytes}

    def assign_popen(self, proc: Any) -> dict[str, Any]:
        """Convenience for a subprocess.Popen-like object, so call sites stay one line."""
        return self.assign_pid(int(getattr(proc, "pid", 0)))

    def close(self) -> None:
        """Release the handle. Without KILL_ON_JOB_CLOSE this cannot kill anything."""
        if self.handle:
            handle, self.handle = self.handle, 0
            k32 = _k32()
            if k32 is not None:
                k32.CloseHandle(ctypes.c_void_p(handle))


def in_a_job(pid: int = 0) -> dict[str, Any]:
    """Is this process already inside someone else's job? Nesting itself is allowed on Win8+."""
    k32 = _k32()
    if k32 is None:
        return {"available": False, "reason": "unsupported-host"}
    target = int(pid or os.getpid())
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    proc = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, ctypes.c_uint32(target))
    if not proc:
        return {"available": False, "reason": "open-process-failed", "pid": target,
                "win32_error": int(k32.GetLastError())}
    try:
        result = ctypes.c_int(0)
        k32.IsProcessInJob.restype = ctypes.c_int
        k32.IsProcessInJob.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        if not k32.IsProcessInJob(ctypes.c_void_p(proc), None, ctypes.byref(result)):
            return {"available": False, "reason": "IsProcessInJob-failed",
                    "win32_error": int(k32.GetLastError())}
        return {"available": True, "in_job": bool(result.value), "pid": target}
    finally:
        k32.CloseHandle(ctypes.c_void_p(proc))


def create(limit_bytes: int, *, name: str = "", active_process_limit: int = 0,
           kill_on_close: bool = False) -> tuple[JobLimit | None, dict[str, Any]]:
    """Create a job whose whole tree is capped at `limit_bytes` of commit. Never advisory."""
    if not supported():
        return None, {"enforced": False, "mechanism": "unsupported-host"}
    if limit_bytes <= 0:
        return None, {"enforced": False, "mechanism": "windows-job-object",
                      "reason": "limit_bytes must be positive"}
    k32 = _k32()
    k32.CreateJobObjectW.restype = ctypes.c_void_p
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    handle = k32.CreateJobObjectW(None, name or None)
    if not handle:
        return None, {"enforced": False, "mechanism": "windows-job-object",
                      "reason": "CreateJobObjectW-failed", "win32_error": int(k32.GetLastError())}

    flags = JOB_LIMIT_JOB_MEMORY
    if active_process_limit > 0:
        flags |= JOB_LIMIT_ACTIVE_PROCESS
    if kill_on_close:
        flags |= JOB_LIMIT_KILL_ON_JOB_CLOSE

    info = _ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = flags
    info.JobMemoryLimit = ctypes.c_size_t(int(limit_bytes))
    if active_process_limit > 0:
        info.BasicLimitInformation.ActiveProcessLimit = ctypes.c_uint32(int(active_process_limit))

    k32.SetInformationJobObject.restype = ctypes.c_int
    k32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    if not k32.SetInformationJobObject(ctypes.c_void_p(handle), JobObjectExtendedLimitInformation,
                                       ctypes.byref(info), ctypes.sizeof(info)):
        err = int(k32.GetLastError())
        k32.CloseHandle(ctypes.c_void_p(handle))
        return None, {"enforced": False, "mechanism": "windows-job-object",
                      "reason": "SetInformationJobObject-failed", "win32_error": err}
    job = JobLimit(limit_bytes=int(limit_bytes), handle=int(handle), name=name or "ruke-job", flags=flags)
    return job, {"enforced": True, "mechanism": "windows-job-object", "name": job.name,
                 "limit_bytes": job.limit_bytes, "flags": flags}


_INSTALLED: JobLimit | None = None
_INSTALL_REPORT: dict[str, Any] = {}


def install_process_job(limit_bytes: int = AGGREGATE_LIMIT_BYTES, *, name: str = "ruke-runtime",
                        kill_on_close: bool = False) -> dict[str, Any]:
    """Cap this process AND everything it later spawns. Idempotent.

    Assigning the supervisor is the only way to bound a lazily spawned heavy child before its
    memory is already resident: children created by a job member join the job at create time,
    so there is no assignment race for them. The handle stays open for the process lifetime,
    and `kill_on_close` stays off by default because closing it would take the supervisor
    down with its children.
    """
    global _INSTALLED, _INSTALL_REPORT
    if _INSTALLED is not None:
        return dict(_INSTALL_REPORT)
    job, report = create(limit_bytes, name=name, kill_on_close=kill_on_close)
    if job is None:
        _INSTALL_REPORT = report
        return dict(report)
    assigned = job.assign_pid(os.getpid())
    outer = in_a_job()
    if not assigned.get("assigned"):
        job.close()
        _INSTALL_REPORT = {"enforced": False, "mechanism": "windows-job-object",
                           "reason": str(assigned.get("reason")),
                           "win32_error": assigned.get("win32_error"), "outer_job": outer,
                           "limit_bytes": int(limit_bytes)}
        return dict(_INSTALL_REPORT)
    _INSTALLED = job
    _INSTALL_REPORT = {**report, "self_assigned": True, "outer_job": outer,
                       "target_bytes": TARGET_LIMIT_BYTES}
    return dict(_INSTALL_REPORT)


def installed_job() -> JobLimit | None:
    return _INSTALLED

def _env_bytes(name: str, default: int) -> tuple[int, str]:
    """Read a byte-size setting without ever pretending a bad value meant something."""
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return int(default), f"default {int(default)} B (no {name} set)"
    try:
        value = int(float(raw))
    except ValueError:
        return (int(default),
                f"{name}={raw!r} is not a number; the default {int(default)} B was used instead")
    if value <= 0:
        return (int(default),
                f"{name}={raw!r} is not a positive byte count; the default "
                f"{int(default)} B was used instead")
    return value, f"{name}={value}"


def normal_ceiling_bytes() -> tuple[int, dict[str, Any]]:
    """The ceiling for a worker that runs while everything else is still resident."""
    return AGGREGATE_LIMIT_BYTES, {
        "window": "normal",
        "effective_limit_bytes": AGGREGATE_LIMIT_BYTES,
        "effective_limit_mib": AGGREGATE_LIMIT_BYTES >> 20,
        "target_bytes": TARGET_LIMIT_BYTES,
        "bound_by": "the agreed hard maximum for the Ruke runtime tree",
        "reason": ("no coordinated unload happened, so the normal-operation budget still applies "
                   f"in full: target {TARGET_LIMIT_BYTES} B, hard maximum "
                   f"{AGGREGATE_LIMIT_BYTES} B"),
    }


def exclusive_ceiling_bytes(*, reserve_bytes: int | None = None) -> tuple[int, dict[str, Any]]:
    """The bounded ceiling for a worker running INSIDE the coordinated exclusive window.

    The main model has been released, so this window may be wider than normal operation - but
    it is widened by arithmetic, not by removing protection: the effective ceiling is
    `min(configured exclusive maximum, free commit - system reserve)`. When the host's own
    commit charge cannot be read the window is held to the NORMAL hard maximum instead of
    being opened on a guess, and when `free commit - reserve` is under the normal maximum the
    report says the window gained nothing, which is the honest signal that the unload did not
    actually buy the headroom the job needs.
    """
    configured, configured_note = _env_bytes(EXCLUSIVE_LIMIT_ENV, EXCLUSIVE_LIMIT_BYTES_DEFAULT)
    bounded = min(max(configured, EXCLUSIVE_LIMIT_CONFIG_MIN), EXCLUSIVE_LIMIT_CONFIG_MAX)
    if reserve_bytes is not None:
        reserve, reserve_note = int(reserve_bytes), "reserve supplied by the caller"
    else:
        reserve, reserve_note = _env_bytes(SYSTEM_RESERVE_ENV, SYSTEM_RESERVE_BYTES_DEFAULT)
    report: dict[str, Any] = {
        "window": "exclusive",
        "configured_limit_bytes": int(configured),
        "configured_note": configured_note,
        "bounded_config_limit_bytes": int(bounded),
        "config_bounds_bytes": [EXCLUSIVE_LIMIT_CONFIG_MIN, EXCLUSIVE_LIMIT_CONFIG_MAX],
        "system_reserve_bytes": int(reserve),
        "reserve_note": reserve_note,
        "normal_hard_limit_bytes": AGGREGATE_LIMIT_BYTES,
        "normal_target_bytes": TARGET_LIMIT_BYTES,
    }
    mem = resources.system_memory()
    if mem.source != "GlobalMemoryStatusEx":
        report.update({
            "measured": False,
            "commit_available_bytes": None,
            "effective_limit_bytes": AGGREGATE_LIMIT_BYTES,
            "effective_limit_mib": AGGREGATE_LIMIT_BYTES >> 20,
            "bound_by": "no commit measurement available",
            "reason": (f"this host's commit charge could not be read ({mem.source}), so the "
                       f"exclusive window is held to the normal hard maximum "
                       f"{AGGREGATE_LIMIT_BYTES} B rather than widened on an unmeasured guess"),
        })
        return AGGREGATE_LIMIT_BYTES, report
    free_commit_bytes = int(mem.commit_avail_mib) * MIB
    after_reserve = free_commit_bytes - int(reserve)
    effective = int(min(bounded, after_reserve))
    report.update({
        "measured": True,
        "commit_available_bytes": free_commit_bytes,
        "commit_available_mib": int(mem.commit_avail_mib),
        "free_physical_mib": int(mem.available_mib),
        "after_reserve_bytes": int(after_reserve),
        "effective_limit_bytes": effective,
        "effective_limit_mib": effective >> 20,
        "bound_by": ("the configured exclusive maximum" if bounded <= after_reserve
                     else "free commit minus the system reserve"),
        "widened_beyond_normal": bool(effective > AGGREGATE_LIMIT_BYTES),
    })
    if effective < AGGREGATE_LIMIT_BYTES:
        report["window_gained_nothing"] = True
        report["reason"] = (
            f"free commit is {free_commit_bytes} B and the system reserve is {int(reserve)} B, "
            f"leaving {effective} B - under the {AGGREGATE_LIMIT_BYTES} B the normal-operation "
            "budget already allows, so releasing the main model bought no usable headroom")
    else:
        report["reason"] = (
            f"effective exclusive ceiling {effective} B = min(configured {bounded} B, free "
            f"commit {free_commit_bytes} B - reserve {int(reserve)} B); normal-operation hard "
            f"maximum is {AGGREGATE_LIMIT_BYTES} B")
    return effective, report


def worker_ceiling_bytes(*, inside_window: bool, declared_demand_bytes: int = 0,
                         demand_basis: str = "",
                         ceiling_override_bytes: int = 0) -> tuple[int, dict[str, Any]]:
    """Pick the ceiling for one heavy worker, and say whether that ceiling can hold the work.

    A ceiling BELOW the demand the capability declares is not "tight but workable": the load
    fails inside the engine's own allocator, and the parent then reports an engine crash that
    has nothing to do with the engine. So the arithmetic is done here, once, and the caller is
    given a typed answer instead of an allocator traceback.

    `ceiling_override_bytes` lets a caller say "this is the number I am actually going to
    enforce" (an explicit per-worker limit). The demand arithmetic then runs against THAT
    number, so an explicit limit is checked the same way a window-derived limit is - there is
    only one implementation of "does this fit", and it is not in the engine adapter.
    """
    limit, report = (exclusive_ceiling_bytes() if inside_window else normal_ceiling_bytes())
    override = int(ceiling_override_bytes or 0)
    if override > 0:
        report["window_derived_limit_bytes"] = int(limit)
        report["window_note"] = report.get("reason", "")
        limit = override
        report["effective_limit_bytes"] = int(limit)
        report["effective_limit_mib"] = int(limit) >> 20
        report["bound_by"] = "an explicit per-worker ceiling supplied by the caller"
        report["reason"] = (f"the caller supplied the ceiling {override} B ({override >> 20} MiB); "
                            f"the {report['window']} window would have allowed {report['window_derived_limit_bytes']} B")
    demand = max(0, int(declared_demand_bytes or 0))
    demand_measured = bool(demand) and resources.estimate_is_measured(demand_basis)
    charged = demand if (demand == 0 or demand_measured) else int(
        math.ceil(demand * resources.UNMEASURED_ESTIMATE_FACTOR))
    margin = (CEILING_MARGIN_MEASURED_BYTES if demand_measured
              else resources.UNMEASURED_MARGIN_MIB * MIB)
    report.setdefault("measured", True)
    report.update({
        "declared_demand_bytes": demand,
        "demand_basis": (demand_basis or
                         (f"declared {demand} B with no recorded measurement on this host"
                          if demand else "this worker declares no load demand")),
        "demand_is_measured": bool(demand_measured),
        "charged_demand_bytes": charged,
        "margin_bytes": int(margin),
        "minimum_viable_ceiling_bytes": int(charged + margin) if demand else 0,
    })
    report["below_declared_demand"] = bool(demand and int(limit) < int(charged + margin))
    if report["below_declared_demand"]:
        report["refuse_reason"] = (
            f"the {report['window']} window can offer a commit ceiling of {int(limit)} B "
            f"({int(limit) >> 20} MiB), under the {int(charged + margin)} B this worker needs "
            f"({report['charged_demand_bytes']} B charged demand + "
            f"{int(margin) >> 20} MiB margin; demand basis: {report['demand_basis']})")
    return int(limit), report


def peak_hit_limit(peaks: dict[str, Any], *, ratio: float = 0.98) -> dict[str, Any]:
    """Did the kernel actually see this job reach its own commit ceiling?

    This is what distinguishes "the worker died for a reason we cannot see" from "the OS
    refused the allocation it was bounded to refuse". The kernel peak is used, not a sampled
    number, because a sample can miss the peak entirely. When the peak is unreadable the answer
    is `reached: None`, never `False`.
    """
    limit = int((peaks or {}).get("limit_bytes") or 0)
    if not peaks or not peaks.get("available"):
        return {"available": False, "reached": None,
                "note": ("the job object reported no readable peak charge, so whether the worker "
                         "was killed by its ceiling is UNKNOWN and is not recorded as either a "
                         "ceiling kill or a clean death")}
    values = [int(peaks[key]) for key in ("peak_job_commit_mib", "peak_process_commit_mib")
              if peaks.get(key) is not None]
    if not values:
        return {"available": False, "reached": None, "limit_bytes": limit,
                "note": "the job peak block named no readable figure, so the cause is UNKNOWN"}
    peak_bytes = max(values) * MIB
    out = {"available": True, "peak_commit_mib": max(values), "limit_bytes": limit,
           "peak_commit_bytes": peak_bytes}
    if limit <= 0:
        out["reached"] = None
        out["note"] = "no commit ceiling was attached to this job, so a ceiling kill is not applicable"
        return out
    out["peak_over_limit"] = round(peak_bytes / limit, 4)
    out["reached"] = bool(peak_bytes >= int(limit * ratio))
    out["note"] = (f"kernel job peak commit {peak_bytes >> 20} MiB against a "
                   f"{limit >> 20} MiB ceiling"
                   + (" - the ceiling was reached" if out["reached"] else " - the ceiling was not reached"))
    return out


def attach_child(proc: Any, per_worker_limit_bytes: int = 0) -> dict[str, Any]:
    """Bound a freshly spawned child: its own tighter job, else the runtime-tree job.

    A private job per heavy worker is what stops one capability from consuming the whole
    aggregate allowance and then starving the next one, so the pool asks for a per-worker cap
    whenever the capability has a measured peak. The returned JobLimit is kept by the caller
    (the handle must outlive the spawn so the peak is still queryable at reap time).
    """
    if not supported():
        return {"enforced": False, "mechanism": "unsupported-host"}
    limit = int(per_worker_limit_bytes or 0)
    pid = int(getattr(proc, "pid", 0))
    if limit > 0:
        job, report = create(limit, name=f"ruke-worker-{pid}")
        if job is None:
            return report
        result = job.assign_popen(proc)
        if not result.get("assigned"):
            job.close()
            return {**report, **result}
        return {"enforced": True, "mechanism": "windows-job-object", "scope": "per-worker",
                "limit_bytes": limit, "pid": pid, "job": job}
    if _INSTALLED is None:
        return {"enforced": False, "mechanism": "windows-job-object",
                "reason": "no runtime-tree job installed and no per-worker limit requested",
                "pid": pid}
    return {**_INSTALLED.assign_popen(proc), "scope": "runtime-tree",
            "limit_bytes": _INSTALLED.limit_bytes, "job": _INSTALLED}


def status() -> dict[str, Any]:
    if _INSTALLED is None:
        return {"enforced": False,
                "mechanism": "unsupported-host" if not supported() else "not-installed",
                "aggregate_limit_bytes": AGGREGATE_LIMIT_BYTES,
                "target_bytes": TARGET_LIMIT_BYTES, "outer_job": in_a_job()}
    return _INSTALLED.as_dict()


