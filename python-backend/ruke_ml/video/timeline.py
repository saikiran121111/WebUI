"""Durable, atomic timeline evidence. Deep questions never require a re-upload.

Same publish discipline as the retrieval index: stage, validate, then switch a pointer.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..contracts import Coverage, canon_json, sha256_hex
from .observations import Observation

REQUIRED_ON_UPLOAD = ("media_metadata", "streams", "duration", "rotation", "coverage")


@dataclass(slots=True)
class MediaMeta:
    source_id: str
    source_hash: str
    duration: float
    streams: list[dict[str, Any]] = field(default_factory=list)
    rotation_deg: int = 0
    has_audio_track: bool = False
    subtitle_tracks: list[str] = field(default_factory=list)
    stream_start_offsets: dict[str, float] = field(default_factory=dict)
    coverage: dict[str, Any] = field(default_factory=dict)
    processed: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"source_id": self.source_id, "source_hash": self.source_hash, "duration": self.duration,
                "streams": self.streams, "rotation_deg": self.rotation_deg,
                "has_audio_track": self.has_audio_track, "subtitle_tracks": self.subtitle_tracks,
                "stream_start_offsets": self.stream_start_offsets, "coverage": self.coverage,
                "processed": self.processed}


class TimelineStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, source_hash: str) -> Path:
        return self.root / source_hash[:32]

    def init_baseline(self, meta: MediaMeta) -> dict[str, Any]:
        """Cheap upload baseline only: metadata, streams, anchors, current coverage. No heavy modality."""
        d = self._dir(meta.source_hash)
        d.mkdir(parents=True, exist_ok=True)
        rec = {"schema_version": 1, "meta": meta.to_dict(), "observations": [],
               "written_at": time.time()}
        self._atomic(d / "timeline.json", rec)
        return rec

    def load(self, source_hash: str) -> dict[str, Any] | None:
        f = self._dir(source_hash) / "timeline.json"
        if not f.exists():
            return None
        return json.loads(f.read_text(encoding="utf-8"))

    def add_observations(self, source_hash: str, obs: list[Observation], coverage: Coverage,
                         stage: str) -> dict[str, Any]:
        rec = self.load(source_hash)
        if rec is None:
            raise FileNotFoundError("run init_baseline before adding evidence")
        rec["observations"].extend(o.to_dict() for o in obs)
        cov = rec["meta"].get("coverage", {})
        prev = Coverage.from_dict(cov) if cov else Coverage(units="seconds", total_source=rec["meta"]["duration"])
        rec["meta"]["coverage"] = merge_coverage(prev, coverage, stage).to_dict()
        rec["meta"]["processed"] = sorted(set(rec["meta"].get("processed", []) + [stage]))
        rec["written_at"] = time.time()
        self._atomic(self._dir(source_hash) / "timeline.json", rec)
        return rec

    @staticmethod
    def _atomic(path: Path, obj: dict[str, Any]) -> None:
        tmp = path.with_name(path.name + f".tmp{os.getpid()}")
        tmp.write_text(canon_json(obj), encoding="utf-8")
        os.replace(tmp, path)          # a reader sees the old file or the new one, never a mix


def merge_coverage(old: Coverage, new: Coverage, stage: str) -> Coverage:
    """Coverage accumulates honestly: examined spans merge, what remains unexamined stays visible."""
    if old.units != new.units:
        raise ValueError(f"cannot merge coverage measured in {old.units} with {new.units}")
    spans = sorted([(float(a), float(b)) for a, b in old.examined] + [(float(a), float(b)) for a, b in new.examined])
    merged: list[tuple[float, float]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    total = new.total_source if new.total_source is not None else old.total_source
    skipped: list[tuple[float, float]] = []
    if total:
        cursor = 0.0
        for a, b in merged:
            if a > cursor:
                skipped.append((cursor, min(a, total)))
            cursor = max(cursor, b)
        if cursor < total:
            skipped.append((cursor, total))
    complete = bool(merged) and total is not None and (merged[-1][1] >= total - 1e-6) and merged[0][0] <= 1e-6
    note = (f"stage {stage}: examined {sum(b - a for a, b in merged):.1f} of {total if total is not None else '?'} "
            f"{new.units}; unexamined spans are listed, and Top-K exhaustion never proves absence")
    return Coverage(examined=merged, skipped=skipped, units=new.units, total_source=total,
                    complete=complete, note=note)


def coverage_reply(rec: dict[str, Any]) -> str:
    cov = rec["meta"].get("coverage", {})
    if not cov:
        return "only the upload baseline has been examined; no modality has been analysed yet"
    sk = cov.get("skipped") or []
    gap = "; ".join(f"{round(a, 1)}-{round(b, 1)}s" for a, b in sk[:6]) or "none"
    return (f"examined {round(sum(b - a for a, b in (cov.get('examined') or [])), 1)}s of "
            f"{cov.get('total_source')}s; stages: {', '.join(rec['meta'].get('processed') or ['baseline'])}; "
            f"not examined: {gap}")
