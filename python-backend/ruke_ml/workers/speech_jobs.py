"""Real ASR / alignment / diarization jobs, gated on readiness, never on a status string.

The distinction this module must keep loud: NO AUDIO TRACK, SILENCE, NO SPEECH, FAILED
DECODE and UNSUPPORTED LANGUAGE are five different facts. Collapsing them into one
"empty result" is how a missing track becomes a false transcript and a failed run becomes
"there was nothing to say".
"""
from __future__ import annotations

from typing import Any

from ..contracts import Coverage, ModelIdentity, StructuredError
from ..models.registry import catalog
from .jobs import JobContext, typed_from_kind


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
    from ..speech import asr, whisper_ct2
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
    model_id = str(ctx.req.payload.get("model", "") or "") or str(route.get("model") or "")
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
    if model_id not in executable_ids:
        return ctx.failed("model_unavailable",
                          f"{model_id} is not executable on this host (executable rows: "
                          f"{', '.join(executable_ids) or 'none'})",
                          human_step="python -m ruke_ml.models.prepare --model " + model_id)

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
    try:
        transcript = whisper_ct2.transcribe(
            str(target), model_id=model_id, language=language, duration=duration,
            word_timestamps=word_timestamps,
            allow_download=bool(ctx.req.payload.get("allow_download", False)),
            cancel=ctx.cancel,
            progress=lambda state, note: ctx.progress(state, note), **kwargs)
    except whisper_ct2.BackendUnavailable as exc:
        return _typed(ctx, exc)
    if ctx.cancel.is_set():
        return ctx.cancelled()

    coverage = Coverage(units="seconds", total_source=duration or transcript.duration,
                        examined=list(transcript.examined),
                        skipped=_uncovered(duration, transcript.examined),
                        complete=transcript.complete,
                        note=transcript.note or "bounded windows: unexamined audio cannot prove absence")
    identity = ModelIdentity(id=model_id, revision=str(_revision(model_id)), provider="huggingface",
                             quantization=transcript.compute_type or "")
    payload = transcript.as_payload()
    payload["probe"] = {"duration": duration, "audio_state": probe["audio_state"],
                        "selected_audio": probe["selected_audio"],
                        "stream_start_offsets": probe["stream_start_offsets"],
                        "subtitle_tracks": probe["subtitle_tracks"]}
    payload["audio_level"] = level.as_dict()
    payload["routing"] = {"decision": route["decision"], "quality_mode": route["quality_mode"],
                          "note": route["note"]}
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


def _revision(model_id: str) -> str:
    spec = catalog().get(model_id, "speech.asr")
    return spec.revision if spec else "unknown"


def _uncovered(duration: float, examined: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """The intervals this run never decoded. Absence there is unproven, not established."""
    from ..speech import whisper_ct2            # noqa: PLC0415 - lazy by design
    # One rule, shared with the adapter that produced the spans: sub-tolerance rounding is
    # not an unexamined interval, and anything larger is reported in full.
    return whisper_ct2.uncovered_gaps(duration, examined)


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
