"""Recorded published-language tables for pinned backends.

The tables live as data files with provenance (which package version, which module,
capture date) rather than as prose inside a model card string, so:
  * capability reporting answers from data without importing ctranslate2/torch,
  * the routing helper always receives an explicit tag list,
  * a claim can be traced back to the exact pinned dependency that produced it.

A published table is coverage on paper. Measured per-language quality is a separate
`verified` flag and only ever comes from an evaluation run on this machine.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).with_name("data")


def _read(name: str) -> dict[str, Any]:
    try:
        payload = json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _tags(payload: dict[str, Any]) -> list[str]:
    tags = payload.get("languages")
    if not isinstance(tags, list):
        return []
    return [str(t).strip() for t in tags if isinstance(t, str) and str(t).strip()]


def whisper_ct2_languages() -> list[str]:
    """Documented language tags of the pinned CT2 Whisper backend."""
    return _tags(_read("whisper_language_tags.json"))


def whisper_ct2_provenance() -> dict[str, Any]:
    return _read("whisper_language_tags.json")


# B3: the published ASR-candidate tables, keyed by the REGISTRY model id so a
# registry row's claims trace to a named data file (and the file's card URL).
# The ids are the repositories that EXIST on the hub; the brief's "IBM
# granite-speech-..." form is not one, and registering a fictional id is the
# PaddleOCR-VL failure mode the registry comments already document.
CANDIDATE_TAG_FILES = {
    "nvidia/parakeet-tdt-0.6b-v3": "parakeet_tdt_06b_v3_languages.json",
    "ibm-granite/granite-speech-5.0-470m-turboctc":
        "granite_speech_5_470m_turboctc_languages.json",
    "Qwen/Qwen3-ASR-0.6B": "qwen3_asr_languages.json",
    "Qwen/Qwen3-ASR-1.7B": "qwen3_asr_languages.json",
}


def candidate_language_tags(model_id: str) -> dict[str, Any]:
    """The captured published table for a candidate id, {} when there is none."""
    name = CANDIDATE_TAG_FILES.get((model_id or "").strip())
    return _read(name) if name else {}


def candidate_languages(model_id: str) -> list[str]:
    return _tags(candidate_language_tags(model_id))


def validate_language_claims(claims: dict[str, Any], *, model_id: str = "") -> str:
    """Return "" when a manifest's optional language metadata is well formed.

    One bad row must never crash the supervisor and must never be read as if it said
    something. The problem string is surfaced in the capability report instead.
    """
    raw = claims.get("languages", [])
    if not isinstance(raw, (list, tuple, set, frozenset)):
        return (f"{model_id or 'model'}: claims.languages is {type(raw).__name__}, "
                "not a list of language tags; language routing cannot use it")
    if any(not isinstance(item, str) or not item.strip() for item in raw):
        return f"{model_id or 'model'}: claims.languages contains a non-string or empty tag"
    return ""
