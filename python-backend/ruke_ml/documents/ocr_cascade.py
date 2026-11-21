"""The production OCR cascade: measured selection, then primary engine, then per-unit recovery.

Every decision in here is made from a measured fact, in this order:

  1. the page/region assessment has already decided WHICH units need OCR at all (the caller
     passes exactly those units, so a native-text page never gets rasterised);
  2. the registry says which engine is actually executable here - adapter present, isolated
     runtime validated from its pinned dist-info, and BOTH pinned model snapshots complete;
  3. the device plan says where that engine's weights fit RIGHT NOW, from measured free RAM,
     measured commit headroom and measured free VRAM;
  4. only then is anything loaded, and it is loaded once, for the whole unit list.

Fallbacks are separate axes and are reported separately:
  * device fallback   Paddle on GPU -> Paddle on CPU (recorded by the adapter, not here);
  * engine fallback   Paddle -> Tesseract, only for the units the primary did not read, and
    only AFTER the primary worker has been released, because a second engine loaded while the
    first is still resident is a memory accident rather than a recovery strategy.

The recovery is part of the SAME operation as the primary attempt: one resource window, one
admission decision, one durable write. It used to run after `handoff.run_exclusive` had already
restored the main model, which made the production path and the standalone CLI two different
lifecycles and left the recovery charged against an admission that had never included it.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from ..config import runtime_dir
from ..models import provider_config, resources
from . import ocr_paddle, ocr_tesseract
from .ocr_tesseract import OcrPage

PRIMARY = "paddleocr-vl-1.6"
FALLBACK = "tesseract"

# Recognised and empty are both answers; they are NOT retried and NOT sent to the fallback.
NEEDS_RECOVERY = ("ocr_failed", "raster_failed")


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def policy() -> dict[str, Any]:
    """The operator's explicit choices, with the reason each default is what it is."""
    primary = (os.environ.get("RUKE_OCR_PRIMARY") or PRIMARY).strip().lower()
    if primary in ("", "primary", "paddle", "paddleocr", "paddleocr-vl", PRIMARY):
        primary = PRIMARY
    cfg = provider_config.load()
    return {
        "primary": primary,
        "allow_gpu": _flag("RUKE_OCR_ALLOW_GPU", False),
        "allow_gpu_default_reason": (
            "the pinned OCR runtime is the CPU build: paddle.is_compiled_with_cuda() returned "
            "False on this host (measured 2026-11-17). GPU placement becomes available by "
            "preparing a CUDA-enabled pinned build in the isolated runtime and setting "
            "RUKE_OCR_ALLOW_GPU=1; it is never enabled by borrowing the main LLM's device."),
        "allow_unload": cfg.automatic_handoff,
        "allow_unload_source": cfg.sources.get("automatic_handoff", ""),
        "allow_unload_default_reason": (
            "the coordinated handoff is the configured deployment policy, not an acceptance-script "
            "flag: it is automatic when the measured resources do not fit alongside the resident "
            "main model AND the provider answers a validated unload/load lifecycle. It is switched "
            "off with RUKE_LLM_AUTOMATIC_HANDOFF=0; the legacy per-run override "
            "RUKE_OCR_ALLOW_UNLOAD=1/0 still wins over the configured default. Unloading is never "
            "taken when the job already fits, never while a turn is running, and never against a "
            "provider whose lifecycle calls are unvalidated."),
        "source": ("primary/gpu: env(RUKE_OCR_PRIMARY/RUKE_OCR_ALLOW_GPU); handoff policy: "
                   "ruke_ml.models.provider_config (settings.json > env > .env.local > default)"),
        "provider": cfg.as_dict(),
    }


def _primary_state() -> dict[str, Any]:
    state = ocr_paddle.engine_state()
    ready = bool(state.get("ready"))
    blockers = list(state.get("blockers") or [])
    return {"engine": PRIMARY, "ready": ready, "blockers": blockers,
            "runtime": state.get("runtime") or {},
            "assets": [state.get("recognition_asset") or {}, state.get("layout_asset") or {}],
            "estimate": {k: state.get(k) for k in ("est_peak_mib", "est_peak_basis",
                                                   "est_peak_vram_mib", "est_vram_basis")}}


def run(pdf_path: str, units: Sequence[int], *, language: str, dpi: int,
        rotations: dict[int, int] | None = None,
        cancel: Callable[[], bool] | None = None,
        progress: Callable[[str, str], None] | None = None,
        deadline_at: float = 0.0,
        per_page_timeout_s: float = ocr_paddle.PER_PAGE_TIMEOUT_S,
        job_id: str = "documents.ocr",
        device_override: str = "",
        inside_handoff: bool = False,
        resume: bool = False,
        inject_failure_unit: int = 0,
        inside_window: bool = False) -> tuple[list[OcrPage], dict[str, Any]]:
    """OCR `units` with the primary engine, then recover the unread units with Tesseract.

    `device_override` is a device already chosen and admitted by a caller that owns the
    resource lease (the handoff runner). The plan is STILL recomputed here so the evidence
    stays fresh; the override only says which side of it to act on. `inside_handoff` means the
    caller already holds the exclusive lease, so this cascade must not request another one -
    a nested lease would deadlock against its own holder.
    `inside_window` is the lease holder saying "this operation actually released the main model",
    which is the only condition under which the separately configured exclusive memory ceiling may
    be claimed. A lease that involved no unload keeps the normal-operation maximum. The flag is
    separate from `inside_handoff` on purpose: holding a lease and having freed RAM are different
    facts, and a worker must never widen its own ceiling on the assumption that they travel together.
    Returns (pages, cascade_report). The report states which engine read each page, why a
    fallback happened, and what actually cost what in memory. A unit that neither engine read
    stays in the returned list as a failed unit - it is never dropped.

    `resume` (or RUKE_OCR_RESUME) reuses persisted, content-verified units instead of re-running
    an engine for them. It is OFF by default so an acceptance run always means a real engine
    execution; it exists so an interrupted window can be finished without paying for the work that
    already succeeded. `inject_failure_unit` (or RUKE_OCR_INJECT_FAILURE_PAGE) discards ONE primary
    answer inside the cascade, so the acceptance CLI and the uploaded-file path exercise the same
    recovery code instead of each carrying their own copy of it.
    """
    want = [int(u) for u in units]
    report: dict[str, Any] = {
        "cascade": {"policy": policy(), "units_requested": want,
                    "selection_note": "", "primary": {}, "fallback": {},
                    "device_plan": {}, "handoff": {}, "persisted": {}, "peaks": {}},
    }
    casc = report["cascade"]
    log = progress or (lambda state, note: None)
    inject_unit = int(inject_failure_unit or 0)

    state = _primary_state()
    casc["primary"] = state

    if policy()["primary"] != PRIMARY:
        casc["selection_note"] = (f"the operator pinned the primary engine to "
                                  f"{policy()['primary']!r}; {PRIMARY} was not attempted")
    elif not state["ready"]:
        casc["selection_note"] = ("the primary pipeline is not executable here: "
                                  + "; ".join(state["blockers"]))
    if state.get("fault"):
        # An injected fault must be visible in the evidence, not folded into an engine story.
        casc["primary"]["fault"] = state["fault"]
        casc["primary"]["fault_note"] = state.get("fault_note", "")

    # ONE map holds every engine's answer for a unit, and it exists BEFORE any engine runs. That
    # is what lets one decision - and, when a handoff is needed, ONE window - cover the whole
    # operation: primary attempt, recovery of whatever it did not read, durable write. The
    # previous shape handed the window only the primary attempt, so the Tesseract recovery ran
    # AFTER run_exclusive had already restored the main model, against an admission computed for
    # an operation that had not included the recovery engine.
    by_page: dict[int, OcrPage] = {}
    sampler = resources.PeakSampler(label="documents.ocr")
    primary_stats: dict[str, Any] = {}

    def _merge(pages: Iterable[OcrPage]) -> None:
        for page in pages:
            by_page[int(page.page)] = page

    def _attempt(want_units: list[int], device: str, *,
                 inside_window: bool = False) -> tuple[list[OcrPage], dict[str, Any]]:
        """Run the primary, converting a whole-run failure into a per-unit failure report.

        A primary that cannot run at all (spawn failure, load failure, device contradiction)
        used to escape this function and fail the whole job. That is wrong: the primary worker
        is released in the adapter's finally block, so the units it never read must still get
        recovery. The failure is recorded, then the units fall through to the engine fallback.
        """
        try:
            return _paddle_run(pdf_path, want_units, language=language, dpi=dpi,
                               rotations=rotations, cancel=cancel, progress=progress,
                               deadline_at=deadline_at,
                               per_page_timeout_s=per_page_timeout_s, job_id=job_id,
                               device=device,
                                allow_gpu=bool(casc["policy"]["allow_gpu"]),
                                inside_window=inside_window)
        except ocr_tesseract.OcrUnavailable as exc:
            casc["primary"]["run_refused"] = (f"{exc.kind}: {exc}"
                                              + (f" | next step: {exc.human_step}"
                                                 if exc.human_step else ""))
            log("ocr", f"primary engine failed as a whole run: {exc.kind}")
            return [], {"whole_run_failure": exc.kind}
        except Exception as exc:                            # noqa: BLE001
            # An unexpected adapter error used to escape here and fail the whole job: the units the
            # primary had already read were lost, recovery never ran, and nothing was persisted.
            # The adapter still releases its worker in its own finally block, so the honest answer
            # is a recorded whole-run failure plus per-unit recovery, with the traceback attached.
            casc["primary"]["run_refused"] = f"adapter_crash: {type(exc).__name__}: {exc}"
            casc["primary"]["adapter_traceback"] = traceback.format_exc(limit=8)
            log("ocr", f"primary adapter raised {type(exc).__name__}: recovering per unit instead")
            return [], {"whole_run_failure": "adapter_crash"}

    def _inject_fault() -> None:
        """Discard one PRIMARY answer on purpose, before recovery, so the fallback is exercised.

        The standalone acceptance CLI used to do this by reaching back into Tesseract by hand,
        which is a second copy of the recovery path and therefore evidence about the copy rather
        than about production. Now both the CLI and the uploaded-file path ask the cascade for it.
        """
        page = by_page.get(inject_unit)
        if page is None or page.engine != PRIMARY or page.state not in ("recognised", "empty"):
            return
        page.state, page.text = "ocr_failed", ""
        page.lines = []
        page.detail = ("injected fault: the primary result for this unit was discarded by the "
                       "operator so the engine fallback path would execute on a real page")
        casc["primary"]["injected_failure_unit"] = inject_unit
        log("fault_injected", f"unit {inject_unit}: the primary result was discarded by the "
                              "operator; Tesseract recovery now runs for real on it")

    def _recover() -> list[int]:
        """Engine fallback, one engine at a time, only for units that still need it.

        The primary worker is ALWAYS released first: `_paddle_run` closes it inside its adapter's
        own finally block, and the window path releases the engine before the model is restored.
        Loading a second engine while the first is still resident is a memory accident, not a
        recovery strategy.
        """
        cancelled = bool(cancel and cancel())
        pending = [u for u in want
                   if u not in by_page or (by_page[u].state in NEEDS_RECOVERY and not cancelled)]
        if cancelled:
            casc["fallback"] = {"skipped": "the job was cancelled; no fallback was attempted",
                                "attempted": []}
            return []
        if not pending:
            casc["fallback"] = {"attempted": [], "note": "the primary engine read every requested unit"}
            return []
        reason = ("the primary engine did not read "
                  + ",".join(str(u) for u in pending))
        if casc["primary"].get("run_refused"):
            reason = str(casc["primary"]["run_refused"])
        elif not state["ready"]:
            reason = "primary pipeline unavailable: " + "; ".join(state["blockers"])
        if state.get("fault"):
            note = str(state.get("fault_note") or f"fault-injected: {state['fault']}")
            reason = f"{reason} | {note}"
        if inject_unit and inject_unit in pending:
            reason = f"{reason} | unit {inject_unit} was fault-injected by the operator"
        casc["fallback"] = {"reason": reason, "attempted": pending,
                            "fidelity_note": ("Tesseract recovery does NOT claim equivalent "
                                              "table, formula or layout fidelity; the affected "
                                              "pages are labelled with the engine that read them")}
        log("ocr", f"Tesseract recovery for {len(pending)} unit(s): {reason}")
        sampler.stage("fallback")
        try:
            fb_pages = ocr_tesseract.ocr_pdf_pages(
                pdf_path, pending, language=language, dpi=dpi, rotations=rotations,
                cancel=cancel, progress=progress)
            casc["fallback"]["ran"] = True
            for page in fb_pages:
                page.detail = (f"recovery after primary failure: {page.detail}".strip()[:1000])
            _merge(fb_pages)
            casc["fallback"]["recognized"] = sum(1 for p in fb_pages if p.state == "recognised")
            casc["fallback"]["states"] = {str(p.page): p.state for p in fb_pages}
        except ocr_tesseract.OcrUnavailable as exc:
            casc["fallback"]["failed"] = {"kind": exc.kind, "detail": str(exc),
                                          "human_step": exc.human_step}
        casc["fallback"]["peak"] = sampler.stage_peak("fallback")
        return pending

    def _persist() -> dict[str, Any]:
        """Write what the engines ACTUALLY produced, while the window is still held.

        This used to be a comment saying "persist before restoration" plus an in-memory counter.
        Nothing durable existed, so a failed model restore destroyed the only copy of minutes of
        recognition and a later recovery had nothing to reuse and re-ran the engines.
        """
        casc["peaks"] = {"primary_worker_child": _engine_child_peak(primary_stats),
                         "owned_tree": sampler.overall()}
        info = _write_result(pdf_path, want, language=language, dpi=dpi, rotations=rotations,
                             pages=by_page, casc=casc, job_id=job_id)
        casc["persisted"] = info
        if not info.get("ok"):
            log("ocr", f"the OCR result could NOT be persisted: {info.get('detail', '')}")
        return info

    def _account(saved: dict[str, Any], device_hint: str) -> dict[str, Any]:
        """The ONE operation account, written by whichever path actually did the work.

        Both lifecycles — the windowed `_operation` and the outer path where the primary attempt
        was skipped before any operation ran (pipeline unavailable, policy off, or simply no
        primary runtime on this machine) — must report the same numbers about identical work.
        F73 measured the drift: a skipped-primary run persisted its recovered unit but left the
        caller reading persisted_path "" / units_persisted 0, because only `_operation` wrote
        this account.
        """
        return {"peak": _operation_peak(sampler, primary_stats),
                "persisted_path": str(saved.get("path", "")),
                "units_persisted": int(saved.get("units_persisted", 0) or 0),
                "device_used": str(primary_stats.get("device_used") or device_hint),
                "device_echo": primary_stats.get("device_echo", {}),
                "pages": len(by_page),
                "recognised": sum(1 for p in by_page.values() if p.state == "recognised"),
                "unresolved": [u for u in want
                               if u in by_page
                               and by_page[u].state not in ("recognised", "empty")]}

    def _operation(device: str, *, inside_window: bool = False) -> dict[str, Any]:
        """The one operation a resource window wraps: primary, recovery, durable write.

        Identical code whether or not a window was needed, which is the point: production and the
        acceptance CLI can no longer drift into two different lifecycles.
        """
        casc["resource_window"] = {
            "inside_window": bool(inside_window),
            "basis": ("this operation released the main model, so the separately configured "
                      "exclusive ceiling applies" if inside_window else
                      "no coordinated unload happened for this operation, so the normal-operation "
                      "maximum still applies in full"),
        }
        sampler.start()
        sampler.stage("primary")
        try:
            pages, stats = _attempt(want, device, inside_window=inside_window)
            primary_stats.update(stats)
            casc["primary"]["run"] = stats
            _merge(pages)
            if inject_unit:
                _inject_fault()
            _recover()
        finally:
            sampler.stop()
        saved = _persist()
        out = _account(saved, device)
        # Recorded whether or not a lease was needed, so the caller that DOES own the window (the
        # acceptance CLI) reports the same evidence as the path that takes one here. Without this
        # the two lifecycles would report different numbers about identical work.
        casc["operation"] = out
        return out

    # Reuse durable evidence before spending compute on reproducing it. Off by default so an
    # acceptance run always means a real engine execution; turned on by RUKE_OCR_RESUME or
    # --resume-results when recovering from an interrupted window.
    resumed = False
    if resume or _flag("RUKE_OCR_RESUME", False):
        saved = _read_result(pdf_path, want, language=language, dpi=dpi, rotations=rotations)
        for rec in saved.get("units") or []:
            page = _page_from_record(rec)
            if page is not None:
                by_page[page.page] = page
        if saved.get("usable") and all(u in by_page for u in want):
            resumed = True
            casc["resumed_from"] = str(saved.get("path", ""))
            casc["peaks"] = saved.get("peaks") or {}
            casc["selection_note"] = (
                f"reused {len(by_page)} persisted unit(s) from {saved.get('path', '')}: no engine "
                "was re-run for them (RUKE_OCR_RESUME / --resume-results)")
            log("ocr", f"reused {len(by_page)} persisted unit(s); no engine was started")
        elif saved.get("path"):
            casc["resume_rejected"] = str(saved.get("detail", ""))
            log("ocr", f"persisted result not reusable: {saved.get('detail', '')}")

    if not resumed and policy()["primary"] == PRIMARY and state["ready"]:
        est = ocr_paddle.estimate()
        from ..models import devices, main_model
        snapshot = main_model.snapshot()
        plan = devices.device_plan(
            "documents.ocr", est_peak_mib=int(est["est_peak_mib"]),
            est_peak_vram_mib=int(est["est_peak_vram_mib"]),
            est_basis=str(est["est_peak_basis"]), est_vram_basis=str(est["est_vram_basis"]),
            allow_gpu=bool(casc["policy"]["allow_gpu"]), main_model=snapshot)
        casc["device_plan"] = plan.as_dict()

        if device_override in ("cpu", "gpu"):
            plan = devices.DevicePlan(
                "documents.ocr", device_override, True, False,
                f"device {device_override!r} was chosen by the lease holder; the plan "
                f"recomputed inside the window says {plan.device!r}", plan.evidence)
            casc["device_plan"] = plan.as_dict()
            casc["inside_handoff"] = bool(inside_handoff)

        if (not plan.fits and casc["policy"]["allow_unload"] and not inside_handoff
                and snapshot.get("loaded")):
            from .. import handoff
            log("handoff", "resources do not fit alongside the main model: requesting the "
                           "exclusive handoff for the whole OCR operation, recovery included")
            handoff_out: dict[str, Any] = handoff.run_exclusive(
                "documents.ocr",
                lambda payload: _operation(
                    str(payload.get("device") or "cpu"),
                    # The lease holder states whether IT released the model, so the exclusive
                    # ceiling is claimed only when RAM was actually freed by this operation.
                    inside_window=bool(payload.get("main_model_unloaded_by_us"))),
                est_peak_mib=int(est["est_peak_mib"]),
                est_peak_vram_mib=int(est["est_peak_vram_mib"]),
                est_basis=str(est["est_peak_basis"]), est_vram_basis=str(est["est_vram_basis"]),
                allow_gpu=bool(casc["policy"]["allow_gpu"]), allow_unload=True,
                owner=job_id, progress=log)
            casc["handoff"] = handoff_out
            after = handoff_out.get("plan_after_unload") or handoff_out.get("plan") or {}
            casc["device_plan"] = after
            casc["handoff_work_peak"] = handoff_out.get("work_peak") or {}
            if not by_page and handoff_out.get("reason"):
                casc["primary"]["run_refused"] = (f"{handoff_out['reason']}: "
                                                  f"{handoff_out.get('detail', '')}")
        elif not plan.fits:
            casc["primary"]["run_refused"] = (
                f"resource_limit: {plan.reason}; the exclusive handoff was not requested "
                f"(allow_unload={bool(casc['policy']['allow_unload'])})")
        elif plan.device not in ("gpu", "cpu"):
            casc["selection_note"] = (casc["selection_note"] or
                                      "the device plan placed this job on neither device")
        else:
            # It fits where everything already is, so the SAME operation runs with no lease held:
            # a lease is only worth taking when the unload decision is actually in play.
            # `_operation` records its own evidence in the report, so the return value is not
            # threaded through a second reporting channel here.
            # `inside_window` here is only ever True when an outer caller (the handoff CLI) owns
            # the lease AND released the main model for it; in that case this cascade recomputed
            # a plan but the RAM freeing happened outside it, so the caller's word is the evidence.
            _operation(plan.device, inside_window=bool(inside_window))

    if not casc["fallback"]:
        # The primary never ran inside a window: the pipeline is unavailable, admission refused
        # it, the handoff was not granted, or the plan placed it on no device. The primary worker
        # is still released, because its adapter closes it in its own finally block, so recovery
        # runs here with nothing heavy resident and no lease to hold. The sampler starts here too:
        # the recovery engine really ran, so its peak gets measured rather than left UNKNOWN —
        # F73 measured this path reporting zero usable samples for real recovery work.
        sampler.start()
        try:
            _recover()
        finally:
            sampler.stop()
    # A run that only reused persisted units has no new engine evidence to add, and rewriting the
    # record with THIS run's near-empty peaks would destroy the measurement the engines actually
    # produced. It writes again only if this run really did engine work.
    resumed_only = bool(resumed) and not (casc.get("fallback") or {}).get("attempted")
    if not casc.get("persisted") and not resumed_only:
        _persist()
    if not casc.get("operation"):
        # The primary attempt was skipped before any operation ran, yet this path still did
        # real work (recovery, and the durable write above) or genuinely reused a persisted
        # record. Write the SAME account `_operation` writes, or its caller reports a blank
        # run for work that actually happened. An empty device_used is the honest answer
        # when no engine ran at all (a pure resumed run): nothing executed on any device.
        casc["operation"] = _account(
            casc.get("persisted") or {},
            "cpu" if (casc.get("fallback") or {}).get("attempted") else "")

    ordered = [by_page[u] for u in want if u in by_page]
    for u in want:
        if u not in by_page:
            ordered.append(OcrPage(page=u, state="skipped",
                                   detail="no engine produced a result for this unit",
                                   engine="none", language_code=language))
    # "none" is the marker for a unit no engine produced, not an engine that ran.
    casc["engines_used"] = sorted({p.engine for p in ordered if p.engine and p.engine != "none"})
    casc["units_read"] = sum(1 for p in ordered if p.state in ("recognised", "empty"))
    # "skipped" here means NO engine produced any result for the unit, which is just as
    # unresolved as an explicit failure - reporting it as resolved would overstate coverage.
    casc["units_unresolved"] = [p.page for p in ordered if p.state not in ("recognised", "empty")]
    casc["units_not_read"] = [p.page for p in ordered if p.state == "skipped"]
    return ordered, report


def _engine_child_peak(stats: dict[str, Any]) -> dict[str, Any]:
    """The primary adapter's own child-tree peaks, with an unmeasured peak kept unmeasured."""
    if not stats:
        return {"measured": False, "working_set_mib": None, "commit_mib": None,
                "note": "the primary engine never ran, so it has no measured peak"}
    samples = int(stats.get("samples_available") or stats.get("samples") or 0)
    raw_resident = stats.get("peak_working_set_mib")
    raw_commit = stats.get("peak_commit_mib")
    # Two independent reasons a quantity is not a measurement: no usable sample, and the
    # adapter reporting the quantity as unknown (None). Either one makes it unknown here, so
    # an unmeasured peak can never reach a report as a 0.
    resident = (int(raw_resident) if samples and raw_resident is not None else None)
    commit = (int(raw_commit) if samples and raw_commit is not None else None)
    out: dict[str, Any] = {"working_set_mib": resident,
                           "commit_mib": commit,
                           "samples": samples,
                           "measured": bool((resident or 0) or (commit or 0)),
                           "definition": str(stats.get("peak_basis") or ""),
                           "device_used": str(stats.get("device_used") or "")}
    if not out["measured"]:
        out["note"] = ("the adapter recorded no usable memory sample, so this engine's peak is "
                       "UNKNOWN and is reported as unknown rather than as zero")
    return out


def _operation_peak(sampler: resources.PeakSampler, stats: dict[str, Any]) -> dict[str, Any]:
    """What the operation actually cost, for the window's `work_peak` evidence.

    The adapter's child-tree peak and this process's owned-tree peak are different quantities.
    The window is charged the larger of the two, and neither one uses 0 as a stand-in for unknown.
    """
    tree = sampler.overall()
    child = _engine_child_peak(stats)
    resident = [v for v in (tree.get("working_set_mib"), child.get("working_set_mib"))
                if isinstance(v, int) and v > 0]
    commit = [v for v in (tree.get("commit_mib"), child.get("commit_mib"))
              if isinstance(v, int) and v > 0]
    return {"working_set_mib": max(resident) if resident else None,
            "commit_mib": max(commit) if commit else None,
            "measured": bool(resident or commit),
            "components": {"primary_worker_child": child, "owned_tree": tree},
            "definition": ("maximum of the primary adapter's child-tree peak and this process's "
                           "owned-tree peak; both engines and the rasterizer sit inside the "
                           "owned tree")}


RESULT_SCHEMA = "ruke.ocr-result.v1"
RESULT_DIR_ENV = "RUKE_OCR_RESULT_DIR"
# Hashing a source larger than this uses its head and tail instead of every byte, and SAYS so.
RESULT_HASH_CAP_BYTES = 512 << 20


def _result_dir() -> Path:
    raw = os.environ.get(RESULT_DIR_ENV, "").strip()
    return Path(raw) if raw else runtime_dir() / "ocr-results"


def _identity_core(identity: dict[str, Any]) -> dict[str, Any]:
    """The part of a source identity that staleness is judged on.

    mtime is deliberately excluded: touching a file does not change its content, and rejecting a
    reusable result over a timestamp would re-run minutes of recognition for no reason.
    """
    return {k: identity.get(k) for k in ("sha256", "size_bytes", "hash_basis")}


def _source_identity(pdf_path: str) -> dict[str, Any]:
    """Content identity for a source file. A path name is not identity.

    Above RESULT_HASH_CAP_BYTES only the first and last 8 MiB are hashed, because otherwise
    persistence would put an unbounded read on the critical path. The shortcut is recorded in
    `hash_basis`, so anything reading this record knows exactly what was compared.
    """
    out: dict[str, Any] = {"ok": False, "identity": {}, "detail": ""}
    try:
        size = int(os.path.getsize(pdf_path))
        modified = int(os.stat(pdf_path).st_mtime_ns)
        h = hashlib.sha256()
        with open(pdf_path, "rb") as fh:
            if size <= RESULT_HASH_CAP_BYTES:
                for block in iter(lambda: fh.read(1 << 20), b""):
                    h.update(block)
                basis = f"sha256 over all {size} bytes"
            else:
                head = fh.read(8 << 20)
                fh.seek(max(0, size - (8 << 20)))
                tail = fh.read(8 << 20)
                h.update(head)
                h.update(tail)
                basis = (f"sha256 over the first and last 8 MiB of a {size} byte file (over the "
                         f"{RESULT_HASH_CAP_BYTES} byte cap), so a change confined to the middle "
                         "of the file is NOT detected by this identity")
        out["identity"] = {"sha256": h.hexdigest(), "size_bytes": size, "hash_basis": basis,
                           "modified_ns": modified}
        out["ok"] = True
    except OSError as exc:
        out["detail"] = (f"the source could not be read to establish its identity: "
                         f"{type(exc).__name__}: {exc}")
    return out


def _result_key(pdf_path: str, units: Sequence[int], *, language: str, dpi: int,
                rotations: dict[int, int] | None) -> dict[str, Any]:
    """Key the persisted result by what it is an answer ABOUT, not by where the file sits.

    Reusing a result is only correct for the same content and the same request, so both are inside
    the key. Anything that would change the answer (units, language, dpi, rotations) makes a new key.
    """
    ident = _source_identity(pdf_path)
    if not ident["ok"]:
        return {"ok": False, "detail": ident["detail"]}
    request = {
        "schema": RESULT_SCHEMA,
        "engine": PRIMARY,
        "source": ident["identity"],
        "units": sorted({int(u) for u in units}),
        "language": (language or "").strip().lower(),
        "dpi": int(dpi),
        "rotations": [[int(k), int(v)] for k, v in sorted((rotations or {}).items())],
    }
    blob = json.dumps(request, sort_keys=True).encode("utf-8")
    return {"ok": True, "key": hashlib.sha256(blob).hexdigest(), "request": request,
            "identity": ident["identity"]}


def _result_path(key: str) -> Path:
    return _result_dir() / f"{key}.json"


def _write_result(pdf_path: str, want: list[int], *, language: str, dpi: int,
                  rotations: dict[int, int] | None, pages: dict[int, OcrPage],
                  casc: dict[str, Any], job_id: str) -> dict[str, Any]:
    """Durably write what the engines ACTUALLY produced, before any model is restored.

    A model restore can fail. Anything held only in this process's memory is then gone, the next
    attempt has nothing to reuse, and a later recovery re-runs minutes of recognition - which is
    exactly what the previous version of this file promised it would not do. Never raises: a write
    failure is reported, and the caller decides what to say about it.
    """
    keyed = _result_key(pdf_path, want, language=language, dpi=dpi, rotations=rotations)
    unresolved = [u for u in want
                  if u not in pages or pages[u].state not in ("recognised", "empty")]
    # The record's own coverage and engines are derived HERE, from the units this write is about,
    # not read back off `casc`. `casc["engines_used"]`/`["units_read"]` are only computed at the
    # very end of run(), long after _persist has written this record — F73's frozen D1 scorer
    # caught every durable record declaring coverage.read 0 and engines_used [] while storing
    # units a real engine had recognised. A record must describe itself truthfully.
    read = sum(1 for u in want if u in pages and pages[u].state in ("recognised", "empty"))
    engines_used = sorted({p.engine for p in pages.values() if p.engine and p.engine != "none"})
    if not keyed.get("ok"):
        return {"ok": False, "path": "", "units_persisted": 0, "units_unresolved": unresolved,
                "reusable_when_resuming": 0, "detail": str(keyed.get("detail", ""))}
    path = _result_path(str(keyed["key"]))
    fallback = casc.get("fallback") or {}
    primary = casc.get("primary") or {}
    payload = {
        "schema": RESULT_SCHEMA,
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "job_id": job_id,
        "source": keyed["identity"],
        "request": keyed["request"],
        "pipeline": {"primary_engine": PRIMARY,
                     "engines_used": engines_used,
                     "policy": casc.get("policy") or {},
                     "device_plan": casc.get("device_plan") or {},
                     "handoff": casc.get("handoff") or {},
                     "fallback_ran": bool(fallback.get("ran")),
                     "fallback_reason": str(fallback.get("reason") or ""),
                     "selection_note": str(casc.get("selection_note") or "")},
        "peaks": casc.get("peaks") or {},
        "units": [pages[u].to_dict() for u in sorted(pages)],
        "coverage": {"requested": len(want),
                     "read": read,
                     "unresolved": unresolved,
                     "complete": not unresolved},
        "limitations": {
            "unresolved_units": unresolved,
            "fallback_fidelity": str(fallback.get("fidelity_note") or ""),
            "fallback_failed": fallback.get("failed") or None,
            "primary_run_refused": str(primary.get("run_refused") or ""),
            "primary_fault": str(primary.get("fault") or ""),
            "engine_reported_confidence": (
                "a unit's confidence is the engine's own report, not a calibrated probability; "
                "extraction accuracy is measured only by the frozen quality corpus"),
        },
    }
    try:
        directory = _result_dir()
        directory.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(payload, sort_keys=True, ensure_ascii=False))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError as exc:
        return {"ok": False, "path": str(path), "units_persisted": 0,
                "units_unresolved": unresolved, "reusable_when_resuming": 0,
                "detail": (f"the extracted result could NOT be written to {path}: "
                           f"{type(exc).__name__}: {exc}")}
    reusable = sum(1 for u in want
                   if u in pages and pages[u].state in ("recognised", "empty"))
    return {"ok": True, "path": str(path), "units_persisted": len(payload["units"]),
            "units_unresolved": unresolved, "reusable_when_resuming": reusable,
            "detail": (f"wrote {len(payload['units'])} unit(s) to {path}; {reusable} reusable by a "
                       f"resume; {len(unresolved)} still unresolved")}


def _read_result(pdf_path: str, want: Sequence[int], *, language: str, dpi: int,
                 rotations: dict[int, int] | None) -> dict[str, Any]:
    """Read a persisted result. ABSENT, UNREADABLE, MALFORMED and STALE are four different answers.

    Treating a corrupt record as "nothing persisted" would silently re-run engines and hide the
    corruption; treating it as usable would replay garbage as an answer. Neither is acceptable, so
    each case says which action it justifies.
    """
    out: dict[str, Any] = {"usable": False, "absent": False, "path": "", "units": [], "peaks": {},
                           "detail": ""}
    keyed = _result_key(pdf_path, want, language=language, dpi=dpi, rotations=rotations)
    if not keyed.get("ok"):
        out["detail"] = str(keyed.get("detail", ""))
        return out
    path = _result_path(str(keyed["key"]))
    out["path"] = str(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        out["absent"] = True
        out["detail"] = "no persisted result exists for this source content and request"
        return out
    except (OSError, UnicodeDecodeError) as exc:
        out["detail"] = (f"the persisted result is unreadable, so it was NOT reused: "
                         f"{type(exc).__name__}: {exc}")
        return out
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError(f"the record is a {type(data).__name__}, not an object")
        if data.get("schema") != RESULT_SCHEMA:
            out["detail"] = (f"the persisted record declares schema {data.get('schema')!r}, not "
                             f"{RESULT_SCHEMA!r}, so it was NOT reused")
            return out
    except (ValueError, TypeError) as exc:
        out["detail"] = (f"the persisted result is malformed, so it was NOT reused: "
                         f"{type(exc).__name__}: {exc}")
        return out
    stored_source = data.get("source")
    if not isinstance(stored_source, dict) or _identity_core(stored_source) != _identity_core(
            keyed["identity"]):
        out["detail"] = ("the source content differs from the content this result describes, so the "
                         "persisted units are STALE and were NOT reused")
        return out
    if data.get("request") != keyed["request"]:
        out["detail"] = ("the persisted result was written for a different request (units, "
                         "language, dpi or rotations), so it was NOT reused")
        return out
    units = [u for u in (data.get("units") or []) if isinstance(u, dict)]
    peaks = data.get("peaks")
    out["units"] = units
    out["peaks"] = peaks if isinstance(peaks, dict) else {}
    out["usable"] = bool(units)
    out["detail"] = (f"{len(units)} persisted unit(s) available for reuse" if units
                     else "the persisted record exists but holds no units")
    return out


def _page_from_record(rec: dict[str, Any]) -> OcrPage | None:
    """Rebuild one reusable unit. A unit that FAILED is never replayed as an answer.

    Only a real answer (recognised, or a measured empty page) is reusable. Keys the record holds
    that OcrPage does not - such as the `provenance` marker written by to_dict() - are dropped by
    construction, because the fields are read explicitly rather than splatted.
    """
    state = str(rec.get("state") or "")
    if state not in ("recognised", "empty"):
        return None
    try:
        page_no = int(rec.get("page", 0))
    except (TypeError, ValueError):
        return None
    if page_no <= 0:
        return None
    conf = rec.get("confidence")
    prior = str(rec.get("detail") or "")
    return OcrPage(
        page=page_no,
        state=state,
        text=str(rec.get("text") or ""),
        detail=("reused from the persisted OCR result; no engine was re-run for this unit "
                + (f" | original: {prior}" if prior else ""))[:1200],
        confidence=float(conf) if isinstance(conf, (int, float)) else None,
        lines=[ln for ln in (rec.get("lines") or []) if isinstance(ln, dict)],
        raster=rec.get("raster") if isinstance(rec.get("raster"), dict) else {},
        engine=str(rec.get("engine") or ""),
        language_code=str(rec.get("language_code") or ""),
    )


def _paddle_run(pdf_path: str, want: list[int], *, language: str, dpi: int,
                rotations: dict[int, int] | None, cancel: Any, progress: Any,
                deadline_at: float, per_page_timeout_s: float, job_id: str,
                device: str, allow_gpu: bool,
                inside_window: bool = False) -> tuple[list[OcrPage], dict[str, Any]]:
    """One primary worker for the whole unit list, released before this function returns."""
    run = ocr_paddle.ocr_pdf_pages(
        pdf_path, want, language=language, device=device, dpi=dpi, rotations=rotations,
        cancel=cancel, progress=progress, per_page_timeout_s=per_page_timeout_s,
        deadline_at=deadline_at, job_id=job_id, allow_gpu=allow_gpu,
        inside_window=inside_window)
    stats = dict(run.stats)
    stats["states"] = {str(p.page): p.state for p in run.pages}
    return list(run.pages), stats


def status_report() -> dict[str, Any]:
    """One JSON readiness answer an operator (or an acceptance wrapper) can print and act on.

    It answers only what is knowable WITHOUT loading a model: which engine the policy pins,
    whether that engine's runtime and pinned snapshots are complete, what the recovery engine
    can actually do here, and the declared peak costs the device plan will be built from.
    It is deliberately not a quality claim.
    """
    tess = ocr_tesseract.ocr_status()
    return {
        "policy": policy(),
        "primary": _primary_state(),
        "primary_engine": ocr_paddle.engine_state(),
        "recovery": tess,
        "rasterizer": ocr_tesseract.rasterizer_state(),
        "recovery_languages": tess.get("languages") or tess.get("langs") or [],
    }


def main(argv: list[str] | None = None) -> int:
    report = status_report()
    print(json.dumps(report, indent=1, sort_keys=True, ensure_ascii=False))
    # Non-zero when the PRIMARY engine could not run here, so a wrapper can branch on it
    # without inventing its own readiness test. Recovery being available is not a pass.
    return 0 if report["primary"]["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
