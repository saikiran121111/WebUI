"""Recognition: honest language routing, ffmpeg timebase laws, no fabricated timestamps.

Heavy inference deliberately does NOT live here. This module is importable by the
supervisor (it must stay stdlib-only), so it only builds commands, validates
provider output and reports what this host can actually run.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from ..contracts import StructuredError
from ..models.registry import (AVAILABLE, EVALUATION_REQUIRED, LICENSE_REQUIRED,
                               NOT_INSTALLED, catalog)

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
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
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
    cmd += ["-ac", str(PCM_CHANNELS), "-ar", str(rate), "-f", "s16le"]
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


# ---------------------------------------------------------------- language routing
def language_route(language: str) -> dict[str, Any]:
    """Pick the least-bad candidate for a language using CLAIMS plus measured flags.

    The old default, whisper-base.en, is English-only: routing Telugu through it
    produces confident garbage, which is worse than an honest not_configured.
    """
    lang = (language or "").strip().lower() or "unknown"
    candidates: list[dict[str, Any]] = []
    for spec in catalog().for_capability("speech.asr"):
        claims = [str(x).lower() for x in (spec.claims.get("languages") or [])]
        multi = "multilingual" in " ".join(claims) or "registry" in " ".join(claims)
        explicit = lang in claims
        if lang == "en":
            ok = explicit or multi
            why = "English is inside the published coverage"
        elif claims and not multi:
            ok = explicit
            why = ("language-specific model lists this language" if explicit
                   else "model is language-restricted and does not list this language")
        else:
            ok = multi
            why = "multilingual claim covers it on paper; quality on this host is unverified"
        status = catalog().status_for("speech.asr")
        entry_status = next((e["status"] for e in status["models"] if e["id"] == spec.id), NOT_INSTALLED)
        candidates.append({
            "id": spec.id, "status": entry_status, "acceptable": bool(ok), "reason": why,
            "verified_for_language": bool(spec.verified.get(lang, False)),
            "claims_language": bool(explicit or multi),
            "notes": spec.notes,
        })
    usable = [c for c in candidates if c["acceptable"] and c["status"] == AVAILABLE]
    measured = [c for c in usable if c["verified_for_language"]]
    if measured:
        return {"language": lang, "decision": "route", "model": measured[0]["id"],
                "quality_mode": "measured_on_this_host", "candidates": candidates,
                "note": "quality for this language was measured on this machine"}
    if usable:
        return {"language": lang, "decision": "route_with_warning", "model": usable[0]["id"],
                "quality_mode": "published_claim_only", "candidates": candidates,
                "note": "published support is not quality evidence; transcriptions must be reported as unverified"}
    blocked = [c for c in candidates if c["acceptable"]]
    if blocked:
        st = blocked[0]["status"]
        if st in (EVALUATION_REQUIRED, NOT_INSTALLED):
            return {"language": lang, "decision": "not_configured", "model": None,
                    "quality_mode": "none", "candidates": candidates,
                    "note": "no installed model credibly covers this language",
                    "human_step": "install and evaluate a candidate that lists "
                                  + lang + " (for example a multilingual Whisper checkpoint), then re-run the quality gate"}
        return {"language": lang, "decision": st, "model": None, "quality_mode": "none",
                "candidates": candidates, "note": "coverage exists but access is not configured",
                "human_step": "accept the provider licence and provide the access token"}
    return {"language": lang, "decision": "unsupported", "model": None, "quality_mode": "none",
            "candidates": candidates,
            "note": "no candidate lists this language; refusing to route it through an English-only model",
            "human_step": "add a model that credibly covers " + lang}


def speech_status() -> dict[str, Any]:
    """Capability report without loading or downloading anything."""
    st = catalog().status_for("speech.asr")
    return {"capability": "speech.asr", "status": st["status"], "models": st["models"],
            "pcm_contract": {"rate_hz": PCM_RATE_HZ, "channels": PCM_CHANNELS, "width_bytes": PCM_WIDTH_BYTES},
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
