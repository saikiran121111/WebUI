"""Decide, per embedded-image REGION, whether an OCR engine should run - and run it.

Why this exists: the PDF path already judges unit-by-unit (documents/ocr.assess), but
Office documents carry their text-bearing labels INSIDE package rasters (a PPTX legend,
a DOCX screenshot, an XLSX chart image), and a standalone image is one raster. The old
gate refused everything non-PDF, so an image-only label like "AMBER CLOSE" was invisible:
the native reader returned the paragraph around the picture and the pixels were never
read. This module is the cheap inspection the user brief demands:

  * every region gets ONE raster probe (wrap as one-page PDF, render, luminance features);
  * a clean native label, a uniformly blank render, or a photo with no text structure
    answers with ZERO engine calls - the pixels are kept for visual questions instead;
  * a region whose raster carries text structure the native extraction does not cover is
    OCR-eligible, and the EXISTING cascade reads it (documents/regionpdf wraps the
    raster so ocr_cascade.run applies the engine policy, ceilings, busy-window wait and
    fallback laws unchanged - one resource law, not two);
  * decode/render failure is recorded as unreadable+retryable with the reason;
  * an image count, a character threshold, a filename or a topic never decides anything -
    only the inspected pixels and the native text do.

Every region answers with evidence: state, reason, probe features, engine, and the exact
engine-invocation counts, so "why was this skipped, queued, read, or left unreadable"
is answerable from the record alone.

F152 amendment (PDF figures): a PDF region is ONE EMBEDDED IMAGE, located by its placement
rect. The page renders once, the raster is cropped to the figure (colour kept - a violet
threshold line's colour is the fact, a luma crop cannot answer it), and coverage is judged
token-by-token against the native text LOCAL to that token's position (pypdfium2
get_text_bounded over the probe line's rect) - a word printed in a paragraph does not
prove the same word in a separate chart was read, and a short token (A, 7, pH, 42) or a
non-Latin label is a token like any other. The cascade reads the CROP, so page prose is
never re-OCR'd and the delivered frame is the figure. Every recognition - probe passes
included - is counted from the adapter's own counter, never from a caller's tally. When
the placement rect is unavailable the region degrades to the page-wide path with the
reason recorded, never to zero inspection.
"""
from __future__ import annotations

import re
import statistics
import tempfile
import zipfile
import zlib
from pathlib import Path
from typing import Any, Callable

from . import ocr_cascade, ocr_tesseract, regionpdf

# Probe render DPI: enough to measure luminance structure (text strokes survive),
# cheap enough to pay for EVERY embedded raster without a model load.
PROBE_DPI = 150
# A render is "uniformly blank" when the luminance spans less than this.
BLANK_SPAN = 8
# Ink = a pixel whose luminance differs from the region's median by more than this.
INK_DELTA = 45
# A STROKE must contrast strongly with the region's ground: printed glyphs sit far
# (black-on-paper, white-on-dark). Decorative mid-contrast texture (striped grounds,
# photo gradients) sits below this band and must not swallow the letters.
STROKE_DELTA = 150
# Glyph evidence from 2D ink components (periodic stripes are ONE ground-to-sky slab,
# photos are giant blobs or dust - letters are small, filled, bounded boxes).
GLYPH_MIN = 6      # isolated glyph-shaped components that call a region text-bearing
WORD_MIN = 12      # word-sized components (typeset scan pages connect into word runs)
# Cap for the component walk: huge rasters are measured on a stride-reduced mask.
CC_MAX_PIXELS = 400_000
# Text sits on a quiet background: above this ink fraction the "text" is texture.
TEXT_INK_MAX = 0.35
# Photographic texture: sampled neighbour-to-neighbour luminance moves, averaged.
# Text on a printed/striped background sits far below this; natural photos above it.
PHOTO_EDGE_DENSITY = 18.0
# Cap a region's visual payload so one giant raster cannot sink the frame budget.
MAX_REGION_PNG = 400_000
# Slack around a figure's placement rect when cropping the page render: labels printed
# at the very edge of the image box must not be sliced by a float rounding.
CROP_PAD_PX = 8


def _png_scan(png: bytes) -> tuple[tuple[int, int, int, int], bytes] | None:
    """Split the rasterizer's PNG into (IHDR w,h,bitdepth,colortype, idat bytes)."""
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    pos, idat, ihdr = 8, b"", None
    while pos + 8 <= len(png):
        length = int.from_bytes(png[pos:pos + 4], "big")
        ctype = png[pos + 4:pos + 8]
        body = png[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            w, h, bd, ct = int.from_bytes(body[0:4], "big"), int.from_bytes(body[4:8], "big"), body[8], body[9]
            ihdr = (w, h, bd, ct)
        elif ctype == b"IDAT":
            idat += body
        pos += 12 + length
        if ctype == b"IEND":
            break
    if not ihdr:
        return None
    w, h, bd, ct = ihdr
    if bd != 8 or ct not in (0, 2, 6):
        return None
    try:
        raw = zlib.decompress(idat)
    except zlib.error:
        return None
    return (w, h, bd, ct), raw


def _luma_rows(png: bytes) -> tuple[list[bytes], int, int] | None:
    """Decode the rasterizer's PNG (filter-0 RGB/RGBA rows) to per-row 8-bit luma bytes."""
    scan = _png_scan(png)
    if scan is None:
        return None
    (w, h, _bd, ct), raw = scan
    ch = {0: 1, 2: 3, 6: 4}[ct]
    stride = w * ch
    if len(raw) < (stride + 1) * h:
        return None
    rows = []
    for y in range(h):
        line = raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)]
        if ch == 1:
            rows.append(line)
        else:
            rows.append(bytes((line[3 * x] + line[3 * x + 1] + line[3 * x + 2]) // 3
                              for x in range(w)))
    return rows, w, h


def _rgb_rows(png: bytes) -> tuple[list[bytes], int, int] | None:
    """Decode to per-row 8-bit RGB bytes. COLOUR is kept: the fact under inspection
    can be a colour (a violet line crossing a threshold), so the crop handed to the
    cascade and to Qwen must not be a luma image."""
    scan = _png_scan(png)
    if scan is None:
        return None
    (w, h, _bd, ct), raw = scan
    ch = {0: 1, 2: 3, 6: 4}[ct]
    stride = w * ch
    if len(raw) < (stride + 1) * h:
        return None
    rows = []
    for y in range(h):
        line = raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)]
        if ct == 2:
            rows.append(line)
        elif ct == 0:
            rows.append(bytes([v for v in line for _ in range(3)]))
        else:
            rows.append(bytes(v for x in range(w) for v in line[4 * x:4 * x + 3]))
    return rows, w, h


def raster_features(png: bytes) -> dict[str, Any]:
    """Cheap luminance features of one rendered region. No engine, no model."""
    decoded = _luma_rows(png)
    if decoded is None:
        return {"measurable": False, "reason": "the probe render is not a decodable 8-bit RGB raster"}
    rows, w, h = decoded
    flat = b"".join(rows)
    lo, hi = min(flat), max(flat)
    med = statistics.median(flat)
    ink = sum(1 for v in flat if abs(v - med) > INK_DELTA)
    ink_fraction = ink / len(flat)
    blank = (hi - lo) <= BLANK_SPAN
    glyphs, words, biggest = _component_shapes(rows, w, h, med)
    # Edge density over a sampled grid: photos churn everywhere, text sits on quiet ground.
    steps, moves, samples = 0, 0, 0
    for y in range(1, h, 2):
        prev = rows[y - 1]
        line = rows[y]
        for x in range(1, w, 2):
            steps += 1
            moves += abs(line[x] - prev[x])
            samples += 1
    edge_density = round(moves / samples, 2) if samples else 0.0
    text_structure = (glyphs >= GLYPH_MIN or words >= WORD_MIN) and ink_fraction >= 0.002
    return {"measurable": True, "width": w, "height": h, "luma_min": lo, "luma_max": hi,
            "luma_median": med, "blank": blank, "ink_fraction": round(ink_fraction, 4),
            "glyph_count": glyphs, "word_count": words, "biggest_component": biggest,
            "edge_density": edge_density, "text_structure": text_structure,
            "photo_like": edge_density >= PHOTO_EDGE_DENSITY and ink_fraction > 0.25
            and not text_structure}


def _component_shapes(rows: list[bytes], w: int, h: int, med: int) -> tuple[int, int, int]:
    """Connected ink components classified as glyph-shaped / word-shaped. Returns
    (glyphs, words, biggest_component_area). Stripes span the full height and photos
    form slabs or dust; letters are small filled bounded boxes - that is the whole test."""
    s = 1
    while w * h // (s * s) > CC_MAX_PIXELS:
        s += 1
    if s > 1:
        rows = [line[::s] for line in rows[::s]]
        w, h = len(rows[0]), len(rows)
    mask = [[abs(v - med) > STROKE_DELTA for v in line] for line in rows]
    seen = [[False] * w for _ in range(h)]
    glyphs = words = biggest = 0
    glyph_w, glyph_h = max(8, 0.30 * w), max(10, 0.25 * h)
    word_h = max(8, 0.12 * h)
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            stack = [(y, x)]
            seen[y][x] = True
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            while stack:
                cy, cx = stack.pop()
                area += 1
                if cx < min_x:
                    min_x = cx
                if cx > max_x:
                    max_x = cx
                if cy < min_y:
                    min_y = cy
                if cy > max_y:
                    max_y = cy
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((ny, nx))
            cw, chh = max_x - min_x + 1, max_y - min_y + 1
            biggest = max(biggest, area * s * s)
            fill = area / (cw * chh)
            if 4 <= cw <= glyph_w and 6 <= chh <= glyph_h and area >= 16 and fill >= 0.08:
                glyphs += 1
            elif 10 <= cw <= 0.60 * w and 5 <= chh <= word_h and area >= 24 and fill >= 0.05:
                words += 1
    return glyphs, words, biggest


def _region_bytes(target: Path, kind: str, region: dict[str, Any]) -> bytes:
    part = str(region.get("part") or "")
    # A standalone raster names itself as its part: there is no package to open.
    if kind == "image" or part in (".png", ".jpg", ".jpeg", ".gif", ".bmp",
                                   ".tif", ".tiff", ".webp", ""):
        return target.read_bytes()
    with zipfile.ZipFile(target) as zf:
        return zf.read(part)


def region_id(kind: str, region: dict[str, Any]) -> str:
    part = str(region.get("part") or Path(str(region.get("name", "raster"))).name)
    return f"{kind}:{region.get('unit')}:{part}"


def _words_of(text: str) -> set[str]:
    """Normalised tokens for the coverage comparison: every unicode word run
    (letters, digits, underscore - non-Latin labels included), lower-cased.
    F152 amendment: the old [A-Za-z0-9]{3,} filter DROPPED the tokens that matter -
    the axis label "A", the tick "7", "pH", "42", every non-ASCII label - so a chart
    carrying only short tokens read as "fully covered" and was never OCR'd."""
    return {w.lower() for w in re.findall(r"\w+", text)}


def _covered(word: str, native: set[str]) -> bool:
    """A probe word is covered by the native text when it appears there, or is a
    fragment / superset of a native word - probe OCR at 150 dpi splits and merges
    tokens, and a split fragment is not uncovered content."""
    if word in native:
        return True
    return any(word in n or n in word for n in native)


# ---------------------------------------------------------------- figure geometry
def _rotate_rect(rect: tuple[float, float, float, float], w_px: float, h_px: float,
                 rot: int) -> tuple[float, float, float, float]:
    """Map (x0,y0,x1,y1) in the RAW page raster (w_px x h_px) into the raster rendered
    `rot` degrees clockwise (pypdfium2 applies the page /Rotate; the render parameter
    adds to it, so caller-rotation == total orientation). Corners first, then bounds."""
    x0, y0, x1, y1 = rect
    corners = [(x0, y0), (x0, y1), (x1, y0), (x1, y1)]
    out = []
    for x, y in corners:
        if rot == 90:
            out.append((h_px - 1 - y, x))
        elif rot == 180:
            out.append((w_px - 1 - x, h_px - 1 - y))
        elif rot == 270:
            out.append((y, w_px - 1 - x))
        else:
            out.append((x, y))
    xs = [p[0] for p in out]
    ys = [p[1] for p in out]
    return (min(xs), min(ys), max(xs), max(ys))


def _unrotate_rect(rect: tuple[float, float, float, float], wr_px: float, hr_px: float,
                   rot: int) -> tuple[float, float, float, float]:
    """Inverse of _rotate_rect: a rect in the DISPLAY raster (wr_px x hr_px) back to
    the raw page raster. The 90/270 rasters are transposed, so wr/hr swap roles."""
    x0, y0, x1, y1 = rect
    if rot == 90:          # display (x',y') -> raw (x = y', y = wr_px-1-x')
        return (y0, wr_px - 1 - x1, y1, wr_px - 1 - x0)
    if rot == 180:
        return (wr_px - 1 - x1, hr_px - 1 - y1, wr_px - 1 - x0, hr_px - 1 - y0)
    if rot == 270:         # display (x',y') -> raw (x = hr_px-1-y', y = x')
        return (hr_px - 1 - y1, x0, hr_px - 1 - y0, x1)
    return rect


def _placement_rect(bounds: list[float], page_w_pt: float, page_h_pt: float,
                    raster_w: int, raster_h: int, rot: int) -> tuple[float, float, float, float] | None:
    """The embedded image's placement rect (PDF points, y-up, RAW page space) mapped
    into the rendered raster's pixels - padding, then clamped. None when the rect is
    unusable (degenerate, off-page, page size unknown)."""
    if len(bounds) != 4 or page_w_pt <= 0 or page_h_pt <= 0:
        return None
    try:
        left, bottom, right, top = (float(v) for v in bounds)
    except (TypeError, ValueError):
        return None
    if right <= left or top <= bottom:
        return None
    scale = PROBE_DPI / 72.0
    raw = (left * scale, (page_h_pt - top) * scale, right * scale, (page_h_pt - bottom) * scale)
    rect = _rotate_rect(raw, page_w_pt * scale, page_h_pt * scale, rot % 360)
    rect = (rect[0] - CROP_PAD_PX, rect[1] - CROP_PAD_PX, rect[2] + CROP_PAD_PX, rect[3] + CROP_PAD_PX)
    x0 = max(0.0, rect[0])
    y0 = max(0.0, rect[1])
    x1 = min(float(raster_w), rect[2] + 1.0)
    y1 = min(float(raster_h), rect[3] + 1.0)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return (x0, y0, x1, y1)


def _crop_png(png: bytes, rect: tuple[float, float, float, float]) -> bytes | None:
    """Crop an RGB crop out of the page render. Colour kept (see _rgb_rows)."""
    decoded = _rgb_rows(png)
    if decoded is None:
        return None
    rows, w, h = decoded
    x0 = max(0, int(rect[0]))
    y0 = max(0, int(rect[1]))
    x1 = min(w, int(rect[2] + 0.999))
    y1 = min(h, int(rect[3] + 0.999))
    cw, chh = x1 - x0, y1 - y0
    if cw < 8 or chh < 8:
        return None
    flat = b"".join(row[x0 * 3:x1 * 3] for row in rows[y0:y1])
    return ocr_tesseract.encode_png(cw, chh, 3, flat)


def _pdf_text_probe(target: Path):
    """A lazily opened pdfium view of the TARGET document:
    page_text(index, rect_pt) -> (native text inside the rect, "") or (None, reason),
    and page_size(index) -> (w_pt, h_pt) in raw page points.
    pypdfium2's textpage.get_text_bounded is the documented position query - the
    native characters sitting INSIDE a rect, not the page's word set. One open per
    document; every failure answers with its real reason so the caller can fall back
    to the page-wide law WITH the cause recorded."""
    state: list[Any] = []

    def ensure() -> str:
        if not state:
            try:
                import pypdfium2                          # noqa: PLC0415 - lazy by design
                state.append(pypdfium2.PdfDocument(str(target)))
            except Exception as exc:                      # noqa: BLE001 - report, never crash
                state.append(None)
                return f"position-aware native text unavailable: {type(exc).__name__}: {exc}"[:200]
        return "" if state[0] is not None else "position-aware native text unavailable"

    def page_text(index: int, rect: tuple[float, float, float, float]) -> tuple[str | None, str]:
        if ensure():
            return None, ensure()
        try:
            textpage = state[0][index - 1].get_textpage()
            left, bottom, right, top = rect
            return textpage.get_text_bounded(left=left, bottom=bottom, right=right, top=top), ""
        except Exception as exc:                          # noqa: BLE001 - per rect
            return None, f"native text rect read failed: {type(exc).__name__}: {exc}"[:200]

    def page_size(index: int) -> tuple[float, float]:
        if ensure():
            return 0.0, 0.0
        try:
            w, h = state[0][index - 1].get_size()
            return float(w), float(h)
        except Exception:                                 # noqa: BLE001
            return 0.0, 0.0

    return page_text, page_size


def _figure_coverage(lines: list[dict[str, Any]], crop_rect: tuple[float, float, float, float],
                     raster_w: int, raster_h: int, rot: int, page_index: int,
                     page_text, page_size, native_fallback: str
                     ) -> tuple[set[str], set[str], str]:
    """Position-aware coverage for a figure crop: every probe LINE is mapped back to
    raw page points (crop offset -> display raster -> inverse rotation -> points, the
    y-flip is (h_pt - y_px/scale)), and its tokens are compared against the native
    text INSIDE that line's rect only. Returns (probe_tokens, uncovered_tokens,
    coverage_mode). When the position query fails the page-wide word-set law runs
    WITH the reason recorded - inspection degrades, it never vanishes."""
    scale = PROBE_DPI / 72.0
    w_pt, h_pt = page_size(page_index)
    pad_pt = CROP_PAD_PX / scale
    probe_all: set[str] = set()
    uncovered: set[str] = set()
    mode = "position"
    for line in lines:
        tokens = _words_of(str(line.get("text") or ""))
        if not tokens:
            continue
        probe_all |= tokens
        bbox = line.get("bbox") or [0, 0, 0, 0]
        try:
            lx0, ly0, lx1, ly1 = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
        except (TypeError, ValueError):
            continue
        display = (lx0 + crop_rect[0], ly0 + crop_rect[1], lx1 + crop_rect[0], ly1 + crop_rect[1])
        raw = _unrotate_rect(display, raster_w, raster_h, rot % 360)
        rect_pt = (raw[0] / scale - pad_pt, h_pt - raw[3] / scale - pad_pt,
                   raw[2] / scale + pad_pt, h_pt - raw[1] / scale + pad_pt)
        text, reason = page_text(page_index, rect_pt)
        if text is None:
            mode = f"page-word-set ({reason})"
            native = _words_of(native_fallback)
            uncovered = {w for w in probe_all if not _covered(w, native)}
            return probe_all, uncovered, mode
        local = _words_of(text)
        uncovered |= {w for w in tokens if not _covered(w, local)}
    return probe_all, uncovered, mode


def _policy_choice() -> tuple[str, str]:
    """The user's engine selection, resolved BEFORE the first recognition call.

    F152 audit (2026-11-24): the region probe used to call ocr_tesseract.ocr_png
    directly, so with Paddle selected the FALLBACK engine recognised the region's
    pixels before the selected primary ever saw them. The policy is now read once
    per dispatch from ocr_cascade.policy() (settings.json > env, the same law the
    cascade enforces); any policy-read failure answers as the release default,
    matching the cascade's own fallback.
    """
    try:
        pol = ocr_cascade.policy()
    except Exception:                                 # noqa: BLE001
        return "paddle", "the policy record could not be read; the release default applies"
    return str(pol.get("ocr_selection") or "paddle"), str(pol.get("selection_source") or "")


def _probe_recognize(png: bytes, region_pdf: Path, pdf_page: int, lang: str, *,
                     dpi: int, rotation: int,
                     cancel: Callable[[], bool] | None,
                     deadline_at: float, job_id: str,
                     rec: dict[str, Any], counts: dict[str, int]
                     ) -> tuple[list[dict[str, Any]] | None,
                                tuple[list[Any], dict[str, Any]] | None,
                                Any]:
    """Word recognition for a probe, dispatched through the SELECTED engine policy.

    Cheap inspection (render, luminance features, geometry, native-text coverage)
    stays engine-free. Where ACTUAL word recognition is needed:
      * Tesseract-only: Tesseract reads the probe raster; the Paddle pipeline is
        never probed and never loaded (the selection opted out).
      * Paddle selected: the recognition goes through ocr_cascade.run — the pinned
        primary gets the FIRST eligible recognition attempt, Tesseract runs only as
        the cascade's recorded permitted fallback (its reason travels on the region
        record), and the busy lease answers as waiting. The result is REUSED by the
        eligible path: the region never pays for a second cascade.

    Returns (lines, reuse, failure): `lines` is the recogniser's text lines; `reuse`
    is (pages, cascade_report) when the cascade ran (the eligible path absorbs it
    verbatim); `failure` is the typed OcrUnavailable when the recogniser refused —
    the caller records it, the pixels are never lost. Recognition counts move here,
    from the adapter's own ledger (recognize_count deltas), at dispatch time.
    """
    choice, source = _policy_choice()
    rec["probe"]["engine_policy"] = choice
    rec["probe"]["engine_policy_source"] = source
    snap = ocr_tesseract.recognize_count()
    if choice == ocr_cascade.FALLBACK:
        try:
            lines, _ = ocr_tesseract.ocr_png(png, language=lang)
        except ocr_tesseract.OcrUnavailable as exc:
            return None, None, exc
        delta = ocr_tesseract.recognize_count()["tesseract_ocr_png"] - snap["tesseract_ocr_png"]
        counts["probe_recognitions"] += delta
        rec["invocations"]["probe_recognitions"] += delta
        rec["probe"]["recognizer"] = "tesseract (the selected engine)"
        return lines, None, None
    try:
        pages, casc_report = ocr_cascade.run(
            str(region_pdf), [pdf_page], language=lang, dpi=int(dpi),
            rotations=({pdf_page: rotation} if rotation else None),
            cancel=(lambda: bool(cancel and cancel())) if cancel else None,
            deadline_at=deadline_at, job_id=job_id)
    except ocr_tesseract.OcrUnavailable as exc:
        return None, None, exc
    # Tesseract word recognitions the cascade's PERMITTED FALLBACK ran are counted
    # from the adapter ledger — the cascade's own bookkeeping, attributed to this
    # region's dispatch, never omitted by a caller's tally. The cascade's engine
    # ATTEMPTS are recorded here too (the region pays for what ran, even when the
    # coverage law then skips it); the reuse absorb does not count them twice.
    delta = ocr_tesseract.recognize_count()["tesseract_ocr_png"] - snap["tesseract_ocr_png"]
    counts["cascade_recognitions"] += delta
    rec["invocations"]["cascade_recognitions"] += delta
    casc = casc_report.get("cascade") or {}
    attempts = 1 + (1 if (casc.get("fallback") or {}).get("attempted") else 0)
    rec["invocations"]["cascade"] = attempts
    counts["engine"] += attempts
    rec["fallback_reason"] = str((casc.get("fallback") or {}).get("reason")
                                 or (casc.get("primary") or {}).get("run_refused") or "")
    page = pages[0] if pages else None
    lines = [dict(ln) for ln in ((page.lines if page else []) or []) if isinstance(ln, dict)]
    if not lines and page is not None and str(page.text or "").strip():
        lines = [{"text": t, "bbox": None} for t in str(page.text).splitlines() if t.strip()]
    rec["probe"]["recognizer"] = (str(page.engine) if page and page.engine
                                  else "cascade (no page record)")
    return lines, (pages, casc_report), None


def _absorb_cascade(rec: dict[str, Any], pages: Any, casc_report: dict[str, Any],
                    counts: dict[str, int], counted: bool = True) -> None:
    """Record the cascade's verdict on the region record: real attempts, the engine,
    the REAL fallback reason, the busy-wait state, and what the engine read. Shared
    by the eligible path and by the policy-dispatched probe — whose result is
    REUSED there, never re-run. An empty preliminary result states "the engine ran
    and found the region empty of text": it never marks a text-bearing region as
    fully covered, and the pixels stay in the record for visual questions."""
    casc = casc_report.get("cascade", {})
    if counted:
        attempts = 1 + (1 if (casc.get("fallback") or {}).get("attempted") else 0)
        rec["invocations"]["cascade"] = attempts
        counts["engine"] += attempts
        # The REAL reason the primary engine handed this region over (loader
        # refusal, busy window, fault injection) travels on the region record,
        # not only in the durable cascade file nobody reads at answer time.
        casc_fallback = casc.get("fallback") or {}
        casc_primary = casc.get("primary") or {}
        rec["fallback_reason"] = str(casc_fallback.get("reason")
                                     or casc_primary.get("run_refused") or "")
    if casc.get("waiting"):
        rec.update(state="waiting", retryable=True,
                   reason="the inference lease is held by another job; this region is "
                          "queued and retryable, and no fallback engine ran for it")
        return
    page = pages[0] if pages else None
    if page is None:
        rec.update(state="unreadable", retryable=True,
                   reason="the cascade returned no page record for this region")
        return
    rec["engine"] = page.engine
    rec["confidence"] = page.confidence
    if page.state == "recognised":
        rec.update(state="recognised", text=page.text,
                   reason="engine read text from the region")
    elif page.state == "empty":
        rec.update(state="empty", reason="the engine ran and found the region empty of text")
    else:
        rec.update(state="unreadable", retryable=True,
                   reason=f"the engine could not read this region ({page.state}): {page.detail}")


def inspect_regions(target: str | Path, kind: str, regions: list[dict[str, Any]], *,
                    requested_language: str = "", declared_language: str = "",
                    dpi: int = ocr_tesseract.DEFAULT_DPI,
                    cancel: Callable[[], bool] | None = None,
                    deadline_at: float = 0.0,
                    job_id: str = "documents.ocr") -> dict[str, Any]:
    """Inspect every region; OCR exactly the eligible ones. Never default a language.

    Returns {"regions": [record...], "invocations": {"probe": n, "engine": n,
    "probe_recognitions": n, "cascade_recognitions": n}, "waiting": bool}. A record
    carries: region, unit, part, anchor, state, reason, retryable, probe features,
    engine, language, text, confidence, png (visual payload when it fits the cap),
    fallback_reason and invocations {probe, cascade, probe_recognitions,
    cascade_recognitions} for THAT region. *_recognitions are adapter counts
    (ocr_tesseract.recognize_count deltas): a probe pass that ran the engine is
    reported by the engine's own ledger, not omitted by a caller's tally.
    """
    target = Path(target)
    out: list[dict[str, Any]] = []
    counts = {"probe": 0, "engine": 0, "probe_recognitions": 0, "cascade_recognitions": 0}
    waiting = False
    page_text = page_size = None
    if kind == "pdf":
        page_text, page_size = _pdf_text_probe(target)
    with tempfile.TemporaryDirectory(prefix="ruke-region-") as scratch:
        for region in regions:
            rec: dict[str, Any] = {
                "region": region_id(kind, region), "unit": region.get("unit"),
                "part": str(region.get("part") or ""), "anchor": region.get("anchor", ""),
                "state": "", "reason": "", "retryable": False,
                "probe": None, "engine": "", "language": "", "text": "",
                "confidence": None, "png": b"", "crop": None, "fallback_reason": "",
                "invocations": {"probe": 0, "cascade": 0,
                                "probe_recognitions": 0, "cascade_recognitions": 0},
            }
            out.append(rec)
            if cancel and cancel():
                rec.update(state="cancelled", reason="the job was cancelled before this region")
                continue
            # 1. Get the region's raster into a renderable one-page PDF.
            #    Office regions and standalone rasters are wrapped (documents/
            #    regionpdf.py); a PDF PAGE region already IS a PDF - the page is
            #    rendered straight from the source, rotation honored.
            pdf_page = 1
            rotation = int(region.get("rotation") or 0)
            crop_rect: tuple[float, float, float, float] | None = None
            # The policy-dispatched probe recognition, once run, is REUSED by every
            # later step of this region: one recognition per eligible region, law.
            # Under the Paddle policy the cascade result itself is reused verbatim
            # (casc_reuse); under Tesseract-only the probe lines already answer the
            # coverage probe too (same raster, same dpi, same language).
            casc_reuse: tuple[list[Any], dict[str, Any]] | None = None
            probe_recognized = False
            render_w = render_h = 0
            source_page = int(region.get("unit") or 1)
            if kind == "pdf":
                region_pdf = target
                pdf_page = source_page
                try:
                    png, info = ocr_tesseract.render_page_png(
                        str(target), pdf_page, dpi=PROBE_DPI, rotation=rotation)
                except ocr_tesseract.OcrUnavailable as exc:
                    rec.update(state="unreadable", retryable=True,
                               reason=f"the region failed to render: {exc.kind}: {exc.detail}")
                    continue
                rec["width"], rec["height"] = info["width"], info["height"]
                render_w, render_h = int(info["width"]), int(info["height"])
                # F152: the region carries the image's placement rect -> inspect the
                # FIGURE, not the page. The crop is the probe raster, the coverage
                # ground, the cascade input and the delivered frame, so page prose is
                # never re-OCR'd and a targeted reread of one figure cannot drag its
                # neighbour's pixels and words into the answer.
                bounds = region.get("bounds")
                if bounds:
                    w_pt, h_pt = page_size(pdf_page)
                    rect = _placement_rect(list(bounds), w_pt, h_pt, render_w, render_h, rotation)
                    cropped = _crop_png(png, rect) if rect is not None else None
                    if cropped is None:
                        # Degrade to the page-wide law WITH the cause, never to zero inspection.
                        rec["bounds_reason"] = str(
                            region.get("bounds_reason")
                            or "the placement rect is unusable on the rendered page; "
                               "full-page inspection used")
                    else:
                        try:
                            crop_bytes, cdims = regionpdf.wrap_raster(cropped)
                        except (regionpdf.RegionDecode, OSError) as exc:
                            rec.update(state="unreadable", retryable=True,
                                       reason="the figure crop could not be prepared for inspection: "
                                              f"{getattr(exc, 'kind', 'crop_failed')}: "
                                              f"{getattr(exc, 'detail', exc)}")
                            continue
                        crop_pdf = Path(scratch) / f"r{len(out)}_figure.pdf"
                        crop_pdf.write_bytes(crop_bytes)
                        crop_rect = rect
                        png, region_pdf, pdf_page = cropped, crop_pdf, 1
                        rec["width"], rec["height"] = int(cdims["width"]), int(cdims["height"])
                        rec["crop"] = [int(v) for v in rect]
                        # The crop burned in the page /Rotate at render time: the cascade
                        # must not rotate the figure a second time.
                        rotation = 0
            else:
                try:
                    pdf_bytes, dims = regionpdf.wrap_raster(_region_bytes(target, kind, region))
                except (regionpdf.RegionDecode, KeyError, zipfile.BadZipFile, OSError) as exc:
                    kind_name = getattr(exc, "kind", "read_failed")
                    rec.update(state="unreadable", retryable=True,
                               reason=f"the region raster could not be prepared for inspection: "
                                      f"{kind_name}: {getattr(exc, 'detail', exc)}")
                    continue
                region_pdf = Path(scratch) / f"r{len(out)}.pdf"
                region_pdf.write_bytes(pdf_bytes)
                rec["width"], rec["height"] = dims["width"], dims["height"]
                # 2. The cheap probe: render + luminance features. No engine loaded, no model.
                try:
                    png, info = ocr_tesseract.render_page_png(region_pdf, 1, dpi=PROBE_DPI)
                except ocr_tesseract.OcrUnavailable as exc:
                    rec.update(state="unreadable", retryable=True,
                               reason=f"the region failed to render: {exc.kind}: {exc.detail}")
                    continue
            rec["probe"] = raster_features(png)
            rec["invocations"]["probe"] = 1
            counts["probe"] += 1
            if len(png) <= MAX_REGION_PNG:
                rec["png"] = png
            feats = rec["probe"]
            if not feats.get("measurable"):
                rec.update(state="unreadable", retryable=True, reason=str(feats.get("reason")))
                continue
            # 3. The decision - from pixels vs native text, never from counts or names.
            if feats["blank"]:
                rec.update(state="skipped", reason="the rendered region is uniformly blank; "
                                                   "there is nothing for an engine to read")
                continue
            if feats["photo_like"] and not feats["text_structure"]:
                rec.update(state="skipped", reason="photographic content with no text structure; "
                                                   "the pixels are kept for visual questions")
                continue
            if not feats["text_structure"]:
                # Quiet, not blank, no glyph structure: the honest ambiguous band. With a
                # language in hand (never a default) one recognition pass over the probe
                # raster settles it; words found promote the region, zero words skip it.
                lang, src, why = _region_language(region_pdf, requested_language,
                                                  declared_language, page=pdf_page)
                if not lang:
                    rec.update(state="needs_language", retryable=True,
                               reason=f"no validated language for this region: {why}")
                    continue
                rec["language"] = lang
                # F152 audit: recognition goes through the SELECTED policy, resolved
                # before the first call — with Paddle selected the primary gets the
                # first eligible attempt (the cascade's Tesseract runs are recorded
                # permitted fallbacks); with Tesseract-only, Tesseract reads the
                # pixels and Paddle is never probed. The cascade result is REUSED.
                lines, casc_reuse, failure = _probe_recognize(
                    png, region_pdf, pdf_page, lang,
                    dpi=PROBE_DPI, rotation=rotation, cancel=cancel,
                    deadline_at=deadline_at, job_id=job_id, rec=rec, counts=counts)
                if failure is not None:
                    rec.update(state="needs_language", retryable=True,
                               reason=f"the probe engine could not run ({failure.kind}): {failure.detail}")
                    continue
                if casc_reuse is not None and (casc_reuse[1].get("cascade") or {}).get("waiting"):
                    waiting = True
                    rec.update(state="waiting", retryable=True,
                               reason="the inference lease is held by another job; this region is "
                                      "queued and retryable, and no fallback engine ran for it")
                    continue
                words = sum(1 for m in re.finditer(r"\S{2,}", " ".join(
                    ln.get("text", "") for ln in lines)))
                rec["probe"]["probe_words"] = words
                rec["probe"]["language_source"] = src
                if words > 0:
                    rec["probe"]["text_structure"] = True
                    probe_recognized = True
                else:
                    rec.update(state="skipped",
                               reason="the probe recognised zero words in the region at the "
                                      f"validated language {lang!r}; pixels kept for visual questions")
                    continue
            # 3b. PDF coverage law (F152): a PDF page is a region because it carries
            #     embedded rasters next to a USABLE text layer, not because it is
            #     unreadable. The page renders straight from the source; the probe
            #     recognises the rendered pixels at the validated language and every
            #     word is compared against the page's OWN native text. Words the text
            #     layer already has are not new content - a decorative logo on a prose
            #     page costs zero engine calls. Only words the native layer LACKS
            #     (an image-only legend) justify the cascade.
            if kind == "pdf":
                lang, src, why = _region_language(region_pdf, requested_language,
                                                  declared_language, page=pdf_page)
                if not lang:
                    rec.update(state="needs_language", retryable=True,
                               reason=f"no validated language for this region: {why}")
                    continue
                rec["language"] = lang
                if not probe_recognized:
                    # No probe recognition has run yet for this region: the SELECTED
                    # engine policy reads the pixels (Tesseract-only → Tesseract;
                    # Paddle → the cascade, primary first). A site-3 recognition is
                    # REUSED here — the region never pays for a second recognition.
                    lines, casc_reuse, failure = _probe_recognize(
                        png, region_pdf, pdf_page, lang,
                        dpi=PROBE_DPI, rotation=rotation, cancel=cancel,
                        deadline_at=deadline_at, job_id=job_id, rec=rec, counts=counts)
                    if failure is not None:
                        rec.update(state="needs_language", retryable=True,
                                   reason=f"the probe engine could not run ({failure.kind}): {failure.detail}")
                        continue
                    if casc_reuse is not None and (casc_reuse[1].get("cascade") or {}).get("waiting"):
                        # The lease is busy: the engine ran NOTHING for this region,
                        # so the coverage probe must not answer "zero words" for it.
                        waiting = True
                        rec.update(state="waiting", retryable=True,
                                   reason="the inference lease is held by another job; this region is "
                                          "queued and retryable, and no fallback engine ran for it")
                        continue
                rec["probe"]["language_source"] = src
                if crop_rect is not None:
                    probe_set, uncovered, mode = _figure_coverage(
                        lines, crop_rect, render_w, render_h,
                        int(region.get("rotation") or 0), source_page,
                        page_text, page_size, str(region.get("native_text") or ""))
                    rec["probe"]["coverage_mode"] = mode
                    rec["probe"]["probe_words"] = len(probe_set)
                    rec["probe"]["uncovered_words"] = len(uncovered)
                    rec["probe"]["uncovered_tokens"] = sorted(uncovered)[:30]
                    if not probe_set:
                        if feats.get("text_structure"):
                            # Glyph structure the probe could not read at probe dpi (tiny
                            # type): the features are evidence - the cascade reads the crop.
                            rec["probe"]["glyph_evidence"] = True
                        else:
                            rec.update(state="skipped",
                                       reason="the probe recognised zero words in the figure at the "
                                              f"validated language {lang!r} and no glyph structure is "
                                              "visible; pixels kept for visual questions")
                            continue
                    elif not uncovered:
                        rec.update(
                            state="skipped",
                            reason=("every token the figure carries is native text at that token's "
                                    "own position; nothing uncovered to read")
                            if mode == "position" else
                            ("every token the raster carries is already in the page's native text "
                             "layer; nothing uncovered to read"))
                        continue
                else:
                    probe_text = " ".join(ln.get("text", "") for ln in lines)
                    probe_words = _words_of(probe_text)
                    native = _words_of(str(region.get("native_text") or ""))
                    uncovered = {w for w in probe_words if not _covered(w, native)}
                    rec["probe"]["probe_words"] = len(probe_words)
                    rec["probe"]["uncovered_words"] = len(uncovered)
                    if not uncovered:
                        rec.update(state="skipped",
                                   reason="every word the page raster carries is already in the "
                                          "page's native text layer; nothing uncovered to read")
                        continue
            # 4. Eligible: the EXISTING cascade reads exactly this region, engine policy,
            # ceilings, busy-window law and fallback included.
            lang = requested_language.strip() or declared_language.strip() or rec["language"]
            if not lang:
                lang_det = _safe_detect(region_pdf, page=pdf_page)
                if not lang_det.get("verified"):
                    rec.update(state="needs_language", retryable=True,
                               reason=f"no validated language for this region: {lang_det.get('reason')}")
                    continue
                lang = str(lang_det["language"])
            rec["language"] = lang
            if casc_reuse is not None:
                # The policy-dispatched probe cascade read exactly this region
                # (same raster, same language) already: absorb its verdict — one
                # recognition per eligible region, the region never pays twice.
                pages, casc_report = casc_reuse
                _absorb_cascade(rec, pages, casc_report, counts, counted=False)
                if rec["state"] == "waiting":
                    waiting = True
                continue
            snap = ocr_tesseract.recognize_count()
            try:
                pages, casc_report = ocr_cascade.run(
                    str(region_pdf), [pdf_page], language=lang, dpi=int(dpi),
                    rotations=({pdf_page: rotation} if rotation else None),
                    cancel=(lambda: bool(cancel and cancel())) if cancel else None,
                    deadline_at=deadline_at, job_id=job_id)
            except ocr_tesseract.OcrUnavailable as exc:
                rec.update(state="unreadable", retryable=True,
                           reason=f"the cascade could not run on this region: {exc.kind}: {exc.detail}")
                continue
            rec["invocations"]["cascade_recognitions"] = (
                ocr_tesseract.recognize_count()["tesseract_ocr_png"] - snap["tesseract_ocr_png"])
            counts["cascade_recognitions"] += rec["invocations"]["cascade_recognitions"]
            # The REAL reason the primary engine handed this region over (loader
            # refusal, busy window, fault injection) travels on the region record,
            # not only in the durable cascade file nobody reads at answer time.
            _absorb_cascade(rec, pages, casc_report, counts)
            if rec["state"] == "waiting":
                waiting = True
    return {"regions": out,
            "invocations": {"probe": counts["probe"], "engine": counts["engine"],
                            "probe_recognitions": counts["probe_recognitions"],
                            "cascade_recognitions": counts["cascade_recognitions"]},
            "waiting": waiting}


def _region_language(region_pdf: Path, requested: str, declared: str,
                     page: int = 1) -> tuple[str, str, str]:
    """Language for a region: explicit request, document-declared, validated detection. Never a default."""
    if requested.strip():
        return requested.strip(), "requested", ""
    if declared.strip():
        return declared.strip(), "declared by the document", ""
    det = _safe_detect(region_pdf, page=page)
    if det.get("verified"):
        return str(det["language"]), "detected and verified on the region raster", ""
    return "", "", str(det.get("reason", "language detection did not verify"))


def _safe_detect(region_pdf: Path, page: int = 1) -> dict[str, Any]:
    """detect_language whose engine/engine-language refusals answer as verified=False.

    F152 audit (2026-11-24): detect_language's verification pass is Tesseract WORD
    recognition, so under a Paddle-selected policy it read pixels before the primary.
    Under Paddle the language step uses the script analyser ONLY (run_osd is a script
    estimate, not word recognition; it does not load Paddle either): the primary's
    first eligible recognition is the verification. Tesseract-only keeps the full
    verify pass — Tesseract IS the selected engine, there is nothing to protect.
    """
    verify = _policy_choice()[0] == ocr_cascade.FALLBACK
    try:
        return ocr_tesseract.detect_language(region_pdf, page, dpi=PROBE_DPI, verify=verify)
    except ocr_tesseract.OcrUnavailable as exc:
        return {"verified": False, "reason": f"{exc.kind}: {exc.detail}"}
