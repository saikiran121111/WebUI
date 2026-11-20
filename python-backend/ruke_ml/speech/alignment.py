"""Word-level timestamps: only when a provider genuinely supplies them.

A segment span is NOT a word timestamp. Interpolating word times from a segment
duration manufactures evidence, so this module accepts, validates or refuses -
it never invents.

Whose language table decides alignment support? The ALIGNER's, never the ASR's.
The previous version keyed its exclusions by ASR model id and then asked whether
the transcribing model was merely importable, which produced two wrong answers at
once: an ASR row with no aligner at all still looked alignable, and the aligner
that IS registered was never consulted for the languages it actually publishes.
`ASR_TO_ALIGNER` names the aligner that can consume a given transcript family,
`language_is_supported` reads only explicit published tags, and the executable
verdict comes from the same `AdapterReadiness` conjunction the capability report
and the job dispatcher use, so "advertised available" and "actually runnable"
cannot drift apart again.
"""
from __future__ import annotations

from typing import Any

from ..models.registry import AVAILABLE, catalog
from .languages import is_known_language, language_is_supported, normalize_language

# Documented holes in an ALIGNER's published table, keyed by the aligner id that is
# actually registered. The Qwen3 forced aligner's table omits Telugu and Hindi;
# routing those through it is expected to fail, so the honest answer is "unsupported
# for word timing here", while segment-level timing remains available.
ALIGNER_EXCLUSIONS: dict[str, set[str]] = {
    "Qwen/Qwen3-ForcedAligner-0.6B": {"te", "hi"},
}

# Which aligner can produce word times for a transcript produced by this ASR row.
# Keyed by ASR id because callers ask "can I get word timing for the audio THIS model
# transcribed"; the value must be a registered speech.align row. A transcript whose
# family has no aligner gets segment spans, never interpolated word times.
ASR_TO_ALIGNER: dict[str, str] = {
    "Systran/faster-whisper-base": "Systran/faster-whisper-base",
    "openai/whisper-large-v3": "whisperx/whisper-alignment",
    "Xenova/whisper-base.en": "whisperx/whisper-alignment",
    "Qwen/Qwen3-ASR-1.7B": "Qwen/Qwen3-ForcedAligner-0.6B",
    "Qwen/Qwen3-ASR-0.6B": "Qwen/Qwen3-ForcedAligner-0.6B",
}

# Stable, machine-checkable verdicts. The wire reason for each lives in workers/
# speech_jobs.py, which must not re-read prose to decide what happened.
KIND_SUPPORTED = "supported"
KIND_UNSUPPORTED_LANGUAGE = "unsupported_language"
KIND_UNKNOWN_LANGUAGE = "unknown_language"
KIND_NO_ALIGNER = "no_aligner"
KIND_NOT_EXECUTABLE = "not_executable"
KIND_BAD_METADATA = "bad_metadata"


def aligner_for(model_id: str) -> str:
    """The registered aligner row that would service this transcript family."""
    model_id = (model_id or "").strip()
    return ASR_TO_ALIGNER.get(model_id, model_id)


def decide(model_id: str, language: str) -> dict[str, Any]:
    """Can word timing be produced for this transcript/language, and if not, why?

    Answers from published tags plus computed readiness. Nothing here loads a model,
    touches the network, or accepts a licence.
    """
    requested = (model_id or "").strip()
    aligner_id = aligner_for(requested)
    lang = normalize_language(language)
    excluded = {normalize_language(t) for t in ALIGNER_EXCLUSIONS.get(aligner_id, set())}
    out: dict[str, Any] = {
        "ok": False, "kind": KIND_NO_ALIGNER, "requested_model": requested,
        "aligner": aligner_id, "language": lang or "unknown",
        "language_known": is_known_language(lang), "excluded_languages": sorted(excluded),
        "published_tags": 0, "measured_for_language": False, "quality_mode": "none",
        "blockers": [], "detail": "", "human_step": "",
    }
    spec = catalog().get(aligner_id, "speech.align")
    if spec is None:
        out["detail"] = (f"no aligner is registered for {requested}"
                         + (f" (looked up {aligner_id})" if aligner_id != requested else ""))
        out["human_step"] = ("register the aligner that can consume this transcript family, "
                             "otherwise report segment-level timing only")
        return out

    raw = spec.claims.get("languages", [])
    published = list(raw) if isinstance(raw, (list, tuple, set, frozenset)) else []
    out["published_tags"] = len(published)
    try:
        listed = language_is_supported(raw, lang)
    except ValueError as exc:                     # malformed optional metadata, reported
        out["kind"] = KIND_BAD_METADATA
        out["detail"] = f"unusable language metadata on aligner {aligner_id}: {exc}"
        out["human_step"] = "fix the aligner manifest: languages must be explicit tags, not prose"
        return out

    if lang in excluded:
        out["kind"] = KIND_UNSUPPORTED_LANGUAGE
        out["detail"] = (f"aligner {aligner_id} does not list {lang} for forced alignment; "
                         "segment-level timing is still available, word timing is not")
        out["human_step"] = "accept segment spans, or prepare an aligner that publishes this language"
        return out
    if not out["language_known"]:
        out["kind"] = KIND_UNKNOWN_LANGUAGE
        out["detail"] = ("automatic/unknown language cannot be routed to an aligner; word timing "
                         "needs the language the ASR actually detected")
        out["human_step"] = "run speech.asr with detection, then align with the detected language"
        return out
    if not listed:
        out["kind"] = KIND_UNSUPPORTED_LANGUAGE
        out["detail"] = (f"aligner {aligner_id} publishes {len(published)} language tag(s) and none "
                         f"of them covers {lang}; word timing would be an unverified guess"
                         if published else
                         f"aligner {aligner_id} has no language table captured offline, so no "
                         f"language can be claimed for word timing (asked: {lang})")
        out["human_step"] = ("capture the aligner's published language table, or keep segment "
                             "spans and say word timing is unavailable")
        return out

    ready = catalog().readiness(aligner_id, "speech.align")
    out["blockers"] = ready.blockers()
    out["measured_for_language"] = bool(spec.verified.get(lang, False))
    out["quality_mode"] = "measured_on_this_host" if out["measured_for_language"] else "published_claim_only"
    if not ready.executable:
        out["kind"] = KIND_NOT_EXECUTABLE
        out["detail"] = (f"aligner {aligner_id} publishes {lang} but is not executable here: "
                         + ("; ".join(out["blockers"]) or "unknown readiness blocker"))
        out["human_step"] = ("resolve the listed readiness blocker, otherwise keep segment-level "
                             "timing rather than loading an unverified aligner")
        return out

    out["ok"] = True
    out["kind"] = KIND_SUPPORTED
    out["detail"] = (f"aligner {aligner_id} publishes {lang} and is executable here; word times "
                     "come from the aligner's own output and are validated on receipt"
                     + ("" if out["measured_for_language"]
                        else "; alignment quality for this language is unmeasured on this host"))
    return out


def alignment_supported(model_id: str, language: str) -> tuple[bool, str]:
    """Compat wrapper: (ok, why). Callers that branch on WHAT failed use decide()."""
    got = decide(model_id, language)
    return bool(got["ok"]), str(got["detail"])


def alignment_status() -> dict[str, Any]:
    st = catalog().status_for("speech.align")
    asr_view = {asr_id: sorted(ALIGNER_EXCLUSIONS.get(aligner_id, set()))
                for asr_id, aligner_id in ASR_TO_ALIGNER.items()
                if ALIGNER_EXCLUSIONS.get(aligner_id)}
    return {"capability": "speech.align", "status": st["status"], "models": st["models"],
            "exclusions": {k: sorted(v) for k, v in ALIGNER_EXCLUSIONS.items()},
            "exclusions_by_transcript_family": asr_view,
            "aligner_for": dict(ASR_TO_ALIGNER),
            "aligners": [{"id": s.id,
                          "published_languages": len(s.claims.get("languages") or []),
                          "excluded": sorted(ALIGNER_EXCLUSIONS.get(s.id, set())),
                          "executable": catalog().readiness(s.id, "speech.align").executable,
                          "blockers": catalog().readiness(s.id, "speech.align").blockers()}
                         for s in catalog().for_capability("speech.align")],
            "metadata_problems": [p for p in catalog().claim_problems() if "speech" in p or "align" in p],
            "detail": ("alignment loads only for subtitle/word-timing requests, never for plain "
                       "retrieval; alignment support is the aligner's table, not the ASR's"),
            "human_step": ("" if st["status"] == AVAILABLE else
                           "make one registered aligner row executable (adapter + pinned deps + "
                           "asset), then verify it on real audio for the target language")}


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
