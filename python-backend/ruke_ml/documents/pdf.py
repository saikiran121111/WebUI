"""PDF text-layer extraction through the pinned pypdf backend.

The adapter implements pypdf's documented API (PdfReader over a file object, PageObject
.extract_text), verified against the installed version - not another library's spelling.

Laws this module encodes:
  * a page count is not an extraction result: every page gets an explicit outcome
    (succeeded / empty / needs OCR / failed) and coverage is DERIVED from those ids;
  * page numbering is 1-based everywhere in this repository (sheets, slides, pages), and
    the ids here are the ids the citations use;
  * a non-empty text layer on some pages never proves the whole document was read;
  * encrypted, corrupt and unsupported inputs are typed refusals, never empty successes;
  * input size is bounded BEFORE any whole-file allocation, and the file is opened as a
    stream rather than read into a bytes object.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from ..contracts import sha256_hex
from .parser import ExtractionRejected
from .structures import Block, DocCoverage, Document

MAX_PDF_BYTES = 200 * 1024 * 1024        # refuse before allocating, rather than after
MAX_PAGES = 4000
READ_CHUNK = 1 << 20
MIN_GLYPHS_PER_PAGE = 24                # below this a "text layer" is decoration


def _backend():
    try:
        import pypdf                                  # noqa: PLC0415 - lazy by design
    except Exception as exc:                          # noqa: BLE001 - report, never crash
        raise ExtractionRejected(
            f"the pinned PDF backend pypdf is not importable: {type(exc).__name__}: {exc}") from exc
    return pypdf


def backend_version() -> str:
    return getattr(_backend(), "__version__", "")


def _looks_encrypted(exc: BaseException) -> bool:
    """Is this failure the "supply the password" condition?

    pypdf raises several exception types for the same deployment condition, and not all of
    them carry "Decrypt"/"Password" in the class name (FileNotDecryptedError does not). A
    misclassified encrypted file tells the reader to repair a file that is fine.
    """
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in text for marker in ("decrypt", "password", "encrypt"))


def stream_sha256(path: Path) -> str:
    """Hash without loading the whole file into memory."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(READ_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def load_pdf(path: str | Path, *, password: str = "", max_bytes: int = MAX_PDF_BYTES,
             max_pages: int = MAX_PAGES) -> Document:
    """Extract the text layer page by page, recording every page's real outcome.

    Raises ExtractionRejected with an actionable reason for encrypted, corrupt,
    oversized or structurally unusable files. Callers map that to a typed failure; they
    never receive an empty "success".
    """
    p = Path(path)
    pypdf = _backend()
    try:
        size = p.stat().st_size
    except OSError as exc:
        raise ExtractionRejected(f"cannot stat {p.name}: {exc}") from exc
    if size <= 0:
        raise ExtractionRejected("empty file: a 0-byte PDF cannot contain a page tree")
    if size > max_bytes:
        raise ExtractionRejected(
            f"{size} bytes exceeds the {max_bytes} byte bound for this adapter; "
            "split the document rather than truncating pages")

    source_hash = stream_sha256(p)
    source_id = p.name

    with p.open("rb") as fh:
        try:
            reader = pypdf.PdfReader(fh, password=password or None)
        except Exception as exc:                          # noqa: BLE001 - classified below
            if _looks_encrypted(exc):
                raise ExtractionRejected(
                    "encrypted PDF: owner/user password required before any page can be read") from exc
            name = type(exc).__name__
            raise ExtractionRejected(f"corrupt PDF: {name}: {exc}") from exc
        try:
            total = len(reader.pages)
        except Exception as exc:                          # noqa: BLE001
            # Encryption surfaces here too (FileNotDecryptedError on the page tree). Calling
            # it "unreadable page tree" hides the one action that would work: supply the
            # password. Same typed answer as the constructor path.
            if _looks_encrypted(exc):
                raise ExtractionRejected(
                    "encrypted PDF: owner/user password required before any page can be read") from exc
            raise ExtractionRejected(f"page tree unreadable: {type(exc).__name__}: {exc}") from exc
        # /Lang is a document-level entry on the Catalog (ISO 32000-1 s14.3.1), not in the /Info
        # dictionary reader.metadata covers. pypdf resolves indirect objects lazily, so this must
        # happen WHILE the handle is open - touching the Catalog after the `with` closes the file
        # raises "seek of closed file". The declared-language contract (_ocr_language) reads it
        # from meta["metadata"]["/Lang"].
        try:
            declared_lang = str(reader.trailer["/Root"].get_object().get("/Lang") or "")[:200]
        except Exception:                                 # noqa: BLE001 - absence is not an error
            declared_lang = ""
        if total <= 0:
            raise ExtractionRejected("the page tree is empty")
        if total > max_pages:
            raise ExtractionRejected(
                f"{total} pages exceeds the {max_pages} page bound; process the document in parts "
                "rather than silently dropping pages")

        blocks: list[Block] = []
        succeeded: list[int] = []
        empty: list[int] = []
        needs_ocr: list[int] = []
        failed: list[dict[str, str]] = []
        rotations: dict[int, int] = {}
        images: dict[int, int] = {}

        for index, page in enumerate(reader.pages, start=1):
            try:
                rotation = int(page.get("/Rotate", 0) or 0)
            except Exception:                             # noqa: BLE001 - malformed optional entry
                rotation = 0
            if rotation:
                rotations[index] = rotation
            try:
                text = page.extract_text(extraction_mode="plain") or ""
            except Exception as exc:                      # noqa: BLE001 - per page, never all-or-nothing
                failed.append({"page": str(index), "stage": "text_layer",
                               "detail": f"{type(exc).__name__}: {exc}"[:300]})
                continue
            try:
                image_count = len(page.images)
            except Exception:                             # noqa: BLE001 - image inventory is best effort
                image_count = -1
            if image_count > 0:
                images[index] = image_count

            stripped = text.strip()
            glyphs = sum(1 for ch in stripped if not ch.isspace())
            if glyphs >= MIN_GLYPHS_PER_PAGE:
                succeeded.append(index)
                blocks.append(Block(stripped, "page_text", source_id, source_hash,
                                    {"page": index, "rotation": rotation,
                                     "extraction": "pypdf-plain"}))
                if image_count > 0:
                    # F73 production (frozen fixture d1_mixed p1): the text layer carried
                    # only the heading while the page body was a raster image. A usable
                    # layer marked the page fully read and the imagery was never offered to
                    # OCR, so an image-only fact was undeliverable end-to-end. The page is
                    # recorded read AND stays OCR-eligible - the same two-flag honesty the
                    # weak-layer branch below uses. image_count == -1 means the inventory
                    # itself failed: unknown is not evidence of imagery, so it stays put.
                    needs_ocr.append(index)
            elif stripped:
                # Something is there but too little to be a text layer: the page is
                # recorded as BOTH extracted and OCR-eligible instead of being called good.
                succeeded.append(index)
                needs_ocr.append(index)
                blocks.append(Block(stripped, "page_text", source_id, source_hash,
                                    {"page": index, "rotation": rotation,
                                     "extraction": "pypdf-plain-weak"}))
            else:
                empty.append(index)
                if image_count != 0:
                    needs_ocr.append(index)

    failed_ids = [int(f["page"]) for f in failed]
    cov = DocCoverage(
        units_total=total,
        units_extracted=len(succeeded),
        units_succeeded=sorted(succeeded),
        units_empty=sorted(empty),
        units_needing_ocr=sorted(needs_ocr),
        units_failed=sorted(failed_ids),
        method=f"pypdf-{backend_version()}-plain",
        note=(f"{len(succeeded)}/{total} pages produced a text layer; "
              f"{len(empty)} page(s) had none, {len(failed_ids)} page(s) failed to extract. "
              "A non-empty document is not proof that every page was read."),
    )
    meta: dict[str, Any] = {
        "pages": total,
        "bytes": size,
        "page_numbering": "1-based",
        "rotated_pages": rotations,
        "pages_with_images": images,
        "page_failures": failed,
        "needs_ocr": sorted(needs_ocr),
        "metadata": _safe_metadata(pypdf, reader),
    }
    if declared_lang:
        meta["metadata"].setdefault("/Lang", declared_lang)
    return Document(source_id, source_hash, "pdf", blocks, cov, meta)


def _safe_metadata(pypdf: Any, reader: Any) -> dict[str, Any]:
    try:
        raw = reader.metadata or {}
    except Exception:                                     # noqa: BLE001
        return {}
    out = {}
    for key, value in list(raw.items())[:20]:
        if isinstance(value, str):
            out[str(key)] = value[:200]
    return out


def pdf_status() -> dict[str, Any]:
    """Capability truth without reading a document or loading a model."""
    try:
        return {"capability": "documents.parse.pdf", "status": "available",
                "backend": "pypdf", "version": backend_version(),
                "text_layer_only": True,
                "detail": "native text layer extracts per page; image-only pages are "
                          "reported as needing OCR rather than as extracted",
                "human_step": "an OCR engine must pass the document quality gate before "
                              "scanned pages can be transcribed"}
    except Exception as exc:                              # noqa: BLE001
        return {"capability": "documents.parse.pdf", "status": "not_installed",
                "backend": "pypdf", "version": "",
                "detail": f"pypdf is not importable here: {type(exc).__name__}: {exc}",
                "human_step": "install the documents extra into the backend venv"}
