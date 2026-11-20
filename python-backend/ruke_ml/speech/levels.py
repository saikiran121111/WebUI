"""Measured audio level: what a decoded track actually carries, without any inference.

Why this module exists at all: "no audio track", "silence", "decoded but no speech"
and "the run failed" are four different facts, and only the first is visible in the
stream inventory. Before this module, a silent recording was only distinguishable from
a transcribed one by what the ASR model happened to emit - which is exactly how a
hallucinated "Thank you." ends up attributed to a recording that contained nothing.

So the content states come from a MEASUREMENT instead:

  * probe_media.has_audio is False        -> nothing was ever decoded (no track);
  * measure_level says "silence"          -> the track WAS decoded and its loudest
    sample sits at or below the noise floor, so no speech can come from it;
  * transcript.state == "no_speech"       -> the model ran on audible audio and
    returned nothing;
  * audio_level_state == "unknown"        -> the loudness pass itself failed or
    timed out; this is never reported as silence.

This module is stdlib-only at import time, like the rest of the speech package that the
supervisor is allowed to load: it builds one bounded ffmpeg pass and parses ffmpeg's
own log lines.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from typing import Any

from .. import processes

NOISE_FLOOR_DBFS = -60.0        # at or below this a decoded track is silence
SILENCE_SEGMENT_S = 0.5         # minimum run of near-zero audio counted as an interval
LEVEL_TIMEOUT_S = 120.0         # bounded: a loudness pass must not hang a job
MAX_LOG_CHARS = 200_000         # retained stderr is bounded; the pass is not


@dataclass(slots=True)
class AudioLevel:
    """The measured loudness facts for one decoded audio span."""
    ok: bool
    measured: bool                       # True only when the whole span was measured
    mean_volume_db: float | None = None
    max_volume_db: float | None = None
    silence_intervals: list[tuple[float, float]] = field(default_factory=list)
    silence_ratio: float | None = None
    audio_level_state: str = "unknown"   # silence | audible | unknown
    truncated: bool = False
    error: str = ""
    human_step: str = ""
    note: str = ""
    engine: str = ""
    noise_floor_db: float = NOISE_FLOOR_DBFS

    def is_silence(self) -> bool:
        # Silence is only asserted from a complete measurement at/below the floor.
        return (self.ok and self.measured and not self.truncated
                and self.audio_level_state == "silence")

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "measured": self.measured,
                "mean_volume_db": self.mean_volume_db, "max_volume_db": self.max_volume_db,
                "silence_intervals": [[a, b] for a, b in self.silence_intervals],
                "silence_ratio": self.silence_ratio, "state": self.audio_level_state,
                "truncated": self.truncated, "error": self.error,
                "human_step": self.human_step, "note": self.note, "engine": self.engine,
                "noise_floor_db": self.noise_floor_db}


def level_command(src: str, *, noise_floor_db: float = NOISE_FLOOR_DBFS,
                  silence_s: float = SILENCE_SEGMENT_S,
                  start_s: float = 0.0, duration_s: float | None = None) -> list[str]:
    """One decode pass that reports level plus silence intervals.

    The filters run on the decoder's own timeline, so the reported silence intervals
    are SOURCE times when start_s is 0; with a bounded span the caller adds start_s
    back, the same law pcm_command states for transcription windows.
    """
    # -nostdin before the input: this pass runs inside a capability worker whose stdin
    # is the supervisor's request pipe, and an ffmpeg that reads it never exits.
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-i", src]
    if start_s:
        cmd += ["-ss", f"{start_s:.3f}"]
    if duration_s is not None:
        cmd += ["-t", f"{duration_s:.3f}"]
    cmd += ["-af", f"volumedetect,silencedetect=noise={noise_floor_db:.1f}dB:d={silence_s:.3f}",
            "-f", "null", "-"]
    return cmd


def parse_level_log(text: str, *, noise_floor_db: float = NOISE_FLOOR_DBFS) -> dict[str, Any]:
    """Pull the measured numbers out of ffmpeg's log lines, line-anchored.

    The pattern requires the filter's own prefix, so a filename or a comment that
    happens to contain "mean_volume" cannot invent a level for the track.
    """
    mean = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", text)
    peak = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", text)
    starts = [float(m.group(1)) for m in re.finditer(r"silence_start:\s*(-?\d+(?:\.\d+)?)", text)]
    ends = [float(m.group(1)) for m in re.finditer(r"silence_end:\s*(-?\d+(?:\.\d+)?)", text)]
    intervals: list[tuple[float, float]] = []
    for i, st in enumerate(starts):
        if i < len(ends) and ends[i] > st:
            intervals.append((round(st, 3), round(ends[i], 3)))
    return {"mean_volume_db": float(mean.group(1)) if mean else None,
            "max_volume_db": float(peak.group(1)) if peak else None,
            "silence_intervals": intervals, "noise_floor_db": noise_floor_db}


def measure_level(path: str, *, ffmpeg: str = "", duration_s: float = 0.0,
                  timeout_s: float = LEVEL_TIMEOUT_S,
                  noise_floor_db: float = NOISE_FLOOR_DBFS) -> AudioLevel:
    """Measure how much audible audio a track actually carries. Never infers content type.

    Speech vs music vs effects is NOT decided here: that would need a classifier, and a
    classifier that has not been evaluated on this host would be an unverified claim.
    What this can prove is the binary "there was nothing loud enough to transcribe",
    which is the case ASR most often fabricates an answer for.
    """
    from ..models import binaries
    exe = ffmpeg or binaries.path_for("ffmpeg") or "ffmpeg"
    cmd = level_command(str(path), noise_floor_db=noise_floor_db)
    cmd[0] = exe
    try:
        done = processes.run_captured(cmd, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return AudioLevel(False, False, truncated=True, audio_level_state="unknown",
                          error=f"the loudness pass exceeded {timeout_s:.0f}s",
                          human_step="the track is too long for one pass; measure bounded spans",
                          engine=exe, noise_floor_db=noise_floor_db)
    except (OSError, subprocess.SubprocessError) as exc:
        return AudioLevel(False, False, audio_level_state="unknown",
                          error=f"the loudness pass could not run: {type(exc).__name__}: {exc}",
                          human_step="install/validate ffmpeg before classifying audio content",
                          engine=exe, noise_floor_db=noise_floor_db)
    text = (done.stderr or b"")[-MAX_LOG_CHARS:].decode("utf-8", "replace")
    if done.returncode != 0:
        return AudioLevel(False, False, audio_level_state="unknown",
                          error=f"the loudness pass exited {done.returncode}: {text[-300:]}",
                          human_step="the track could not be decoded; it may be corrupt",
                          engine=exe, noise_floor_db=noise_floor_db)
    got = parse_level_log(text, noise_floor_db=noise_floor_db)
    if got["mean_volume_db"] is None or got["max_volume_db"] is None:
        # No level at all means the filter never saw samples. That is an undecodable
        # track, not a silent one, and not "no speech".
        return AudioLevel(False, False, audio_level_state="unknown",
                          error="the loudness pass produced no level measurement",
                          human_step="re-probe the media; the selected track may be undecodable",
                          engine=exe, noise_floor_db=noise_floor_db)
    silent = sum(b - a for a, b in got["silence_intervals"])
    ratio = round(min(1.0, max(0.0, silent / duration_s)), 4) if duration_s > 0 else None
    state = "silence" if got["max_volume_db"] <= noise_floor_db else "audible"
    note = (f"max {got['max_volume_db']:.1f} dBFS, mean {got['mean_volume_db']:.1f} dBFS, "
            f"{silent:.1f}s at or below {noise_floor_db:.0f} dBFS")
    if duration_s > 0:
        note += f" over a reported {duration_s:.1f}s"
    return AudioLevel(True, True, mean_volume_db=got["mean_volume_db"],
                      max_volume_db=got["max_volume_db"],
                      silence_intervals=got["silence_intervals"], silence_ratio=ratio,
                      audio_level_state=state, note=note, engine=exe,
                      noise_floor_db=noise_floor_db)
