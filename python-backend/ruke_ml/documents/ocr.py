"""OCR escalation ladder. Escalation is driven by measured text-layer quality, not by
'is the extracted string non-empty', and not by a provider confidence number alone."""
from __future__ import annotations

from dataclasses import dataclass

from .structures import Document

# Suffixes that decide the route; the assessment is per document, not per example.
TEXT_LAYER_OK = "native"
LIGHT_OCR = "light_ocr"
LAYOUT_MODEL = "layout_model"


@dataclass(slots=True)
class Assessment:
    route: str
    reasons: list[str]
    units: list[int]


def assess(doc: Document, min_chars_per_unit: int = 80) -> Assessment:
    """Decide the cheapest route that can plausibly answer, then escalate when it cannot."""
    reasons: list[str] = []
    if doc.kind != "pdf":
        # native/ooxml readers already keep structure; OCR would only lose it
        return Assessment(TEXT_LAYER_OK, ["structured reader already produced blocks"], [])
    cov = doc.coverage
    weak = list(dict.fromkeys(cov.units_empty + cov.units_needing_ocr))
    if cov.units_total == 0:
        return Assessment(LAYOUT_MODEL, ["no text layer was recovered at all"], [])
    if weak:
        reasons.append(f"{len(weak)} of {cov.units_total} units produced too little text")
        return Assessment(LIGHT_OCR, reasons, weak)
    if cov.units_extracted < cov.units_total:
        reasons.append("some units failed to extract")
        return Assessment(LIGHT_OCR, reasons, cov.units_failed)
    short = [i for i, b in enumerate(doc.blocks, start=1) if len(b.text.strip()) < min_chars_per_unit]
    if len(short) > len(doc.blocks) // 2:
        reasons.append("most blocks are shorter than a plausible sentence - possible column/reading-order loss")
        return Assessment(LAYOUT_MODEL, reasons, [])
    return Assessment(TEXT_LAYER_OK, ["text layer looks sufficient"], [])


def ocr_status() -> dict[str, object]:
    """Report the real capability state; OCR is not installed until the quality gate runs."""
    from ..models.registry import EVALUATION_REQUIRED, catalog
    return {"capability": "documents.ocr", "status": EVALUATION_REQUIRED,
            "candidates": [m.id for m in catalog().for_capability("documents.ocr")],
            "detail": "no OCR engine is pinned; Indic coverage is unverified, so none is claimed",
            "human_step": "run the document/OCR quality gate, then pin the selected engine"}
