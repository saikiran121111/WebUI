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
    # Escalation needs MEASURED evidence that a raster exists and was not read: a page whose
    # text layer is too short, a page that carries an image but no text, or a page whose text
    # extraction raised. A page that produced neither text nor image evidence is blank - OCR
    # cannot manufacture evidence there, so it stays an uncovered unit instead of becoming an
    # advertised OCR job. (A PDF upload is not an OCR instruction.)
    escalate = list(dict.fromkeys(list(cov.units_needing_ocr) + list(cov.units_failed)))
    blank = [u for u in cov.units_empty if u not in set(escalate)]
    if cov.units_total == 0:
        return Assessment(LAYOUT_MODEL, ["no text layer was recovered at all"], [])
    if escalate:
        reasons.append(f"{len(escalate)} of {cov.units_total} unit(s) carry raster or "
                       "extraction evidence that the text layer did not capture")
        if blank:
            reasons.append(f"{len(blank)} unit(s) produced neither text nor image evidence")
        return Assessment(LIGHT_OCR, reasons, escalate)
    if blank:
        reasons.append(
            f"{len(blank)} of {cov.units_total} unit(s) produced no text layer and carry no "
            "image evidence: there is nothing there to recognise, so they stay recorded as "
            "uncovered rather than being sent to an OCR engine")
        return Assessment(TEXT_LAYER_OK, reasons, [])
    if cov.units_extracted < cov.units_total:
        reasons.append("some units failed to extract")
        return Assessment(LIGHT_OCR, reasons, cov.units_failed)
    short = [i for i, b in enumerate(doc.blocks, start=1) if len(b.text.strip()) < min_chars_per_unit]
    if len(short) > len(doc.blocks) // 2:
        reasons.append("most blocks are shorter than a plausible sentence - possible column/reading-order loss")
        return Assessment(LAYOUT_MODEL, reasons, [])
    return Assessment(TEXT_LAYER_OK,
                      [f"all {cov.units_total} unit(s) produced a usable text layer; no unit "
                       "showed raster evidence"], [])


def ocr_status() -> dict[str, object]:
    """Report the real capability state from the adapter, never from a status string.

    The engine itself decides whether OCR can execute here (a validated binary plus a
    working rasterizer). Coverage claims come from the engine's own language data, and
    ACCURACY still only ever comes from the eval harness - executable is not measured.
    """
    from ..models.registry import AVAILABLE, catalog
    from . import ocr_tesseract
    st = catalog().status_for("documents.ocr")
    adapter = ocr_tesseract.ocr_status()
    executable = st["status"] == AVAILABLE
    return {"capability": "documents.ocr",
            "status": st["status"],
            "candidates": [m.id for m in catalog().for_capability("documents.ocr")],
            "executable": executable,
            "engine": {"binary": ocr_tesseract.engine_state()["binary"],
                       "version": adapter.get("version", "") or ocr_tesseract.engine_state()["version"],
                       "languages": adapter.get("languages", []),
                       "languages_source": adapter.get("languages_source", ""),
                       "rasterizer": ocr_tesseract.rasterizer_state()},
            "detail": st["detail"],
            "quality": adapter.get("quality", "accuracy is measured only by the document quality gate"),
            "human_step": st.get("human_step", "") or adapter.get("human_step", "")}
