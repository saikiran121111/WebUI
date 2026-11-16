"""Word-level timestamps: only when a provider genuinely supplies them.

A segment span is NOT a word timestamp. Interpolating word times from a segment
duration manufactures evidence, so this module accepts, validates or refuses -
it never invents.
"""
from __future__ import annotations

from typing import Any, Iterable

from ..models.registry import AVAILABLE, catalog

# Published aligner coverage, recorded as a claim with its known holes. The Qwen3
# aligner table inspected during planning omitted Telugu and Hindi; routing those
# through it is expected to fail, so the honest answer is "unsupported here".
ALIGNER_EXCLUSIONS = {
    "Qwen/Qwen3-ASR-1.7B": {"te", "hi"},
    "Qwen/Qwen3-ASR-0.6B": {"te", "hi"},
}


def alignment_supported(model_id: str, language: str) -> tuple[bool, str]:
    lang = (language or "").strip().lower()
    excluded = ALIGNER_EXCLUSIONS.get(model_id, set())
    if lang in excluded:
        return False, (f"{model_id} does not list {lang} for forced alignment; "
                       "segment-level timing is still available, word timing is not")
    spec = next((s for s in catalog().for_capability("speech.align") if s.id == model_id), None)
    if spec is None:
        return False, f"no aligner is registered for {model_id}"
    if not spec.installed():
        return False, "aligner not installed; load it only when precise word timing is actually needed"
    return True, "aligner installed for this model/language pair"


def alignment_status() -> dict[str, Any]:
    st = catalog().status_for("speech.align")
    return {"capability": "speech.align", "status": st["status"], "models": st["models"],
            "exclusions": {k: sorted(v) for k, v in ALIGNER_EXCLUSIONS.items()},
            "detail": "alignment loads only for subtitle/word-timing requests, never for plain retrieval",
            "human_step": ("" if st["status"] == AVAILABLE else
                           "install the aligner family, then verify it on real audio for the target language")}


def accept_word_timestamps(segment: dict[str, Any], *, tolerance_s: float = 0.05) -> dict[str, Any]:
    """Validate provider-supplied word times against their own segment.

    Returns the segment with a `word_timestamps` verdict plus any rejected entries.
    Rejection is reported, never silently dropped, and never repaired by guessing.
    """
    start = _f(segment.get("start"))
    end = _f(segment.get("end"))
    words = segment.get("words")
    if start is None or end is None or end < start:
        return {**segment, "word_timestamps": "invalid_segment_span", "accepted_words": [],
                "rejected_words": []}
    if not isinstance(words, list) or not words:
        return {**segment, "word_timestamps": "segment_span_only", "accepted_words": [],
                "rejected_words": [],
                "note": "the provider gave no word-level times; segment span must not be read as word timing"}
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    prev_start = -1.0
    for w in words:
        if not isinstance(w, dict):
            rejected.append({"raw": w, "why": "not an object"})
            continue
        ws, we = _f(w.get("start")), _f(w.get("end"))
        if ws is None or we is None or we < ws:
            rejected.append({"raw": w, "why": "missing or inverted word span"})
            continue
        if ws < start - tolerance_s or we > end + tolerance_s:
            rejected.append({"raw": w, "why": f"word span falls outside its segment [{start:.3f},{end:.3f}]"})
            continue
        if ws < prev_start:
            rejected.append({"raw": w, "why": "word order is not monotonic; provider output cannot be trusted"})
            continue
        accepted.append({"word": str(w.get("word", "")), "start": ws, "end": we})
        prev_start = ws
    verdict = "provider_supplied" if accepted and not rejected else (
        "partially_valid" if accepted else "provider_output_invalid")
    return {**segment, "word_timestamps": verdict, "accepted_words": accepted,
            "rejected_words": rejected,
            "note": "" if not rejected else f"{len(rejected)} word span(s) rejected as unusable"}


def _f(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None
