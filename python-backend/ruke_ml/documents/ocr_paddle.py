"""Primary OCR engine: the pinned PaddleOCR-VL 1.6 PIPELINE, run as an owned child process.

This parent deliberately never imports paddle. The supervisor answers capability questions,
so importing the framework here would allocate 2 GB of weights just to report a status. The
weights exist only inside `ocr_paddle_worker.py`, in the isolated interpreter, under a job
object, and only for the duration of one owned job.

What the parent owns:
  * the pinned isolated interpreter and the two pinned model directories (recognition +
    layout) - if either is not verified on disk, this is an asset failure, not a crash;
  * the DEVICE actually used. The plan says cpu or gpu; the child echoes what paddle
    resolved; a contradiction is refused, never reported as success;
  * the process bound (job object) and the memory measurement (tree accounting, because the
    venv's python.exe is a redirector pair and single-pid numbers understate it);
  * per-page deadlines with a real kill, so a hung inference cannot hold the runtime ceiling;
  * raw per-page JSON/markdown kept on disk, so the text the caller sees is traceable.
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from ..config import child_env, repo_root, runtime_dir
from .. import allocations
from ..models import assets, devices, job_limits, ocr_runtime, registry, resources
from .ocr_tesseract import (DEFAULT_DPI, MAX_DPI, MIN_DPI, OcrPage, OcrUnavailable,
                            render_page_png)

ENGINE = "paddleocr-vl-1.6"
WORKER_FILE = Path(__file__).with_name("ocr_paddle_worker.py")


def load_refusal(detail: str, fallback_step: str = "",
                 *, fallback_kind: str = "load_failed") -> OcrUnavailable:
    """A worker that refused to allocate is a RESOURCE failure, never an asset failure.

    The three load sites below all report "the worker did not come up", and the three most
    common causes look identical from the parent: a missing asset, an incompatible pinned
    runtime, and the host refusing an allocation. Only the first two are fixed by preparing
    the runtime or the assets, so the message decides the kind. Verified against the ASR
    reproduction in ruke_ml/allocations.py; the OCR path has not yet produced a page, so this
    classification is a guard, not measured OCR behaviour.
    """
    if allocations.is_allocation_failure(detail):
        return OcrUnavailable(
            "allocation_failed", detail,
            "the pinned runtime and model directories are on disk: an allocation was refused. "
            "Free RAM/commit or let the resource coordinator unload the main model, then retry. "
            "Do NOT re-prepare the runtime or re-download the assets.")
    return OcrUnavailable(fallback_kind, detail, fallback_step)

LOAD_TIMEOUT_S = 420.0
PER_PAGE_TIMEOUT_S = 240.0
IDLE_SAMPLE_S = 0.4

# Fault injection, off unless an operator asks for it. It exists because the fallback contract
# ("release the primary worker, THEN retry the affected unit with Tesseract") cannot otherwise be
# demonstrated on a host where inference takes minutes and costs 3 GB.
#   RUKE_OCR_FAULT=unavailable -> readiness says the pipeline cannot run here at all, so the
#                                 cascade never spawns a primary and goes straight to recovery.
#   RUKE_OCR_FAULT=crash       -> the REAL worker process is spawned with the REAL handshake, but
#                                 it skips the model load and dies on the first page request.
#                                 That exercises the parent's death path, the release, and the
#                                 per-unit fallback without loading 1.9 GB of weights.
# Both modes are reported in the returned evidence; a fault-injected run is never readable as a
# clean engine result.
FAULT_ENV = "RUKE_OCR_FAULT"
WORKER_FAULT_ENV = "RUKE_OCR_WORKER_FAULT"
FAULT_MODES = ("", "unavailable", "crash")


def fault_mode() -> str:
    """The injected fault for this process, normalised. Empty string means no fault."""
    raw = (os.environ.get(FAULT_ENV) or "").strip().lower()
    return raw if raw in FAULT_MODES else ""


# --------------------------------------------------------------------------- death forensics
# A worker that goes down gets classified by the SAME helper at every site that notices, because
# "the child died" is one class of problem and the two places that see it (the load handshake and a
# page request) used to reach their own conclusions. What must never happen is reporting a refused
# allocation as an engine defect, or the reverse: both send a caller after the wrong fix.
_NAMED_EXCEPTION = re.compile(
    r"(?:Traceback \(most recent call last\)|\b[A-Za-z_][\w.]*(?:Error|Exception|EnforceError)\b)")


def classify_worker_death(*, code: int | None, verdict: dict[str, Any], detail: str,
                          ceiling_bytes: int, enforced_by_os: bool,
                          event_marker: str = "", stage: str = "load") -> dict[str, Any]:
    """What a dead OCR worker should be CALLED, from the evidence that actually exists.

    `stage` says which site is asking, because the NON-resource label differs: a worker that dies
    before it ever reported ready is a load failure, and one that dies mid-inference is an engine
    death. The resource branches do not care about the stage.

    Ordered by strength of evidence, and each branch says how strong it is:
      1. the engine named a refused allocation (the child tagged it, or the log tail says so);
      2. the kernel's own job peak reached the ceiling we attached - the OS proved the refusal;
      3. the child terminated abnormally under an attached ceiling with no engine-named exception,
         which is consistent with a single allocation larger than the remaining headroom being
         refused (the kernel peak never reaches the ceiling in that shape) - SUSPECTED, and said
         to be suspected;
      4. anything else keeps the load/engine label, because there is no evidence for more.
    """
    tail = str(detail or "")
    abnormal = code is None or int(code or 0) < 0
    named = allocations.is_allocation_failure(event_marker) or \
        allocations.is_allocation_failure(tail)
    peak_proven = bool(verdict.get("reached"))
    out: dict[str, Any] = {"code": code, "abnormal_termination": bool(abnormal),
                           "ceiling_bytes": int(ceiling_bytes),
                           "ceiling_enforced_by_os": bool(enforced_by_os)}
    if named:
        out.update({
            "kind": "resource_limit", "reason": "allocation_named_by_engine",
            "why": ("the engine itself named a refused allocation"
                    + (f" (marker {event_marker!r} from the worker protocol)" if event_marker
                       else " (in the recorded worker log)")),
            "note": ("the refusal is stated by the engine, so the job-object peak ratio is not "
                     "what this classification rests on"),
        })
    elif peak_proven:
        out.update({
            "kind": "resource_limit", "reason": "kernel_peak_reached_ceiling",
            "why": str(verdict.get("note") or "the kernel job peak reached the attached ceiling"),
            "note": "measured by the kernel, not sampled",
        })
    elif abnormal and enforced_by_os:
        out.update({
            "kind": "resource_limit", "reason": "suspected_under_attached_ceiling",
            "why": (f"terminated abnormally (code {code}) while bounded by an attached commit "
                     f"ceiling of {int(ceiling_bytes) >> 20} MiB; {verdict.get('note', '')}"),
            "note": ("SUSPECTED, not proven: the kernel peak did not reach the ceiling, which is "
                     "the shape a single allocation larger than the remaining headroom makes - "
                     "the request is refused whole, so the peak stops short of the limit. No "
                     "engine-named exception appears in the worker log, so an engine fault is also "
                     "not proven. The honest label is a resource limit with its evidence gap "
                     "stated."),
        })
    elif abnormal:
        out.update({
            "kind": "resource_limit", "reason": "abnormal_death_unbounded",
            "why": f"terminated abnormally (code {code}) with no measurable ceiling attribution",
            "note": ("no per-worker ceiling was attached, so this death cannot be pinned on one; "
                     "reported as a resource limit only because an abnormal termination in a "
                     "multi-gigabyte pipeline is the same class of condition and is retried the "
                     "same way - the cause itself is UNKNOWN"),
        })
    else:
        kind = "engine_death" if (stage == "page" or _NAMED_EXCEPTION.search(tail)) else "load_failed"
        out.update({
            "kind": kind, "reason": "engine_reported_failure",
            "why": f"the worker exited with code {code}"
                   + (", naming an exception in its log" if _NAMED_EXCEPTION.search(tail)
                      else " without naming an exception"),
            "note": "no ceiling evidence and no abnormal termination: not labelled a resource limit",
        })
    return out


RESOURCE_LIMIT_STEP = (
    "the demand declared for this pipeline does not fit the resource window it ran in: open the "
    "coordinated exclusive window (drain inference, release the main model, re-check admission) "
    "or run the recovery engine; report this as a resource limit rather than an engine fault, and "
    "do NOT raise the hard maximum, drop a page, or re-prepare assets that are already valid")


def fault_reason(mode: str = "") -> str:
    mode = mode or fault_mode()
    if not mode:
        return ""
    return (f"fault-injected by {FAULT_ENV}={mode} for the fallback acceptance run; this is NOT "
            "an engine result")


def estimate() -> dict[str, Any]:
    """The pinned row's own declared peaks, so callers plan from one source of truth."""
    specs = [s for s in registry.catalog().all_specs()
             if s.capability == "documents.ocr" and s.provider == "paddle"]
    if not specs:
        return {"est_peak_mib": 0, "est_peak_basis": "no pinned OCR row",
                "est_peak_commit_mib": 0, "est_peak_commit_basis": "no pinned OCR row",
                "est_peak_vram_mib": 0, "est_vram_basis": "no pinned OCR row"}
    spec = specs[0]
    # A declared number with no recorded measurement must never be printed as "measured":
    # that is how a provisional weight-byte bound silently becomes a proven fact in whatever
    # report quotes this dict. The basis string carries the provenance, and estimate_kind
    # states it in one word so a caller cannot infer "measured" from a non-zero number.
    ram_est = int(spec.est_peak_mib or 0)
    ram_basis = (spec.est_peak_basis or "").strip()
    commit_est = int(getattr(spec, "est_peak_commit_mib", 0) or 0)
    commit_basis = str(getattr(spec, "est_peak_commit_basis", "") or "").strip()
    vram_est = int(getattr(spec, "est_peak_vram_mib", 0) or 0)
    vram_basis = str(getattr(spec, "est_vram_basis", "") or "").strip()

    def kind(basis: str, declared: int) -> str:
        if not declared:
            return "not declared"
        return "measured" if resources.estimate_is_measured(basis) else "provisional"

    return {"est_peak_mib": ram_est,
            "est_peak_basis": (ram_basis or
                               (f"declared {ram_est} MiB with no recorded measurement on this host"
                                if ram_est else "no OCR row declares a RAM estimate")),
            "estimate_kind": kind(ram_basis, ram_est),
            # The COMMIT peak, separately from the resident working set: the CUDA build charges
            # its DLL and CUDA mappings to the commit charge, so a ceiling bounded by commit
            # must be sized from THIS figure. The working-set row above stays what the device
            # plan's RAM admission uses (measured 2026-11-23: a 6675 MiB commit ceiling sized
            # from the 2620 MiB working set killed the pipeline load mid-model, 0xC0000409).
            "est_peak_commit_mib": commit_est,
            "est_peak_commit_basis": (commit_basis or
                                      (f"declared {commit_est} MiB with no recorded commit "
                                       f"measurement on this host" if commit_est
                                       else "no OCR row declares a commit peak")),
            "est_commit_kind": kind(commit_basis, commit_est),
            "est_peak_vram_mib": vram_est,
            "est_vram_basis": (vram_basis or
                               (f"declared {vram_est} MiB with no recorded GPU measurement on this host"
                                if vram_est else "no OCR row declares a VRAM estimate")),
            "est_vram_kind": kind(vram_basis, vram_est),
            "model_id": spec.id}


def engine_state() -> dict[str, Any]:
    """Readiness without loading: interpreter, pins, and BOTH pinned asset snapshots."""
    runtime = ocr_runtime.status()
    est = estimate()
    vl = assets.asset_state(registry.PADDLE_VL_REPO, expected_revision=registry.PADDLE_VL_REVISION,
                            required=registry.PADDLE_VL_FILES)
    layout = assets.asset_state(registry.PADDLE_LAYOUT_REPO,
                                expected_revision=registry.PADDLE_LAYOUT_REVISION,
                                required=registry.PADDLE_LAYOUT_FILES)
    injected = fault_mode()
    blockers = [reason for reason, ok in (
        (f"isolated OCR runtime: {runtime.detail}", runtime.found),
        (f"recognition snapshot ({registry.PADDLE_VL_REPO}): {vl.detail}", vl.present),
        (f"layout snapshot ({registry.PADDLE_LAYOUT_REPO}): {layout.detail}", layout.present),
        (f"worker script missing: {WORKER_FILE}", WORKER_FILE.is_file()),
    ) if not ok]
    if runtime.abi_issues:
        # A stub that raises at import time is a dependency-ABI failure, not a missing asset and
        # not a slow run. It must be visible before a resource window opens, because the pipeline
        # only discovers it minutes into a window that cost an LLM unload to open (measured
        # 2026-11-17).
        blockers[0:0] = [f"OCR venv dependency ABI: {issue}" for issue in runtime.abi_issues]
    if injected == "unavailable":
        # The operator asked for the unavailable-engine path. Say so in the SAME place a real
        # asset failure would appear, so the cascade's reason string is honest either way.
        blockers.insert(0, fault_reason(injected))
        ready = False
    else:
        ready = bool(runtime.found and vl.present and layout.present and WORKER_FILE.is_file())
    return {"engine": ENGINE, "runtime": runtime.as_dict(), "recognition_asset": vl.as_dict(),
            "layout_asset": layout.as_dict(), **est,
            "worker": WORKER_FILE.name, "worker_present": WORKER_FILE.is_file(),
            "ready": ready,
            "fault": injected, "fault_note": fault_reason(injected),
            # "not ready" without the reason is decoration: the caller needs to know WHICH of
            # the four conditions failed, and a readiness answer without reasons cannot be
            # turned into a next action.
            "blockers": blockers}


def _model_dirs() -> tuple[str, str]:
    vl = assets.asset_state(registry.PADDLE_VL_REPO, expected_revision=registry.PADDLE_VL_REVISION,
                            required=registry.PADDLE_VL_FILES)
    if not vl.present:
        raise OcrUnavailable("asset_missing",
                             f"the pinned recognition snapshot is unusable: {vl.detail}",
                             "python -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6")
    layout = assets.asset_state(registry.PADDLE_LAYOUT_REPO,
                                expected_revision=registry.PADDLE_LAYOUT_REVISION,
                                required=registry.PADDLE_LAYOUT_FILES)
    if not layout.present:
        raise OcrUnavailable("asset_missing",
                             f"the pinned layout snapshot is unusable: {layout.detail}",
                             "the pipeline needs PP-DocLayoutV3 as well as the VL model: re-run "
                             "python -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6")
    return vl.path, layout.path


@dataclass(slots=True)
class PaddleRun:
    pages: list[OcrPage] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)


def _reader_loop(pipe: Any, sink: "queue.Queue[Any]") -> None:
    for line in pipe:
        sink.put(line)
    sink.put(None)


def _monitor(pid: int, stop: threading.Event, out: dict[str, Any]) -> None:
    """Peak RAM for the child AND the interpreter it re-execs, sampled while it runs."""
    samples = available = 0
    # Same folding rule as the operation-level sampler in models/resources.py: every field is
    # either a measured maximum or None, and a snapshot that reported nothing counts as an
    # unmeasured sample instead of a zero.
    fold: dict[str, Any] = {field: None for field in resources.PEAK_FIELDS}
    while not stop.is_set():
        sample = resources.process_tree_memory(pid)
        samples += 1
        if sample.get("available"):
            available += 1
            resources.fold_peak_sample(fold, sample)
            out["last_tree"] = {"pids": sample.get("pids", []),
                                **{field: sample.get(field)
                                   for field in resources.PEAK_FIELDS}}
        stop.wait(IDLE_SAMPLE_S)
    # A peak of zero with zero usable samples means "we could not measure", not "it was free",
    # so the unmeasured case is reported as None and every consumer has to say "unknown".
    out["peak_working_set_mib"] = fold["working_set_mib"]
    out["peak_commit_mib"] = fold["commit_mib"]
    out["samples"] = samples
    out["samples_available"] = available
    unmeasured = {field: fold[f"{field}_unmeasured_samples"]
                  for field in resources.PEAK_FIELDS
                  if fold.get(f"{field}_unmeasured_samples")}
    if unmeasured:
        out["unmeasured_field_samples"] = unmeasured


def _terminate(proc: subprocess.Popen, reason: str) -> None:
    try:
        proc.terminate()
    except OSError:
        return
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=10)
        except (subprocess.TimeoutExpired, OSError):
            pass


def ocr_pdf_pages(pdf_path: str | Path, pages: Sequence[int], *, language: str,
                  device: str = "cpu", dpi: int = DEFAULT_DPI,
                  rotations: dict[int, int] | None = None,
                  cancel: Callable[[], bool] | None = None,
                  progress: Callable[[str, str], None] | None = None,
                  load_timeout_s: float = LOAD_TIMEOUT_S,
                  per_page_timeout_s: float = PER_PAGE_TIMEOUT_S,
                  deadline_at: float = 0.0,
                  per_worker_limit_bytes: int = 0,
                  job_id: str = "documents.ocr",
                  allow_gpu: bool = False,
                  inside_window: bool = False) -> PaddleRun:
    """OCR the given 1-based pages with the primary pipeline.

    Raises OcrUnavailable for whole-run conditions (missing runtime/assets, spawn or load
    failure, device contradiction). Per-page failures come back as OcrPage states so the
    caller can fall back for THAT unit and keep the units that worked.

    `inside_window` states which resource window this call runs in: True only when the caller
    actually released the main model for this operation, which is what makes the separately
    configured exclusive ceiling applicable. The commit ceiling is then RESOLVED AND CHECKED HERE,
    before the child exists - see the block below the fault injection.
    """
    if device not in ("cpu", "gpu"):
        raise OcrUnavailable("input_rejected", f"unknown device request {device!r}")
    # Normalise once: `pages` is counted for the stats header AND iterated per page, so a lazy
    # argument would silently produce zero pages and a header claiming otherwise.
    page_list = [int(p) for p in pages]
    if not page_list:
        raise OcrUnavailable("input_rejected", "no pages were requested for OCR")
    if device == "gpu" and not allow_gpu:
        raise OcrUnavailable("gpu_placement_refused",
                             "GPU placement was requested but this run has GPU disabled",
                             "run on cpu, or re-plan with allow_gpu")
    state = engine_state()
    if not state["runtime"]["found"]:
        raise OcrUnavailable("runtime_missing",
                             f"the isolated OCR runtime is not validated: {state['runtime']['detail']}",
                             "scripts/prepare-ocr-runtime.ps1")
    if not state["worker_present"]:
        raise OcrUnavailable("runtime_missing", f"the OCR worker script is missing: {WORKER_FILE}")
    vl_dir, layout_dir = _model_dirs()

    dpi = max(MIN_DPI, min(MAX_DPI, int(dpi or DEFAULT_DPI)))
    # ONE deterministic repair, allowed once per page: re-rasterise at a clamped different DPI and
    # re-send to the SAME worker (no second model load). It is deliberately not "retry harder with
    # a different engine" - that decision belongs to the cascade, which releases this worker first.
    repair_dpi = 0
    if dpi < MAX_DPI:
        repair_dpi = min(MAX_DPI, max(MIN_DPI, dpi * 2))
    elif dpi > MIN_DPI:
        repair_dpi = max(MIN_DPI, dpi // 2)
    if repair_dpi == dpi:
        repair_dpi = 0
    scratch = runtime_dir() / "tmp" / f"ocr-paddle-{os.getpid()}"
    scratch.mkdir(parents=True, exist_ok=True)

    env = child_env(job_id)
    env.setdefault("PADDLE_PDX_CACHE_HOME", str(repo_root() / ".data" / "ml-cache" / "paddle"))
    env.setdefault("OMP_NUM_THREADS", "4")
    if device == "cpu":
        # Belt and braces: the pinned wheel is the CUDA build (the CPU wheel is the recorded
        # fallback), so a cpu placement on a CUDA build is a real placement, not a no-op -
        # CUDA_VISIBLE_DEVICES=-1 makes an accidental GPU allocation impossible rather than
        # merely unlikely, and the worker's paddle.device echo is checked against the plan.
        env["CUDA_VISIBLE_DEVICES"] = "-1"
        env["FLAGS_selected_gpus"] = "-1"

    injected = fault_mode()
    if injected == "unavailable":
        raise OcrUnavailable("engine_unavailable", fault_reason(injected),
                             "unset RUKE_OCR_FAULT to run the real pipeline")
    if injected == "crash":
        # The child is really spawned and really speaks the protocol; it only skips the weights
        # and dies on the first page. The parent still pays for a spawn, a handshake, a death and
        # a release, which is exactly the sequence the fallback contract depends on.
        env[WORKER_FAULT_ENV] = "crash"

    # ---- the ceiling is chosen and checked BEFORE the child exists -------------------------
    # Spawning first and letting the engine's own allocator fail costs a full model load and then
    # reports an "engine crash" that is really a refused allocation: measured 2026-11-18, when a
    # 3,814 MiB job-object ceiling killed the worker inside `model.safetensors` and the parent
    # could only say "the worker exited before reporting ready (code None)". The window, the
    # demand the pinned row declares, and the arithmetic deciding whether they fit all live in
    # models/job_limits.py, so this adapter does not invent its own ceiling maths - it asks, and
    # the answer is either a bounded OS ceiling or a typed refusal.
    # The job object bounds the child's COMMIT charge, so the demand is charged from the row's
    # measured COMMIT peak when it has one: the CUDA build's DLL and CUDA mappings never show
    # up in the resident working-set figure, and sizing the ceiling from that figure squeezed
    # the worker into a ceiling it could not load under - the 2026-11-18 allocator death, and
    # again 2026-11-23 when a 6675 MiB ceiling killed the load mid-model (0xC0000409). The RAM
    # estimate stays what the device plan's admission uses; only the ceiling maths moves here.
    commit_demand = int(state.get("est_peak_commit_mib") or 0)
    demand_mib = commit_demand if commit_demand > 0 else int(state.get("est_peak_mib") or 0)
    demand_basis = (str(state.get("est_peak_commit_basis") or "") if commit_demand > 0
                    else str(state.get("est_peak_basis") or ""))
    demand_bytes = demand_mib * job_limits.MIB
    ceiling, ceiling_report = job_limits.worker_ceiling_bytes(
        inside_window=bool(inside_window),
        declared_demand_bytes=demand_bytes,
        demand_basis=demand_basis,
        ceiling_override_bytes=int(per_worker_limit_bytes or 0))
    ceiling_evidence = dict(ceiling_report)
    ceiling_evidence["declared_demand_source"] = (
        "registry ModelSpec for documents.ocr: "
        + ("est_peak_commit_mib, the kernel job commit peak (the ceiling bounds commit)"
           if commit_demand > 0 else
           "est_peak_mib, the resident working set (this row records no commit peak)"))
    if injected == "crash":
        # The fault-injected worker loads no weights at all, so a demand-based refusal here would
        # describe a load that was never attempted. The ceiling is still attached and still
        # reported, and the suppression itself is part of the evidence.
        ceiling_evidence["refusal_suppressed"] = (
            f"{FAULT_ENV}=crash loads no weights, so the demand check did not gate this spawn; "
            "the ceiling above is still the ceiling this child runs under")
    elif ceiling_report.get("below_declared_demand"):
        raise OcrUnavailable(
            "resource_limit",
            f"refusing to spawn: {ceiling_report.get('refuse_reason', '')}",
            RESOURCE_LIMIT_STEP)

    stderr_path = scratch / f"worker-{int(time.time())}.log"
    stderr_file = open(stderr_path, "wb")                       # noqa: SIM115 - owned below
    try:
        proc = subprocess.Popen(                                # noqa: S603 - project-local exe
            [state["runtime"]["interpreter"], str(WORKER_FILE)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_file,
            cwd=str(repo_root()), env=env, text=True, bufsize=1,
            encoding="utf-8", errors="replace")
    except OSError as exc:
        stderr_file.close()
        raise OcrUnavailable("engine_spawn_failed",
                             f"could not start the OCR worker: {type(exc).__name__}: {exc}",
                             "check the isolated interpreter at "
                             + str(state["runtime"]["interpreter"])) from exc

    limit_report = job_limits.attach_child(proc, ceiling)
    ceiling_evidence["attached"] = {k: v for k, v in limit_report.items() if k != "job"}
    ceiling_evidence["enforced_by_os"] = bool(limit_report.get("enforced"))
    if not limit_report.get("enforced"):
        # A ceiling the OS did not actually attach is a warning, not a pass: the worker is then
        # bounded only by whatever the outer runtime tree carries, and the report must say which.
        why = (limit_report.get("reason") or limit_report.get("detail")
               or limit_report.get("mechanism") or "no mechanism reported")
        ceiling_evidence["enforcement_note"] = (
            f"no per-worker commit ceiling was attached to pid {proc.pid} ({why}); the demand "
            "check above is arithmetic, not an OS guarantee for this child. The measured peak of "
            "this run therefore says nothing about whether the ceiling would have held it.")
    job_handle = limit_report.get("job")
    lines: "queue.Queue[Any]" = queue.Queue()
    reader = threading.Thread(target=_reader_loop, args=(proc.stdout, lines), daemon=True)
    reader.start()
    stop_monitor = threading.Event()
    peak: dict[str, Any] = {}
    monitor = threading.Thread(target=_monitor, args=(proc.pid, stop_monitor, peak), daemon=True)
    monitor.start()

    stats: dict[str, Any] = {"engine": ENGINE, "pid": proc.pid,
                             "requested_device": device, "dpi": dpi,
                             "interpreter": state["runtime"]["interpreter"],
                             "recognition_dir": vl_dir, "layout_dir": layout_dir,
                             "limit": {k: v for k, v in limit_report.items() if k != "job"},
                             "ceiling": ceiling_evidence,
                             "stderr_log": str(stderr_path), "pages_attempted": len(page_list),
                             "fault": injected, "fault_note": fault_reason(injected)}

    def finish_pages(collected: list[OcrPage], remaining: Iterable[int], state_name: str,
                     detail: str) -> list[OcrPage]:
        for page in remaining:
            collected.append(OcrPage(page=int(page), state=state_name, detail=detail,
                                     engine=ENGINE, language_code=language))
        return collected

    def close_child(reason: str) -> None:
        try:
            if proc.stdin and proc.poll() is None:
                proc.stdin.write(json.dumps({"event": "shutdown"}) + "\n")
                proc.stdin.flush()
        except (OSError, ValueError):
            pass
        if proc.poll() is None:
            _terminate(proc, reason)
        # Close the pipes only AFTER the child is gone: the reader thread is still iterating
        # proc.stdout, and closing underneath it would raise inside that thread. An unclosed
        # pipe here is a real descriptor leak, because this runs once per OCR job.
        reader.join(timeout=3)
        for pipe in (proc.stdin, proc.stdout):
            try:
                if pipe is not None:
                    pipe.close()
            except (OSError, ValueError):
                pass
        stop_monitor.set()
        monitor.join(timeout=5)
        stderr_file.close()
        stats["exit"] = proc.returncode
        # Two DIFFERENT quantities, never merged into one number:
        #   resident  - largest sampled working set over the child's process TREE
        #   commit    - the kernel's peak job-object charge, which samples can miss between ticks
        job_peak = _job_peak(job_handle)
        sampled_ws = peak.get("peak_working_set_mib")
        sampled_commit = peak.get("peak_commit_mib")
        job_commit = job_peak.get("peak_commit_mib")
        usable_samples = int(peak.get("samples_available") or 0)
        stats["peak_working_set_mib"] = int(sampled_ws) if sampled_ws is not None else None
        commit_values = [int(v) for v in (sampled_commit, job_commit) if v is not None]
        stats["peak_commit_mib"] = max(commit_values) if commit_values else None
        stats["peak_job_object_commit_mib"] = (int(job_commit) if job_commit is not None else None)
        stats["peak_measured"] = bool(usable_samples or job_commit is not None)
        stats["peak_basis"] = ("resident = max sampled working set over the process tree; commit = "
                               "max(sampled commit, job-object peak charge). They are different "
                               "quantities and neither is a substitute for the other. A null means "
                               "the quantity was never measured, not that it was zero.")
        if not stats["peak_measured"]:
            stats["peak_unmeasured_reason"] = str(
                job_peak.get("why") or
                "the memory sampler recorded no usable sample for this child, so its peak is "
                "UNKNOWN and is reported as unknown rather than as zero")
        stats["samples"] = int(peak.get("samples", 0) or 0)
        # The count of ALL samples and the count of USABLE samples are different claims, and the
        # cascade reads the second one to decide whether a peak is trustworthy.
        stats["samples_available"] = usable_samples
        if job_handle is not None:
            try:
                job_handle.close()
            except Exception:                                   # noqa: BLE001
                pass

    def _job_peak(handle: Any) -> dict[str, Any]:
        if handle is None or not hasattr(handle, "peaks"):
            return {"peak_commit_mib": None,
                    "why": "no job object was attached, so the kernel peak charge is UNKNOWN"}
        try:
            peaks = handle.peaks() or {}
            if not peaks.get("available"):
                return {"peak_commit_mib": None,
                        "why": "the job object reported no readable peak charge, so it is UNKNOWN"}
            # models/job_limits.py reports the peak in MiB already, under these two names: the
            # job-wide peak and the largest single member. We keep the larger of the pair so a
            # ceiling is compared against the whole tree, not one process.
            values = [int(peaks.get(key) or 0) for key in ("peak_job_commit_mib",
                                                           "peak_process_commit_mib")
                      if peaks.get(key) is not None]
            if not values:
                return {"peak_commit_mib": None,
                        "why": "the job object's peak block named no readable figure"}
            return {"peak_commit_mib": max(values)}
        except Exception:                                       # noqa: BLE001
            return {"peak_commit_mib": None, "why": "the job object's peak query raised"}

    def _ceiling_verdict() -> dict[str, Any]:
        """Did the kernel actually take this child down at the ceiling we attached?

        This is what separates "the worker died for a reason we cannot see" from "the OS refused
        the allocation it was bounded to refuse". The KERNEL job peak is used, not a sample,
        because a sampler can miss the peak entirely between ticks. When no per-worker ceiling was
        attached, or the peak is unreadable, the answer is `reached: None` - never False, because
        "not proven to be a ceiling kill" is not the same claim as "proven not to be one".
        """
        if not ceiling_evidence.get("enforced_by_os"):
            return {"available": False, "reached": None,
                    "note": ("no per-worker commit ceiling was attached to this child, so its "
                             "death cannot be attributed to (or cleared of) that ceiling; the "
                             "cause is UNKNOWN")}
        if job_handle is None or not hasattr(job_handle, "peaks"):
            return job_limits.peak_hit_limit({})
        try:
            return job_limits.peak_hit_limit(job_handle.peaks() or {})
        except Exception:                                       # noqa: BLE001
            return job_limits.peak_hit_limit({})

    def _reap(timeout_s: float = 10.0) -> int | None:
        """Make the exit status real BEFORE anything is classified from it.

        `returncode is None` right after stdout reaches EOF is not evidence that the OS never set
        a status: Python only fills it in after a poll/wait. Reading the code here is what stops
        an ordinary crash and a ceiling kill from being told apart by the absence of a number.
        """
        if proc.poll() is None:
            try:
                proc.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                _terminate(proc, "unresponsive after stdout EOF")
        return proc.returncode

    try:
        header = {"header": {"vl_rec_model_dir": vl_dir, "layout_model_dir": layout_dir,
                             "device": device, "cpu_threads": 4, "pipeline_version": "v1.6",
                             "scratch_dir": str(scratch), "precision": "fp32",
                             # The child must not import ruke_ml, so the ONE authoritative list of
                             # what an allocation refusal looks like is handed to it over the pipe.
                             "memory_refusal_markers": list(allocations.ALLOCATED_REFUSED_MARKERS)}}
        _write(proc, header)

        ready_deadline = time.time() + max(30.0, float(load_timeout_s))
        echo: dict[str, Any] = {}
        while True:
            remaining = ready_deadline - time.time()
            if remaining <= 0:
                raise OcrUnavailable("load_failed",
                                     f"the OCR worker did not finish loading within "
                                     f"{int(load_timeout_s)} s",
                                     "the model load is the expensive step; lower the pipeline "
                                     "scope or free RAM and retry")
            try:
                event = _read_event(lines, remaining)
            except TimeoutError as exc:
                raise load_refusal(f"OCR worker load timed out: {exc}",
                                   "retry with more free RAM") from exc
            if event is None:
                code = _reap()
                verdict = _ceiling_verdict()
                stats["worker_exit_code"] = code
                stats["ceiling_verdict"] = verdict
                detail = _tail(stderr_path)
                # ONE classifier for every place a worker death is noticed (amendment 15). The F59
                # signature is a child killed while `model.safetensors` was being mapped: it leaves
                # no exception and its kernel peak stops short of the ceiling, because one request
                # larger than the remaining headroom is refused whole. The old code labelled that a
                # load failure whenever the peak happened to be readable and low.
                called = classify_worker_death(
                    code=code, verdict=verdict, detail=detail, ceiling_bytes=int(ceiling),
                    enforced_by_os=bool(ceiling_evidence.get("enforced_by_os")))
                stats["death_classification"] = called
                if called["kind"] == "resource_limit":
                    raise OcrUnavailable(
                        "resource_limit",
                        (f"the worker died during the load (code {code}) {called['why']}; attached "
                         f"commit ceiling {int(ceiling) >> 20} MiB; {called['note']}; {detail}"),
                        RESOURCE_LIMIT_STEP)
                raise load_refusal(f"the OCR worker exited before reporting ready (code {code}) "
                                   f"{called['why']}; {detail}",
                                   "see the recorded worker log")
            if event.get("event") == "error":
                # The child is still alive here, so reap it before anything is classified from an
                # exit code: an error event is a deliberate exit, not a kill, and must not be read
                # as an abnormal termination.
                stats["worker_exit_code"] = _reap()
                error_detail = str(event.get("detail") or "")
                called = classify_worker_death(
                    code=stats["worker_exit_code"], verdict={"reached": None},
                    detail=error_detail, ceiling_bytes=int(ceiling),
                    enforced_by_os=bool(ceiling_evidence.get("enforced_by_os")),
                    event_marker=str(event.get("allocation_refusal") or ""))
                stats["death_classification"] = called
                if called["kind"] == "resource_limit":
                    raise OcrUnavailable(
                        "resource_limit",
                        (f"the worker reported a load failure that names a refused allocation: "
                         f"{error_detail}; attached commit ceiling {int(ceiling) >> 20} MiB; "
                         f"{called['why']}"),
                        RESOURCE_LIMIT_STEP)
                raise load_refusal(
                    f"OCR worker failed to load the pipeline: {event.get('detail')}",
                    "verify the pinned runtime and the two model directories")
            if event.get("event") == "ready":
                echo = event
                break

        stats["device_echo"] = echo
        stats["load_seconds"] = echo.get("seconds")
        stats["dropped_kwargs"] = echo.get("dropped_kwargs", [])
        # What numeric format the weights were ACTUALLY loaded in, as the child reported it.
        # `precision` is a TensorRT-only knob in the pinned build, so a header saying "fp32" is not
        # proof of the dtype the run used - the child's own policy block is where that is settled.
        stats["dtype_policy"] = echo.get("dtype_policy", {
            "available": False,
            "note": ("the worker echoed no dtype policy, so the numeric format the weights loaded "
                     "in is UNKNOWN for this run and is not recorded as fp32")})
        echoed = str(echo.get("device", "")).lower()
        stats["device_used"] = echoed or "unknown"
        stats["cuda_compiled"] = echo.get("cuda_compiled")
        stats["paddle_version"] = echo.get("paddle_version", "")
        if device == "cpu" and echoed and not echoed.startswith("cpu"):
            raise OcrUnavailable("gpu_placement_refused",
                                 f"the plan said cpu but paddle resolved {echoed!r}; the pinned "
                                 "build placed work on a device this policy does not allow",
                                 "re-prepare the CPU runtime or re-plan with allow_gpu")
        if device == "gpu" and echoed.startswith("cpu"):
            stats["device_downgrade"] = ("the plan said gpu but paddle resolved cpu; the result "
                                         "is recorded as a CPU run, not a GPU run")

        collected: list[OcrPage] = []
        for index, page in enumerate(page_list):
            if cancel is not None and cancel():
                stats["cancelled_at_page"] = page
                if progress:
                    progress("cancelled", f"OCR stopped before page {page}")
                return PaddleRun(finish_pages(collected, page_list[index:], "skipped",
                                              "cancelled before this page was sent to the engine"),
                                 stats)
            if deadline_at and time.time() >= deadline_at:
                stats["deadline_reached_at_page"] = page
                return PaddleRun(finish_pages(collected, page_list[index:], "ocr_failed",
                                              "the job deadline expired before this page"), stats)
            if progress:
                progress("ocr", f"{ENGINE} page {page} at {dpi} dpi")

            def attempt(dpi_now: int, rotation_now: int, tag: str) -> tuple[str, dict[str, Any]]:
                """Rasterise one page, send it, and return (outcome, payload).

                outcome is "ok" (payload has an OcrPage), "raster_failed", "timeout" or "died".
                timeout/died are whole-run conditions: the caller releases the worker.
                """
                try:
                    png, raster = render_page_png(pdf_path, page, dpi=dpi_now, rotation=rotation_now)
                except OcrUnavailable as exc:
                    return "raster_failed", {"detail": str(exc)}
                image_path = scratch / f"page-{page:04d}-{tag}.png"
                try:
                    image_path.write_bytes(png)
                except OSError as exc:
                    return "raster_failed", {"detail": f"scratch write failed: {exc}"}

                budget = per_page_timeout_s
                if deadline_at:
                    budget = min(budget, max(5.0, deadline_at - time.time()))
                _write(proc, {"page": page, "image": str(image_path), "language": language})
                try:
                    answer = _read_event(lines, budget)
                except TimeoutError:
                    return "timeout", {"budget": budget}
                if answer is None:
                    return "died", {"detail": _tail(stderr_path)}
                if "page" not in answer:
                    return "ok", {"page_state": "ocr_failed",
                                  "detail": f"unexpected worker event: {answer}"}
                state_name = str(answer.get("state") or "ocr_failed")
                marker = str(answer.get("allocation_refusal") or "")
                if marker:
                    stats["allocation_refusals"] = int(stats.get("allocation_refusals", 0)) + 1
                return "ok", {
                    "page_state": state_name if state_name in ("recognised", "empty", "ocr_failed")
                    else "ocr_failed",
                    "text": str(answer.get("text") or ""),
                    "detail": str(answer.get("detail") or ""),
                    "allocation_refusal": marker,
                    "confidence": answer.get("confidence"),
                    "lines": list(answer.get("regions") or [])[:500],
                    "raster": {**raster, "raw_json_path": answer.get("raw_json_path", ""),
                               "markdown_path": answer.get("markdown_path", ""),
                               "seconds": answer.get("seconds"), "dpi": dpi_now,
                               "rotation": rotation_now},
                }

            def page_from(page_payload: dict[str, Any]) -> OcrPage:
                marker = str(page_payload.get("allocation_refusal") or "")
                detail = str(page_payload.get("detail") or "")
                if marker:
                    # A page the engine could not recognise BECAUSE an allocation was refused is a
                    # resource condition on this unit, and the caller's fallback decision must be
                    # able to see that; it is not an empty page and not a corrupt page.
                    detail = (f"the engine named a refused allocation (marker {marker!r}) on page "
                              f"{page} under an attached commit ceiling of "
                              f"{int(ceiling) >> 20} MiB - a resource limit, not an empty page; "
                              f"{detail}")
                return OcrPage(
                    page=page,
                    state=str(page_payload.get("page_state") or "ocr_failed"),
                    text=str(page_payload.get("text") or ""),
                    detail=detail,
                    confidence=page_payload.get("confidence"),
                    lines=list(page_payload.get("lines") or []),
                    raster=dict(page_payload.get("raster") or {}),
                    engine=ENGINE, language_code=language)

            rotation = int((rotations or {}).get(page, 0))
            kind, payload = attempt(dpi, rotation, "main")
            if kind == "ok" and payload.get("page_state") == "ocr_failed" and repair_dpi:
                # A recognised-but-empty page is NOT retried: emptiness is a real answer. Only a
                # failed recognition gets the one allowed repair, and the repair is recorded.
                stats["repairs_attempted"] = int(stats.get("repairs_attempted", 0)) + 1
                if progress:
                    progress("ocr", f"{ENGINE} page {page}: one repair pass at {repair_dpi} dpi")
                r_kind, r_payload = attempt(repair_dpi, rotation, "repair")
                if r_kind == "ok" and r_payload.get("page_state") in ("recognised", "empty"):
                    r_payload["detail"] = (f"recovered by the single repair pass at {repair_dpi} dpi "
                                           f"after: {payload.get('detail', '')[:180]}")
                    r_payload["repair_dpi"] = repair_dpi
                    stats["repairs_recovered"] = int(stats.get("repairs_recovered", 0)) + 1
                    kind, payload = "ok", r_payload
                elif kind == "ok":
                    payload["detail"] = (f"{payload.get('detail', '')} | the single repair pass at "
                                         f"{repair_dpi} dpi also failed"
                                         + (f": {r_payload.get('detail', '')}" if r_kind == "raster_failed"
                                           else ""))

            if kind == "raster_failed":
                collected.append(OcrPage(page=page, state="raster_failed",
                                         detail=str(payload.get("detail") or ""), engine=ENGINE,
                                         language_code=language))
                continue
            if kind == "timeout":
                _terminate(proc, "page deadline")
                stats["killed_at_page"] = page
                stats["kill_reason"] = f"page {page} exceeded {int(payload.get('budget', 0))} s"
                return PaddleRun(finish_pages(collected, page_list[index:], "ocr_failed",
                                              f"{ENGINE} exceeded the per-page deadline on page "
                                              f"{page}; the worker was killed and released"), stats)
            if kind == "died":
                code = _reap()
                verdict = _ceiling_verdict()
                stats["worker_died_at_page"] = page
                stats["worker_exit_code"] = code
                stats["ceiling_verdict"] = verdict
                # Same classifier as the load handshake, with the page stage so a mid-inference
                # death that is NOT resource-bound is still called an engine death.
                called = classify_worker_death(
                    code=code, verdict=verdict, detail=str(payload.get("detail") or ""),
                    ceiling_bytes=int(ceiling),
                    enforced_by_os=bool(ceiling_evidence.get("enforced_by_os")), stage="page")
                stats["death_classification"] = called
                stats["worker_death_reason"] = str(called["kind"])
                cause = f"{called['why']}; {called['note']}"
                return PaddleRun(finish_pages(collected, page_list[index:], "ocr_failed",
                                              f"the OCR worker died on page {page} ({cause}); "
                                              f"{payload.get('detail', '')}"),
                                 stats)
            collected.append(page_from(payload))
        return PaddleRun(collected, stats)
    finally:
        close_child("job end")


def _write(proc: subprocess.Popen, payload: dict[str, Any]) -> None:
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        proc.stdin.flush()
    except (OSError, ValueError, AssertionError) as exc:
        raise OcrUnavailable("engine_spawn_failed",
                             f"the OCR worker pipe is broken: {type(exc).__name__}: {exc}",
                             "the worker died early; see the recorded stderr log") from exc


def _read_event(lines: "queue.Queue[Any]", timeout_s: float) -> dict[str, Any] | None:
    """Next parsed worker event, or None on EOF. Raises TimeoutError past the budget."""
    end = time.time() + max(1.0, timeout_s)
    while True:
        left = end - time.time()
        if left <= 0:
            raise TimeoutError(f"no worker event within {int(timeout_s)} s")
        try:
            line = lines.get(timeout=min(left, 2.0))
        except queue.Empty:
            continue
        if line is None:
            return None
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value


def _tail(path: Path, limit: int = 1200) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return "no worker log was readable"
    text = data[-limit:].decode("utf-8", "replace").strip()
    return f"worker log tail: {text}" if text else "worker log was empty"
