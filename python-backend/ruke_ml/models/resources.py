"""Measured resource accounting. Never inferred from parameter counts."""
from __future__ import annotations

import ctypes
import math
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any

PSAPI_OK = True
try:
    _k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
except AttributeError:  # non-Windows host
    _k32 = None


@dataclass(slots=True)
class Memory:
    total_mib: int = 0
    available_mib: int = 0
    commit_total_mib: int = 0
    commit_avail_mib: int = 0
    source: str = "unknown"


def system_memory() -> Memory:
    if _k32 is None:
        return Memory(source="unsupported-host")

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                    ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                    ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                    ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                    ("ullAvailExtendedVirtual", ctypes.c_uint64)]

    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not _k32.GlobalMemoryStatusEx(ctypes.byref(st)):
        return Memory(source="GlobalMemoryStatusEx-failed")
    mib = 1 << 20
    return Memory(total_mib=st.ullTotalPhys // mib, available_mib=st.ullAvailPhys // mib,
                  commit_total_mib=st.ullTotalPageFile // mib, commit_avail_mib=st.ullAvailPageFile // mib,
                  source="GlobalMemoryStatusEx")


def process_memory(pid: int) -> dict[str, int]:
    """Working set + private bytes for one pid (psutil-free, Windows API)."""
    if _k32 is None or pid <= 0:
        return {"available": 0}

    class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                    ("PrivateUsage", ctypes.c_size_t)]

    proc = _k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not proc:
        return {"available": 0}
    counters = PROCESS_MEMORY_COUNTERS_EX()
    counters.cb = ctypes.sizeof(counters)
    psapi = ctypes.windll.psapi  # type: ignore[attr-defined]
    ok = psapi.GetProcessMemoryInfo(ctypes.c_void_p(proc), ctypes.byref(counters), counters.cb)
    _k32.CloseHandle(ctypes.c_void_p(proc))
    if not ok:
        return {"available": 0}
    mib = 1 << 20
    return {"available": 1, "working_set_mib": counters.WorkingSetSize // mib,
            "private_mib": counters.PrivateUsage // mib,
            "peak_working_set_mib": counters.PeakWorkingSetSize // mib,
            "commit_mib": counters.PagefileUsage // mib,
            "peak_commit_mib": counters.PeakPagefileUsage // mib}


class _ProcessEntry32W(ctypes.Structure):
    _fields_ = [("dwSize", ctypes.c_uint32), ("cntUsage", ctypes.c_uint32),
                ("th32ProcessID", ctypes.c_uint32), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", ctypes.c_uint32), ("cntThreads", ctypes.c_uint32),
                ("th32ParentProcessID", ctypes.c_uint32), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", ctypes.c_uint32), ("szExeFile", ctypes.c_wchar * 260)]


def child_pids(pid: int) -> list[int]:
    """Direct children of pid from a Toolhelp32 snapshot. Empty means unknown or none.

    Measured on this host (F18): ``python-backend/.venv/Scripts/python.exe`` is a
    redirector, so the pid this supervisor records for a worker is NOT the pid that
    holds its memory. A probe run recorded pid 12880 for a worker while the interpreter
    that loaded faster-whisper reported pid 14096, and single-pid accounting then
    reported a 5 MiB working set for a process that was holding hundreds of MiB. Any
    memory number that ignores the child is therefore wrong, not merely imprecise.
    """
    if _k32 is None or pid <= 0:
        return []
    _k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    snap = _k32.CreateToolhelp32Snapshot(ctypes.c_uint32(0x2), ctypes.c_uint32(pid))
    if snap is None or ctypes.c_void_p(snap).value in (None, ctypes.c_void_p(-1).value):
        return []
    entry = _ProcessEntry32W()
    entry.dwSize = ctypes.sizeof(entry)
    first = _k32.Process32FirstW
    first.restype = ctypes.c_int
    nxt = _k32.Process32NextW
    nxt.restype = ctypes.c_int
    out: list[int] = []
    try:
        if first(ctypes.c_void_p(snap), ctypes.byref(entry)):
            while True:
                if int(entry.th32ParentProcessID) == int(pid) and int(entry.th32ProcessID) != int(pid):
                    out.append(int(entry.th32ProcessID))
                if not nxt(ctypes.c_void_p(snap), ctypes.byref(entry)):
                    break
    finally:
        _k32.CloseHandle(ctypes.c_void_p(snap))
    return out


def tree_pids(pid: int, max_depth: int = 4) -> list[int]:
    """pid plus its descendants, breadth first, bounded so a runaway tree is bounded."""
    if pid <= 0:
        return []
    seen = [int(pid)]
    frontier = [int(pid)]
    for _ in range(max(0, max_depth)):
        if not frontier:
            break
        nxt_level: list[int] = []
        for parent in frontier:
            for child in child_pids(parent):
                if child not in seen:
                    seen.append(child)
                    nxt_level.append(child)
        frontier = nxt_level
    return seen


def sum_reported_mib(rows: list[dict[str, Any]], key: str) -> tuple[int | None, int]:
    """Sum `key` over the rows that actually reported it: (total or None, rows that did not).

    "Could not be measured" and "measured as zero" are different answers, and only the second
    one is safe to put in a total: a zero here becomes a headroom calculation, a budget report
    or an admission decision. A field that no row reported is None.
    """
    vals = [row[key] for row in rows if isinstance(row.get(key), int)]
    return (sum(vals) if vals else None), len(rows) - len(vals)


def process_tree_memory(pid: int) -> dict[str, Any]:
    """Resident/private/commit for an owned child AND the interpreter it re-execs.

    Reported per process as well as summed, so a tree total can always be traced back
    to the process that actually held the bytes.
    """
    pids = tree_pids(pid)
    per = [{"pid": p, **process_memory(p)} for p in pids]
    live = [m for m in per if m.get("available")]
    if not live:
        # Nothing in the tree could be read. The bytes are UNKNOWN, and a caller that sums
        # or compares these fields must not be handed a 0 that reads as "used nothing".
        return {"available": 0, "pids": pids, "processes": per,
                "working_set_mib": None, "private_mib": None,
                "peak_working_set_mib": None, "peak_commit_mib": None,
                "commit_mib": None,
                "note": ("no process in the owned tree could be measured, so every byte figure "
                         "here is UNKNOWN and is reported as unknown rather than as zero")}
    mib = 1 << 20
    # A row that failed to answer one of the counters must not silently contribute zero to a
    # total that will be read as a measurement, so each field is summed only over the rows that
    # actually reported it, and the rows that did not are counted and named.
    fields = ("working_set_mib", "private_mib", "peak_working_set_mib",
              "commit_mib", "peak_commit_mib")
    totals = {f: sum_reported_mib(live, f) for f in fields}
    unknown = {f: n for f, (_, n) in totals.items() if n}
    out = {"available": 1, "pids": pids, "processes": per}
    for f in fields:
        out[f] = totals[f][0]
    if unknown:
        out["unmeasured_rows"] = unknown
        out["note"] = ("these rows reported no value for the named field; the total covers only "
                       "the rows that reported, and a field with no reporting row is UNKNOWN "
                       "(None), never zero")
    out["definition"] = ("K32GetProcessMemoryInfo over the owned child plus its process "
                         "children; working set = resident RAM, commit = pagefile charge")
    return out


def process_creation_time(pid: int) -> int:
    """FILETIME of process start - identity proof so a recycled PID is never mistaken for ours."""
    if _k32 is None or pid <= 0:
        return 0
    proc = _k32.OpenProcess(0x1000, False, pid)
    if not proc:
        return 0
    ct, et, kt, ut = (ctypes.c_uint64() for _ in range(4))
    ok = _k32.GetProcessTimes(ctypes.c_void_p(proc), ctypes.byref(ct), ctypes.byref(et), ctypes.byref(kt), ctypes.byref(ut))
    _k32.CloseHandle(ctypes.c_void_p(proc))
    return ct.value if ok else 0


def vram() -> list[dict[str, Any]]:
    """Best effort; a missing nvidia-smi means unknown, not zero."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=6)
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0:
        return []
    rows = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3:
            # A driver can answer "[N/A]" for a field on a MIG/virtualised GPU. That row is still
            # worth reporting, with the unreadable amount left as None, rather than throwing away
            # the whole probe or inventing a 0 that a placement decision would then trust.
            def _num(text: str) -> int | None:
                try:
                    return int(text)
                except ValueError:
                    return None
            rows.append({"name": parts[0], "total_mib": _num(parts[1]),
                         "used_mib": _num(parts[2])})
    return rows


def headroom(budget_mib: int, extra_mib: int = 0) -> dict[str, Any]:
    m = system_memory()
    if m.source != "GlobalMemoryStatusEx":
        return {"measured": False, "reason": m.source, "fits": None}
    avail = m.commit_avail_mib - extra_mib
    return {"measured": True, "commit_available_mib": m.commit_avail_mib, "budget_mib": budget_mib,
            "estimated_available_after_mib": avail, "fits_within_budget": avail >= budget_mib,
            "sampled_at": time.time()}


# Below this much free physical RAM, loading another heavy worker is what pushes the host
# into the pagefile: the run stops being slow, it stops being correctable.
FLOOR_FREE_PHYSICAL_MIB = 1024


# A load peak that has never been recorded on THIS host is a guess, and `margin_mib` is
# calibrated against measured numbers. So an unmeasured estimate is charged at a multiplier AND
# gets a wider floor: the difference between a provisional 3300 MiB and a 2 GiB model's real
# cold load is paid out of the RAM the resident main model is running in, and 256 MiB of margin
# over an unverified estimate is not headroom - it is a pageable stall with a "fits" label on
# it. Once the registry basis says "measured", the charge drops back to the declared number and
# a job that genuinely fits is admitted WITHOUT unloading anything, so this is a trust rule and
# not a blanket refusal.
UNMEASURED_ESTIMATE_FACTOR = 1.5
UNMEASURED_MARGIN_MIB = 1024


def estimate_is_measured(est_basis: str) -> bool:
    """True only when the basis string names an actual measurement taken on this host."""
    return str(est_basis or "").strip().lower().startswith("measured")


def charged_estimate(est_peak_mib: int, est_basis: str) -> int:
    """What this load is CHARGED for admission, which may exceed what it declares."""
    est = max(0, int(est_peak_mib))
    if est == 0 or estimate_is_measured(est_basis):
        return est
    return int(math.ceil(est * UNMEASURED_ESTIMATE_FACTOR))


def admission(est_peak_mib: int, margin_mib: int = 256,
              floor_mib: int = FLOOR_FREE_PHYSICAL_MIB,
              est_basis: str = "") -> dict[str, Any]:
    """May a heavy worker be loaded right now, given what the host is ALREADY holding?

    A job-object ceiling bounds the COMMIT charge a process tree may reach; it cannot bound
    resident physical RAM, and on this host physical RAM is what runs out first (measured
    2026-11-16: 63.8 GiB total with 4.9 GiB free while the main LLM is resident). So the
    ceiling is paired with this gate: refuse a heavy worker before it can evict the LLM or
    stall the machine, and return a typed reason the UI can show.

    Refusing is not failure-by-avoidance: the caller still runs the capability through a
    cheaper engine, or reports the limit honestly. Silently paging a 2 GiB model in and
    calling the result "processed" is the failure this gate exists to prevent.

    `est_basis` says how much trust the number deserves. A provisional estimate is charged
    higher (see `charged_estimate`) and gets a wider margin, and the refusal text says so in
    those words - an unmeasured estimate must never get to read as a measurement in the
    evidence that a later report quotes.
    """
    m = system_memory()
    if m.source != "GlobalMemoryStatusEx":
        return {"measured": False, "reason": m.source, "fits": None}

    est = max(0, int(est_peak_mib))
    margin = max(0, int(margin_mib))
    floor = max(0, int(floor_mib))
    basis_measured = est == 0 or estimate_is_measured(est_basis)
    charged = charged_estimate(est, est_basis)
    if charged != est:
        margin = max(margin, UNMEASURED_MARGIN_MIB)
    # The floor applies to every load that brings model weights with it, measured or not. A
    # capability whose measured load peak is 200 MiB still must not be loaded when the host
    # has 300 MiB free: the processing allocations land on top of the load peak, and on this
    # host the difference is taken out of the RAM the resident model is running in. Measured
    # 2026-11-16: the model holds 50.6 GiB resident of 63.8 GiB, so "the arithmetic fits" and
    # "the host stays usable" are different questions. A caller passes floor_mib=0 only for a
    # worker that runs a native reader with no weights; the owner decides that, not us.
    required = max(charged + margin, floor)
    reasons: list[str] = []
    if m.available_mib < required:
        if est > 0 and basis_measured:
            basis = f"measured load peak {charged} MiB + {margin} MiB margin"
        elif est > 0:
            basis = (f"provisional load peak {est} MiB charged at {charged} MiB because it has "
                     f"never been measured on this host + {margin} MiB margin")
        else:
            basis = f"the {floor} MiB floor for a model-backed capability"
        reasons.append(f"free physical RAM is {m.available_mib} MiB, under the "
                       f"{required} MiB this load needs ({basis})")
    if m.commit_avail_mib < charged + margin:
        reasons.append(f"available commit charge is {m.commit_avail_mib} MiB, under the "
                       f"{charged + margin} MiB this capability would need")

    return {"measured": True, "fits": not reasons,
            "free_physical_mib": m.available_mib, "total_physical_mib": m.total_mib,
            "commit_available_mib": m.commit_avail_mib, "est_peak_mib": est,
            "est_peak_mib_charged": charged,
            "estimate_basis": ("measured" if est > 0 and basis_measured
                               else ("provisional" if est > 0 else "not declared")),
            "required_mib": required, "reasons": reasons,
            # Never label a number "measured" because it is non-zero: only a basis string naming
            # a measurement taken on THIS host earns that word (see estimate_is_measured).
            "estimate": ("measured" if est > 0 and basis_measured
                         else ("provisional-estimate" if est > 0 else "unmeasured")),
            "floor_free_physical_mib": floor,
            "policy": "free-physical-plus-commit", "sampled_at": time.time()}


def memory_report() -> dict[str, Any]:
    """The host numbers, in the exact definitions the budget claim uses.

    `available_mib` is resident physical RAM currently free (GlobalMemoryStatusEx's
    available, which counts reclaimable standby pages as the OS sees them);
    `commit_available_mib` is the pagefile-backed charge still grantable. They are not the
    same quantity and this host ran out of the first one while the second was plentiful, so
    the health snapshot reports both instead of an aggregate that hides which one matters.
    """
    m = system_memory()
    return {"measured": m.source == "GlobalMemoryStatusEx", "source": m.source,
            "total_physical_mib": m.total_mib, "free_physical_mib": m.available_mib,
            "commit_total_mib": m.commit_total_mib, "commit_available_mib": m.commit_avail_mib,
            "free_physical_floor_mib": FLOOR_FREE_PHYSICAL_MIB,
            "definitions": {"free_physical_mib": "resident RAM free now",
                            "commit_available_mib": "pagefile-backed charge still grantable"},
            "sampled_at": time.time()}


PEAK_SAMPLE_INTERVAL_S = 0.5


PEAK_FIELDS = ("working_set_mib", "commit_mib")


def fold_peak_sample(rec: dict[str, Any], tree: dict[str, Any]) -> dict[str, Any]:
    """Fold one `process_tree_memory()` snapshot into a stage record, updating `rec` in place.

    A field the snapshot did not report is counted as an unmeasured sample, never folded in as
    a zero: a peak that later gets quoted against the memory budget must only ever contain
    bytes somebody actually measured. `measured` therefore means "at least one real value was
    folded", not "a sample was attempted".
    """
    for field in PEAK_FIELDS:
        value = tree.get(field)
        if isinstance(value, int):
            rec[field] = value if rec[field] is None else max(rec[field], value)
        else:
            key = f"{field}_unmeasured_samples"
            rec[key] = rec.get(key, 0) + 1
    rec["measured"] = any(rec.get(field) is not None for field in PEAK_FIELDS)
    return rec


class PeakSampler:
    """Sample an owned process tree's peak for the duration of one capability's work.

    Two failure modes this exists to prevent, both recorded in docs/overnight/SPEC.md
    (amendment 7, defect 6):

      * reporting a peak of 0 when nothing could be read. A peak of 0 reads as "this engine
        used nothing", when the truthful answer is "we never measured it". Every number here
        is either a measured maximum or None, and a stage with no usable sample says so in
        words.
      * attributing one engine's child peak to the whole operation. The cascade loads the
        primary, releases it, then may load the recovery engine; a plan charged only for the
        first engine has never accounted for the second. Sampling the OWNED TREE around the
        whole operation catches both, and per-stage maxima keep device/engine fallback
        attributable to the stage that actually cost the bytes.
    """

    def __init__(self, label: str = "", pid: int = 0,
                 interval_s: float = PEAK_SAMPLE_INTERVAL_S):
        self.label = label
        self.pid = int(pid) if int(pid) > 0 else os.getpid()
        self.interval_s = max(0.1, float(interval_s))
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._stage = "total"
        self._stages: dict[str, dict[str, Any]] = {}
        self._samples = 0
        self._usable = 0

    @staticmethod
    def _blank() -> dict[str, Any]:
        return {field: None for field in PEAK_FIELDS} | {
            "samples": 0, "usable_samples": 0, "measured": False}

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="ruke-peak-sampler",
                                        daemon=True)
        self._thread.start()

    def stage(self, name: str) -> None:
        """Attribute subsequent samples to `name` as well as to the operation total."""
        if name:
            with self._lock:
                self._stage = str(name)

    def _loop(self) -> None:
        while not self._stop.wait(self.interval_s):
            try:
                tree = process_tree_memory(self.pid)
            except Exception:                                          # noqa: BLE001
                continue
            with self._lock:
                self._samples += 1
                if not tree.get("available"):
                    continue
                self._usable += 1
                names = [self._stage, "total"] if self._stage != "total" else ["total"]
                for name in names:
                    rec = self._stages.setdefault(name, self._blank())
                    fold_peak_sample(rec, tree)
                    rec["samples"] += 1
                    rec["usable_samples"] += 1
                    rec["processes"] = len(tree.get("pids") or [])

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=self.interval_s * 4 + 1.0)

    def stage_peak(self, name: str) -> dict[str, Any]:
        with self._lock:
            out = dict(self._stages.get(name) or self._blank())
        out["label"] = self.label
        out["stage"] = name
        out["sampled_pids"] = self.pid
        out["definition"] = ("maximum over sampled process_tree_memory() snapshots of the owned "
                             "tree (this process plus its engine children); working_set_mib = "
                             "resident RAM, commit_mib = pagefile charge")
        if not out.get("measured"):
            out["working_set_mib"] = None
            out["commit_mib"] = None
            out["note"] = ("no usable sample was taken during this stage, so the peak is UNKNOWN "
                           "and is reported as unknown rather than as zero")
        return out

    def overall(self) -> dict[str, Any]:
        return self.stage_peak("total")
