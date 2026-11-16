"""MediaSearchHints: evidence that actually reaches the search tool.

The contract is consumed by the TS/Rust search layer, which turns hints into real
tool arguments. A hint with no reader is a defect, so to_queries() is part of the
contract and is covered by tests.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .observations import Observation

URL = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+")
QUOTED = re.compile(r"[\"'“”]([^\"'“”]{4,80})[\"'“”]")


@dataclass(slots=True)
class Hint:
    value: str
    kind: str          # observed_name | visible_text | url | distinctive_speech | scene_clue | uncertain_audio
    start: float
    end: float
    provenance: str
    confidence: float | None = None
    corroborated_by: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"value": self.value, "kind": self.kind, "start": self.start, "end": self.end,
                "provenance": self.provenance, "confidence": self.confidence,
                "corroborated_by": self.corroborated_by}


@dataclass(slots=True)
class MediaSearchHints:
    source_hash: str
    hints: list[Hint] = field(default_factory=list)
    coverage_note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"schema_version": 1, "source_hash": self.source_hash, "coverage_note": self.coverage_note,
                "hints": [h.to_dict() for h in self.hints]}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MediaSearchHints":
        return cls(source_hash=d.get("source_hash", ""), coverage_note=d.get("coverage_note", "") or "",
                   hints=[Hint(h["value"], h["kind"], float(h["start"]), float(h["end"]), h.get("provenance", ""),
                               h.get("confidence"), list(h.get("corroborated_by") or [])) for h in d.get("hints", [])])

    def to_queries(self, limit: int = 8) -> list[str]:
        """Actual arguments for the search tool, ranked by how directly they identify something."""
        rank = {"url": 0, "visible_text": 1, "distinctive_speech": 2, "observed_name": 3,
                "scene_clue": 4, "uncertain_audio": 5}
        out: list[str] = []
        seen: set[str] = set()
        for h in sorted(self.hints, key=lambda x: rank.get(x.kind, 9)):
            q = h.value.strip()
            if len(q) < 3 or q.lower() in seen:
                continue
            if h.kind == "url":
                m = URL.match(q)
                q = (m.group(0) if m else q)[:120]
            if h.kind == "uncertain_audio" and not h.corroborated_by:
                q = '"' + q + '"'      # candidate, never asserted: quoted exact-phrase probe
            seen.add(q.lower())
            out.append(q)
            if len(out) >= limit:
                break
        return out


def build_hints(timeline: dict[str, Any]) -> MediaSearchHints:
    hints: list[Hint] = []
    for o in timeline.get("observations", []):
        kind_map = {"ocr": "visible_text", "speech": "distinctive_speech", "subtitle": "distinctive_speech",
                    "visual": "scene_clue", "audio_event": "uncertain_audio"}
        base = kind_map.get(o.get("kind", ""), "scene_clue")
        start, end = float(o.get("start", 0)), float(o.get("end", 0))
        prov = f"{o.get('kind')}@{start:.1f}s:{o.get('provider', '')}"
        text = (o.get("text") or "").strip()
        if not text:
            continue
        for u in URL.findall(text):
            hints.append(Hint(u, "url", start, end, prov, o.get("confidence")))
        for q in QUOTED.findall(text):
            hints.append(Hint(q.strip(), base, start, end, prov, o.get("confidence")))
        if len(text) <= 120:
            hints.append(Hint(text, base, start, end, prov, o.get("confidence")))
        else:
            hints.append(Hint(text[:120], base, start, end, prov, o.get("confidence")))
    _merge_duplicates(hints)
    corroborate(hints)
    cov = timeline.get("meta", {}).get("coverage", {})
    return MediaSearchHints(timeline.get("meta", {}).get("source_hash", ""), hints,
                            cov.get("note", "coverage unknown"))


def _merge_duplicates(hints: list[Hint]) -> None:
    by: dict[tuple[str, str], Hint] = {}
    drop: list[Hint] = []
    for h in hints:
        key = (h.value.lower(), h.kind)
        if key in by:
            other = by[key]
            if other not in h.corroborated_by:
                h.corroborated_by.append(other.provenance)
            if h not in other.corroborated_by:
                other.corroborated_by.append(h.provenance)
            drop.append(h)
        else:
            by[key] = h
    for h in drop:
        hints.remove(h)


CORROBORATION_JACCARD = 0.34        # conservative: only a genuinely similar clue counts as agreement
CORROBORATION_MIN_TOKEN_LEN = 4


def corroborate(hints: list[Hint]) -> int:
    """Mark an uncertain audio clue as corroborated by a DIFFERENT modality.

    Agreement must be simultaneous in time and similar in content; otherwise an audio
    guess stays a quoted probe. This never merges the texts and never deletes evidence.
    """
    from ..retrieval.chunking import tokenize
    def keys(h: Hint) -> set[str]:
        return {t for t in (x.lower() for x in tokenize(h.value)) if len(t) >= CORROBORATION_MIN_TOKEN_LEN}
    pairs = 0
    uncertain = [h for h in hints if h.kind == "uncertain_audio"]
    others = [h for h in hints if h.kind != "uncertain_audio"]
    for h in uncertain:
        hk = keys(h)
        if not hk:
            continue
        for o in others:
            if o.provenance in h.corroborated_by:
                continue
            if o.start >= h.end or h.start >= o.end:      # must overlap in time
                continue
            ok_ = keys(o)
            shared = hk & ok_
            if not shared:
                continue
            jaccard = len(shared) / len(hk | ok_)
            if jaccard >= CORROBORATION_JACCARD:
                h.corroborated_by.append(o.provenance)
                o.corroborated_by.append(h.provenance)
                pairs += 1
    return pairs
