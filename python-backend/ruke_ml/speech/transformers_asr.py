"""The ONE Transformers ASR integration - Parakeet-TDT-0.6B-v3, English release scope.

Final decision 2026-11-22: Ruke maintains ONE Transformers ASR integration, not a
Python adapter per model family. This module IS that integration: the shared
adapter contract from transcript.py, the published Parakeet TDT surface of
Hugging Face Transformers (ParakeetForTDT/AutoModelForTDT + ParakeetProcessor,
shipped in transformers v5.9.0, PR #44171), and nothing model-specific beyond
the pinned checkpoint's published laws.

Laws, each with its measured evidence (g103 probe, .data/tmp/g103/probe-result.json,
checkpoint 541d1f99c6b0c3cd0b11a95167540bb8edefd82b, transformers 5.24.0,
torch 2.14.1+cu126, RTX 3060 driver 621.35):

  * English release scope: the only selectable transcription engine is Parakeet for
    English. A non-English request is REFUSED with the reason before the model is
    touched - deferred multilingual never silently degrades into an English run;
  * GPU preferred, CPU is the MEASURED recovery path: the probe transcribed the
    same checkpoint on both with identical text and token timestamps. (The NeMo
    fallback in parakeet_tdt.py stays CUDA-first by its own published law; this
    integration publishes CPU execution, so refusing here would throw away a
    working recovery path the final decision explicitly asks for.)
  * placement is RECEIVED, not self-decided (F91, 2026-11-23): the worker accepts
    the device the measured DevicePlan/handoff window chose ("gpu"/"cpu"), and an
    empty device keeps the legacy probe. A CPU placement reports the planner's
    specific measured reason, never a fabricated "no CUDA is available" when the
    release simply was not permitted - the reason is the evidence.
  * the install fault is named, not laundered (F123, 2026-11-23): a CUDA placement
    whose .to() fails is the typed device_unavailable fault naming the runtime
    installation (a CPU-only wheel beside a real GPU), and the GPU-less legacy
    probe checks the nvidia-smi hardware truth before claiming a GPU-less host -
    the host is never described as having no GPU when the GPU exists and the
    installed runtime is the defect.
  * from_pretrained(dtype="auto") + model.to(device): device_map needs `accelerate`,
    which this venv deliberately does not install - the probe measured the .to()
    form working, so the integration pins that form;
  * per-token timestamps are published (processor.decode(sequences,
    durations=output.durations)); the engine returns them WINDOW-relative, and this
    module adds each window's source offset - the asr.pcm_windows source-time law.
    Word timing is TDT token granularity, reported as such; no word boundaries are
    fabricated from subword tokens;
  * the worker loads ONCE per job and GPU memory is released when the job ends
    (torch.cuda.empty_cache in the exit path);
  * allow_download=False (the production default) pins the hub offline for the load:
    a missing snapshot is the typed asset_missing refusal, never an unannounced
    network pull mid-upload; trust_remote_code is never enabled - model-supplied
    Python is not executed;
  * the published full-attention bound of the family is 24 minutes; longer audio is
    decoded in bounded windows merged under the shared window-boundary law
    (transcript._merge_windows), same as the NeMo adapter.
"""
from __future__ import annotations

import importlib
import math
import threading
from typing import Any, Callable

from .asr import pcm_windows
from .languages import normalize_language
from .transcript import (BackendUnavailable, Transcript, _merge_windows, audio_array,
                         decode_window, uncovered_gaps)

# The frozen release default; Settings stores it, the integration receives it.
PARAKEET_TDT_V3 = "nvidia/parakeet-tdt-0.6b-v3"
# The release scope. Multilingual is deferred (final decision 2026-11-22); the
# checkpoint itself publishes 25 European languages, and that published table
# stays in ruke_ml/data/ for provenance - this release ships English only.
ENGLISH_SCOPE = "en"
# Published full-attention bound of the Parakeet CTC/TDT family (same as NeMo's).
MAX_FULL_ATTENTION_S = 1440.0
DEFAULT_OVERLAP_S = 2.0
# Measured token rate ~3.6 tokens/s (probe: 40 tokens over 11.04 s). generate
# needs an explicit budget for a window; 6x the measured rate + slack is honest
# headroom, not a guess: the greedy TDT loop ends at the end of audio.
TOKENS_PER_SECOND_BUDGET = 6.0


def import_backend() -> Any:
    """Resolve the published Transformers TDT classes, typed when not installed."""
    try:
        tf = importlib.import_module("transformers")
        return tf.AutoModelForTDT, tf.AutoProcessor
    except (ImportError, ModuleNotFoundError) as exc:
        raise BackendUnavailable(
            "dependency_missing",
            "Hugging Face Transformers (with the Parakeet TDT integration, "
            f"shipped in transformers>=5.9.0) is not installed: {exc}",
            "provision the pinned Transformers runtime (engine bootstrap) - "
            "Settings→Models performs this automatically on first use") from exc


def _device() -> str:
    try:
        import torch  # noqa: PLC0415 - torch belongs to the engine, not the supervisor
        return "cuda" if torch.cuda.is_available() else "cpu"
    except (ImportError, ModuleNotFoundError):
        # No torch at all: transformers cannot run; report it as its dependencies,
        # and let load classify the exact failure.
        return "cpu"


def load_worker(model_id: str, *, snapshot_dir: str = "", allow_download: bool = False,
                device: str = "cpu") -> tuple[Any, Any]:
    """(processor, model) loaded once from the pinned local snapshot.

    snapshot_dir is the project-local store path the automatic provisioning owns;
    an ordinary run passes it and the hub is never contacted. With
    allow_download=False and no snapshot_dir, the hub is pinned offline for the
    call, so a cold cache is asset_missing, not a network pull.
    """
    AutoModelForTDT, AutoProcessor = import_backend()
    src = snapshot_dir or model_id
    offline = not allow_download
    common = {"local_files_only": offline, "trust_remote_code": False}
    try:
        processor = AutoProcessor.from_pretrained(src, **common)
        model = AutoModelForTDT.from_pretrained(src, dtype="auto", **common)
    except Exception as exc:  # noqa: BLE001 - classify by kind, never crash the job
        text = f"{type(exc).__name__}: {exc}"
        low = text.lower()
        if "offline" in low or ("not found" in low and "local" in low) or "cache" in low:
            raise BackendUnavailable(
                "asset_missing",
                f"the pinned snapshot of {model_id} is not prepared locally: {text}",
                "the first upload prepares it automatically (progress is shown in "
                "the composer); offline, prepare it while connected once") from exc
        raise BackendUnavailable("load_failed",
                                 f"Transformers could not load {model_id}: {text}",
                                 "retry; if it repeats, re-prepare the pinned model") from exc
    # F123 (2026-11-23): a CUDA placement on a host running the WRONG torch runtime
    # (a CPU-only wheel beside a real GPU) used to raise a bare RuntimeError from
    # .to(), punching through the dispatcher's typed-failure capture as an
    # unclassified crash. The law: expose the INSTALLATION fault by name - the
    # placement's GPU is a measured nvidia-smi fact, so this host HAS a GPU; what
    # is missing is the CUDA-capable runtime. Never describe the host as having
    # no GPU (that sends the user to buy hardware they own), and never let the
    # raw exception escape the adapter contract.
    try:
        model.to(device)
    except Exception as exc:  # noqa: BLE001 - classify by kind, never crash the job
        text = f"{type(exc).__name__}: {exc}"
        if device == "cuda":
            raise BackendUnavailable(
                "device_unavailable",
                f"the run was placed on CUDA (the planner measures the GPU with "
                f"nvidia-smi, so this host HAS one), but the installed torch runtime "
                f"cannot move {model_id} onto it: {text} — this is a runtime "
                f"installation fault (likely a CPU-only torch build), not a missing GPU",
                "install the CUDA build of the pinned torch runtime declared in "
                "python-backend/pyproject.toml; the CPU recovery path needs no reinstall "
                "and no hardware change") from exc
        raise BackendUnavailable("load_failed",
                                 f"Transformers could not move {model_id} to {device}: {text}",
                                 "retry; if it repeats, re-prepare the pinned model") from exc
    model.eval()
    return processor, model


def _release(model: Any, device: str) -> None:
    """Promptly free the worker; GPU runs must give VRAM back to Strata."""
    del model
    if device == "cuda":
        try:
            import torch  # noqa: PLC0415
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 - release is best-effort, never fatal
            pass


def _segments_from(stamps: list[dict[str, Any]], text: str, *, offset: float,
                   window: tuple[float, float], word_timestamps: bool) -> list[dict[str, Any]]:
    """Published per-token timings (window-relative) -> absolute-span segment(s).

    The published TDT surface is TOKEN timing; sentence segmentation is not, so one
    honest span per window is emitted (text from the processor's decode), never
    fabricated sub-sentences. Words are the TDT tokens themselves - subword spans
    labelled as what they are.
    """
    seg: dict[str, Any] = {}
    if stamps:
        seg["start"] = round(float(stamps[0]["start"]) + offset, 3)
        seg["end"] = round(float(stamps[-1]["end"]) + offset, 3)
    else:
        seg["start"], seg["end"] = round(offset, 3), round(window[1], 3)
    seg["text"] = text
    if word_timestamps and stamps:
        seg["words"] = [{"word": str(t.get("token", "")),
                         "start": round(float(t["start"]) + offset, 3),
                         "end": round(float(t["end"]) + offset, 3)} for t in stamps]
    seg["_window"] = window
    return [seg]


def transcribe(src: str, *, model_id: str = PARAKEET_TDT_V3, language: str = "",
               duration: float = 0.0, word_timestamps: bool = False,
               allow_download: bool = False, window_s: float | None = None,
               overlap_s: float = DEFAULT_OVERLAP_S, cancel: threading.Event | None = None,
               progress: Callable[[str, str], None] | None = None, ffmpeg: str = "",
               vad_filter: bool = True, snapshot_dir: str = "",
               device: str = "", placement_reason: str = "",
               start_s: float = 0.0, end_s: float = 0.0) -> Transcript:
    """Transcribe on the shared contract; module docstring for the laws.

    `device` is the planner's verdict ("gpu" | "cpu"); "" keeps the legacy probe.
    `placement_reason` is the measured reason the plan carries, reported verbatim
    when the run lands on CPU, so a reader can tell a chosen CPU from a starved
    one.

    F152 (question-driven interval): `start_s`/`end_s` bound the DECODED span
    (accurate-seek windows over the span, the pcm source-offset law: every window
    offset is absolute source time). The Transcript stays a fact about the WHOLE
    source: `duration` is the full track, the un-inspected head/tail appear in the
    coverage gaps, and `complete` is False for a bounded run - an interval answer
    can never be read as a verdict on audio that was never decoded.
    """
    prog = progress or (lambda state, note: None)
    cancel = cancel or threading.Event()
    lang = normalize_language(language) if language else ""
    if lang and lang != ENGLISH_SCOPE:
        raise BackendUnavailable(
            "unsupported_language",
            f"the release scope is English transcription through {model_id}; "
            f"language {lang!r} is not provided in this release (multilingual is "
            "deferred by the release decision)",
            "this build transcribes English audio and video only")
    if cancel.is_set():
        return Transcript(model=model_id, state="transcribed", complete=False,
                          note="cancelled before the model was loaded")

    # F91: the plan's verdict is honored, not re-probed here. The planner measured
    # free VRAM and the release; re-deciding by a bare cuda.is_available() is the
    # same self-placement that let the worker run on CPU beside idle reclaimable
    # VRAM. An empty (or unrecognized) device keeps the legacy probe.
    device = {"gpu": "cuda", "cpu": "cpu"}.get(device) or _device()
    processor, model = load_worker(model_id, snapshot_dir=snapshot_dir,
                                   allow_download=allow_download, device=device)
    if device == "cuda":
        cpu_note = ""
    elif placement_reason:
        cpu_note = f"executed on CPU by measured placement: {placement_reason}"
    else:
        # F123 (2026-11-23): the legacy probe runs only when no placement was
        # received. "no CUDA device is available" is a claim about the HARDWARE,
        # and on a CUDA-capable host with a CPU-only torch wheel it is false - the
        # host has a GPU and the runtime is the fault. The hardware truth is the
        # nvidia-smi probe (torch-independent); the note names the installation
        # fault when the GPU is measured present, and only claims a GPU-less host
        # when the hardware probe itself finds none.
        from ..models import devices                      # noqa: PLC0415 - lazy by design
        vram = devices.vram_state()
        if vram.available:
            cpu_note = ("executed on the CPU recovery path: this host HAS an NVIDIA GPU ("
                        f"{vram.detail}) but the installed torch runtime reports no usable "
                        "CUDA - a runtime installation fault (install the CUDA build of the "
                        "pinned torch), not a host without a GPU; measured to transcribe "
                        "correctly on CPU, at CPU speed")
        else:
            cpu_note = ("executed on the CPU recovery path: no usable CUDA device was "
                        f"measured ({vram.detail}); measured to transcribe correctly, "
                        "at CPU speed")

    duration = float(duration or 0.0)
    span_start = max(0.0, min(float(start_s or 0.0), duration))
    span_end = min(float(end_s), duration) if float(end_s or 0.0) > 0 else duration
    if span_end - span_start < 0.5:      # a degenerate bound is the whole-file run
        span_start, span_end = 0.0, duration
    inspecting = span_start > 0.0 or span_end < duration
    single = (window_s is None and not inspecting
              and 0.0 < duration <= MAX_FULL_ATTENTION_S)
    if single:
        windows = [(0.0, duration)]
    else:
        bound = float(window_s) if window_s else MAX_FULL_ATTENTION_S
        # Tiling happens over the SPAN; the offsets shift to absolute source time,
        # the same law pcm_command's accurate seek enforces on the decode itself.
        windows = [(span_start + w.start_s, span_start + w.end_s) for w in
                   pcm_windows(span_end - span_start, window_s=bound,
                               overlap_s=overlap_s, src=src)]

    segments: list[dict[str, Any]] = []
    examined: list[tuple[float, float]] = []
    cancelled = False
    try:
        import torch  # noqa: PLC0415 - loaded by load_worker's side effects already
        for i, (a, b) in enumerate(windows):
            if cancel.is_set():
                cancelled = True
                break
            prog("transcribing", f"parakeet window {a:.1f}-{b:.1f}s ({i + 1}/{len(windows)})")
            if single:
                samples = audio_array(src, b, ffmpeg=ffmpeg)
            else:
                samples = decode_window(src, a, b, ffmpeg=ffmpeg)
            if cancel.is_set():
                # Cancellation stops GENERATION, not just later windows: observed
                # during this window's decode means this window never generates.
                cancelled = True
                break
            inputs = processor([samples],
                               sampling_rate=processor.feature_extractor.sampling_rate,
                               return_tensors="pt")
            inputs = inputs.to(model.device, dtype=model.dtype)
            budget = int(math.ceil((b - a) * TOKENS_PER_SECOND_BUDGET)) + 32
            with torch.no_grad():
                output = model.generate(**inputs, max_new_tokens=budget,
                                        return_dict_in_generate=True)
            decoded, stamped = processor.decode(output.sequences,
                                                durations=output.durations,
                                                skip_special_tokens=True)
            text = (decoded[0] if decoded else "").strip()
            stamps = (stamped[0] if stamped else []) or []
            if text:
                segments.extend(_segments_from(stamps, text, offset=a, window=(a, b),
                                               word_timestamps=word_timestamps))
            examined.append((a, b))
            del inputs, output, samples
    finally:
        _release(model, device)

    merged, superseded = _merge_windows(segments, duration=duration)
    for seg in merged:
        seg.pop("_window", None)
    gaps = uncovered_gaps(duration, examined)
    note_parts: list[str] = []
    if inspecting:
        note_parts.append(
            f"bounded interval inspection {span_start:.1f}-{span_end:.1f}s: audio outside "
            "the span was never decoded, so this run says nothing about it")
    if cpu_note:
        note_parts.append(cpu_note)
    if vad_filter:
        note_parts.append("speech gating is not published for this engine; the run is ungated")
    if cancelled:
        note_parts.append("cancelled mid-run: the transcript covers the decoded windows only")
    # The delivered text is built from the MERGED segments, never a raw join of the
    # per-window decodes: overlapping windows repeat their overlap-span words, and a
    # superseded fragment (cut off at a window edge, reheard whole by the next window)
    # must never appear on the wire. whisper_ct2.py established this law; a Parakeet
    # run over overlapping windows proved the raw join duplicated sentences.
    text = " ".join(s["text"] for s in merged).strip()
    return Transcript(
        text=text, segments=merged,
        language=lang,
        language_source="explicit" if lang else "none",
        duration=duration, examined=examined,
        complete=bool(duration) and not gaps and not cancelled,
        state="transcribed" if text else "no_speech",
        note="; ".join(note_parts)
        + ("" if text else ": the hypothesis carried no words, so this is a model "
           "no-speech verdict on the decoded windows, not a decode failure"),
        model=model_id, device=device, compute_type="auto",
        word_timestamps=word_timestamps,
        vad_filter=False, vad_state="unsupported_by_backend",
        superseded=superseded)
