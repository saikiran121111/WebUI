"""Document extraction jobs: the parse cascade, its OCR escalation, and honest coverage.

Laws enforced here (each one was a reproduced defect at some point):
  * an unsupported extension is a TYPED refusal, never an empty "success" - the old code
    answered ready with zero blocks, which downstream read as "the document is empty";
  * coverage is derived from the ids that SUCCEEDED, never from a count. Pages 1 and 3
    succeeding while page 2 failed is two spans, not a [0,2) prefix;
  * OCR escalation is a real adapter run, and it only runs when the readiness gate says
    the engine is executable; otherwise the result keeps its text-layer provenance and
    says out loud that OCR did not run;
  * OCR text is a separate block kind with its own provenance and engine confidence. It
    never overwrites the native text layer of a page that already extracted.
"""
from __future__ import annotations

import base64
from typing import Any

from ..contracts import Coverage
from ..models.registry import catalog
from .jobs import JobContext

DEFAULT_OCR_DPI = 200
MAX_VISUAL_PAGES = 12
MAX_VISUAL_PAGE_B64 = 400_000
MAX_VISUAL_TOTAL_B64 = 1_500_000
VISUAL_DPI = 150


def _resolve(ctx: JobContext, capability_note: str) -> Any:
    from ..security import resolve_within
    path = str(ctx.req.payload.get("path", ""))
    root = str(ctx.req.payload.get("root", ""))
    if not path or not root:
        ctx.progress("input_rejected", f"{capability_note} needs path and root")
        return None
    try:
        target = resolve_within(path, root)
    except Exception as exc:                       # noqa: BLE001 - path policy refusal
        ctx.progress("input_rejected", f"path refused: {exc}")
        return None
    if not target.exists():
        ctx.progress("input_rejected", "file not found inside the allowed root")
        return None
    return target


def _ocr_language(ctx: JobContext, doc: Any) -> tuple[str, str]:
    """The document language for OCR. Never defaulted to English, never guessed per file.

    Priority: the explicit request, then the document's own declared language (the PDF
    /Lang entry, which the extractor already read), then nothing - and "nothing" is an
    actionable refusal because choosing a language data file silently is how a Hindi scan
    comes back as Latin gibberish.
    """
    explicit = str(ctx.req.payload.get("language", "") or "").strip()
    if explicit:
        return explicit, "requested"
    declared = ""
    for key, value in (getattr(doc, "meta", {}) or {}).get("metadata", {}).items():
        if str(key).lower() in ("/lang", "lang"):
            declared = str(value or "").strip()
            if declared:
                return declared, "declared by the document (/Lang)"
    return "", ""


def parse_job(ctx: JobContext) -> Any:
    """parse -> assess -> (maybe) OCR cascade, with per-page outcomes kept separate."""
    from ..documents import ocr, parser
    target = _resolve(ctx, "documents.parse")
    if target is None:
        return ctx.failed("input_rejected",
                          "documents.parse needs a path and a root inside the allowed upload root")
    if ctx.cancel.is_set():
        return ctx.cancelled()
    ctx.progress("extracting", target.name)
    try:
        doc = parser.load_document(target)
    except parser.ExtractionRejected as exc:
        return ctx.failed("corrupt_input", str(exc),
                          human_step="the archive exceeded its bounds or was malformed; "
                                     "re-export the file and retry")
    except Exception as exc:                       # noqa: BLE001 - adapter-level fault
        return ctx.failed("unsupported_input", f"extraction failed: {type(exc).__name__}: {exc}",
                          human_step="confirm the file is readable and re-export it from the "
                                     "source application if it is corrupt")
    if doc.kind == "unsupported":
        # The parser looked at the extension and found nothing configured for it. Saying
        # "ready, zero blocks" would tell the caller the document is EMPTY.
        return ctx.failed("unsupported_input",
                          f"No parser is configured for {target.suffix.lower() or 'this format'}",
                          human_step="convert the file to a supported format, or register a parser "
                                     "adapter for this extension")
    assessment = ocr.assess(doc)
    if ctx.cancel.is_set():
        return ctx.cancelled()

    ocr_payload = run_ocr_stage(ctx, doc, target, assessment)
    return _parse_result(ctx, doc, assessment, ocr_payload, target)


def _visual_pages(doc: Any, target: Any) -> dict[str, Any]:
    """Rendered page images for pages whose CONTENT is drawn (vector charts/diagrams).

    Driven by the extractor's content-derived flag (meta["pages_with_visual"], paint
    operations counted in the page's own content streams - never a name, topic or phrase
    match). The text layer of a chart page reads as a title plus axis labels; the drawn
    fact (which bar is taller) exists only in the page image, so the flagged pages are
    rendered on demand and carried to the reader as frames. Bounded: a page cap and a
    total cap keep the payload inside the worker memory budget, and a page that fails to
    render is omitted, never replaced.
    """
    pages = (getattr(doc, "meta", {}) or {}).get("pages_with_visual") or {}
    if doc.kind != "pdf" or not pages:
        return {"pages": [], "note": ""}
    from ..documents import ocr_tesseract
    rotations = {int(k): int(v) for k, v in (doc.meta.get("rotated_pages") or {}).items()}
    ranked = sorted(((int(k), int(v)) for k, v in pages.items()),
                    key=lambda kv: (-kv[1], kv[0]))[:MAX_VISUAL_PAGES]
    out: list[dict[str, Any]] = []
    total = 0
    for page, ops in sorted(ranked):
        try:
            png, info = ocr_tesseract.render_page_png(str(target), page, dpi=VISUAL_DPI,
                                                       rotation=rotations.get(page, 0))
        except ocr_tesseract.OcrUnavailable:
            continue                                      # omitted, not replaced
        encoded = base64.b64encode(png).decode("ascii")
        if len(encoded) > MAX_VISUAL_PAGE_B64 or total + len(encoded) > MAX_VISUAL_TOTAL_B64:
            continue
        total += len(encoded)
        out.append({"page": page, "ops": ops, "png_base64": encoded,
                    "width": info["width"], "height": info["height"], "dpi": info["dpi"]})
    note = (f"{len(out)} page image(s) rendered for pages whose content is drawn "
            "(vector chart/diagram marks the text layer cannot carry); `page` is the "
            "1-based PDF page index" if out else "")
    return {"pages": out, "note": note}


def _parse_result(ctx: JobContext, doc: Any, assessment: Any, ocr_payload: dict[str, Any],
                  target: Any) -> Any:
    units = doc.coverage.units_total or len(doc.blocks)
    units_name = "pages" if doc.kind == "pdf" else "units"
    note = doc.coverage.note or "non-empty text is not proof that every unit was understood"
    if ocr_payload.get("ran"):
        note = f"{note} | OCR ran on {ocr_payload['attempted']} unit(s): {ocr_payload['summary']}"
    elif ocr_payload.get("reason"):
        note = f"{note} | OCR NOT run: {ocr_payload['reason']}"
    # A structure-preserving rendering of each office unit, DERIVED from the blocks and
    # shipped ALONGSIDE them. Without it, a caller that joins block texts loses the cell
    # coordinates, merged-range facts, heading levels and table-row identity this reader
    # genuinely parsed - and then measures its own output as worse than the TS reader's.
    from ..documents import render as render_mod
    rendered = render_mod.render_units(doc)
    visual = _visual_pages(doc, target)
    if visual["pages"]:
        note = f"{note} | {visual['note']}"
    return ctx.ready(
        {"document": doc.to_dict(), "ocr_route": assessment.route,
         "ocr_reasons": assessment.reasons, "ocr_units": assessment.units,
         "ocr": ocr_payload,
         "visual_pages": visual["pages"],
         "visual_note": visual["note"],
         "coverage_complete": doc.coverage.complete,
         "units_succeeded": doc.coverage.units_succeeded,
         "units_needing_ocr": doc.coverage.units_needing_ocr,
         "units_failed": doc.coverage.units_failed,
         "units_empty": doc.coverage.units_empty,
         "page_numbering": "1-based",
         "rendered_units": rendered,
         "rendering_note": ("office units are rendered with their coordinates, merged ranges, "
                            "heading levels and table-row identity; the block list remains the "
                            "raw evidence" if rendered else
                            "no per-unit rendering for this kind; blocks are the text")},
        coverage=Coverage(units=units_name, total_source=float(units),
                          examined=doc.coverage.succeeded_spans(),
                          skipped=doc.coverage.uncovered_spans(),
                          complete=doc.coverage.complete, note=note))


def run_ocr_stage(ctx: JobContext, doc: Any, target: Any, assessment: Any) -> dict[str, Any]:
    """Run the real OCR adapter on the units the assessment flagged, and merge honestly.

    Returns a report dict; the document's blocks/coverage are only updated for pages the
    engine ACTUALLY recognised. A page whose rasterization or recognition failed stays in
    the uncovered set with its detail, so a partial OCR never inflates coverage.
    """
    from ..documents import ocr
    report: dict[str, Any] = {"ran": False, "attempted": 0, "recognized": 0, "pages": [],
                              "summary": "", "reason": "", "language": "", "language_source": ""}
    if assessment.route == ocr.TEXT_LAYER_OK:
        # The assessment's own reasons are the evidence: "native text layer" alone would hide
        # the case where units are uncovered because they carry neither text nor image evidence.
        report["reason"] = ("; ".join(assessment.reasons)
                            or "the assessment routed this document to the native text layer")
        return report
    if doc.kind != "pdf":
        report["reason"] = f"the OCR cascade is wired for pdf; this document is {doc.kind}"
        return report
    units = [int(u) for u in (assessment.units or [])]
    if not units:
        report["reason"] = "the assessment flagged no specific unit to OCR"
        return report
    if not catalog().executable_for("documents.ocr"):
        _, blockers = catalog().blockers_for("documents.ocr")
        report["reason"] = ("the OCR engine is not executable here: "
                            + ("; ".join(blockers) if blockers else "no executable row"))
        return report
    language, source = _ocr_language(ctx, doc)
    if not language:
        # Nobody declared a language. Before the refusal, the engine may answer - validated,
        # not defaulted: its own script estimate on the raster of the first flagged page,
        # mapped by the general script table, then required to READ that page within the
        # measured quality bounds (ocr_tesseract constants). Every failed step names its
        # reason, and the typed refusal below is unchanged when detection refuses too.
        from ..documents import ocr_tesseract
        rotations = {int(k): int(v) for k, v in (doc.meta.get("rotated_pages") or {}).items()}
        try:
            detection = ocr_tesseract.detect_language(
                str(target), units[0], rotation=rotations.get(units[0], 0))
        except ocr_tesseract.OcrUnavailable as exc:
            detection = {"verified": False,
                         "reason": f"detection raster failed: {exc.kind}: {exc.detail}"}
        report["language_detection"] = detection
        if detection.get("verified"):
            language = str(detection.get("language", ""))
            source = (f"detected: the engine's script analysis of page {units[0]} "
                      f"({detection.get('script', '')}), validated by a verification OCR pass")
    if not language:
        reason = ("no document language was given or declared; the engine's language "
                  "data is chosen explicitly and is never defaulted to English")
        detection = report.get("language_detection")
        if detection:
            reason += f"; validated detection on page {units[0]} refused: {detection['reason']}"
        report["reason"] = reason
        report["needs_language"] = True
        return report
    report.update(language=language, language_source=source)
    # The cascade owns engine choice; this job owns the request's language, DPI, rotation map,
    # cancellation and deadline. ocr_tesseract stays imported because an OcrUnavailable that
    # escapes the cascade still has to reach the shared kind->wire-reason mapping.
    from ..documents import ocr_cascade, ocr_tesseract
    dpi = int(ctx.req.payload.get("dpi", DEFAULT_OCR_DPI) or DEFAULT_OCR_DPI)
    ctx.progress("ocr", f"{len(units)} page(s) at {dpi} dpi, language={language}")
    try:
        pages, cascade_report = ocr_cascade.run(
            str(target), units, language=language, dpi=dpi,
            rotations={int(k): int(v) for k, v in ((doc.meta.get("rotated_pages") or {})).items()},
            cancel=ctx.cancel.is_set,
            progress=lambda state, note: ctx.progress(state, note),
            deadline_at=ctx.deadline_at(),
            job_id=ctx.req.job_id or "documents.ocr")
    except ocr_tesseract.OcrUnavailable as exc:
        from .jobs import typed_from_kind
        err = typed_from_kind(exc.kind, exc.detail, human_step=exc.human_step,
                              capability="documents.ocr")
        report.update(reason=f"{err.reason}: {err.message}", human_step=err.human_step)
        return report
    casc = cascade_report["cascade"]
    report["cascade"] = casc
    if casc.get("waiting"):
        # F122: the exclusive window was busy. The pages stay in the OCR-pending set
        # (nothing is recognised, nothing is substituted), and the report says the job is
        # waiting/retryable rather than presenting a fallback answer as an outcome.
        report["waiting"] = True
        report["retryable"] = True
        report["reason"] = ("resource_busy: the exclusive window is held by another owner; "
                            "the OCR pages stay pending and the job is retryable — no "
                            "engine was substituted")
    report["engines"] = casc.get("engines_used", [])
    report["primary_ready"] = bool((casc.get("primary") or {}).get("ready"))
    report["ran"] = True
    report["attempted"] = len(pages)
    recognized: list[int] = []
    for page in pages:
        report["pages"].append({"page": page.page, "state": page.state, "detail": page.detail,
                                "confidence": page.confidence, "engine": page.engine,
                                "language_code": page.language_code, "raster": page.raster})
        if page.state == "recognised" and page.text:
            recognized.append(page.page)
            doc.blocks.append(_Block(page.text, "ocr_text", doc.source_id, doc.source_hash,
                                     {"page": page.page, "dpi": page.raster.get("dpi", dpi),
                                      "engine": page.engine, "language_code": page.language_code,
                                      "provenance": "ocr"}))
    report["recognized"] = len(recognized)
    per_engine: dict[str, int] = {}
    for page in pages:
        if page.state == "recognised":
            per_engine[str(page.engine or "none")] = per_engine.get(str(page.engine or "none"), 0) + 1
    report["summary"] = (f"{len(recognized)}/{len(pages)} page(s) recognised "
                         f"({report['language']}), "
                         f"{sum(1 for p in pages if p.state == 'empty')} empty, "
                         f"{sum(1 for p in pages if p.state in ('ocr_failed', 'raster_failed'))} failed, "
                         f"{sum(1 for p in pages if p.state == 'skipped')} skipped by cancellation; "
                         f"recognised per engine: {per_engine or 'none'}")
    report["engines_recognised"] = per_engine
    _absorb_ocr_units(doc, pages, recognized)
    return report


def _absorb_ocr_units(doc: Any, pages: list[Any], recognized: list[int]) -> None:
    """Move a page from the OCR-pending set to the succeeded set ONLY if the engine read it."""
    cov = doc.coverage
    states = {p.page: p.state for p in pages}
    for page in recognized:
        if page not in cov.units_succeeded:
            cov.units_succeeded = sorted(set(cov.units_succeeded) | {page})
        cov.units_needing_ocr = [u for u in cov.units_needing_ocr if u != page]
        cov.units_empty = [u for u in cov.units_empty if u != page]
        cov.units_failed = [u for u in cov.units_failed if u != page]
    still_bad = [p.page for p in pages if states.get(p.page) in ("ocr_failed", "raster_failed")]
    if still_bad:
        cov.units_failed = sorted(set(cov.units_failed) | set(still_bad))
    cov.units_extracted = len(set(cov.units_succeeded)) if cov.units_succeeded else cov.units_extracted
    cov.note = (cov.note + f" | OCR attempted {len(pages)} page(s), recognised {len(recognized)}"
                if cov.note else f"OCR attempted {len(pages)} page(s), recognised {len(recognized)}")


def ocr_job(ctx: JobContext) -> Any:
    """The OCR capability on its own: rasterize + recognise an explicit page list."""
    from ..documents import ocr_cascade, ocr_tesseract, pdf
    target = _resolve(ctx, "documents.ocr")
    if target is None:
        return ctx.failed("input_rejected",
                          "documents.ocr needs a path and a root inside the allowed upload root")
    if target.suffix.lower() != ".pdf":
        return ctx.failed("unsupported_input",
                          f"the OCR adapter is wired for pdf; got {target.suffix.lower() or 'no extension'}",
                          human_step="pass a PDF, or rasterize the source first")
    language, source = _ocr_language(ctx, None)
    if not language:
        return ctx.failed("input_rejected",
                          "documents.ocr needs an explicit document language",
                          human_step='pass payload.language (an ISO tag); the engine language '
                                     'data is never defaulted to English')
    pages = ctx.req.payload.get("pages")
    if not isinstance(pages, list) or not pages:
        try:
            doc = pdf.load_pdf(target)
        except pdf.ExtractionRejected as exc:
            return ctx.failed("corrupt_input", str(exc),
                              human_step="decrypt/repair the PDF, then retry")
        pages = (sorted(set(doc.coverage.units_needing_ocr + doc.coverage.units_empty
                            + doc.coverage.units_failed))
                 or list(range(1, doc.coverage.units_total + 1)))
    dpi = int(ctx.req.payload.get("dpi", DEFAULT_OCR_DPI) or DEFAULT_OCR_DPI)
    ctx.progress("ocr", f"{len(pages)} page(s) at {dpi} dpi, language={language}")
    try:
        results, cascade_report = ocr_cascade.run(
            str(target), [int(p) for p in pages], language=language, dpi=dpi,
            cancel=ctx.cancel.is_set,
            progress=lambda state, note: ctx.progress(state, note),
            deadline_at=ctx.deadline_at(),
            job_id=ctx.req.job_id or "documents.ocr")
    except ocr_tesseract.OcrUnavailable as exc:
        from .jobs import typed_from_kind
        err = typed_from_kind(exc.kind, exc.detail, human_step=exc.human_step,
                              capability="documents.ocr")
        return ctx.failed(err.reason, err.message, retryable=err.retryable, human_step=err.human_step)
    if ctx.cancel.is_set():
        return ctx.cancelled()
    waiting = cascade_report["cascade"].get("waiting")
    if waiting:
        # F122 (user brief 2026-11-23): a busy exclusive lease leaves the job WAITING and
        # RETRYABLE — the same wire mapping the ASR dispatcher uses. No engine was
        # substituted, so the caller keeps the request, not a Tesseract answer.
        return ctx.failed(
            "resource_busy",
            f"the exclusive window is held by another owner: {waiting.get('detail', '')}",
            retryable=True,
            human_step="the OCR run starts once the endpoint is idle; active inference is "
                       "never interrupted, and the selected OCR engine is never silently "
                       "replaced — send the upload again when the window is free")
    recognised = [r for r in results if r.state == "recognised"]
    blocks = [{"page": r.page, "text": r.text, "confidence": r.confidence,
               "engine": r.engine, "language_code": r.language_code} for r in recognised]
    total = len(results)
    return ctx.ready(
        {"pages": [r.to_dict() for r in results], "blocks": blocks,
         "language": language, "language_source": source, "dpi": dpi,
         "engine": ocr_tesseract.engine_state().get("version", ""),
         "cascade": cascade_report["cascade"],
         "recognized": len(recognised),
         "note": "confidence is the engine's own; accuracy on this host is measured only by the "
                 "document quality gate"},
        coverage=Coverage(units="pages", total_source=float(total),
                          examined=[(float(r.page - 1), float(r.page)) for r in recognised],
                          skipped=[(float(r.page - 1), float(r.page)) for r in results
                                   if r.state != "recognised"],
                          complete=bool(total) and len(recognised) == total,
                          note=f"{len(recognised)}/{total} page(s) recognised; page ids are 1-based"))


def _Block(text: str, kind: str, source_id: str, source_hash: str, loc: dict[str, Any]) -> Any:
    from ..documents.structures import Block
    return Block(text, kind, source_id, source_hash, loc)
