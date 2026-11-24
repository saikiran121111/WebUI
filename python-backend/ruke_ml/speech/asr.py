"""Recognition: honest language routing, ffmpeg timebase laws, no fabricated timestamps.

Heavy inference deliberately does NOT live here. This module is importable by the
supervisor (it must stay stdlib-only), so it only builds commands, validates
provider output and reports what this host can actually run.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .. import processes
from ..contracts import StructuredError
from ..language_tables import candidate_language_tags, candidate_languages
from ..models.registry import (AVAILABLE, EVALUATION_REQUIRED, LICENSE_REQUIRED,
                               NOT_INSTALLED, PARAKEET_ID, catalog)
from .languages import (UNKNOWN_TAGS, is_known_language, language_is_supported,
                        normalize_language)

PCM_RATE_HZ = 16000           # what current ASR front-ends expect; a law, not a default
PCM_CHANNELS = 1
PCM_WIDTH_BYTES = 2           # s16le
DEFAULT_WINDOW_S = 30.0
DEFAULT_OVERLAP_S = 5.0


# ---------------------------------------------------------------- ffmpeg commands
def ffprobe_command(src: str) -> list[str]:
    """Stream inventory: track index, codec, language, default flag, start time."""
    return ["ffprobe", "-v", "error", "-print_format", "json",
            "-show_streams", "-show_format", src]


def pcm_command(src: str, *, start_s: float | None = None, duration_s: float | None = None,
                stream_id: int | None = None, rate: int = PCM_RATE_HZ,
                accurate_seek: bool = True) -> list[str]:
    """Decode to mono s16le PCM at the model rate.

    accurate_seek puts -ss after -i (sample-accurate, slower). Fast seek is fine for
    coarse windows, but a seek placed BEFORE -i resets the timebase, so any timestamp
    derived from the output would be relative to the seek point, not the source.
    The caller must therefore keep start_s and add it back; that offset is explicit
    in pcm_window() below rather than hidden in a flag.
    """
    # -nostdin comes before the first input: ffmpeg must never read the stdin it
    # inherits. Inside a capability worker that stdin is the owner's request pipe (see
    # ruke_ml/processes.py); a tool that reads it cannot be relied on to exit, and the
    # control channel it steals from is the one the worker answers on.
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
    if start_s is not None and not accurate_seek:
        cmd += ["-ss", f"{start_s:.3f}"]
    cmd += ["-i", src]
    if start_s is not None and accurate_seek:
        cmd += ["-ss", f"{start_s:.3f}"]
    if duration_s is not None:
        cmd += ["-t", f"{duration_s:.3f}"]
    if stream_id is not None:
        cmd += ["-map", f"0:{stream_id}", "-vn", "-sn", "-dn"]
    else:
        # No explicit track: let ffmpeg apply its own best-stream rule rather than
        # blindly taking track 0 or concatenating every audio track together.
        cmd += ["-vn", "-sn", "-dn"]
    # The output target is part of the command, not something a caller may forget: with
    # `-f s16le` and no target, ffmpeg exits 1 with "At least one output file must be
    # specified" (measured F14, first real decode run). `-` writes the PCM to stdout,
    # which is what every caller here captures.
    cmd += ["-ac", str(PCM_CHANNELS), "-ar", str(rate), "-f", "s16le", "-"]
    return cmd


@dataclass(slots=True)
class PcmWindow:
    start_s: float
    end_s: float
    command: list[str]

    def sample_offset_s(self) -> float:
        """Timestamps inside this window start at 0; add start_s to get source time."""
        return self.start_s

    def to_source_time(self, t_in_window: float) -> float:
        return self.start_s + t_in_window


def pcm_windows(duration_s: float, *, window_s: float = DEFAULT_WINDOW_S,
                overlap_s: float = DEFAULT_OVERLAP_S, src: str = "media",
                stream_id: int | None = None) -> list[PcmWindow]:
    """Bounded windows with overlap; every window knows its own source offset."""
    if duration_s <= 0:
        return []
    if window_s <= 0 or overlap_s < 0 or overlap_s >= window_s:
        raise ValueError("window_s must be positive and overlap_s must be smaller than window_s")
    out: list[PcmWindow] = []
    start = 0.0
    step = window_s - overlap_s
    while start < duration_s:
        end = min(duration_s, start + window_s)
        out.append(PcmWindow(start_s=round(start, 3), end_s=round(end, 3),
                             command=pcm_command(src, start_s=round(start, 3),
                                                 duration_s=round(end - start, 3),
                                                 stream_id=stream_id)))
        if end >= duration_s:
            break
        start += step
    return out


def pcm_bytes_per_second(rate: int = PCM_RATE_HZ, channels: int = PCM_CHANNELS) -> int:
    return rate * channels * PCM_WIDTH_BYTES


# ---------------------------------------------------------------- stream choice
def select_audio_stream(streams: Iterable[dict[str, Any]],
                        preferred_language: str | None = None) -> dict[str, Any]:
    """Never assume track 0 is the intended audio.

    Preference: explicit language match -> stream marked default -> first audio.
    A file with no audio stream is reported as such, which is NOT the same as silence.
    """
    audio = [s for s in streams if str(s.get("codec_type", "")) == "audio"]
    if not audio:
        return {"selected": None, "audio_streams": 0,
                "state": "no_audio_track",
                "reason": "the container has no audio stream; that is not silence and not absence of evidence"}
    def lang_of(s: dict[str, Any]) -> str:
        tags = s.get("tags") or {}
        return str(tags.get("language", "") or "").strip().lower()
    if preferred_language:
        want = preferred_language.strip().lower()
        exact = [s for s in audio if lang_of(s) == want]
        if exact:
            return {"selected": _stream_ref(exact[0]), "audio_streams": len(audio), "state": "selected",
                    "reason": f"language tag {want!r} matched"}
        prefix = [s for s in audio if lang_of(s).startswith(want[:2])]
        if prefix:
            return {"selected": _stream_ref(prefix[0]), "audio_streams": len(audio), "state": "selected",
                    "reason": f"language tag prefix {want[:2]!r} matched"}
    default = [s for s in audio if s.get("default") in (1, True, "1", "true")]
    if default:
        return {"selected": _stream_ref(default[0]), "audio_streams": len(audio), "state": "selected",
                "reason": "stream flagged default"}
    return {"selected": _stream_ref(audio[0]), "audio_streams": len(audio), "state": "selected",
            "reason": "no language tag and no default flag; fell back to the first audio stream"}


def _stream_ref(s: dict[str, Any]) -> dict[str, Any]:
    tags = s.get("tags") or {}
    return {"index": s.get("index"), "codec": s.get("codec_name", ""),
            "language": str(tags.get("language", "") or ""),
            "default": bool(s.get("default") in (1, True, "1", "true")),
            "start_time": _maybe_float(s.get("start_time")),
            "sample_rate": _maybe_int(s.get("sample_rate")),
            "channels": _maybe_int(s.get("channels"))}


def _maybe_float(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _maybe_int(v: Any) -> int | None:
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def probe_media(path: str, ffprobe: str = "") -> dict[str, Any]:
    """Stream/duration inventory from ffprobe, with no inference about content.

    The result separates the facts a caller must not confuse: container duration, the
    per-stream start offset, whether an audio stream EXISTS at all, rotation, and which
    track was selected. A missing track is not silence, and a stream offset is not zero.
    """
    import json
    import subprocess
    from ..models import binaries
    exe = ffprobe or binaries.path_for("ffprobe") or "ffprobe"
    cmd = ffprobe_command(str(path))
    cmd[0] = exe
    try:
        done = processes.run_captured(cmd, timeout=60.0)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"ffprobe could not run: {type(exc).__name__}: {exc}",
                "human_step": "install/validate ffprobe before probing media"}
    if done.returncode != 0:
        return {"ok": False,
                "error": f"ffprobe exited {done.returncode}: {(done.stderr or b'')[-300:]!r}",
                "human_step": "the file could not be probed; it may be corrupt or unsupported"}
    try:
        data = json.loads((done.stdout or b"").decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"ffprobe output was not JSON: {exc}", "human_step": ""}
    streams = data.get("streams") or []
    format_ = data.get("format") or {}
    duration = _maybe_float(format_.get("duration")) or 0.0
    offsets: dict[str, float] = {}
    for s in streams:
        start = _maybe_float(s.get("start_time"))
        if start:
            offsets[f"{s.get('codec_type', '?')}:{s.get('index', '?')}"] = start
    rotation = 0
    for s in streams:
        if str(s.get("codec_type", "")) != "video":
            continue
        for side in s.get("side_data_list") or []:
            rot = _maybe_int(side.get("rotation"))
            if rot:
                rotation = abs(int(rot))
        tags = s.get("tags") or {}
        rotation = rotation or (_maybe_int(tags.get("rotate")) or 0)
    audio_choice = select_audio_stream(streams)
    subtitles = [{"index": s.get("index"),
                  "language": str(((s.get("tags") or {}).get("language", "") or ""))}
                 for s in streams if str(s.get("codec_type", "")) == "subtitle"]
    return {"ok": True, "error": "", "duration": float(duration),
            "ffprobe": exe, "audio_streams": audio_choice["audio_streams"],
            "has_audio": audio_choice["selected"] is not None,
            "audio_state": audio_choice["state"], "audio_reason": audio_choice["reason"],
            "selected_audio": audio_choice["selected"], "streams": streams[:64],
            "stream_start_offsets": offsets, "rotation_deg": abs(int(rotation)),
            "subtitle_tracks": subtitles,
            "video_streams": sum(1 for s in streams if str(s.get("codec_type", "")) == "video")}


# ---------------------------------------------------------------- language routing
def language_route(language: str) -> dict[str, Any]:
    """Pick the least-bad candidate from EXPLICIT language tags plus measured flags.

    Two rules drive this: a `languages` claim that is not a list of tags says nothing, so
    it is reported as a metadata fault rather than searched for substrings; and automatic
    detection is a real capability of some backends, so "auto" routes only to a model that
    publishes detection, never to whatever happens to be installed.
    """
    raw = (language or "").strip()
    lang = normalize_language(raw) or "unknown"
    detecting = lang in UNKNOWN_TAGS
    status = catalog().status_for("speech.asr")
    metadata_problems: list[str] = []
    candidates: list[dict[str, Any]] = []
    for spec in catalog().for_capability("speech.asr"):
        try:
            if detecting:
                ok = bool(spec.claims.get("language_detection"))
                why = ("automatic identification is a published capability of this backend"
                       if ok else "this backend does not publish automatic language detection")
            else:
                ok = language_is_supported(spec.claims.get("languages", []), lang)
                why = ("the model's published tag list contains this language" if ok
                       else "the model's published tag list does not contain this language")
        except ValueError as exc:                      # malformed manifest metadata, reported
            ok = False
            why = f"unusable language metadata on this row: {exc}"
            metadata_problems.append(f"{spec.id}: {exc}")
        detected_ok = bool(spec.claims.get("language_detection"))
        entry_status = next((e["status"] for e in status["models"] if e["id"] == spec.id), NOT_INSTALLED)
        candidates.append({
            "id": spec.id, "status": entry_status, "acceptable": bool(ok), "reason": why,
            "verified_for_language": bool(spec.verified.get(lang, False)),
            "claims_language": bool(ok),
            "supports_detection": detected_ok,
            "publishes_tag_count": len(spec.claims.get("languages") or [])
                                   if isinstance(spec.claims.get("languages"), (list, tuple)) else 0,
            "notes": spec.notes,
        })
    if detecting:
        # Automatic detection must never resolve to a single-language checkpoint.
        return _route_detection(lang, candidates, metadata_problems)
    usable = [c for c in candidates if c["acceptable"] and c["status"] == AVAILABLE]
    measured = [c for c in usable if c["verified_for_language"]]
    if measured:
        return {"language": lang, "decision": "route", "model": measured[0]["id"],
                "quality_mode": "measured_on_this_host", "candidates": candidates,
                "metadata_problems": metadata_problems,
                "note": "quality for this language was measured on this machine"}
    if usable:
        return {"language": lang, "decision": "route_with_warning", "model": usable[0]["id"],
                "quality_mode": "published_claim_only", "candidates": candidates,
                "metadata_problems": metadata_problems,
                "note": "published support is not quality evidence; transcriptions must be reported as unverified"}
    blocked = [c for c in candidates if c["acceptable"]]
    if blocked:
        st = blocked[0]["status"]
        if st in (EVALUATION_REQUIRED, NOT_INSTALLED):
            return {"language": lang, "decision": "not_configured", "model": None,
                    "quality_mode": "none", "candidates": candidates,
                    "metadata_problems": metadata_problems,
                    "note": "no installed model credibly covers this language",
                    "human_step": "install and evaluate a candidate that lists "
                                  + lang + " (multilingual scope is deferred by the 2026-11-22 "
                                  "release decision), then re-run the quality gate"}
        return {"language": lang, "decision": st, "model": None, "quality_mode": "none",
                "candidates": candidates, "note": "coverage exists but access is not configured",
                "metadata_problems": metadata_problems,
                "human_step": "accept the provider licence and provide the access token"}
    if metadata_problems:
        return {"language": lang, "decision": "not_configured", "model": None,
                "quality_mode": "none", "candidates": candidates,
                "metadata_problems": metadata_problems,
                "note": "the registered rows carry unreadable language metadata, so nothing "
                        "can be routed on it; the supervisor stays up and the metadata is reported",
                "human_step": "replace the prose language claim with the backend's explicit tag list"}
    return {"language": lang, "decision": "unsupported", "model": None, "quality_mode": "none",
            "candidates": candidates,
            "note": "no candidate lists this language; refusing to route it through an English-only model",
            "human_step": "add a model that credibly covers " + lang}


def _route_detection(lang: str, candidates: list[dict[str, Any]],
                     metadata_problems: list[str]) -> dict[str, Any]:
    """Automatic language means REAL detection, run at job time by the selected model."""
    able = [c for c in candidates if c["supports_detection"]]
    ready = [c for c in able if c["status"] == AVAILABLE]
    if ready:
        return {"language": lang, "decision": "detect", "model": ready[0]["id"],
                "quality_mode": "published_claim_only", "candidates": candidates,
                "metadata_problems": metadata_problems,
                "note": "the model identifies the language at decode time; the identified tag "
                        "is reported with its probability, and detection quality is unmeasured"}
    if able:
        return {"language": lang, "decision": "detect_not_configured", "model": None,
                "quality_mode": "none", "candidates": candidates,
                "metadata_problems": metadata_problems,
                "note": "a detection-capable backend is registered but is not executable here "
                        "(missing dependency, missing asset or missing access)",
                "human_step": "make one detection-capable row executable: "
                              + "; ".join(f"{c['id']}={c['status']}" for c in able)}
    return {"language": lang, "decision": "unsupported", "model": None, "quality_mode": "none",
            "candidates": candidates, "metadata_problems": metadata_problems,
            "note": "no registered backend publishes automatic language detection; a "
                    "single-language checkpoint is never used as the default",
            "human_step": "register a multilingual backend that publishes language identification"}


def speech_status() -> dict[str, Any]:
    """Capability report without loading or downloading anything."""
    st = catalog().status_for("speech.asr")
    # B6 (final decision 2026-11-22): the report answers from the SOLE engine's captured
    # published table, not Whisper's. The retired engine's table stays as provenance DATA
    # for the aligner row; quoting it as the ASR capability's language provenance made the
    # product's own status surface recommend an engine the release never runs.
    published = candidate_language_tags(PARAKEET_ID)
    return {"capability": "speech.asr", "status": st["status"], "models": st["models"],
            "pcm_contract": {"rate_hz": PCM_RATE_HZ, "channels": PCM_CHANNELS, "width_bytes": PCM_WIDTH_BYTES},
            "language_table": {"source": "published table captured from the engine's model card",
                               "count": len(candidate_languages(PARAKEET_ID)),
                               "provenance": published},
            "known_language_tags": sorted(t for t in candidate_languages(PARAKEET_ID)
                                          if is_known_language(t)),
            "metadata_problems": st.get("metadata_problems", []),
            "detail": ("no ASR weights are loaded at startup; transcription runs in an owned worker"
                       if st["status"] != AVAILABLE else "weights load only inside an owned worker"),
            "human_step": ("" if st["status"] == AVAILABLE else
                           "install a family from python-backend/pyproject.toml extras, then evaluate it")}


def license_required_error(capability: str = "speech.diarize") -> StructuredError:
    spec = next((s for s in catalog().for_capability(capability) if s.needs_token), None)
    return StructuredError(
        LICENSE_REQUIRED if spec else "not_configured",
        f"{capability} needs a gated model; licence acceptance and an access token are required",
        retryable=False, capability=capability,
        human_step="accept the model licence on the provider site and set the access token; "
                   "Ruke will not accept terms on the user's behalf",
    )
