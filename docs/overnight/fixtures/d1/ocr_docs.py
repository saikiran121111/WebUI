"""Generator + independent answer key for the D1 OCR acceptance fixtures (amendment 4/6, SPEC 16.6).

Why this file exists and how it must be read
--------------------------------------------
The answer key in this directory is derived from the TEXT THAT WAS AUTHORED, before any OCR engine
saw the page. It is therefore independent of the engine under test - but it is only independent for
the strings listed in it. These are clean synthetic renders at a fixed 200 dpi, so passing them
establishes *mechanics and fidelity on known content*: page attribution, reading order, scan vs
native routing, rotated pages, fallback selection, coverage honesty. It does NOT establish general
OCR quality on photographs, handwriting, bad scans or real books, and no claim beyond the key may be
made from it.

Construction
------------
1. author the page text (this is the ground truth);
2. render it into a legal minimal PDF with a real text layer;
3. rasterise the selected pages to 200 dpi grayscale with the SAME rasteriser production uses
   (pypdfium2), then embed the raster as the page's only content -> a genuine scan with no text layer;
4. emit scanned / mixed / native-control / no-language variants plus `answer-key.json`.

No OCR engine, model or network is used here, so this script is safe to run unattended.
"""
from __future__ import annotations

import json
import re
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "pdfs"
DPI = 200
KEY_VERSION = "d1-ocr-1"

# ---------------------------------------------------------------- page content (ground truth) --
# Each entry is (kind, text). `kind` is what the page must contain after construction.
COLUMN_LEFT = [
    "Section 4.2 Ground Water",
    "The aquifer beneath the basin yields",
    "1.4 million cubic metres per month",
    "measured across eleven observation wells.",
    "Extraction permits were capped at 62%",
    "of the recharge estimate for 2019.",
]
COLUMN_RIGHT = [
    "Downstream salinity rose to 3.1 ppt",
    "at the Kandla gauge in March 2019,",
    "which the committee attributed to",
    "reduced dry-season flow rather than",
    "tidal intrusion alone.",
]
TABLE_ROWS = [
    ["Station", "Flow m3/s", "Turbidity NTU"],
    ["Kandla", "18.4", "12.7"],
    ["Gandhi Dham", "44.0", "3.9"],
    ["Aranjes", "12.6", "51.2"],
]
CODE_LINES = [
    "def recharge(precip_mm, area_km2):",
    "    runoff = precip_mm * 0.18 * area_km2",
    "    return round(runoff * 1000, 1)  # m3",
    "print(recharge(740, 12.5))",
]
EQN_LINES = [
    "Q = W x b x sqrt(2 g h)",
    "T = 25 degC, pH = 7.4, EC = 0.84 dS/m",
]
SMALL_LINE = "Appendix note: the borehole log for well BH-07 was transcribed from a field notebook."
LATE_FACT = ("Chapter eleven records that the arbitration award of 14 November 2021 ordered the "
             "defendant to pay 4,18,25,000 rupees within ninety days, with interest at 6% per annum.")
HEADING_MIXED = "Exhibit C - native heading carried by the text layer, not by recognition."
# Page layout of both the native control and the scan built from it (6 pages):
#   1 two-column block A, 2 two-column block B, 3 the whole table, 4 code, 5 equations + small text,
#   6 the late arbitration fact. Table rows are joined with three spaces when flattened to text.
PAGE_TEXTS = [
    COLUMN_LEFT[:3] + COLUMN_RIGHT[:3],
    COLUMN_LEFT[3:] + COLUMN_RIGHT[3:],
    ["   ".join(r) for r in TABLE_ROWS],
    CODE_LINES,
    EQN_LINES + [SMALL_LINE],
    [LATE_FACT],
]


def _norm(text: str) -> str:
    return " ".join(text.split())


def words_of(text: str) -> list[str]:
    return [w for w in _norm(text).replace("\u2013", "-").split(" ") if w]


# --------------------------------------------------------------------- minimal PDF writer ------
def _esc(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _wrap(line: str, size: int) -> list[str]:
    """Fit an authored line to the page box with a deliberately pessimistic width estimate.

    F73 measured the defect this prevents: a single long line (the 152-character late arbitration
    fact) ran off the right edge of the letter-size page, so the 200 dpi raster PHYSICALLY lost
    the tail of its own answer-key sentence - no honest engine could recover it from the scan.
    The estimate over-wraps on purpose; extraction and the answer key normalise the added line
    breaks away, so the key stays exactly as authored.
    """
    if not line.strip():
        return [line]
    per_char = 0.62 * max(1, int(size))          # pessimistic Helvetica average
    limit = max(20, int((612 - 2 * 56) / per_char))
    words = line.split()
    out: list[str] = []
    cur = ""
    for w in words:
        cand = f"{cur} {w}".strip()
        if cur and len(cand) > limit:
            out.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        out.append(cur)
    return out or [line]


def text_stream(lines: list[str], *, x: int = 56, top: int = 760, lead: int = 16,
                size: int = 11) -> bytes:
    out = []
    i = 0
    for line in lines:
        for piece in _wrap(line, size):
            out.append(f"BT /F1 {size} Tf {x} {top - lead * i} Td ({_esc(piece)}) Tj ET")
            i += 1
    return "\n".join(out).encode("latin-1", "replace")


def compose_pdf(pages: list[dict], lang: str = "en-US") -> bytes:
    """pages: [{"stream": bytes, "rotate": int, "image": (w,h,gray_bytes) | None}]

    The page's own /Resources carries both fonts and (when present) the raster, and the image is
    actually drawn with `q W 0 0 H 0 0 cm /Im0 Do Q` - a referenced-but-never-drawn XObject renders
    as a blank page, which would quietly produce an empty "scan".
    """
    objs: dict[int, bytes] = {}
    kids: list[int] = []
    # Objects 1..5 are reserved (catalog, pages, two fonts, info); allocation starts at 6 so the
    # xref table stays contiguous - a gap shifts every later offset and pdfium rejects the page.
    nid = 5
    for page in pages:
        img_ref = None
        res_xobj = ""
        draw = b""
        if page.get("image"):
            w, h, gray = page["image"]
            nid += 1
            img_ref = nid
            comp = zlib.compress(gray, 6)
            objs[img_ref] = (f"<</Type/XObject/Subtype/Image/Width {w}/Height {h}"
                             f"/ColorSpace/DeviceGray/BitsPerComponent 8"
                             f"/Filter/FlateDecode/Length {len(comp)}>>\nstream\n").encode() + comp + b"\nendstream"
            # An indirect reference MUST be "<obj> <gen> R"; emitting "/Im0 6 R" is not a reference
            # at all, which made every rasterised page render blank and made pypdf walk off the
            # content stream. _check_refs() below keeps that from regenerating silently.
            res_xobj = f"/XObject<</Im0 {img_ref} 0 R>>"
            pw = round(w * 72.0 / DPI, 2)
            ph = round(h * 72.0 / DPI, 2)
            draw = f"q {pw} 0 0 {ph} 0 0 cm /Im0 Do Q\n".encode()
        stream = page["stream"]
        stream = draw + stream
        nid += 1
        content_ref = nid
        objs[content_ref] = (f"<</Length {len(stream)}>>\nstream\n").encode() + stream + b"\nendstream"
        nid += 1
        page_ref = nid
        kids.append(page_ref)
        rot = f"/Rotate {page['rotate']} " if page.get("rotate") else ""
        objs[page_ref] = (f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]{rot}"
                          f"/Resources<</Font<</F1 3 0 R/F2 4 0 R>>{res_xobj}>>"
                          f"/Contents {content_ref} 0 R>>").encode()
    kids_s = " ".join(f"{k} 0 R" for k in kids)
    # /Lang is a DOCUMENT-level entry on the Catalog (ISO 32000-1 s14.3.1), not a /Pages entry:
    # spec-following extractors read it there and nowhere else. It previously sat on the Pages
    # node, so the declared-language path never fired on the declared fixtures - the honest
    # no-language refusal measured on f74g proved the declaration was invisible.
    lang_s = f"/Lang({_esc(lang)})" if lang else ""
    objs[1] = (f"<</Type/Catalog/Pages 2 0 R{' ' + lang_s if lang_s else ''}>>").encode()
    objs[2] = (f"<</Type/Pages/Count {len(kids)}/Kids[{kids_s}]>>").encode()
    objs[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>"
    objs[4] = b"<</Type/Font/Subtype/Type1/BaseFont/Courier>>"
    objs[5] = (f"<</Producer(Ruke d1 fixture generator)/CreationDate"
               f"(D:20261117000000)>>").encode()
    order = sorted(objs)
    out = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"
    off: dict[int, int] = {}
    for ref in order:
        off[ref] = len(out)
        out += f"{ref} 0 obj\n".encode() + objs[ref] + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(order) + 1}\n".encode() + b"0000000000 65535 f \n"
    for ref in order:
        out += f"{off[ref]:010d} 00000 n \n".encode()
    out += (f"trailer\n<</Size {len(order) + 1}/Root 1 0 R/Info 5 0 R>>\n"
            f"startxref\n{start}\n%%EOF\n").encode()
    _check_refs(out)
    return out


_REF_RE = re.compile(rb"/[A-Za-z0-9]+ (\d+)(?! 0 R) R")


def _check_refs(pdf: bytes) -> None:
    """Fail loudly if any emitted indirect reference is missing its generation number.

    A malformed reference is not an error at render time - pdfium silently drops the resource and
    the "scan" becomes a blank page, which would make every OCR fixture worthless.
    """
    bad = _REF_RE.findall(pdf)
    if bad:
        raise AssertionError("malformed indirect reference(s) in generated PDF: "
                             + ", ".join(b.decode() for b in bad))


def rasterize(page_pdf: bytes, dpi: int = DPI) -> list[tuple[int, int, bytes]]:
    """Render every page of `page_pdf` to 200 dpi grayscale bytes using the production rasteriser."""
    import pypdfium2 as pdfium
    import numpy as np

    pdf = pdfium.PdfDocument(page_pdf)
    out = []
    for page in pdf:
        bmp = page.render(scale=dpi / 72.0)
        w, h = int(bmp.width), int(bmp.height)
        nch = bmp.n_channels
        buf = bytes(bmp.buffer)
        # pypdfium2 reports the raw buffer; derive the row pitch in bytes from its
        # length so a padded stride (if any) cannot silently shift every row.
        row_bytes = len(buf) // (h * nch) * nch
        arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, row_bytes // nch, nch)[:, :w, :]
        gray = arr.min(axis=2) if nch > 1 else arr[:, :, 0]
        out.append((w, h, np.ascontiguousarray(gray).tobytes()))
    pdf.close()
    return out


def _native_pages() -> list[dict]:
    sizes = [11, 11, 11, 10, 8, 10]
    return [{"stream": text_stream(t, size=sizes[i])} for i, t in enumerate(PAGE_TEXTS)]


def build() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    native_pages = _native_pages()
    native_pdf = compose_pdf(native_pages)
    (OUT / "d1_native.pdf").write_bytes(native_pdf)

    rasters = rasterize(native_pdf)
    # scanned: the same visual content, raster embedded, text layer removed.
    scan_pages = [{"stream": b"", "image": rasters[i]} for i in range(len(native_pages))]
    (OUT / "d1_scanned.pdf").write_bytes(compose_pdf(scan_pages, lang="en-US"))

    # mixed: p1 keeps a native heading + its own image; p2 is image only; p3 native only.
    # F74 measured the geometry defect this fixes: text_stream defaults to top=760, which is
    # EXACTLY the baseline the raster's own first line ("Section 4.2 Ground Water", rasterized
    # from native page 1 at the same top) prints on. Drawing the heading there fused the two
    # inks into one unreadable stroke on the rendered page - the frozen key asks OCR to
    # recognise the raster line, and the fixture itself made it physically unrecoverable
    # (f74a content pass + f73-engine-d1_mixed.json: fused garbage where the line used to be).
    # The heading now draws in the blank band at the foot of the page: still "carried by the
    # text layer, not by recognition", still never duplicated, but no longer printed over ink
    # the key requires recognition to deliver.
    mixed = [
        {"stream": text_stream([HEADING_MIXED], top=56), "image": rasters[0]},
        {"stream": b"", "image": rasters[1]},
        {"stream": text_stream([LATE_FACT]), "image": None},
    ]
    (OUT / "d1_mixed.pdf").write_bytes(compose_pdf(mixed, lang="en-US"))

    # rotated scan: page 2 raster with /Rotate 90 (the visual content is upright, the page is not).
    rotated = [{"stream": b"", "image": rasters[1], "rotate": 90}]
    (OUT / "d1_rotated_scan.pdf").write_bytes(compose_pdf(rotated, lang="en-US"))

    # no declared language: the same scan with the /Lang entry removed -> honest refusal expected.
    (OUT / "d1_scan_nolang.pdf").write_bytes(compose_pdf(scan_pages, lang=""))

    key = _answer_key(len(native_pages))
    (HERE / "answer-key.json").write_text(json.dumps(key, indent=2), encoding="utf-8")
    return key


def _answer_key(n_pages: int) -> dict:
    # One expected line per page, in page order, derived from PAGE_TEXTS (the authored content).
    per_page = {str(i + 1): _norm(" ".join(t)) for i, t in enumerate(PAGE_TEXTS)}
    assert len(per_page) == n_pages == len(PAGE_TEXTS)
    return {
        "key_version": KEY_VERSION,
        "authored_before_engine_run": True,
        "nature": ("clean synthetic renders at 200 dpi with known text; passing establishes routing, "
                   "page attribution, fallback selection and coverage honesty, NOT general OCR quality"),
        "thresholds_fixed_before_results": {
            "word_error_rate_primary": 0.10,
            "word_error_rate_fallback": 0.15,
            "coverage_units_read_fraction": 1.0,
            "note": "measured against these listed words only; a run that misses any listed fact fails",
        },
        "fixtures": {
            "d1_native.pdf": {
                "pages": n_pages,
                "expect_route": "text_layer_ok",
                "ocr_must_not_run": True,
                "expected_per_page": per_page,
                "late_evidence": {"page": str(n_pages), "contains": "4,18,25,000"},
            },
            "d1_scanned.pdf": {
                "pages": n_pages,
                "expect_route": "any_of:image_only,mixed,layout_model,light_ocr",
                "ocr_must_run": True,
                "expected_per_page": per_page,
                "must_not_fabricate": {"page": "1", "absent_word": "Chapter"},
                "late_evidence": {"page": str(n_pages), "contains": "4,18,25,000"},
                "word_error_rate_key": {p: words_of(t) for p, t in per_page.items()},
            },
            "d1_mixed.pdf": {
                "pages": 3,
                "page_1_must_contain_native": HEADING_MIXED,
                "page_1_must_contain_recognised": COLUMN_LEFT[0],
                "no_duplicate_heading_once": HEADING_MIXED,
                "page_3_native_only": True,
                "late_evidence": {"page": "3", "contains": "4,18,25,000"},
            },
            "d1_rotated_scan.pdf": {
                "pages": 1,
                "rotate_declared": 90,
                "must_recognise_despite_rotation": PAGE_TEXTS[1][0],
                "page_reference_must_be": "1",
            },
            "d1_scan_nolang.pdf": {
                "pages": n_pages,
                "ocr_must_not_run": True,
                "typed_error": "needs_language",
                "note": "an undeclared language is a refusal with an actionable reason, never a silent English default",
            },
        },
        "fallback_expectation": {
            "trigger": "RUKE_OCR_FAULT=crash (or RUKE_OCR_PRIMARY=not-registered)",
            "must_report_engine_per_unit": True,
            "must_keep_unread_units_unresolved": True,
            "fidelity_note_must_state_reduced": "layout/formula/table fidelity is not equivalent under recovery",
        },
        "memory": {
            "target_bytes": 4_000_000_000,
            "hard_max_bytes": 5_000_000_000,
            "excludes": "the resident main LLM and this coding agent",
            "must_record": ["baseline", "cold_load_peak", "processing_peak", "post_job_release",
                            "vram_before", "vram_after"],
        },
    }


if __name__ == "__main__":
    key = build()
    print(json.dumps({"key_version": key["key_version"],
                      "pdfs": sorted(p.name for p in OUT.glob("*.pdf")),
                      "fixtures": sorted(key["fixtures"])}, indent=2))
