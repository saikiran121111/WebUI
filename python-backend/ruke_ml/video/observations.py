"""Typed observations per time interval. Absence of a transcript is not silence."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

AUDIO_STATES = ("no_audio_track", "silence", "speech", "music", "nonspeech", "mixed", "unknown", "processing_failed")
EVIDENCE_KINDS = ("visual", "ocr", "speech", "subtitle", "audio_event", "scene")


@dataclass(slots=True)
class Observation:
    start: float
    end: float
    kind: str
    text: str = ""
    frame_ref: str = ""
    bbox: list[float] | None = None
    audio_state: str = "unknown"
    provider: str = ""
    confidence: float | None = None      # only when the provider genuinely reports it

    def __post_init__(self) -> None:
        if self.kind not in EVIDENCE_KINDS:
            raise ValueError(f"unknown observation kind {self.kind!r}")
        if self.audio_state not in AUDIO_STATES:
            raise ValueError(f"unknown audio state {self.audio_state!r}")
        if self.end < self.start:
            raise ValueError("observation end precedes start")

    def to_dict(self) -> dict[str, Any]:
        return {"start": self.start, "end": self.end, "kind": self.kind, "text": self.text,
                "frame_ref": self.frame_ref, "bbox": self.bbox, "audio_state": self.audio_state,
                "provider": self.provider, "confidence": self.confidence}


def audio_state(has_track: bool, speech_spans: int, rms: float | None, failed: bool = False) -> str:
    """Decide from what was measured. No ASR text never means no useful audio evidence."""
    if not has_track:
        return "no_audio_track"
    if failed:
        return "processing_failed"
    if speech_spans:
        return "speech"
    if rms is None:
        return "unknown"
    return "silence" if rms < 1e-4 else "nonspeech"
