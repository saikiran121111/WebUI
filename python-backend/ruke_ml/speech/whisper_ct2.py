"""The faster-whisper (CTranslate2) backend: real transcription, real timestamps.

This is the adapter the registry actually points at, so the contract it implements is
the pinned package's documented one (faster_whisper.WhisperModel.transcribe), verified
against the installed version rather than assumed from another library's API.

Laws this module encodes:
  * bounded decode windows with EXPLICIT source offsets - a segment timestamp inside a
    window is meaningless until start_s is added back (asr.pcm_windows states the same
    law for the command line);
  * published language coverage comes from the pinned package's own table, and it is a
    CLAIM; per-language verified quality only ever comes from an evaluation run;
  * automatic language means REAL detection (info.language + probability), never a
    silent fall back to an English-only checkpoint;
  * word timing only exists when the provider actually returns it;
  * no track, silence, no speech, failed decode and unsupported language are five
    different answers, so the state strings stay separate.
  * speech-activity gating is ON by default and reported, because an ungated decoder
    emits invented text over silence and over non-speech noise (measured, see the VAD
    block below), while reported coverage stays "what was decoded", never "what
    contained speech".
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Callable, NoReturn

from .. import allocations
from ..language_tables import whisper_ct2_languages, whisper_ct2_provenance
from .asr import DEFAULT_OVERLAP_S, DEFAULT_WINDOW_S, PCM_RATE_HZ, pcm_windows
from .languages import detected_language_or_none, language_is_supported, normalize_language
# The shared adapter contract (Transcript, coverage, window-merge, decode) lives in
# transcript.py so every engine returns the same shape; re-exported here so this
# module's public surface is unchanged.
from .transcript import (  # noqa: F401 - re-export of the contract surface
    BOUNDARY_CLIP_TOLERANCE_S, COVERAGE_TOLERANCE_S, MAX_REPORTED_SUPERSEDED,
    MAX_RETAINED_SEGMENTS, SUPERSEDED_COVER_FRACTION, VAD_STATES, BackendUnavailable,
    Transcript, _dedupe_exact, _merge_windows, _window_edge_clipped, uncovered_gaps,
    audio_array, decode_window as _decode_window)

# Pinned adapter identity. The registry must name THIS package and these model ids,
# otherwise "installed" and "executable" would describe a different library than the one
# the job actually runs (the audit's faster-whisper/transformers mismatch).
PACKAGE = "faster_whisper"
MAX_WHOLE_FILE_S = 900.0      # above this, stream bounded windows instead of one array
# ---------------------------------------------------------------- speech gating (VAD)
# Measured defect (F58, real model run, logs/f58-g33-asr-vad-1.log): the pinned
# faster-whisper default is vad_filter=False, so a 40 s window that is digital silence
# until 33.75 s emitted "You" at 0.0-2.0 s - a hallucination about nothing - and placed
# the real sentence ~3.8 s early. The SAME window with vad_filter=True produced one
# segment at 33.62-38.62 s against an independently measured speech interval of
# [33.75, 38.25] s (energy profile at -45 dBFS).
# Measured quality side (F58b, logs/f58b-g35-vad-e03-1.log, real engine, real fixtures):
#   speech.wav and final.wav: word-for-word identical with and without gating;
#   long.wav: same words, segment boundary moves;
#   tone.wav (audible non-speech): ungated emitted six "." hallucinations, gated none;
#   digital silence: ungated emitted "You", gated emitted nothing.
# So gating is the quality choice, not a heuristic: it removes invented text over
# silence and non-speech without changing the words it keeps. It is on by default and
# reported, so a caller can still ask for the ungated behaviour.
VAD_ASSET = "silero_vad_v6.onnx"


def published_languages() -> list[str]:
    """The pinned backend's own documented language table (recorded at pin time).

    It is a snapshot of `faster_whisper.tokenizer._LANGUAGE_CODES` with the package
    versions that produced it, so answering a capability question never imports
    ctranslate2, and the claim is traceable to the dependency that made it.
    """
    return whisper_ct2_languages()


def language_table_provenance() -> dict[str, Any]:
    return whisper_ct2_provenance()


def supports_language(tag: str) -> bool:
    return language_is_supported(published_languages(), tag)


def import_backend() -> Any:
    try:
        import faster_whisper                      # noqa: PLC0415 - lazy by design
    except Exception as exc:                       # noqa: BLE001 - report, never crash
        raise BackendUnavailable(
            "dependency_missing",
            f"the pinned ASR backend {PACKAGE!r} cannot be imported: {type(exc).__name__}: {exc}",
            "install the speech extra (python-backend/pyproject.toml) into the backend venv",
        ) from exc
    return faster_whisper


def device_choice() -> tuple[str, str]:
    """The CPU-only processing policy, resolved explicitly rather than auto-probed.

    Measured policy defect (F13, DECISIONS D-038/D-040): this host HAS a CUDA device -
    the main LLM runs on it - so an availability probe used it, and an ASR job would
    have allocated GPU memory and displaced the resident model the user is talking to.
    The pinned processing policy is CPU, always:

      * default: ("cpu", "int8");
      * an operator may override with RUKE_ML_DEVICE (device) and RUKE_ML_COMPUTE_TYPE,
        which is honoured ONLY as an explicit request and is reported in the transcript
        identity so the run states which device actually produced it;
      * a GPU is never chosen because it exists.
    """
    dev = os.environ.get("RUKE_ML_DEVICE", "").strip().lower() or "cpu"
    ctype = os.environ.get("RUKE_ML_COMPUTE_TYPE", "").strip().lower()
    if dev not in ("cpu", "cuda", "cuda_all", "auto"):
        # A typo must not silently become GPU or crash the supervisor.
        dev = "cpu"
    if not ctype:
        ctype = "int8" if dev == "cpu" else "float16"
    return dev, ctype


def load_model(model_id: str, *, allow_download: bool = False,
               device: str = "", compute_type: str = "") -> Any:
    """Load a pinned checkpoint. Ordinary startup never downloads anything."""
    faster_whisper = import_backend()
    dev = device or device_choice()[0]
    ctype = compute_type or device_choice()[1]
    try:
        return faster_whisper.WhisperModel(model_id, device=dev, compute_type=ctype,
                                           local_files_only=not allow_download)
    except Exception as exc:                            # noqa: BLE001
        text = f"{type(exc).__name__}: {exc}"
        low = text.lower()
        # ORDER IS THE MEASUREMENT: the 2026-11-17 reproduction below is an allocation
        # refusal that ALSO contains words the asset branch matches on, and it was reported
        # as "prepare the pinned asset" while the weights were already on disk. See
        # ruke_ml/allocations.py and logs/f54-g26-asr-{default,raised}-1.log.
        if allocations.is_allocation_failure(text):
            raise BackendUnavailable(
                "allocation_failed",
                text,
                "the pinned asset is already on disk: free RAM/commit, or let the resource "
                "coordinator run the unload/load handoff, then retry. Do NOT re-download "
                "the asset.",
            ) from exc
        if "local" in low or "not found" in low or "cache" in low or "network" in low:
            raise BackendUnavailable(
                "asset_missing",
                f"{model_id} is not present in the local model cache: {text}",
                "prepare the pinned asset explicitly: python -m ruke_ml.models.prepare "
                f"--model {model_id} (ordinary startup must not download it)",
            ) from exc
        raise BackendUnavailable("load_failed", text, "retry; if it repeats, report this line") from exc


def vad_asset_state() -> str:
    """Is the pinned backend's OWN speech-activity asset usable here, without downloading?

    "available" | "asset_missing" | "runtime_missing". The pinned ``get_vad_model()``
    loads only ``<package>/assets/silero_vad_v6.onnx`` (faster_whisper/vad.py), so a
    missing file is a real gap and must never be repaired by a job reaching the network.
    """
    try:
        faster_whisper = import_backend()
        path = Path(faster_whisper.utils.get_assets_path()) / VAD_ASSET
    except BackendUnavailable:
        return "runtime_missing"
    if not path.is_file():
        return "asset_missing"
    try:
        import importlib.util                          # noqa: PLC0415 - probe, not a dep
        if importlib.util.find_spec("onnxruntime") is None:
            return "runtime_missing"
    except (ImportError, ValueError, OSError):
        return "runtime_missing"
    return "available"


def _is_vad_refusal(exc: BaseException) -> bool:
    """Does this failure say "the speech filter itself could not run", and nothing else?

    Narrow on purpose. A TypeError naming vad_filter means the pinned signature does not
    accept it; the pinned get_vad_model() raises RuntimeError naming onnxruntime when the
    runtime is absent, and an onnxruntime session failure names the silero asset. Any
    other error stays whatever it is - an allocation refusal is NEVER retried as if it
    were a VAD problem, because re-running ungated would hide the real cause.
    """
    text = f"{type(exc).__name__}: {exc}".lower()
    if isinstance(exc, TypeError):
        return "vad" in text
    if isinstance(exc, ImportError):
        return "onnxruntime" in text
    return any(marker in text for marker in
               ("silero", "onnxruntime", "vad_filter", "vad model", "vad detection"))


def _raise_transcription_failure(exc: BaseException) -> NoReturn:
    """Classify a failed model call: allocation refusal or generic failure, never VAD."""
    if allocations.is_allocation_failure(exc):
        raise BackendUnavailable(
            "allocation_failed",
            f"transcribe failed: {type(exc).__name__}: {exc}",
            "the model loaded, so this is not an asset problem: an allocation was "
            "refused mid-run. Reduce the decode window or free RAM/commit and retry.",
        ) from exc
    raise BackendUnavailable(
        "transcription_failed",
        f"transcribe failed: {type(exc).__name__}: {exc}",
        "retry; if it repeats, lower the window size or re-check the asset") from exc


def _transcribe_audio(model: Any, audio: Any, *, lang: str, word_timestamps: bool,
                      vad: bool) -> tuple[Any, Any]:
    kwargs: dict[str, Any] = dict(language=(lang or None), task="transcribe",
                                  word_timestamps=word_timestamps, beam_size=5,
                                  condition_on_previous_text=False)
    if vad:
        kwargs["vad_filter"] = True
    return model.transcribe(audio, **kwargs)


def _transcribe_gated(model: Any, audio: Any, *, lang: str, word_timestamps: bool,
                      vad: bool) -> tuple[Any, Any, bool, str]:
    """One model run over one window, with AT MOST one ungated retry.

    Returns (segments, info, vad_applied, vad_refusal). The retry happens only when the
    backend refused its own speech filter, and only once per window - it is a bounded
    correction of a capability mismatch, not a retry loop, and it never swallows an
    allocation or decode failure.
    """
    refusal = ""
    if vad:
        try:
            segments_iter, info = _transcribe_audio(model, audio, lang=lang,
                                                    word_timestamps=word_timestamps, vad=True)
            return segments_iter, info, True, ""
        except BackendUnavailable:
            raise
        except Exception as exc:                       # noqa: BLE001 - classified here
            if allocations.is_allocation_failure(exc) or not _is_vad_refusal(exc):
                _raise_transcription_failure(exc)
            refusal = ("unsupported_by_backend" if isinstance(exc, TypeError)
                       else "backend_rejected")
    try:
        segments_iter, info = _transcribe_audio(model, audio, lang=lang,
                                                word_timestamps=word_timestamps, vad=False)
    except BackendUnavailable:
        raise
    except Exception as exc:                           # noqa: BLE001 - classified here
        _raise_transcription_failure(exc)
    return segments_iter, info, False, refusal


def _vad_note(out: "Transcript") -> str:
    """One sentence on what the speech gate ACTUALLY did on this run, or why it could not."""
    if out.vad_state == "applied":
        return ("; speech-activity gating was applied to the decoded audio, so a decoded "
                "interval with no segment is a claim about speech presence, not a claim "
                "that the audio went unexamined")
    if out.vad_state == "not_requested":
        return ("; the caller turned speech gating off, so this run can and does emit text "
                "over silence (measured: 'You' over digital silence)")
    if out.vad_state in ("asset_missing", "runtime_missing"):
        return (f"; speech gating could not run here ({out.vad_state}: the pinned backend "
                "loads only the silero asset shipped in its own package and must never "
                "download one mid-job), so text over silence is possible")
    if out.vad_state in ("unsupported_by_backend", "backend_rejected"):
        where = ("the windows after the refusal ran ungated" if out.vad_filter
                 else "every window was re-run ungated")
        return (f"; the backend refused its own speech-activity filter ({out.vad_state}) "
                f"and got one ungated retry; {where}, so text over silence is possible")
    return ""


def _pyav_decode_audio(src: str) -> Any:
    """This backend's documented decode fallback, for a host with no validated ffmpeg.

    Measured defect (F14, real engine run): the whole-file path used to call
    ``faster_whisper.audio.load_audio``, a helper the pinned 1.2.1 release does not
    export (it has ``audio.decode_audio``), so every short-file transcription failed
    with ``decode_failed`` before the model could even be exercised. The fallback
    therefore names the API it looked for and what the module actually exports.
    """
    faster_whisper = import_backend()
    decode = getattr(faster_whisper.audio, "decode_audio", None)
    if decode is None:
        raise BackendUnavailable(
            "decode_failed",
            f"neither a validated ffmpeg copy nor {PACKAGE}.audio.decode_audio is available "
            f"on this host (audio module exports: {sorted(n for n in dir(faster_whisper.audio) if not n.startswith('_'))[:12]})",
            "install/validate ffmpeg (ruke_ml.models.binaries) or pin an ASR backend whose "
            "documented decode API exists")
    try:
        return decode(src, sampling_rate=PCM_RATE_HZ)
    except Exception as exc:                            # noqa: BLE001
        raise BackendUnavailable(
            "decode_failed",
            f"audio decode failed: {type(exc).__name__}: {exc}",
            "check that the file has a decodable audio track") from exc


def _audio_array(src: str, duration: float, *, ffmpeg: str = "") -> Any:
    """Decode the whole short source through the shared decode law (transcript).

    The whole-file path uses the SAME ffmpeg decoder as the windowed path, so the
    sample rate, channel layout and stream-selection rule are identical in both, and
    a source decoded in one pass produces timestamps comparable to a chunked run.
    """
    return audio_array(src, duration, ffmpeg=ffmpeg, no_ffmpeg=_pyav_decode_audio)


def transcribe(src: str, *, model_id: str, language: str = "", duration: float = 0.0,
               word_timestamps: bool = False, allow_download: bool = False,
               window_s: float | None = None, overlap_s: float = DEFAULT_OVERLAP_S,
               cancel: threading.Event | None = None,
               progress: Callable[[str, str], None] | None = None,
               ffmpeg: str = "", vad_filter: bool = True) -> Transcript:
    """Transcribe the selected audio track in bounded windows with source offsets.

    Timestamps in every returned segment are SOURCE time: a segment from the window
    starting at 50 s carries 50.something, not 0.something.

    `window_s` is a sentinel, not a default-with-a-value: passing it explicitly bounds
    memory even on a short source and forces the chunked path (which is the only path
    where offsets get exercised), while leaving it unset decodes a short source in one
    pass, which is the better quality choice when it fits.

    `vad_filter` gates the model on measured speech before it decodes. It defaults to
    True because that is the measured quality choice, not a preference: ungated, the
    pinned model emits "You" over digital silence and six "." segments over a tone, and
    gated it transcribes real speech with the same words (see the VAD block above for
    the numbers). `out.vad_state` records what actually happened, including the cases
    where gating could NOT run, and `out.vad_filter` records whether any window really
    ran gated. Coverage is unaffected either way: it reports decoded audio, not speech.
    """
    lang = normalize_language(language)
    table = published_languages()
    if lang and not language_is_supported(table, lang):
        raise BackendUnavailable(
            "unsupported_language",
            f"the pinned backend does not list {lang!r} in its published language table",
            "choose a backend whose published table covers this language, or accept that it is unsupported")

    model = load_model(model_id, allow_download=allow_download)
    device, compute_type = device_choice()
    out = Transcript(model=model_id, device=device, compute_type=compute_type,
                     word_timestamps=word_timestamps,
                     vad_state=("available" if vad_filter else "not_requested"))
    if vad_filter:
        out.vad_state = vad_asset_state()
    try_vad = out.vad_state == "available"

    explicit_window = window_s is not None
    window = DEFAULT_WINDOW_S if window_s is None else float(window_s)
    whole_file = 0.0 < duration <= MAX_WHOLE_FILE_S and not explicit_window
    if whole_file:
        audio = _audio_array(src, duration, ffmpeg=ffmpeg)
        runs = [(audio, 0.0)]
    else:
        windows = pcm_windows(duration or 0.0, window_s=window, overlap_s=overlap_s, src=src)
        if not windows:
            raise BackendUnavailable(
                "input_rejected",
                "no decodable window: the reported duration is zero",
                "probe the media again; a container with no audio track is not silence")
        runs = []
        for w in windows:
            if cancel is not None and cancel.is_set():
                break
            if progress:
                progress("extracting", f"decoding {w.start_s:.1f}s-{w.end_s:.1f}s")
            runs.append((_decode_window(src, w.start_s, w.end_s, ffmpeg=ffmpeg), w.start_s))

    seen_end = 0.0
    for audio, offset in runs:
        if cancel is not None and cancel.is_set():
            break
        if progress:
            progress("analysing", f"transcribing at {offset:.1f}s")
        segments_iter, info, vad_applied, vad_refusal = _transcribe_gated(
            model, audio, lang=lang, word_timestamps=word_timestamps, vad=try_vad)
        if vad_refusal:
            # The engine refused its OWN speech filter. Record which kind of refusal it
            # was, stop asking for the rest of this run, and keep the fact that the text
            # below therefore came from an ungated pass.
            out.vad_state = vad_refusal
            try_vad = False
        elif vad_applied:
            out.vad_state = "applied"
            out.vad_filter = True
        detected = detected_language_or_none(getattr(info, "language", None))
        if detected:
            out.language = detected
            out.language_source = "explicit" if lang else "detected"
            prob = getattr(info, "language_probability", None)
            out.language_probability = float(prob) if isinstance(prob, (int, float)) else None
        window_end = offset + (len(audio) / PCM_RATE_HZ if hasattr(audio, "__len__") else 0.0)
        for seg in segments_iter:
            start = float(seg.start) + offset
            end = float(seg.end) + offset
            text = (seg.text or "").strip()
            if not text:
                continue
            entry: dict[str, Any] = {"start": round(start, 3), "end": round(end, 3), "text": text}
            # Window provenance. Without it no later step can tell a complete reading from
            # one the chunking cut off mid-utterance. _merge_windows consumes this key and
            # removes it; it never reaches a payload.
            entry["_window"] = [round(offset, 3), round(window_end, 3)]
            if word_timestamps:
                entry["words"] = [{"word": (w.word or "").strip(),
                                   "start": round(float(w.start) + offset, 3),
                                   "end": round(float(w.end) + offset, 3),
                                   "probability": getattr(w, "probability", None)}
                                  for w in (seg.words or [])]
            out.segments.append(entry)
            seen_end = max(seen_end, end)
        # Six decimals, not three: rounding an examined span DOWN to a millisecond used to
        # manufacture an 84 us "unexamined" tail, which then made a complete run report
        # itself partial. Coverage honesty cuts both ways.
        out.examined.append((round(offset, 6), round(max(window_end, seen_end), 6)))

    if lang:
        out.language, out.language_source = lang, "explicit"
    out.duration = duration or seen_end
    merged, superseded = _merge_windows(out.segments, duration=out.duration)
    out.segments = merged
    out.superseded = superseded
    out.text = " ".join(s["text"] for s in merged).strip()
    # Completeness is a COVERAGE fact, not a "did the last segment nearly reach the end"
    # heuristic: a silent tail is still decoded audio, and a decoded pass that stops short
    # of the end is still partial even if its last segment is near the end.
    gaps = uncovered_gaps(out.duration, out.examined)
    out.complete = bool(out.examined) and not gaps
    if not merged:
        out.state = "no_speech"
        out.note = ("the selected track decoded and the model ran, but no speech was "
                    "transcribed; that is not the same as silence, a missing track, or a "
                    "failed run")
    else:
        out.note = (f"{len(merged)} segment(s); decoded window(s) "
                    f"{sum(b - a for a, b in out.examined):.3f}s of {out.duration:.3f}s; "
                    + (f"full track decoded (gaps under {COVERAGE_TOLERANCE_S * 1000:.2f} ms "
                       "are reporting rounding, not unexamined audio)" if out.complete else
                       f"partial: undecoded interval(s) "
                       f"{[(round(a, 3), round(b, 3)) for a, b in gaps]}; absence there is "
                       "unproven, not established"))
    out.note += _vad_note(out)
    if superseded:
        out.note += (f"; {len(superseded)} reading(s) cut off at a decode-window edge were "
                     "superseded by a complete reading of the same span (spans "
                     f"{[(round(s['start'], 2), round(s['end'], 2)) for s in superseded[:8]]})")
    return out

