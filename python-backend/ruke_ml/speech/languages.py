"""One validated language-capability helper for every speech adapter.

Why this module exists: `claims["languages"]` used to be either a list of tags or
a prose sentence ("registry multilingual, includes te and hi"). Code that iterated it
therefore walked a sentence CHARACTER BY CHARACTER, and the prose was additionally
pattern-matched for the substring "multilingual", which made every unsupported language
look supported and every real tag invisible. Both failure modes produced the same
confident routing table, which is why capability truth lives in exactly one place now.

Rules encoded here:
  * a capability claim is an explicit list of language tags, never prose;
  * base-language support is not proof of measured dialect quality (publish != measured);
  * automatic/unknown/und is NOT a language, so it can never be "supported";
  * a malformed claim is a typed ValueError, so the caller reports it instead of
    silently widening support.
"""
from __future__ import annotations

import unicodedata

from ..language_tables import validate_language_claims  # noqa: F401  (shared manifest check)

# Tags that mean "the caller does not know": they must go through real language
# detection, never through whatever model happens to be installed.
UNKNOWN_TAGS = frozenset({"", "auto", "unknown", "und", "mul", "none", "n/a", "-"})


def normalize_language(value: str) -> str:
    """Canonical form for a language tag: NFKC, lower case, BCP-47 dash separator.

    The Unicode fold matters for real input: a full-width or accented tag typed by a
    user must match the ASCII tag in a model's own table, and `zh_CN`/`zh-Hans`/`zh-cn`
    must share a base language.
    """
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = text.replace("_", "-").replace(" ", "-")
    return text


def language_is_supported(raw_languages: object, requested: str) -> bool:
    """Is `requested` inside an explicit list of supported language tags?

    Raises ValueError when the claim is not an explicit tag list: a prose sentence
    is not evidence of coverage, and accepting it is exactly how the audit reproduced
    "Telugu supported" from the words "registry multilingual".
    """
    if not isinstance(raw_languages, (list, tuple, set, frozenset)):
        raise ValueError("languages must be explicit language tags, not prose")

    if any(not isinstance(item, str) or not item.strip()
           for item in raw_languages):
        raise ValueError("each language tag must be a nonempty string")

    supported = {normalize_language(item) for item in raw_languages}
    language = normalize_language(requested)

    if language in UNKNOWN_TAGS:
        return False

    # Base-language support is not proof of measured dialect quality.
    return language in supported or language.split("-", 1)[0] in supported


def is_known_language(requested: str) -> bool:
    """True when the request actually names a language (so routing/detection can run)."""
    return normalize_language(requested) not in UNKNOWN_TAGS


def detected_language_or_none(value: object) -> str | None:
    """Only a provider-detected tag may drive a later stage; anything else is unknown."""
    if not isinstance(value, str):
        return None
    tag = normalize_language(value)
    return None if tag in UNKNOWN_TAGS else tag
