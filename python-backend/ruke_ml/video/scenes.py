"""Temporal sampling. A bounded sample is a sample, never a completeness proof."""
from __future__ import annotations

import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any

from ..models.binaries import path_for

# Showinfo prints one line per selected frame, and the token `best_eff_pts_time:`
# CONTAINS `pts_time:`, so an unguarded search counts every cut twice. The
# lookbehind is the fix; a per-example regex would be the usual way this bug
# survives its first test. The optional run of spaces after the colon is not decoration
# either: showinfo pads its numeric fields, and a build that pads would otherwise
# scan as "no cuts" - the same false-completeness trap in a different costume.
_PTS_TIME = re.compile(r"(?<!best_eff_)pts_time:\s*(-?\d+(?:\.\d+)?)")
MAX_CUT_SCAN_CHARS = 2_000_000


def _pipe_text(value: Any) -> str:
    """A pipe's text, or "" when it is absent/binary.

    showinfo logs at AV_LOG_INFO on STDERR, and a timeout's partial output can be
    bytes rather than str. Both cases must be handled, or the scan reports "no cuts"
    for every clip on earth - which is what reading only `stdout` did.
    """
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str):
        return ""
    return value[:MAX_CUT_SCAN_CHARS] + "\n"


def parse_cut_timestamps(text: str) -> list[float]:
    """Cut times in SECONDS on the decode timeline, in ascending order, no repeats.

    This is the read side of the detection law: a command that nothing parses is
    decoration. Unknown/NaN stamps are skipped rather than turned into 0.0, which
    would invent a cut at the start of every clip.
    """
    seen: list[float] = []
    for match in _PTS_TIME.finditer(text[:MAX_CUT_SCAN_CHARS]):
        try:
            value = float(match.group(1))
        except ValueError:  # pragma: no cover - the regex only admits numerics
            continue
        if not seen or abs(value - seen[-1]) > 1e-6:
            seen.append(value)
    return seen


def apply_stream_offset(cuts: list[float], stream_start_offset: float) -> list[float]:
    """Move decode-timeline stamps onto the media timeline.

    A clip trimmed with a non-zero start has presentation timestamps that begin
    away from zero; answering "the logo appears at 12.3 s" for a player that shows
    14.8 s is a wrong answer no matter how exact the decoder was.
    """
    if not stream_start_offset:
        return list(cuts)
    return [max(0.0, c + stream_start_offset) for c in cuts]


@dataclass(slots=True)
class CutScan:
    """What a real scan actually saw, including how far it got."""
    cuts: list[float] = field(default_factory=list)
    scanned_seconds: float = 0.0
    threshold: float = 0.35
    truncated: bool = False
    error: str = ""
    detail: str = ""
    ffmpeg: str = ""
    elapsed_ms: int = 0

    @property
    def ok(self) -> bool:
        return not self.error


def scan_scene_cuts(src: str, duration: float = 0.0, threshold: float = 0.35,
                    timeout_s: float = 120.0, max_cuts: int = 2000,
                    stream_start_offset: float = 0.0) -> CutScan:
    """Decode the clip once and take the real cut timestamps out of the decode.

    Bounds are part of the contract, not a nicety: a bounded runtime, a bounded
    read and a bounded cut list mean a corrupt or enormous file cannot pin a worker.
    A scan that stops early reports truncated=True, which the caller must surface
    instead of claiming the whole timeline was examined.
    """
    exe = path_for("ffmpeg")
    if not exe:
        return CutScan(threshold=threshold, error="ffmpeg_not_installed",
                       detail="no validated ffmpeg copy (override, PATH or project-local)",
                       ffmpeg="")
    started = time.monotonic()
    cmd = ffmpeg_scene_command(src, threshold, ffmpeg=exe)
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s,
                              creationflags=flags)
    except subprocess.TimeoutExpired as exc:
        partial = parse_cut_timestamps(_pipe_text(exc.stderr) + _pipe_text(exc.stdout))
        return CutScan(cuts=apply_stream_offset(partial, stream_start_offset),
                       scanned_seconds=duration, threshold=threshold, truncated=True,
                       error="timeout", detail=f"{timeout_s}s decode deadline", ffmpeg=exe,
                       elapsed_ms=int((time.monotonic() - started) * 1000))
    except (OSError, ValueError) as exc:
        return CutScan(threshold=threshold, error="spawn_failed", detail=str(exc), ffmpeg=exe,
                       elapsed_ms=int((time.monotonic() - started) * 1000))
    raw = parse_cut_timestamps(_pipe_text(proc.stderr) + _pipe_text(proc.stdout))
    truncated = len(raw) > max_cuts
    cuts = apply_stream_offset(raw[:max_cuts], stream_start_offset)
    scan = CutScan(cuts=cuts, scanned_seconds=duration, threshold=threshold,
                   truncated=truncated, ffmpeg=exe,
                   elapsed_ms=int((time.monotonic() - started) * 1000))
    if proc.returncode != 0:
        scan.error = "decode_failed"
        scan.detail = (proc.stderr or "")[-500:]
    return scan


@dataclass(slots=True)
class Anchor:
    start: float
    end: float
    kind: str            # scene_cut | novelty | interval_query | head | middle | tail
    reason: str = ""


def ffmpeg_scene_command(src: str, threshold: float = 0.35,
                         ffmpeg: str | None = None) -> list[str]:
    """Real seek/decode command; scene cuts alone miss static lectures, so anchors are not enough.

    The executable is the copy the registry actually validated (override, PATH or
    project-local), so the command we BUILD is the command we CLAIM can run; when no copy
    is validated the bare token stays, and the registry reports the capability
    not_installed rather than pretending the spawn would succeed.

    Measured against the pinned ffmpeg (6.1.1): `-loglevel error` SUPPRESSES the
    showinfo lines we parse (they are AV_LOG_INFO) and showinfo writes to STDERR, so the
    original spelling produced an exit-0 scan with zero cuts - the most convincing kind
    of wrong answer. `-vsync v0` was also rejected outright by this build
    ("Expected number for vsync but found: v0"), so the modern `-fps_mode passthrough`
    is used, which keeps decoded timestamps instead of resampling them onto a fixed rate.
    """
    exe = ffmpeg or path_for("ffmpeg") or "ffmpeg"
    return [exe, "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin", "-i", src,
            "-vf", f"select=gt(scene\\,{threshold}),showinfo", "-fps_mode", "passthrough",
            "-f", "null", "-"]


def anchors(duration: float, cuts: list[float] | None = None, max_anchors: int = 12) -> list[Anchor]:
    """Head/middle/tail + scene cuts + equal-interval coverage, bounded by max_anchors."""
    if duration <= 0:
        return []
    out: list[Anchor] = []
    for c in cuts or []:
        if 0 <= c < duration:
            out.append(Anchor(c, min(duration, c + 2.0), "scene_cut", "detected cut"))
    for label, at in (("head", 0.0), ("middle", duration / 2), ("tail", max(0.0, duration - 3.0))):
        out.append(Anchor(at, min(duration, at + 3.0), label, f"{label} coverage"))
    step = max(1.0, duration / max(1, max_anchors))
    t = 0.0
    while t < duration and len(out) < max_anchors * 2:
        out.append(Anchor(t, min(duration, t + step), "novelty", "interval coverage"))
        t += step
    out.sort(key=lambda a: a.start)
    merged: list[Anchor] = []
    for a in out:
        if merged and a.start <= merged[-1].end:
            if a.kind != merged[-1].kind:
                merged[-1].reason += " + " + a.kind
            continue
        merged.append(a)
    return merged[: max_anchors]


@dataclass(slots=True)
class Plan:
    windows: list[Anchor] = field(default_factory=list)
    deduped: int = 0
    honest_note: str = ""


def sample_windows(duration: float, query_windows: list[tuple[float, float]] | None = None,
                   cuts: list[float] | None = None, budget: int = 12,
                   separate_ranges: bool = False) -> Plan:
    """Query-directed windows win; comparative requests stay SEPARATE ranges, not one span.

    separate_ranges=True keeps two asked-about intervals as two intervals. Merging them
    into one continuous span would silently claim evidence in the gap that was never read.
    """
    wins: list[Anchor] = []
    for a, b in query_windows or []:
        if a > b:
            a, b = b, a
        wins.append(Anchor(max(0.0, a), min(duration, b), "interval_query", "explicit request"))
    if not separate_ranges and len(wins) > 1:
        lo, hi = min(w.start for w in wins), max(w.end for w in wins)
        wins = [Anchor(lo, hi, "interval_query", "merged continuous span")]
    if len(wins) < budget:
        for a in anchors(duration, cuts, max(1, budget - len(wins))):
            wins.append(a)
    wins.sort(key=lambda w: w.start)
    deduped = 0
    out: list[Anchor] = []
    for w in wins:
        if out and w.start < out[-1].end and not (separate_ranges and w.kind == "interval_query"):
            deduped += 1
            continue
        out.append(w)
    note = (f"examined {sum(min(duration, w.end) - max(0.0, w.start) for w in out):.1f}s of "
            f"{duration:.1f}s; unexamined intervals may contain further occurrences")
    return Plan(windows=out[: max(1, budget)], deduped=deduped, honest_note=note)


def observation_key(frame_digest: str, scene_id: str = "") -> str:
    """Cheap dedupe for EXPENSIVE analysis while every temporal occurrence is still recorded."""
    return f"{scene_id}:{frame_digest}"


def provenance(frame_ref: str, at: float, provider: str = "") -> dict[str, Any]:
    return {"frame_ref": frame_ref, "start": at, "provider": provider, "timebase": "presentation"}
