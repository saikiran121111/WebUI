"""Media jobs that need BOTH a decoder and an analyser: frame OCR (video.frame_ocr).

The five facts this module refuses to merge, in the same spirit as speech_jobs:

    the container has no video stream  !=  the decoder failed at that instant
    the frame decoded but had no glyphs != the recogniser failed
    the recogniser is not installed     != the recording has no text

A video whose mp4 carries only audio is a STRUCTURAL routing fact and gets a typed refusal;
it is not "a video with no text on screen", and reporting it as one is how an audio-only
file ends up with an empty-but-successful visual finding.
"""
from __future__ import annotations

from typing import Any

from ..contracts import Coverage
from ..models.registry import catalog
from .jobs import JobContext


def _resolve_media(ctx: JobContext) -> Any:
    """Media path resolved strictly inside the caller-supplied allowed root, or None."""
    from ..security import resolve_within
    path = str(ctx.req.payload.get("path", ""))
    root = str(ctx.req.payload.get("root", ""))
    if not path or not root:
        ctx.progress("input_rejected", "video jobs need path and root")
        return None
    try:
        target = resolve_within(path, root)
    except Exception as exc:                        # noqa: BLE001 - path policy refusal
        ctx.progress("input_rejected", f"path refused: {exc}")
        return None
    if not target.exists():
        ctx.progress("input_rejected", "file not found inside the allowed root")
        return None
    return target


def _typed(ctx: JobContext, exc: Any) -> Any:
    from .jobs import typed_from_kind
    err = typed_from_kind(getattr(exc, "kind", ""), str(getattr(exc, "detail", exc)),
                          human_step=str(getattr(exc, "human_step", "") or ""),
                          capability=ctx.req.capability)
    return ctx.failed(err.reason, err.message, retryable=err.retryable, human_step=err.human_step)


def _requested_times(ctx: JobContext, duration: float) -> tuple[list[float], str]:
    """Explicit instants, or a bounded head/middle/tail plan when the caller asked for one.

    The plan is labelled as a PLAN in the returned note: it is a decision about where to
    look, never evidence about what is there.
    """
    raw = ctx.req.payload.get("times")
    if isinstance(raw, list) and raw:
        try:
            return [float(x) for x in raw], "requested explicitly by the caller"
        except (TypeError, ValueError):
            return [], "rejected: times must be numbers"
    if not ctx.req.payload.get("plan"):
        return [], "none: pass times, or pass plan=true to get a bounded sample"
    from ..video import scenes
    cuts = [float(x) for x in (ctx.req.payload.get("cuts") or [])]
    picked: list[float] = []
    for anchor in scenes.anchors(duration, cuts):
        mid = round((anchor.start + anchor.end) / 2.0, 3)
        if 0.0 <= mid <= duration and mid not in picked:
            picked.append(mid)
    return picked, (f"bounded head/middle/tail plan over a {duration:.1f}s source "
                    f"({len(picked)} instants); a plan is not coverage")


def frame_ocr_job(ctx: JobContext) -> Any:
    """Decode one frame per requested instant and read the text in it."""
    from ..documents.ocr_tesseract import OcrUnavailable
    from ..speech import asr
    from ..video import frame_ocr
    target = _resolve_media(ctx)
    if target is None:
        return ctx.failed("input_rejected",
                          "video.frame_ocr needs a path and a root inside the allowed upload root",
                          human_step="pass the uploaded media path and its allowed root")
    language = str(ctx.req.payload.get("language", "") or "").strip()
    if not language:
        return ctx.failed("input_rejected",
                          "video.frame_ocr needs an explicit text language for the frames",
                          human_step="pass payload.language as an ISO tag; the engine never "
                                     "defaults to English, which is how non-Latin slides come "
                                     "back as Latin noise")
    if ctx.cancel.is_set():
        return ctx.cancelled()

    probe = asr.probe_media(str(target), ffprobe=str(ctx.req.payload.get("ffprobe", "") or ""))
    if not probe["ok"]:
        return ctx.failed("corrupt_input", probe["error"],
                          human_step=probe.get("human_step", "") or "the media could not be probed")
    if not int(probe.get("video_streams", 0) or 0):
        # Structural, not perceptual: there is no picture to read, so no amount of OCR
        # sampling would produce a finding. (This is the same probe that proves an mp4-family
        # container can be audio-only.)
        return ctx.failed("unsupported_input",
                          f"the container carries no video stream, so there is no frame to read "
                          f"(audio streams: {probe.get('audio_state', 'unknown')})",
                          human_step="run the speech capability on this file instead; frame OCR "
                                     "requires a decoded picture")
    duration = float(ctx.req.payload.get("duration", 0.0) or probe.get("duration", 0.0) or 0.0)
    times, plan_note = _requested_times(ctx, duration)
    if not times:
        return ctx.failed("input_rejected", f"no frame times to read ({plan_note})",
                          human_step="pass payload.times as source-relative seconds, or "
                                     "plan=true for a bounded sample")

    ctx.progress("extracting", f"{len(times)} frame(s), language={language}")
    try:
        readings, report = frame_ocr.ocr_frames(
            str(target), times, language=language, duration=duration,
            ffmpeg=str(ctx.req.payload.get("ffmpeg", "") or ""),
            cancel=ctx.cancel.is_set,
            progress=lambda state, note: ctx.progress(state, note),
            deadline_at=ctx.deadline_at(),
            max_frames=int(ctx.req.payload.get("max_frames", frame_ocr.MAX_FRAMES)))
    except (OcrUnavailable, frame_ocr.FrameDecodeFailed) as exc:
        return _typed(ctx, exc)

    read = [r for r in readings if r.state == "recognised"]
    glyph_free = [r for r in readings if r.state == "empty"]
    unresolved = [r for r in readings if r.unresolved]
    if ctx.cancel.is_set() and not read and not glyph_free:
        return ctx.cancelled()

    instants = [(r.time_s, r.time_s) for r in readings if r.read or r.state == "empty"]
    note = (f"{len(read)} of {len(readings)} sampled instant(s) yielded text; "
            f"{len(glyph_free)} decoded frame(s) carried no glyph; "
            f"{len(unresolved)} unresolved. {report['note']} Sampling basis: {plan_note}.")
    return ctx.ready(
        {"frames": [r.to_dict() for r in readings],
         "blocks": [{"start": r.time_s, "end": r.time_s, "text": r.text,
                     "confidence": r.confidence, "engine": r.engine,
                     "language_code": r.language_code, "frame_digest": r.digest}
                    for r in read],
         "ocr": report,
         "language": language,
         "duration": duration,
         "probe": {"duration": duration, "video_streams": probe.get("video_streams"),
                   "audio_state": probe.get("audio_state"),
                   "rotation_deg": probe.get("rotation_deg"),
                   "stream_start_offsets": probe.get("stream_start_offsets"),
                   "subtitle_tracks": probe.get("subtitle_tracks")},
         "sampling_note": plan_note,
         "stage_counts": {"planned": report["planned"], "decoded": report["decoded"],
                          "recognised": report["recognised"],
                          "glyph_free": report["glyph_free"],
                          "duplicates": report["duplicates"],
                          "unresolved": len(unresolved)},
         "note": note},
        coverage=Coverage(units="instants", total_source=duration,
                          examined=instants,
                          skipped=[(0.0, duration)] if duration > 0 else [],
                          complete=False,
                          note=("examined entries are zero-width SAMPLED INSTANTS at which a "
                                "frame was decoded and read; sampling instants examines no "
                                "interval, so the timeline is reported as not examined. " +
                                report["note"])),
        model=None)
