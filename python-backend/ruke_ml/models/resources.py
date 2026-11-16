"""Measured resource accounting. Never inferred from parameter counts."""
from __future__ import annotations

import ctypes
import subprocess
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
            "private_mib": counters.PrivateUsage // mib, "peak_working_set_mib": counters.PeakWorkingSetSize // mib}


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
            rows.append({"name": parts[0], "total_mib": int(parts[1]), "used_mib": int(parts[2])})
    return rows


def headroom(budget_mib: int, extra_mib: int = 0) -> dict[str, Any]:
    m = system_memory()
    if m.source != "GlobalMemoryStatusEx":
        return {"measured": False, "reason": m.source, "fits": None}
    avail = m.commit_avail_mib - extra_mib
    return {"measured": True, "commit_available_mib": m.commit_avail_mib, "budget_mib": budget_mib,
            "estimated_available_after_mib": avail, "fits_within_budget": avail >= budget_mib,
            "sampled_at": time.time()}
