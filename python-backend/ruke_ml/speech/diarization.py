"""Speaker diarization: anonymous labels, overlap preserved, licence gated.

pyannote Community-1 sits behind licence acceptance. Ruke reports the blocker and
keeps startup working; it never accepts a licence on the user's behalf.
"""
from __future__ import annotations

from typing import Any, Iterable

from ..models.registry import LICENSE_REQUIRED, catalog


def diarization_status() -> dict[str, Any]:
    st = catalog().status_for("speech.diarize")
    spec = next((s for s in catalog().for_capability("speech.diarize") if s.needs_token), None)
    needs = bool(spec and spec.needs_token)
    return {"capability": "speech.diarize", "status": st["status"], "models": st["models"],
            "license_acceptance_required": needs,
            "detail": st["detail"],
            "human_step": ("accept the model licence on the hosting provider and configure the access token"
                           if st["status"] == LICENSE_REQUIRED else st["detail"])}


def validate_turns(turns: Iterable[dict[str, Any]], duration_s: float | None = None,
                   *, max_clamp_s: float = 0.5) -> dict[str, Any]:
    """Sanity-check provider turns. Overlap between speakers is legitimate output."""
    out: list[dict[str, Any]] = []
    problems: list[str] = []
    clamped = 0
    for t in turns:
        s, e = _f(t.get("start")), _f(t.get("end"))
        if s is None or e is None or e <= s:
            problems.append("turn with missing or inverted span dropped from evidence")
            continue
        if duration_s is not None and s > duration_s:
            problems.append(f"turn start {s:.3f}s is past the media duration {duration_s:.3f}s - dropped")
            continue
        if duration_s is not None and e > duration_s:
            if e - duration_s <= max_clamp_s:
                e = duration_s
                clamped += 1
            else:
                problems.append(f"turn end {e:.3f}s exceeds duration by {e - duration_s:.3f}s - provider clock is wrong")
                continue
        out.append({**t, "start": s, "end": e})
    overlaps = sum(1 for i, a in enumerate(out) for b in out[i + 1:]
                   if a["start"] < b["end"] and b["start"] < a["end"])
    return {"turns": out, "clamped": clamped, "overlapping_turns": overlaps,
            "problems": problems,
            "note": "overlapping turns are kept: two people talking at once is real evidence, not an error"}


def speaker_labels(turns: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Remap provider diar ids to anonymous S1, S2... in first-appearance order.

    Identity is never inferred. Labels are stable within this recording only.
    """
    mapping: dict[str, str] = {}
    relabelled: list[dict[str, Any]] = []
    for t in turns:
        raw = str(t.get("speaker", t.get("speaker_id", "unknown")))
        if raw not in mapping:
            mapping[raw] = f"S{len(mapping) + 1}"
        relabelled.append({**t, "speaker": mapping[raw], "identity_claimed": False})
    return relabelled, mapping


def stage_plan(need_transcript: bool, need_word_times: bool, need_speakers: bool) -> list[str]:
    """Heavy stages run one at a time, persisting between them.

    Running ASR, alignment and diarization in one resident process multiplies peak
    memory; sequential stages inside short-lived workers let the OS reclaim it.
    """
    plan = ["speech.asr"] if need_transcript else []
    if need_word_times:
        plan.append("speech.align")
    if need_speakers:
        plan.append("speech.diarize")
    return plan


def _f(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None
