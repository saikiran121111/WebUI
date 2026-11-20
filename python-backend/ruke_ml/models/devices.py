"""Device selection from MEASURED resources, never from a static device string.

Amendment 5 (SPEC 17) authorizes GPU execution when the measured fit says it fits and
keeps CPU as the fallback - which must pass its own RAM check, because moving work from
VRAM to RAM does not reduce pressure on a host that is already out of RAM.

Two independent quantities decide placement:
  * free physical RAM plus commit headroom (models/resources.admission), and
  * free VRAM on the device that would actually run the job (nvidia-smi).
Neither is inferred from parameter counts: a capability that has never been measured says
so in its estimate basis, and an unmeasured VRAM estimate disqualifies the GPU path
rather than guessing at it.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from . import resources

# nvidia-smi costs ~100 ms; probing repeatedly inside one job would sample the same
# instant twice. The cache is short so a job that waited still sees fresh numbers.
VRAM_PROBE_TTL_S = 5.0

# Headroom on top of an estimate. A fit with zero margin is not a fit: the processing
# allocations land after the load peak, not alongside it.
DEFAULT_MARGIN_MIB = 256


@dataclass(slots=True)
class VramState:
    available: bool
    free_mib: int = 0
    devices: list[dict[str, Any]] = field(default_factory=list)
    detail: str = ""
    source: str = "nvidia-smi"
    sampled_at: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {"available": self.available,
                "free_mib": self.free_mib if self.available else None,
                "devices": self.devices, "detail": self.detail, "source": self.source,
                "sampled_at": self.sampled_at}


_vram_cache: tuple[float, VramState] | None = None
_vram_lock = threading.Lock()


def vram_state(force: bool = False) -> VramState:
    """Free VRAM per NVIDIA GPU, or an honest unavailable - never a silent zero.

    WMI's AdapterRAM is wrong on this host (it reports a fraction of the real 12 GiB), and
    nvidia-smi's `memory.used` already includes the resident main LLM, which is exactly the
    number that matters when deciding whether another model fits.
    """
    global _vram_cache
    now = time.time()
    with _vram_lock:
        if not force and _vram_cache and now - _vram_cache[0] < VRAM_PROBE_TTL_S:
            return _vram_cache[1]
    rows = resources.vram()
    if not rows:
        state = VramState(False, 0, [],
                          "no nvidia-smi output: VRAM is unknown, not zero",
                          "nvidia-smi-absent", now)
    else:
        # A row that failed to answer one of the two memory queries has an UNKNOWN free amount,
        # not a free amount of zero: a partial query would otherwise be ranked as "least free"
        # or, worse, a total-less-than-used reading would become a confident 0 MiB of headroom.
        for row in rows:
            total, used = row.get("total_mib"), row.get("used_mib")
            if not isinstance(total, int) or not isinstance(used, int) or used > total:
                row["free_mib"] = None
            else:
                row["free_mib"] = int(total) - int(used)
        known = [r for r in rows if r["free_mib"] is not None]
        if not known:
            state = VramState(False, 0, rows,
                              ("nvidia-smi answered but reported no consistent memory figures: "
                               "VRAM is unknown, not zero"),
                              "nvidia-smi-unreadable", now)
        else:
            best = max(known, key=lambda r: r["free_mib"])
            state = VramState(True, int(best["free_mib"]), rows,
                              f"{len(known)} of {len(rows)} GPU row(s) readable; most free: "
                              f"{best.get('name', '?')} {best['free_mib']} MiB of "
                              f"{best.get('total_mib', '?')} MiB",
                              "nvidia-smi", now)
    with _vram_lock:
        _vram_cache = (now, state)
    return state


def clear_cache() -> None:
    """Test seam / refresh after a main-model unload changed the numbers."""
    global _vram_cache
    with _vram_lock:
        _vram_cache = None


@dataclass(slots=True)
class DevicePlan:
    capability: str
    device: str                    # gpu | cpu | none
    fits: bool
    needs_handoff: bool
    reason: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"capability": self.capability, "device": self.device, "fits": self.fits,
                "needs_handoff": self.needs_handoff, "reason": self.reason,
                "evidence": self.evidence}


def device_plan(capability: str, *, est_peak_mib: int, est_peak_vram_mib: int = 0,
                est_basis: str = "", est_vram_basis: str = "", allow_gpu: bool = True,
                margin_mib: int = DEFAULT_MARGIN_MIB,
                floor_mib: int = resources.FLOOR_FREE_PHYSICAL_MIB,
                main_model: dict[str, Any] | None = None) -> DevicePlan:
    """Where may this capability's weights actually be loaded right now?

    GPU requires BOTH a declared VRAM estimate and enough free VRAM to hold it with
    margin. A capability with no VRAM estimate is placed on CPU rather than guessed onto
    the GPU, and if an estimate exists but was never measured, the evidence says so.

    `needs_handoff` means the shortfall is plausibly recoverable by releasing the resident
    main model through the coordinator. It is not a claim that this has been arranged.

    Provisional estimates are charged higher than declared (resources.charged_estimate) on BOTH
    axes: an estimate that has never been measured on this host must not be the basis for
    loading a heavy worker alongside a 50 GiB resident model with a few hundred MiB to spare.
    """
    ram = resources.admission(est_peak_mib, margin_mib=margin_mib, floor_mib=floor_mib,
                              est_basis=est_basis)
    vram = vram_state()
    est_vram = max(0, int(est_peak_vram_mib or 0))
    # The same trust rule applies to VRAM: a declared GPU number nobody measured on this host
    # is charged wider, because a CUDA allocation failure lands inside a child we then have to
    # clean up, which is worse than a placement decision made up front.
    est_vram_charged = resources.charged_estimate(est_vram, est_vram_basis)
    # A number with no recorded measurement is a guess, and the evidence must not let it read
    # as a measurement: that is how a memory estimate silently becomes "proven".
    def basis_for(basis: str, declared: int) -> str:
        if basis:
            return basis
        return (f"declared {declared} MiB with no recorded measurement on this host"
                if declared else "no estimate declared")

    ev: dict[str, Any] = {
        "ram": ram,
        "vram": vram.as_dict(),
        "est_peak_mib": int(est_peak_mib),
        "est_peak_basis": basis_for(est_basis, int(est_peak_mib)),
        "est_peak_vram_mib": est_vram,
        "est_vram_basis": basis_for(est_vram_basis, est_vram),
        "margin_mib": int(margin_mib),
        "charged": {"ram_mib": int(ram.get("est_peak_mib_charged") or est_peak_mib),
                    "vram_mib": est_vram_charged,
                    "rule": ("declared estimate accepted as measured"
                             if resources.estimate_is_measured(est_basis)
                             else "unmeasured estimate charged at "
                                  f"{resources.UNMEASURED_ESTIMATE_FACTOR}x with a "
                                  f"{resources.UNMEASURED_MARGIN_MIB} MiB minimum margin"),
                    # When the host's own memory could not be read, admission returns no
                    # requirement at all. Reporting that as 0 MiB required would read as "this
                    # job needs nothing", which is the opposite of what an unreadable host means.
                    "required_ram_mib": (ram.get("required_mib") if ram.get("measured")
                                         else None)},
        "main_model": main_model or {},
    }

    gpu_ok = False
    gpu_reason = ""
    if not allow_gpu:
        gpu_reason = "GPU execution is disabled for this run"
    elif not vram.available:
        gpu_reason = vram.detail
    elif est_vram <= 0:
        gpu_reason = ("no VRAM estimate is declared for this capability, so GPU placement "
                      "would be a guess")
    elif vram.free_mib < est_vram_charged + margin_mib:
        gpu_reason = (f"free VRAM is {vram.free_mib} MiB, under the "
                      f"{est_vram_charged + margin_mib} MiB this needs ({est_vram} MiB estimate "
                      f"charged at {est_vram_charged} MiB + {margin_mib} MiB margin)")
    else:
        gpu_ok = True

    ram_ok = bool(ram.get("measured")) and bool(ram.get("fits"))
    ram_reason = ("; ".join(ram.get("reasons") or [])
                  or "measured RAM and commit headroom are sufficient")

    if gpu_ok and ram_ok:
        reason = (f"GPU fits: free VRAM {vram.free_mib} MiB covers the "
                  f"{est_vram} MiB estimate; {ram_reason}")
        return DevicePlan(capability, "gpu", True, False, reason, ev)
    if ram_ok:
        return DevicePlan(capability, "cpu", True, False,
                          f"CPU placement: {gpu_reason}; {ram_reason}", ev)

    # RAM is the binding constraint on BOTH devices - that is the whole point of the CPU
    # fallback passing its own check. Say which constraint bound, and whether releasing
    # the resident main model is what would change the answer.
    resident = bool((main_model or {}).get("loaded"))
    parts = [f"neither device fits: {ram_reason}"]
    if not gpu_ok:
        parts.append(f"GPU: {gpu_reason}")
    if resident:
        parts.append("the main model is resident and would have to be released first")
    return DevicePlan(capability, "none", False, True, "; ".join(parts), ev)
