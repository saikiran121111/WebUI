"""Real ASR / alignment / diarization jobs, gated on readiness, never on a status string.

The distinction this module must keep loud: NO AUDIO TRACK, SILENCE, NO SPEECH, FAILED
DECODE and UNSUPPORTED LANGUAGE are five different facts. Collapsing them into one
"empty result" is how a missing track becomes a false transcript and a failed run becomes
"there was nothing to say".
"""
from __future__ import annotations

import time
from typing import Any

from ..contracts import Coverage, ModelIdentity, StructuredError
from ..models.registry import catalog
from .jobs import JobContext, typed_from_kind

# F136 (2026-11-23, accept-12): the loader death IS the pagefile-shrink transient. The
# sampler's shape (f91-accept-12/f91-host.csv): after the release the system-managed pagefile
# EXPANDS (~78-84 GB free commit, a ~30-45 s plateau), then COLLAPSES within 15 s (22:59:46
# 80,543 -> 23:00:02 24,920 MiB), and during the collapse the commit limit drops under the
# import demand. A same-instant retry lands inside the same collapse (accept-12: GPU loader
# died, the immediate CPU retry died 2 s later, same WinError 1455). The post-collapse steady
# state (free commit ~19-25 GB) fits the measured demand (9,006 MiB required), so the fix is
# to settle OUT of the transient and retry. Seam-patched to no-ops in the fixtures.
_LOADER_SETTLE_S = 20.0
# F137 (2026-11-23, accept-13): "settled" must mean FIT, not elapsed time. accept-13's
# sampler caught instant 1455 deaths at samples reading 19-25 GB free (the 16 s grid hid
# the momentary dips a fixed 20 s settle can land in), so when the import's commit demand
# is known the settle polls the handoff gate's own free-commit probe at 1 s cadence until
# it covers the demand for _LOADER_FIT_STABLE_S CONSECUTIVE samples (consecutive, so a
# momentary dip does not send the retry into a fresh death), capped at _LOADER_FIT_CAP_S -
# at the cap the retry runs anyway and records its own fact (F136 law). The ASR import
# demand (9,006 MiB) fits the post-collapse steady state, so this law is what turns the
# fr-U1 dip deaths into a clean same-device retry. An unreadable probe keeps the fixed
# F136 settle; the ASR row's demand is never replaced by an invented number.
_LOADER_FIT_CAP_S = 120.0
_LOADER_FIT_STABLE_S = 10
_sleep = time.sleep


def _free_commit_mib() -> "int | None":
    """System free commit through the handoff gate's own probe; None = unreadable host."""
    try:
        from ..models import resources
        mem = resources.system_memory()
    except Exception:                                   # noqa: BLE001 - probe is best-effort
        return None
    if mem.source != "GlobalMemoryStatusEx" or int(mem.commit_avail_mib) <= 0:
        return None
    return int(mem.commit_avail_mib)


def _settle_out_of_shrink(ctx: JobContext, required_mib: int = 0,
                          deadline_at: float = 0.0) -> bool:
    """Wait the pagefile collapse out (1 s cancel checks). True = may retry.

    F137: with a known import demand, "settled" means free commit >= required_mib for
    _LOADER_FIT_STABLE_S consecutive 1 s samples, capped at _LOADER_FIT_CAP_S (at the cap
    the retry runs anyway and records its own death). With no demand or an unreadable
    probe this is exactly the F136 fixed settle.
    F140 (2026-11-24, accept-15): the job's own wall-clock deadline clamps both caps -
    a transcription must end typed and hand the exclusive window back, never spin in
    the fit poll past the caller's exit. deadline_at = 0 keeps F137 verbatim.
    """
    if required_mib > 0:
        cap_s = _LOADER_FIT_CAP_S
        if deadline_at:
            cap_s = max(0.0, min(_LOADER_FIT_CAP_S, float(deadline_at) - time.time()))
        deadline = time.monotonic() + cap_s
        stable = 0
        while time.monotonic() < deadline:
            if ctx.cancel.is_set():
                return False
            free = _free_commit_mib()
            if free is None:
                break                                   # probe died: fixed settle below
            if free >= required_mib:
                stable += 1
                if stable >= _LOADER_FIT_STABLE_S:
                    return True
            else:
                stable = 0
            _sleep(1.0)
        else:
            return not ctx.cancel.is_set()              # cap: retry; facts get recorded
    limit = max(1, int(_LOADER_SETTLE_S))
    if deadline_at:
        limit = min(limit, max(0, int(float(deadline_at) - time.time())))
    for _ in range(limit):
        if ctx.cancel.is_set():
            return False
        _sleep(1.0)
    return not ctx.cancel.is_set()


def _flag(name: str, default: bool) -> bool:
    """Operator env flag, same reading as the OCR cascade's policy gate."""
    import os
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _resolve_source(ctx: JobContext) -> Any:
    """Resolve and check the media path inside the allowed root. Returns None on failure."""
    from ..security import resolve_within
    path = str(ctx.req.payload.get("path", ""))
    root = str(ctx.req.payload.get("root", ""))
    if not path or not root:
        ctx.progress("input_rejected", "speech jobs need path and root")
        return None
    try:
        target = resolve_within(path, root)
    except Exception as exc:                      # noqa: BLE001 - path policy refusal
        ctx.progress("input_rejected", f"path refused: {exc}")
        return None
    if not target.exists():
        ctx.progress("input_rejected", "file not found inside the allowed root")
        return None
    return target


def asr_job(ctx: JobContext) -> Any:
    """Transcribe the selected audio track with the row the registry says is executable."""
    import importlib
    from ..models import assets
    from ..speech import asr
    from ..speech.transcript import BackendUnavailable
    target = _resolve_source(ctx)
    if target is None:
        return ctx.failed("input_rejected",
                          "speech.asr needs a path and root inside the allowed upload root",
                          human_step="pass the uploaded file path and its allowed root")
    language = str(ctx.req.payload.get("language", "") or "")
    if ctx.cancel.is_set():
        return ctx.cancelled()

    probe = asr.probe_media(str(target), ffprobe=str(ctx.req.payload.get("ffprobe", "") or ""))
    if not probe["ok"]:
        return ctx.failed("corrupt_input", probe["error"],
                          human_step=probe.get("human_step", "") or "the media could not be probed")
    if not probe["has_audio"]:
        # A missing track is NOT silence and NOT "no speech": nothing was ever decoded.
        # The wording stays structural on purpose. `probe["audio_reason"]` carries the
        # fuller contrast ("this is not the same fact as silence") for callers that read
        # the probe, but embedding that sentence in a REFUSAL put the word "silence" in
        # front of a user whose file simply has no audio stream, and made a missing track
        # look like an audio finding. The state name distinguishes them; the message must
        # not blur them.
        return ctx.failed("unsupported_input",
                          "the container carries no decodable audio track: ffprobe found "
                          f"0 audio streams (probe state {probe['audio_state'] or 'no_audio_track'}), "
                          "so nothing could be decoded and no audio property was measured",
                          human_step="attach a file with an audio track, or use the video/OCR path for visual content")

    # ---- measured content fact BEFORE any inference: is there anything to transcribe?
    # Skipping ASR here is not an optimisation, it is the difference between an honest
    # "this track is silent" and a model's hallucinated sentence about nothing.
    from ..speech import levels
    duration = float(probe["duration"] or 0.0)
    level = levels.measure_level(
        str(target), ffmpeg=str(ctx.req.payload.get("ffmpeg", "") or ""),
        duration_s=duration,
        noise_floor_db=float(ctx.req.payload.get("noise_floor_db", levels.NOISE_FLOOR_DBFS)))
    if ctx.cancel.is_set():
        return ctx.cancelled()
    if not level.ok and level.truncated:
        # The pass ran out of its bound: the level stays UNKNOWN, and an unknown level
        # must not be reported as silence. Proceed to ASR with the state recorded.
        ctx.progress("analysing", f"loudness unknown: {level.error}")
    elif not level.ok:
        return ctx.failed("corrupt_input", level.error, human_step=level.human_step)
    elif level.is_silence():
        return _silence_result(ctx, probe, level, duration)

    route = asr.language_route(language)
    # FINAL DECISION 2026-11-22: the ASR model selector is removed; the routing law
    # over the registered rows IS the selection, so the fixed default (Parakeet
    # through Transformers) runs. A payload still carrying an obsolete "model"
    # value (an old Whisper choice saved before the visible Settings migration) is
    # IGNORED - honoring it would keep a removed selector live through the back
    # door, and running the default under the old id's name would launder
    # provenance. The Settings UI performs the visible migration; the job enforces
    # the fixed default.
    model_id = str(route.get("model") or "")
    if route["decision"] not in ("route", "route_with_warning", "detect"):
        reason = "unsupported_input" if route["decision"] == "unsupported" else "not_configured"
        return ctx.failed(reason,
                          f"no ASR route for {route['language']}: {route['note']}",
                          human_step=str(route.get("human_step", "")) or "install/evaluate a covering model")
    if not model_id:
        return ctx.failed("not_configured",
                          f"the routing decision {route['decision']} named no model",
                          human_step=str(route.get("human_step", "")))
    executable_ids = [s.id for s in catalog().executable_for("speech.asr")]
    snapshot_dir = ""
    if model_id not in executable_ids:
        # The refusal names the SELECTED row's own unmet conditions, mapped through the
        # shared readiness law: a row blocked on "no adapter code" must be told to
        # register the adapter, and a row blocked on its asset on preparing the asset.
        # A fixed "prepare --model" step told users to re-download weights that were
        # already valid on disk whenever the real blocker was the missing adapter.
        from .jobs import readiness_error
        ready = catalog().readiness(model_id, "speech.asr")
        gated = catalog().get(model_id, "speech.asr")
        # FIRST-USE PROVISIONING (final decision 2026-11-22): the frozen release ships
        # ONE ASR engine whose pinned weights are NOT pre-installed, the Settings UI has
        # no model page, and the engine's own failure text promises "the first upload
        # prepares it automatically (progress is shown in the composer)". This job is
        # where that promise is kept: when the ONLY unmet readiness condition is the
        # pinned asset, the job prepares it NOW, with composer-visible progress, at the
        # row's pinned revision, and validates before anything loads. Every other
        # blocker stays a refusal - downloading weights fixes no missing adapter,
        # dependency, licence or configuration, and a failed preparation never reaches
        # the engine over invalid weights.
        if (gated is not None and gated.asset and not ready.assets_validated
                and ready.implemented and ready.dependencies_present
                and ready.configuration_valid and ready.access_satisfied):
            ctx.progress("preparing_model",
                         f"{gated.asset}@{gated.revision}: downloading the pinned model for "
                         "first use; the download is verified before transcription starts")
            state = assets.prepare(str(gated.asset), revision=str(gated.revision),
                                   required=tuple(gated.required_files))
            if ctx.cancel.is_set():
                # A first-use download is minutes long; a cancel pressed during it is a
                # cancellation, not a transcript of audio the user walked away from.
                return ctx.cancelled()
            if not state.present:
                return ctx.failed(
                    "model_unavailable",
                    f"first-use preparation of the pinned asset {gated.asset}@{gated.revision} "
                    f"did not produce a valid snapshot: {state.detail}",
                    human_step="check the network connection and send the upload again; the "
                               "download resumes where it stopped, and no engine's working "
                               "state is touched")
            snapshot_dir = state.path
        else:
            err = readiness_error("speech.asr", ready.blockers(), candidates=executable_ids,
                                  detail=f"the routing decision named {model_id}")
            return ctx.failed(err.reason, err.message, retryable=err.retryable,
                              human_step=err.human_step)

    word_timestamps = bool(ctx.req.payload.get("word_timestamps", False))
    ctx.progress("extracting", f"{target.name}: {duration:.1f}s, language={route['language']}")
    # An explicit window is honoured even below the whole-file bound: it is how the
    # caller bounds memory, and it is the only way chunk offsets get exercised on a
    # short source. Absent it, a short track is decoded in one pass.
    window_s = ctx.req.payload.get("window_s")
    kwargs: dict[str, Any] = {}
    if window_s:
        kwargs["window_s"] = max(2.0, float(window_s))
    # The decoder path is the SAME for a one-pass decode and for bounded windows, and it
    # needs the resolved project-local ffmpeg either way: bare "ffmpeg" is not on PATH on
    # this host, so a chunked run used to fail with WinError 2 on the very file the
    # whole-file path transcribed. Passing the resolved path keeps both paths identical.
    kwargs["ffmpeg"] = str(ctx.req.payload.get("ffmpeg", "") or "")
    # Speech gating is on unless a caller explicitly asks for the ungated run. Measured
    # reason (logs/f58-g33-asr-vad-1.log, logs/f58b-g35-vad-e03-1.log): ungated, the
    # pinned model writes "You" over digital silence and "." over a tone; gated, real
    # speech keeps the same words. The transcript reports vad_state either way, so a
    # caller can tell whether the emptiness of an interval is evidence or luck.
    kwargs["vad_filter"] = bool(ctx.req.payload.get("vad_filter", True))
    # THE DISPATCH LAW: the engine that runs is the module the ROW names, never a
    # hardcoded one. Selecting Parakeet in Settings and silently running whisper would
    # launder provenance: the payload's model/revision identity comes from the row, so
    # the run must BE that row's adapter or refuse. BackendUnavailable is the SHARED
    # contract class (whisper_ct2 re-exports it), so every adapter's typed failure maps
    # through the same kind table here.
    spec = catalog().get(model_id, "speech.asr")
    adapter_name = str(getattr(spec, "adapter", "") or "")
    if not adapter_name:
        return ctx.failed("model_unavailable",
                          f"{model_id} is registered with no adapter code; this job will "
                          "not fall back to another engine",
                          human_step="implement and register the adapter for this model id")
    try:
        engine = importlib.import_module(adapter_name)
    except (ImportError, ValueError) as exc:
        return _typed(ctx, BackendUnavailable(
            "dependency_missing",
            f"the adapter module for {model_id} ({adapter_name}) cannot be imported: {exc}",
            "install the pinned dependency declared in python-backend/pyproject.toml"))
    # The snapshot path is a measured disk fact, verified offline, on the warm path too:
    # an adapter told the exact project-local path loads with zero network involvement,
    # where a bare repo id on a cold cache reaches for the hub. First-use provisioning
    # above already set snapshot_dir when it prepared the asset.
    if spec.asset and not snapshot_dir:
        state = assets.asset_state(str(spec.asset), expected_revision=str(spec.revision),
                                   required=tuple(spec.required_files))
        if state.present:
            snapshot_dir = state.path
    if snapshot_dir and _accepts_kwarg(engine, "snapshot_dir"):
        kwargs["snapshot_dir"] = snapshot_dir

    # GPU-first placement (F91 law, 2026-11-23 - the Parakeet half). The engine used to
    # self-place on "is CUDA importable", and devices.device_plan answered CPU whenever
    # RAM fit, so the measured VRAM shortage beside an idle resident model produced a CPU
    # run: sufficient RAM must NOT bypass the release path. The rule, mirroring the OCR
    # cascade: fits beside the resident model -> GPU, model stays loaded; VRAM-only
    # shortage + permitted release + a loaded model -> ONE exclusive window (lease,
    # unload once, CONFIRM, remeasure - the window's remeasured plan is the real gate,
    # no GPU execution is inferred from the planner's bound); a busy owner -> typed
    # retryable refusal, active inference is never interrupted; no CUDA / estimate /
    # capacity / policy -> the supported CPU path with the SPECIFIC reason recorded.
    # The adapter's own reported device (per segment, below) is the acceptance evidence -
    # the placement only asks, the engine's report proves.
    from .. import handoff as handoff_mod
    from ..models import devices, job_limits, lifecycle, main_model, provider_config
    allow_gpu = _flag("RUKE_ASR_ALLOW_GPU", True)
    allow_unload = bool(provider_config.load().automatic_handoff)
    est_peak_mib = int(getattr(spec, "est_peak_mib", 0) or 0)
    est_peak_vram_mib = int(getattr(spec, "est_peak_vram_mib", 0) or 0)
    est_peak_commit_mib = int(getattr(spec, "est_peak_commit_mib", 0) or 0)
    est_basis = str(getattr(spec, "est_peak_basis", "") or "")
    est_vram_basis = str(getattr(spec, "est_vram_basis", "") or "")
    snapshot = main_model.snapshot()
    plan = devices.device_plan(
        "speech.asr", est_peak_mib=est_peak_mib, est_peak_vram_mib=est_peak_vram_mib,
        est_basis=est_basis, est_vram_basis=est_vram_basis,
        allow_gpu=allow_gpu, allow_unload=allow_unload, main_model=snapshot)
    placement: dict[str, Any] = {"plan": plan.as_dict()}
    box: dict[str, Any] = {}

    def _run(device: str, reason: str) -> None:
        # The adapter runs on the device the PLANNER placed it on, not on an
        # availability guess of its own; the injected kwargs obey the published-
        # signature law (the same snapshot_dir rule the dispatcher already runs on).
        # A typed adapter failure is captured, not raised through the lease holder:
        # it must map through the shared kind table, never be laundered into the
        # window's generic crash bucket.
        run_kwargs = dict(kwargs)
        if _accepts_kwarg(engine, "device"):
            run_kwargs["device"] = device
            if _accepts_kwarg(engine, "placement_reason"):
                run_kwargs["placement_reason"] = reason
        try:
            box["transcript"] = engine.transcribe(
                str(target), model_id=model_id, language=language, duration=duration,
                word_timestamps=word_timestamps,
                allow_download=bool(ctx.req.payload.get("allow_download", False)),
                cancel=ctx.cancel,
                progress=lambda state, note: ctx.progress(state, note), **run_kwargs)
        except BackendUnavailable as exc:
            box["failure"] = exc
        except OSError as exc:
            # F135 (2026-11-23, accept-11): a GPU placement can die inside the Windows
            # loader - the pagefile manager shrank the commit limit while the worker's
            # import ran, and `import torch` died on cufft64_11.dll with
            # [WinError 1455] "The paging file is too small". That is an OS/loader fact
            # raised as a plain OSError, NOT the engine's typed BackendUnavailable: it
            # used to propagate out of the window work and surface as the window's
            # generic "handoff_failed". Captured here so the device fallback below can
            # keep F123's law - the fallback keeps the SAME pinned model.
            box["loader_death"] = f"{type(exc).__name__}: {exc}"

    def _run_with_fallback(device: str, reason: str) -> None:
        # F123 (user brief 2026-11-23): "device fallback keeps the SAME model". A loader
        # death on a GPU placement reruns the identical pinned engine on CPU with the
        # specific OS reason threaded through as the placement reason (the adapter
        # records it; the per-segment device report is the proof). CPU is never tried
        # when the placement was already CPU, and a cancelled job runs nothing.
        # F136 (accept-12 law): the death is the pagefile-shrink transient, so an
        # INSTANT retry is inside the same collapse. After a loader death the SAME
        # device gets ONE retry after settling out of the transient; only if the
        # settled retry dies does the model move to CPU (same pinned model, F123).
        # CPU placement never self-retries (its death is the terminal fact).
        _run(device, reason)
        death = box.get("loader_death")
        if not death or str(device) == "cpu" or ctx.cancel.is_set():
            return
        first_death = str(death)
        # F137: size the wait to the loader, from the pinned row's own declared commit
        # peak - the same source the handoff gate's import_required formula (2x the
        # measured peak + the ceiling margin, the F133 axis) is built from.
        required = (2 * est_peak_commit_mib + lifecycle.COMMIT_CEILING_MARGIN_MIB
                    if est_peak_commit_mib > 0 else 0)
        t0 = time.monotonic()
        settled = _settle_out_of_shrink(ctx, required_mib=required,
                                        deadline_at=ctx.deadline_at())
        record: dict[str, Any] = {
            "device": str(device), "reason": first_death,
            "settle_s": round(time.monotonic() - t0, 1),
            "required_commit_mib": required,
            "note": ("the loader died while the system pagefile's commit limit was shrinking; "
                     "the same pinned model retried on the same device after the pagefile "
                     "settled"),
        }
        free_at_retry = _free_commit_mib()
        if free_at_retry is not None:
            record["free_commit_mib_at_retry"] = free_at_retry
        placement["loader_retry"] = record
        if not settled:
            return
        ctx.progress("extracting",
                     f"{target.name}: the {device} loader died in the paging-file transient; "
                     "settled, retrying the same pinned model on the same device")
        box.pop("loader_death", None)  # so the post-retry read is the RETRY's fact, not the first death
        _run(str(device), f"retried on {device} after the loader died mid-pagefile-shrink "
                          f"({first_death}); the pagefile settled; same pinned model")
        death = box.get("loader_death")
        if not death:
            return
        if ctx.cancel.is_set():
            return
        box.pop("loader_death")
        placement["loader_death"] = first_death
        placement["device_fallback"] = {"from_device": str(device), "to_device": "cpu",
                                        "same_model": True, "reason": first_death,
                                        "settled_retry_died": str(death)}
        ctx.progress("extracting",
                     f"{target.name}: the GPU loader died ({first_death}); the same pinned model "
                     "runs on CPU")
        _run("cpu", f"executed on CPU by measured placement: the {device!r} loader died "
                    f"({first_death}); same pinned model")

    def _window_work(payload: dict) -> dict:
        _run_with_fallback(str(payload.get("device") or "cpu"),
                           str(payload.get("reason") or plan.reason))
        return {"peak": {}, "integration": adapter_name}

    if plan.fits:
        # The supervisor defers its commit-ceiling refusal to this dispatcher for
        # speech.asr (F91 law 2026-11-23), because the exclusive window is exactly the
        # state the shortage describes. The deferral is only sound if the dispatcher
        # keeps the "refuse, never squeeze" law on the paths that run INSIDE the normal
        # window: its live ceiling can sit under this capability's measured commit
        # demand (measured batch state: 256 MiB ceiling vs 4,283 MiB), where the load
        # dies inside the engine's allocator and arrives as an engine crash. The
        # exclusive path re-measures its ceiling after the release, and the window's commit
        # gate (run_exclusive's est_peak_commit_mib) enforces the same law there.
        commit_known = est_peak_commit_mib
        if commit_known > 0:
            ceiling, wnote = job_limits.normal_ceiling_bytes()
            placement["window_ceiling_bytes"] = int(ceiling)
            if (ceiling >> 20) < commit_known + lifecycle.COMMIT_CEILING_MARGIN_MIB:
                return ctx.failed(
                    "memory_pressure",
                    f"this transcription was measured needing {commit_known} MiB of commit "
                    f"and the window this host can give right now is {ceiling >> 20} MiB "
                    f"(bound by {wnote.get('bound_by', 'the limits')}); the load would fail "
                    f"inside the engine's allocator rather than run. Placement: {plan.reason}",
                    retryable=True,
                    human_step="free commit charge: close what is holding memory and send "
                               "the upload again; the weights are already on disk, so "
                               "re-preparing them cannot help")
        _run_with_fallback(plan.device, plan.reason)
    elif plan.needs_handoff and allow_unload and snapshot.get("loaded"):
        ctx.progress("extracting",
                     f"{target.name}: the GPU run needs VRAM held by the idle main model; "
                     "requesting one exclusive window - the model is restored as soon as "
                     "the worker releases its resources")
        outcome = handoff_mod.run_exclusive(
            "speech.asr", _window_work,
            est_peak_mib=est_peak_mib, est_peak_vram_mib=est_peak_vram_mib,
            est_peak_commit_mib=est_peak_commit_mib,
            est_basis=est_basis, est_vram_basis=est_vram_basis,
            allow_gpu=allow_gpu, allow_unload=True,
            owner=str(ctx.req.job_id),
            # F140: the gate's settle/fit budgets are bounded by this job's deadline.
            deadline_at=ctx.deadline_at(),
            progress=lambda state, note: ctx.progress(state, note))
        placement["handoff"] = {k: outcome[k] for k in
                                ("plan_after_unload", "freed_vram_mib", "freed_physical_mib",
                                 "work_peak", "restore", "restore_ready", "device_used",
                                 "final_status")
                                if k in outcome}
        if not outcome.get("ok"):
            # The window's outcome reasons are journal words, not wire words: the shared
            # ERROR_REASONS vocabulary is closed (the TS/Rust readers consume it). The
            # mapping keeps the wire stable while the message names the exact window
            # failure; retryable=True is the law for the transient ones - the TS caller
            # keeps its retained fallback for a retryable capability failure, and a busy
            # endpoint is exactly that. Never an interruption of active inference.
            why = str(outcome.get("reason") or "resource_limit")
            detail = str(outcome.get("detail") or "")
            # A commit-headroom shortfall after a CONFIRMED release is transient (the host's
            # commit charge moves; the page file re-extends): retryable. The persistent
            # "neither device fits" stays non-retryable - it needs a policy change.
            wire, retry = {
                "coordination_held": ("resource_busy", True),
                "unload_refused": ("resource_busy", True),
                "restore_failed": ("resource_busy", True),
                "resource_limit": (("memory_pressure", True) if outcome.get("transient")
                                   else ("memory_pressure", False)),
                "provider_unsupported": ("not_configured", False),
                "handoff_failed": ("internal", True),
            }.get(why, ("internal", True))
            if why == "restore_failed":
                detail = ("the run completed inside the window but the main model did not "
                          f"come back: {detail}")
            elif why == "coordination_held":
                detail = f"the exclusive window is held by another owner: {detail}"
            elif why == "resource_limit":
                detail = (("the release was confirmed but the measured commit headroom is under "
                           "this capability's commit demand: ") if outcome.get("transient")
                          else "the window remeasured after the release and neither device fits: ") + detail
            step = ("the transcription runs once the endpoint is idle; active inference is "
                    "never interrupted" if retry else
                    "free VRAM for this job, or review the ASR GPU/automatic-handoff "
                    "policy; the release, remeasurement and refusal are journaled at "
                    ".data/python/handoff-journal.json")
            return ctx.failed(wire, f"the exclusive window ended as {why}: {detail}",
                              retryable=retry, human_step=step)
    elif (plan.needs_handoff and allow_unload and not snapshot.get("loaded")
          and snapshot.get("reachable") is not False
          and (snapshot.get("provider") or snapshot.get("endpoint"))):
        # F127(d) (2026-11-23, accept-8): a window that just ended leaves the machine
        # in a TRANSIENT state - the main model is unloaded and being restored, so the
        # planner's release path reads "not loaded, nothing to reclaim" and the plan
        # lands on "none". The old code answered that with the PERSISTENT terminal
        # refusal (retryable=False), and the live row died in ~300 ms mid-restore.
        # A configured, answering endpoint that is momentarily not resident is the
        # exact state F127(d) calls restore-in-progress: typed resource_busy,
        # retryable, with the restore (not a policy change) named as the way out.
        # An endpoint that never answers keeps the terminal answer - that axis is a
        # hardware/configuration fact and is recorded apart (F127(c)).
        return ctx.failed(
            "resource_busy",
            "the main model is not resident right now - the machine is between "
            f"exclusive windows and the model is being restored: {plan.reason}",
            retryable=True,
            human_step="send the upload again once the main model is back; the same "
                       "pinned engine runs; no re-preparation is needed")
    else:
        return ctx.failed("memory_pressure",
                          f"neither device can run this transcription right now: {plan.reason}",
                          retryable=False,
                          human_step="free VRAM for this job, or review the ASR "
                                     "GPU/automatic-handoff policy; the plan's measured "
                                     "evidence is in the capability report")

    if "failure" in box:
        return _typed(ctx, box["failure"])
    if "loader_death" in box:
        # The loader died on the requested device AND on the CPU fallback of the same
        # model (or the placement was already CPU). Host commit/OS fact, transient: the
        # pagefile re-extends, so the row is retryable, and the message names the exact
        # OS error - never the window's generic crash bucket.
        return ctx.failed("memory_pressure",
                          f"the engine's process loader died: {box['loader_death']}"
                          + (f" (same pinned model retried {placement['device_fallback']['from_device']}"
                             f" -> CPU)" if "device_fallback" in placement else ""),
                          retryable=True,
                          human_step="close what is holding memory and send the upload "
                                     "again; the weights are already on disk, so "
                                     "re-preparing them cannot help")
    if ctx.cancel.is_set():
        return ctx.cancelled()
    if "transcript" not in box:
        return ctx.failed("internal",
                          "the placement routed the run but no adapter call was made",
                          retryable=True, human_step="send the upload again")
    transcript = box["transcript"]

    coverage = Coverage(units="seconds", total_source=duration or transcript.duration,
                        examined=list(transcript.examined),
                        skipped=_uncovered(duration, transcript.examined),
                        complete=transcript.complete,
                        note=transcript.note or "bounded windows: unexamined audio cannot prove absence")
    identity = ModelIdentity(id=model_id, revision=str(_revision(model_id)), provider="huggingface",
                             quantization=transcript.compute_type or "")
    payload = transcript.as_payload()
    # The final decision records engine, revision and device PER AUDIO SEGMENT: a
    # long job can span a device recovery, and a reader must be able to tell which
    # segment ran on which engine and device. The values are measured facts of THIS
    # run - the integration module the row named, the row's pinned revision, the
    # device the adapter reported - never prose.
    for seg in payload.get("segments", []):
        if isinstance(seg, dict):
            seg["engine"] = adapter_name
            seg["revision"] = identity.revision
            seg["device"] = str(transcript.device or "")
    payload["probe"] = {"duration": duration, "audio_state": probe["audio_state"],
                        "selected_audio": probe["selected_audio"],
                        "stream_start_offsets": probe["stream_start_offsets"],
                        "subtitle_tracks": probe["subtitle_tracks"]}
    payload["audio_level"] = level.as_dict()
    payload["routing"] = {"decision": route["decision"], "quality_mode": route["quality_mode"],
                          "note": route["note"]}
    # Where the run was PLACED and, if a window was used, the window's measured
    # evidence (release sizes, the post-unload remeasured plan, restore timings). The
    # per-segment device below is what the engine REPORTS it ran on - the placement is
    # the request, the report is the proof; the two together are the acceptance evidence.
    payload["placement"] = placement
    return ctx.ready(payload, coverage=coverage, model=identity)


def _silence_result(ctx: JobContext, probe: dict, level: Any, duration: float) -> Any:
    """A silent track is a RESULT, not an error, and it was measured, not guessed."""
    span = [(0.0, round(duration, 3))] if duration > 0 else []
    return ctx.ready(
        {"state": "silence", "text": "", "segments": [], "segment_count": 0,
         "language": "", "language_source": "none", "language_probability": None,
         "duration": duration, "examined": [[a, b] for a, b in span],
         "complete": duration > 0, "word_timestamps": False,
         "model": "", "device": "", "compute_type": "",
         "asr_ran": False,
         "audio_level": level.as_dict(),
         "probe": {"duration": duration, "audio_state": probe["audio_state"],
                   "selected_audio": probe["selected_audio"],
                   "stream_start_offsets": probe["stream_start_offsets"],
                   "subtitle_tracks": probe["subtitle_tracks"]},
         "note": (f"the selected track decoded and was measured at {level.max_volume_db:.1f} "
                  f"dBFS peak, at or below the {level.noise_floor_db:.0f} dBFS floor, so no "
                  "ASR pass ran; nothing audible was present to transcribe. This is not a "
                  "failed run, not a missing track, and not a no-speech model verdict")},
        coverage=Coverage(units="seconds", total_source=duration, examined=span,
                          skipped=[], complete=duration > 0,
                          note=("the loudness pass decoded the whole track; ASR was skipped "
                                "because the measured peak is at/below the noise floor")),
        model=None)


def _typed(ctx: JobContext, exc: Any) -> Any:
    from .jobs import typed_from_kind
    err = typed_from_kind(getattr(exc, "kind", ""), str(getattr(exc, "detail", exc)),
                          human_step=str(getattr(exc, "human_step", "") or ""),
                          capability=ctx.req.capability)
    return ctx.failed(err.reason, err.message, retryable=err.retryable, human_step=err.human_step)


def _accepts_kwarg(engine: Any, name: str) -> bool:
    """True when the adapter's published transcribe signature accepts `name`.

    The dispatcher must not inject a kwarg into a call whose signature does not declare
    it: whisper_ct2.transcribe declares no **kwargs, so passing snapshot_dir there is a
    TypeError at the first real call. The check runs on the published signature - the
    same contract the dispatch law already runs on.
    """
    import inspect
    try:
        params = inspect.signature(engine.transcribe).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


def _revision(model_id: str) -> str:
    spec = catalog().get(model_id, "speech.asr")
    return spec.revision if spec else "unknown"


def _uncovered(duration: float, examined: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """The intervals this run never decoded. Absence there is unproven, not established."""
    from ..speech import transcript             # noqa: PLC0415 - lazy by design
    # One rule, shared with every adapter that produced the spans: sub-tolerance rounding
    # is not an unexamined interval, and anything larger is reported in full. The law
    # lives in the contract module, not in one engine, because the job layer is engine-agnostic.
    return transcript.uncovered_gaps(duration, examined)


def align_job(ctx: JobContext) -> Any:
    """Word timing only from a provider that actually supplies it; never interpolated.

    When word timing is unavailable the SEGMENT SPANS are returned unchanged with an
    explicit `segment_span_only` verdict, so a downstream subtitle step can tell the two
    apart instead of stretching a segment across its words.
    """
    from ..speech import alignment
    language = str(ctx.req.payload.get("language", "") or "")
    model_id = str(ctx.req.payload.get("model", "") or "")
    if not language:
        # Word timing is language-scoped: the language the ASR detected (or the user
        # named) is what the aligner's own table is checked against.
        language = str(ctx.req.payload.get("detected_language", "") or "")
    aligners = catalog().for_capability("speech.align")
    if not model_id:
        ready = [s for s in aligners if catalog().readiness(s.id, "speech.align").executable]
        model_id = ready[0].id if ready else (aligners[0].id if aligners else "")
    if not model_id:
        return ctx.failed("not_configured", "no aligner is registered for this capability",
                          human_step="register the aligner the worker is expected to load")
    got = alignment.decide(model_id, language)
    if not got["ok"]:
        # The branch is on a machine verdict, never on substrings of an English sentence:
        # a missing language table and a missing weight are different facts with
        # different remedies, and the caller must receive the right one.
        from .jobs import readiness_error
        if got["kind"] in (alignment.KIND_UNSUPPORTED_LANGUAGE, alignment.KIND_UNKNOWN_LANGUAGE):
            reason = "unsupported_input"
        elif got["kind"] == alignment.KIND_NOT_EXECUTABLE:
            reason = readiness_error("speech.align", list(got["blockers"]),
                                     candidates=[s.id for s in aligners]).reason
        else:
            reason = "not_configured"
        return ctx.failed(reason, str(got["detail"]),
                          human_step=str(got["human_step"]) or
                          "install/verify the aligner, or accept segment-level timing")
    segments = ctx.req.payload.get("segments")
    if not isinstance(segments, list) or not segments:
        return ctx.failed("input_rejected",
                          "speech.align needs the segments whose word timing must be validated",
                          human_step="run speech.asr with word_timestamps=true, then align its segments")
    checked = [alignment.accept_word_timestamps(s, tolerance_s=float(
        ctx.req.payload.get("tolerance_s", 0.05))) for s in segments[:5000] if isinstance(s, dict)]
    counts: dict[str, int] = {}
    for c in checked:
        counts[str(c.get("word_timestamps", ""))] = counts.get(str(c.get("word_timestamps", "")), 0) + 1
    rejected = sum(len(c.get("rejected_words", [])) for c in checked)
    return ctx.ready(
        {"aligner": got["aligner"], "asr_model": model_id, "language": language,
         "quality_mode": got["quality_mode"],
         "measured_for_language": got["measured_for_language"],
         "segments": checked[:5000],
         "verdict_counts": counts, "rejected_words": rejected,
         "note": ("word times are the provider's own; a segment span is reported as a span, "
                  "never stretched into word timing")},
        coverage=Coverage(units="segments", total_source=float(len(checked)),
                          examined=[(0.0, float(len(checked)))],
                          skipped=[], complete=len(checked) >= len(segments),
                          note="every supplied segment was validated; rejected word spans are reported, not repaired"))


def diarize_job(ctx: JobContext) -> Any:
    from ..speech.asr import license_required_error
    err: StructuredError = license_required_error("speech.diarize")
    return ctx.failed(err.reason, err.message, retryable=err.retryable, human_step=err.human_step)
