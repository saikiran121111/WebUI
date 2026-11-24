"""The shared ASR adapter contract: Transcript, coverage law, window-merge law, decode.

Every speech adapter (whisper_ct2, parakeet_tdt, granite_speech, qwen3_asr) returns the
same Transcript and classifies failure with the same typed BackendUnavailable, so the
job layer never needs to know which engine ran. This module is model-agnostic by
construction: it imports no ASR package, only ffmpeg decoding and the stdlib.

The laws it encodes are measured, not stylistic, and are documented at each rule:
  * bounded decode windows with EXPLICIT source offsets (asr.pcm_windows states the
    same law for the command line);
  * coverage is what was DECODED, never what contained speech, with rounding tolerance
    separated from real shortfalls;
  * a reading our own chunking cut at a window edge is superseded only by a complete
    reading of the same span, and is REPORTED, never silently dropped.

whisper_ct2 re-exports everything here, so its public surface is unchanged.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from typing import Any, Callable

from .. import allocations, processes
from .asr import PCM_RATE_HZ, pcm_command

MAX_RETAINED_SEGMENTS = 20000
# Examined spans are REPORTED at millisecond resolution and the decoder resamples to
# 16 kHz, so a run that decoded to the end of the source can still leave a sub-millisecond
# "gap" against the container duration. Calling that unexamined audio would be false:
# it is rounding. Anything larger is a real gap and stays reported.
COVERAGE_TOLERANCE_S = 0.001 + 1.0 / PCM_RATE_HZ   # ms reporting rounding + one 16 kHz frame

# ---------------------------------------------------------------- window boundaries
# A decode window ENDS in the middle of the source. An utterance that runs past that end
# gets a truncated reading whose span stops at the window edge, while a later window that
# contains the whole utterance produces the complete reading of the SAME audio. Measured
# on the pinned engine (F58c, real run, evidence docs/overnight/logs
# /e03-speech-20261117T18323288777.json, long.wav with window_s=12): the window ending at
# 19.3 s emitted "Embrose Finch Park, DeMarune Bicycle Behind" at 16.3-19.3 s and the
# window [14.0, 21.7] emitted the complete "Embrose Finch parked a maroon bicycle behind
# the lighthouse at quarter past nine." at 16.26-21.26 s. Both used to be kept, so the
# transcript carried the same sentence twice, once cut off mid-word.
# The rule that fixes it is STRUCTURAL, not text similarity (a truncated reading rarely
# matches the complete one word-for-word): a span that reaches a window edge which is NOT
# the end of the source was cut by our own chunking, so it is not evidence about some
# other part of the recording.
BOUNDARY_CLIP_TOLERANCE_S = 0.35   # this close to a window edge counts as reaching it
SUPERSEDED_COVER_FRACTION = 0.9    # the uncut reading must cover this much of the fragment
MAX_REPORTED_SUPERSEDED = 24

# Terminal states for Transcript.vad_state. "available" is interim: the asset is
# present and gating was requested, but no window had run yet (a cancelled run).
VAD_STATES = ("not_requested", "available", "applied", "asset_missing", "runtime_missing",
              "unsupported_by_backend", "backend_rejected")


class BackendUnavailable(Exception):
    """Typed, actionable: dependency missing, asset missing, or host cannot run it."""

    def __init__(self, kind: str, detail: str, human_step: str = "") -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.human_step = human_step


@dataclass(slots=True)
class Transcript:
    """What a run actually produced, plus how much of the source it actually covered."""
    text: str = ""
    segments: list[dict[str, Any]] = field(default_factory=list)
    language: str = ""
    language_source: str = ""          # explicit | detected | none
    language_probability: float | None = None
    duration: float = 0.0
    examined: list[tuple[float, float]] = field(default_factory=list)
    complete: bool = False
    state: str = "transcribed"         # transcribed | no_speech
    note: str = ""
    model: str = ""
    device: str = ""
    compute_type: str = ""
    word_timestamps: bool = False
    vad_filter: bool = False           # did a window ACTUALLY run speech-gated?
    vad_state: str = ""                # one of VAD_STATES, what gating actually did
    superseded: list[dict[str, Any]] = field(default_factory=list)

    def as_payload(self) -> dict[str, Any]:
        return {"state": self.state, "text": self.text,
                "segments": self.segments[:MAX_RETAINED_SEGMENTS],
                "segment_count": len(self.segments), "language": self.language,
                "language_source": self.language_source,
                "language_probability": self.language_probability,
                "duration": self.duration, "examined": [[a, b] for a, b in self.examined],
                "complete": self.complete, "note": self.note,
                "model": self.model, "device": self.device, "compute_type": self.compute_type,
                "word_timestamps": self.word_timestamps,
                "vad_filter": self.vad_filter, "vad_state": self.vad_state,
                # Window-boundary fragments this run discarded because a complete reading
                # of the same span existed. Reported, never silently dropped.
                "superseded_fragments": len(self.superseded),
                "superseded": self.superseded[:MAX_REPORTED_SUPERSEDED]}


def uncovered_gaps(duration: float, examined: list[tuple[float, float]],
                   *, tol_s: float = COVERAGE_TOLERANCE_S) -> list[tuple[float, float]]:
    """Intervals this run never decoded, with sub-tolerance rounding gaps discarded.

    A gap is only reported when it exceeds the reporting/quantisation tolerance, because
    the alternative - reporting every microsecond of resampler drift as "unexamined audio" -
    makes an honest complete run look partial, which trains callers to ignore coverage
    fields. Real shortfalls stay visible at full size.
    """
    if duration <= 0:
        return []
    spans = sorted((max(0.0, float(a)), min(float(duration), float(b)))
                   for a, b in examined if float(b) > float(a))
    out: list[tuple[float, float]] = []
    cursor = 0.0
    for a, b in spans:
        if a - cursor > tol_s:
            out.append((cursor, a))
        cursor = max(cursor, b)
    if duration - cursor > tol_s:
        out.append((cursor, duration))
    return out


def _window_edge_clipped(seg: dict[str, Any], window: Any, duration: float) -> str:
    """Return "end"/"start"/"" for a span our own chunking cut off at a window edge.

    An edge that coincides with the start or end of the SOURCE is not a cut: there is no
    more audio on that side, so a segment reaching it is complete, not truncated.
    """
    if not window or len(window) != 2:
        return ""
    wstart, wend = float(window[0]), float(window[1])
    start, end = float(seg["start"]), float(seg["end"])
    if wend < duration - BOUNDARY_CLIP_TOLERANCE_S and end >= wend - BOUNDARY_CLIP_TOLERANCE_S:
        return "end"
    if wstart > BOUNDARY_CLIP_TOLERANCE_S and start <= wstart + BOUNDARY_CLIP_TOLERANCE_S:
        return "start"
    return ""


def _dedupe_exact(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort by source time and drop only PROVEN identical duplicates.

    Two genuinely repeated sentences also exist, so only identical text whose span is
    fully inside an already covered region counts as the duplicate; legitimate repetition
    at a different source time survives.
    """
    out: list[dict[str, Any]] = []
    covered_until = -1.0
    for seg in sorted(segments, key=lambda s: (s["start"], s["end"])):
        if seg["end"] <= covered_until and out and any(
                o["text"] == seg["text"] and o["end"] <= covered_until for o in out[-8:]):
            continue
        out.append(seg)
        covered_until = max(covered_until, seg["end"])
    return out


def _merge_windows(segments: list[dict[str, Any]], *,
                   duration: float = 0.0) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Merge bounded-window readings: (kept segments, superseded fragments).

    Three rules, each provable from the run's own provenance and none from text content:

    1. a reading whose span reaches a window edge that is not the end of the source was
       truncated by our chunking. If an UTRUNCATED reading of the same span exists, the
       fragment is the weaker view of audio already transcribed in full, so the complete
       reading is kept and the fragment is REPORTED, not silently discarded;
    2. a fragment with no untruncated covering reading stays in the transcript - partial
       evidence beats none - but carries `window_truncated: true` so no caller can read
       its cut-off last word as the end of the sentence;
    3. identical text inside already-covered time is the same utterance read twice by
       overlapping windows and is dropped (see _dedupe_exact).

    Readings from the SAME window are never merged with each other: one window does not
    emit two readings of the same interval, so overlapping spans inside one window are
    kept as they came.
    """
    plain: list[dict[str, Any]] = []
    fragments: list[tuple[str, dict[str, Any], Any]] = []
    window_of: dict[int, Any] = {}      # id(segment) -> its decode window, for provenance
    for seg in segments:
        window = seg.pop("_window", None)
        window_of[id(seg)] = window
        edge = _window_edge_clipped(seg, window, float(duration or 0.0))
        if edge:
            fragments.append((edge, seg, window))
        else:
            plain.append(seg)
    kept = _dedupe_exact(plain)
    superseded: list[dict[str, Any]] = []
    rescued: list[dict[str, Any]] = []
    for edge, seg, window in fragments:
        start, end = float(seg["start"]), float(seg["end"])
        span = max(0.001, end - start)
        keeper = None
        for other in kept:
            # Readings from the SAME window never supersede each other: one window does
            # not transcribe the same interval twice, so an overlap inside one window is
            # two different spans of audio, not a duplicate reading.
            if window and window_of.get(id(other)) == window:
                continue
            overlap = min(end, float(other["end"])) - max(start, float(other["start"]))
            if overlap / span >= SUPERSEDED_COVER_FRACTION:
                # The covering reading must have real audio beyond the edge this one was
                # cut at, otherwise both are truncated views and neither supersedes the
                # other.
                if edge == "end" and float(other["end"]) > end + BOUNDARY_CLIP_TOLERANCE_S:
                    keeper = other
                    break
                if edge == "start" and float(other["start"]) < start - BOUNDARY_CLIP_TOLERANCE_S:
                    keeper = other
                    break
        if keeper is not None:
            superseded.append({"start": seg["start"], "end": seg["end"], "text": seg["text"],
                               "window": list(window) if window else [],
                               "cut_at": edge,
                               "superseded_by": {"start": keeper["start"], "end": keeper["end"]},
                               "reason": ("the span reaches the end of its decode window and "
                                          "another reading covers it with audio beyond that "
                                          "edge: the fragment was cut by chunking, not by the "
                                          "end of the sentence")})
            continue
        seg["window_truncated"] = True
        rescued.append(seg)
    return _dedupe_exact(kept + rescued), superseded


def decode_window(src: str, start_s: float, end_s: float, *, ffmpeg: str) -> Any:
    """Decode one bounded window to float32 mono 16 kHz, in memory."""
    import numpy as np                                # noqa: PLC0415
    from ..models import binaries
    cmd = pcm_command(src, start_s=start_s, duration_s=end_s - start_s, rate=PCM_RATE_HZ)
    # Measured defect (F17 E03-C2): the windowed path used a bare "ffmpeg", which is NOT
    # on PATH on this host, so every chunked transcription failed with WinError 2 while
    # the whole-file path succeeded because it resolves the project-local copy. Both
    # paths must resolve the same way, or "works on short files" is a false pass.
    exe = ffmpeg or binaries.path_for("ffmpeg")
    if not exe:
        raise BackendUnavailable(
            "decode_failed",
            "no ffmpeg could be resolved for decoding (bare 'ffmpeg' is not on PATH here)",
            "run npm install / point RUKE_FFMPEG at a validated ffmpeg.exe so "
            "ruke_ml.models.binaries can resolve it")
    cmd[0] = exe
    try:
        proc = processes.run_captured(cmd, timeout=600)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BackendUnavailable("decode_failed", f"ffmpeg could not run: {exc}",
                                 "install/validate ffmpeg for decoding") from exc
    if proc.returncode != 0:
        raise BackendUnavailable(
            "decode_failed",
            f"ffmpeg exited {proc.returncode}: {(proc.stderr or b'')[-400:]!r}",
            "the media could not be decoded; check the container and the audio track")
    raw = proc.stdout or b""
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def audio_array(src: str, duration: float, *, ffmpeg: str = "",
                no_ffmpeg: Callable[[str], Any] | None = None) -> Any:
    """Decode the whole short source to float32 mono, in memory.

    Measured defect (F14, real engine run): the whisper path used a helper the pinned
    release does not export, so every short-file transcription failed before the model
    could even be exercised. The whole-file path therefore uses the SAME ffmpeg decoder
    as the windowed path, so the sample rate, channel layout and stream-selection rule
    are identical in both, and a source decoded in one pass produces timestamps
    comparable to a chunked run. A backend may pass `no_ffmpeg`: a documented fallback
    for a host with no validated ffmpeg copy, and its failure must say WHY the fallback
    cannot run, never hide it.
    """
    from ..models import binaries                  # noqa: PLC0415 - lazy by design
    exe = ffmpeg or binaries.path_for("ffmpeg")
    if exe:
        return decode_window(src, 0.0, float(duration), ffmpeg=exe)
    if no_ffmpeg is None:
        raise BackendUnavailable(
            "decode_failed",
            "no validated ffmpeg copy is resolvable and this backend provides no "
            "documented decode fallback",
            "install/validate ffmpeg (ruke_ml.models.binaries) or pin an ASR backend "
            "whose documented decode API exists")
    return no_ffmpeg(src)
