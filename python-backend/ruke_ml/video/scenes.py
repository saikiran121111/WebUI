"""Temporal sampling. A bounded sample is a sample, never a completeness proof."""
from __future__ import annotations

import math
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .. import processes
from ..models.binaries import path_for

# Showinfo prints one line per selected frame, and the token `best_eff_pts_time:`
# CONTAINS `pts_time:`, so an unguarded search counts every cut twice. The
# lookbehind is the fix; a per-example regex would be the usual way this bug
# survives its first test. The optional run of spaces after the colon is not decoration
# either: showinfo pads its numeric fields, and a build that pads would otherwise
# scan as "no cuts" - the same false-completeness trap in a different costume.
_PTS_TIME = re.compile(r"(?<!best_eff_)pts_time:\s*(-?\d+(?:\.\d+)?)")
MAX_CUT_SCAN_CHARS = 2_000_000
# ffmpeg's own `-progress` machine stream is small (one key=value block per stats
# tick), so its bound is an order of magnitude tighter than the showinfo log bound.
MAX_PROGRESS_CHARS = 400_000
_DRAIN_JOIN_S = 2.0
_KILL_WAIT_S = 5.0


class _PipeBuffer:
    """A bounded, thread-safe-ish accumulator for one subprocess pipe.

    The drain thread keeps READING even after the cap is reached. Stopping the reads
    is how a chatty decoder deadlocks a parent that only waits on exit: ffmpeg fills
    its own pipe and blocks forever, and a blocked decoder is neither a pass nor a
    timeout - it is a hung worker. `capped` records that we saw more than we kept.
    """
    __slots__ = ("kept", "cap", "capped", "bytes_seen")

    def __init__(self, cap: int) -> None:
        self.kept = bytearray()
        self.cap = cap
        self.capped = False
        self.bytes_seen = 0

    def extend(self, chunk: bytes) -> None:
        self.bytes_seen += len(chunk)
        room = self.cap - len(self.kept)
        if room > 0:
            self.kept.extend(chunk[:room])
        if len(chunk) > room:
            self.capped = True

    def text(self) -> str:
        # A truncated tail can split a timestamp mid-token, so the keep-bound is where
        # the parse stops; a partial last line simply fails to match and is dropped.
        return self.kept.decode("utf-8", "replace")


def _drain_pipe(stream: Any, buf: _PipeBuffer) -> None:
    """Drain one pipe to EOF on its own thread. Never raises into the scan."""
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
    except (OSError, ValueError):  # pragma: no cover - the pipe died mid-scan
        pass
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass


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
    """What a real scan actually saw, including how far the DECODER got.

    `scanned_seconds` is a MEASURED prefix, never a stand-in for the clip length. It
    comes from ffmpeg's own machine-readable progress stream, so it is independent of
    which frames the scene filter selected. `prefix_measured` says whether that number
    is a measurement at all; when it is False the value is 0.0 and the honest reading
    is "unknown how far we got", which is what stopped callers from re-asking.
    """
    cuts: list[float] = field(default_factory=list)
    scanned_seconds: float = 0.0
    prefix_measured: bool = False
    threshold: float = 0.35
    truncated: bool = False
    error: str = ""
    detail: str = ""
    ffmpeg: str = ""
    elapsed_ms: int = 0
    progress_updates: int = 0
    log_chars: int = 0
    log_capped: bool = False

    @property
    def ok(self) -> bool:
        return not self.error


def measured_prefix_end(
    value: object,
    duration: float,
    *,
    measured: bool,
) -> float:
    """The end of the timeline we may honestly claim as decoded.

    The `measured` flag must come from a real decoder measurement, never from an
    assumption, so an unmeasured value yields 0.0 rather than "the clip is 120s, so
    presumably we got to 120s". Booleans are rejected because bool IS an int in
    python and True would otherwise measure as a 1-second prefix.
    """
    if not measured or isinstance(value, bool):
        return 0.0

    try:
        end = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0

    if not math.isfinite(end) or not math.isfinite(duration):
        return 0.0

    return min(max(end, 0.0), max(duration, 0.0))


_PROGRESS_US = re.compile(r"out_time_us=(-?\d+)")
_PROGRESS_HMS = re.compile(r"out_time=(\d+):(\d{2}):(\d{2})(?:\.(\d+))?")


def parse_decoder_progress(text: str) -> tuple[float, int]:
    """(seconds decoded per ffmpeg's own report, number of progress updates).

    Returns (0.0, count) when the machine stream said nothing usable. The caller must
    treat count==0 as "unmeasured", not as "decoded nothing"; a scan that never got a
    progress tick has no proven prefix at all.
    """
    us = 0.0
    updates = 0
    for match in _PROGRESS_US.finditer(text):
        updates += 1
        us = float(match.group(1))
    if updates:
        return us / 1_000_000.0, updates
    stamps = list(_PROGRESS_HMS.finditer(text))
    if not stamps:
        return 0.0, 0
    last = stamps[-1]
    seconds = (int(last.group(1)) * 3600 + int(last.group(2)) * 60 + int(last.group(3))
               + float("0." + (last.group(4) or "0")))
    return seconds, len(stamps)


def scan_scene_cuts(src: str, duration: float = 0.0, threshold: float = 0.35,
                    timeout_s: float = 120.0, max_cuts: int = 2000,
                    stream_start_offset: float = 0.0) -> CutScan:
    """Decode the clip once and take the real cut timestamps out of the decode.

    Bounds are part of the contract, not a nicety: a bounded runtime, a bounded
    read and a bounded cut list mean a corrupt or enormous file cannot pin a worker.
    A scan that stops early reports truncated=True, which the caller must surface
    instead of claiming the whole timeline was examined.

    Two pipes, two threads. Reading only one pipe deadlocks a chatty decoder, and
    reading `subprocess.run`'s timeout-time partial output cannot tell us how far the
    decoder reached, so progress comes from ffmpeg's `-progress` machine stream while
    BOTH pipes are drained continuously into bounded buffers. On a deadline the scan
    reports the measured prefix (or unmeasured), never the clip duration: the last
    detected cut and the container length are both proofs of something else.
    """
    exe = path_for("ffmpeg")
    if not exe:
        return CutScan(threshold=threshold, error="ffmpeg_not_installed",
                       detail="no validated ffmpeg copy (override, PATH or project-local)",
                       ffmpeg="")
    started = time.monotonic()
    cmd = ffmpeg_scene_command(src, threshold, ffmpeg=exe)
    logs = _PipeBuffer(MAX_CUT_SCAN_CHARS)
    progress = _PipeBuffer(MAX_PROGRESS_CHARS)
    try:
        # stdin is closed off even though this command also carries -nostdin: inside a
        # capability worker the inherited stdin is the owner's request pipe.
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                **processes.spawn_kwargs())
    except (OSError, ValueError) as exc:
        return CutScan(threshold=threshold, error="spawn_failed", detail=str(exc), ffmpeg=exe,
                       elapsed_ms=int((time.monotonic() - started) * 1000))

    threads = [threading.Thread(target=_drain_pipe, args=(proc.stdout, progress), daemon=True),
               threading.Thread(target=_drain_pipe, args=(proc.stderr, logs), daemon=True)]
    for t in threads:
        t.start()

    timed_out = False
    returncode: int | None
    try:
        returncode = proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            proc.kill()
        except OSError:  # pragma: no cover - already gone
            pass
        try:
            returncode = proc.wait(timeout=_KILL_WAIT_S)
        except subprocess.TimeoutExpired:
            returncode = None
    for t in threads:
        t.join(timeout=_DRAIN_JOIN_S)

    log_text = logs.text()
    progress_text = progress.text()
    raw = parse_cut_timestamps(log_text + progress_text)
    progress_seconds, updates = parse_decoder_progress(progress_text)
    # A cut list that hit its cap, a log that hit its cap, or a deadline all mean the
    # same thing to a caller: what we found is not everything there was.
    truncated = timed_out or len(raw) > max_cuts or logs.capped or progress.capped
    scan = CutScan(cuts=apply_stream_offset(raw[:max_cuts], stream_start_offset),
                   scanned_seconds=measured_prefix_end(progress_seconds, duration,
                                                       measured=bool(updates)),
                   prefix_measured=bool(updates),
                   threshold=threshold, truncated=truncated, ffmpeg=exe,
                   progress_updates=updates, log_chars=logs.bytes_seen, log_capped=logs.capped,
                   elapsed_ms=int((time.monotonic() - started) * 1000))
    if timed_out:
        scan.error = "timeout"
        scan.detail = (f"{timeout_s}s decode deadline; "
                       + (f"decoder progress reached {scan.scanned_seconds:.1f}s"
                          if scan.prefix_measured else "decoder progress unmeasured"))
    elif returncode not in (0, None):
        scan.error = "decode_failed"
        scan.detail = log_text[-500:]
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

    Measured on the same build (why the filter graph looks like this): `-progress pipe:1`
    reports the timestamp of the last frame that reached each MUXER. When the only output
    is the select-filtered stream, progress stops at the last SELECTED frame - on the
    declared 12.0 s probe clip it froze at 9.0 s, three seconds short of the real decode
    endpoint. The second branch (`null`) consumes EVERY decoded frame, and that branch is
    what carries the honest progress reading (measured 11.9 s = last frame start, i.e. all
    120 frames of a 10 fps 12 s clip). Cutting a corner here is precisely how a scan
    reports "examined the whole timeline" while never decoding the tail.
    """
    exe = ffmpeg or path_for("ffmpeg") or "ffmpeg"
    graph = (f"[0:v]split=2[scene][decode];[scene]select=gt(scene\\,{threshold}),showinfo[cuts];"
             "[decode]null[progress]")
    return [exe, "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin", "-i", src,
            "-filter_complex", graph,
            "-map", "[cuts]", "-fps_mode", "passthrough", "-f", "null", "-",
            "-map", "[progress]", "-fps_mode", "passthrough", "-f", "null", "-",
            "-progress", "pipe:1"]


def anchors(duration: float, cuts: list[float] | None = None, max_anchors: int = 12) -> list[Anchor]:
    """Head/middle/tail + scene cuts + equal-interval coverage, bounded by max_anchors."""
    if duration <= 0:
        return []
    out: list[Anchor] = []
    for c in cuts or []:
        if 0 <= c < duration:
            out.append(Anchor(c, min(duration, c + 2.0), "scene_cut",
                              "cut point at %.3fs; the window is a sampling suggestion, "
                              "not a measured scene extent" % c))
    for label, at in (("head", 0.0), ("middle", duration / 2), ("tail", max(0.0, duration - 3.0))):
        out.append(Anchor(at, min(duration, at + 3.0), label, f"{label} coverage"))
    # The merge loop this function used to end with coalesced any window whose start
    # fell inside the previous window's extent. Because the interval windows are exactly
    # as wide as their spacing, the whole grid merged into ONE window spanning the entire
    # timeline, and a merged anchor keeps the FIRST kind - so a twelve-second anchor
    # became a full-duration anchor labelled "head coverage", and every detected cut
    # lost its provenance inside it. That is the same false full-coverage claim as
    # copying planned windows into Coverage, wearing a different file. So: no cross-kind
    # merging, and the interval grid is sized to what is left of the budget instead of
    # being generated wide and trimmed afterwards.
    specific: list[Anchor] = [a for a in out]
    budget = max(0, int(max_anchors) - len(specific))
    step = (max(1.0, duration / max(1, budget)) if budget else 0.0)
    for i in range(budget):
        at = min(duration, i * step)
        specific.append(Anchor(at, min(duration, at + step), "novelty", "interval coverage"))
    specific.sort(key=lambda a: a.start)
    return specific


PINNED_KIND_PRIORITY = {"interval_query": 0, "scene_cut": 1, "tail": 2, "head": 3,
                        "middle": 4}


@dataclass(slots=True)
class Plan:
    windows: list[Anchor] = field(default_factory=list)
    deduped: int = 0
    honest_note: str = ""
    planned_seconds: float = 0.0
    # A plan is a plan. Nothing that produces a Plan may claim inspected-content
    # coverage, so the flag exists to be False and consumers read it instead of
    # string-matching a sentence.
    claims_inspected_coverage: bool = False


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
    # A sorted prefix slice silently drops the TAIL whenever the budget is tight, and the
    # tail is exactly what "did it also happen later?" needs. The budget is therefore
    # spent by provenance first - asked-for ranges, then measured cut points, then the
    # ends of the source - and only then filled with generic interval coverage.
    limit = max(1, budget)
    pinned = sorted((w for w in out if w.kind in PINNED_KIND_PRIORITY),
                    key=lambda w: (PINNED_KIND_PRIORITY[w.kind], w.start))
    filler = [w for w in out if w.kind not in PINNED_KIND_PRIORITY]
    keep = pinned[:limit]
    for w in filler:
        if len(keep) >= limit:
            break
        keep.append(w)
    selected = sorted(keep, key=lambda w: w.start)
    planned = sum(min(duration, w.end) - max(0.0, w.start) for w in selected)

    note = (
        f"Planned {len(selected)} sampling windows across {duration:.1f}s; "
        "a sampling plan does not establish inspected-content coverage."
    )

    return Plan(windows=selected, deduped=deduped, honest_note=note,
                planned_seconds=max(0.0, planned), claims_inspected_coverage=False)


def observation_key(frame_digest: str, scene_id: str = "") -> str:
    """Cheap dedupe for EXPENSIVE analysis while every temporal occurrence is still recorded."""
    return f"{scene_id}:{frame_digest}"


def provenance(frame_ref: str, at: float, provider: str = "") -> dict[str, Any]:
    return {"frame_ref": frame_ref, "start": at, "provider": provider, "timebase": "presentation"}
