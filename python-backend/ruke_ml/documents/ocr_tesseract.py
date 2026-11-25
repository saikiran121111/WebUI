"""OCR through a VALIDATED copy of an external engine, with per-page honesty.

Two independent stages, each with its own truth:
  1. rasterize  - pypdfium2 renders the page at a chosen DPI (rotation aware);
  2. recognise  - the resolved tesseract binary reads the image and emits TSV.

Laws:
  * the program is resolved with provenance (explicit override, PATH, project-local) and
    validated by running it, so the command we BUILD is the command we CLAIM can run;
  * the language list is read back from the installed engine (`--list-langs`), never
    typed from memory; an unmappable requested language is refused, never silently sent
    through English;
  * OCR quality is never asserted here: confidence is whatever the engine reports
    (empty/absent stays unknown), and measurement lives in the eval harness;
  * per-page outcomes are explicit (recognised / empty / failed / raster failed), and the
    cascade keeps the native text layer wherever it already worked.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import threading
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import processes
from ..models import binaries

BINARY = "tesseract"
MAX_OCR_PAGES = 400
DEFAULT_DPI = 200
MIN_DPI, MAX_DPI = 72, 400
MAX_TSV_BYTES = 8 << 20
OCR_TIMEOUT_S = 180.0
PNG_FILTER = b"\x00"


class OcrUnavailable(Exception):
    """Typed, actionable: engine missing, rasterizer missing, or the run failed."""

    def __init__(self, kind: str, detail: str, human_step: str = "") -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.human_step = human_step


def rasterizer_state() -> dict[str, Any]:
    try:
        import pypdfium2                              # noqa: PLC0415 - lazy by design
        return {"present": True, "package": "pypdfium2",
                "version": str(getattr(pypdfium2, "PYPDFIUM_INFO", "")) or ""}
    except Exception as exc:                          # noqa: BLE001
        return {"present": False, "package": "pypdfium2",
                "detail": f"{type(exc).__name__}: {exc}"}


def engine_state() -> dict[str, Any]:
    res = binaries.resolve(BINARY)
    out = {"binary": res.as_dict(), "found": res.found}
    if res.found:
        probe = _probe(res.path)
        out["version"] = probe["version"]
        out["languages"] = probe["languages"]
        out["languages_source"] = "captured from --list-langs of the validated binary"
    else:
        out["version"] = ""
        out["languages"] = []
        out["languages_source"] = "no validated binary, so no language is claimed"
        out["detail"] = res.detail
    return out


_PROBE_CACHE: dict[str, dict[str, Any]] = {}


def _probe(exe: str) -> dict[str, Any]:
    if exe in _PROBE_CACHE:
        return _PROBE_CACHE[exe]
    version, langs = "", []
    for args, parse in ((["--version"], _parse_version), (["--list-langs"], _parse_langs)):
        try:
            done = processes.run_captured([exe, *args], timeout=binaries.PROBE_TIMEOUT_S)
            text = (done.stdout or b"").decode("utf-8", "replace") + \
                   (done.stderr or b"").decode("utf-8", "replace")
            if args[0] == "--version":
                version = parse(text)
            else:
                langs = parse(text)
        except (OSError, subprocess.SubprocessError):
            pass
    out = {"version": version, "languages": langs}
    _PROBE_CACHE[exe] = out
    return out


def _parse_version(text: str) -> str:
    for line in text.splitlines():
        if "tesseract" in line.lower():
            return line.strip()[:200]
    return text.strip().splitlines()[0][:200] if text.strip() else ""


def _parse_langs(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("list of"):
            continue
        out.append(line)
    return out[:2000]


# ------------------------------------------------------------------ language address
def _engine_language_codes() -> list[str]:
    return engine_state()["languages"]


def language_is_addressable(requested: str) -> tuple[bool, str, str]:
    """(ok, code, why): map an ISO tag onto a language data file the engine has.

    The codes come from the installed engine, so an engine without the data for a
    language can never be reported as supporting it. No silent English fallback.
    """
    tag = (requested or "").strip().lower().replace("_", "-")
    codes = _engine_language_codes()
    if not codes:
        return False, "", "no validated OCR engine, so no language data is installed"
    lowered = {c.lower(): c for c in codes}
    if tag in lowered:
        return True, lowered[tag], "engine has language data named for the requested tag"
    base = tag.split("-", 1)[0]
    if base in lowered:
        return True, lowered[base], "engine has language data for the base language tag"
    for iso, code in ISO_TO_TESSERACT.items():
        if iso == base and code.lower() in lowered:
            return True, lowered[code.lower()], (f"requested tag {base!r} maps to the engine's "
                                                 f"language data {code!r}")
    return False, "", (f"the engine has no language data addressable as {tag!r}; refusing to run "
                       "it with a different language and present the result as that language")


# ISO 639-1 -> the language-data name this engine family uses (ISO 639-2/T style). This is
# a general naming mapping, not a per-document exception list; anything absent here is
# reported as unaddressable rather than guessed.
ISO_TO_TESSERACT: dict[str, str] = {
    "en": "eng", "fi": "fin", "fr": "fra", "de": "deu", "es": "spa", "it": "ita",
    "pt": "por", "nl": "nld", "pl": "pol", "cs": "ces", "sk": "slk", "sl": "slv",
    "ru": "rus", "uk": "ukr", "el": "ell", "tr": "tur", "he": "heb", "ar": "ara",
    "fa": "fas", "hi": "hin", "te": "tel", "ta": "tam", "bn": "ben", "mr": "mar",
    "gu": "guj", "kn": "kan", "ml": "mal", "pa": "pan", "or": "ory", "si": "sin",
    "th": "tha", "lo": "lao", "my": "mya", "km": "khm", "id": "ind", "ms": "msa",
    "vi": "vie", "ja": "jpn", "ko": "kor", "zh": "chi_sim", "sa": "san", "ne": "nep",
}

# Script name (the engine's own OSD word, lowercased) -> general language-data name.
# Same general-naming family as ISO_TO_TESSERACT: it maps SCRIPTS, not documents, and
# anything absent is reported as unsupported rather than guessed at. A script that maps
# to a language the engine has no data for is an honest refusal, never an English swap.
SCRIPT_TO_TESSERACT: dict[str, str] = {
    "latin": "eng", "cyrillic": "rus", "greek": "ell", "arabic": "ara", "hebrew": "heb",
    "devanagari": "hin", "bengali": "ben", "gurmukhi": "pan", "gujarati": "guj",
    "oriya": "ory", "tamil": "tam", "telugu": "tel", "kannada": "kan", "malayalam": "mal",
    "sinhala": "sin", "thai": "tha", "lao": "lao", "myanmar": "mya", "khmer": "khm",
    "georgian": "kat", "armenian": "hyw", "ethiopic": "amh", "hangul": "kor",
    "hiragana": "jpn", "katakana": "jpn", "hann": "chi_sim", "han": "chi_sim",
}

# Validated detection bounds, measured on this host (2026-11-21, tesseract v5.5.3,
# this engine family): the genuine scan page mixed.pdf p92 gives OSD Script "Latin" at
# confidence 3.9 (a clean chart page 10.0) and verification OCR of 3 lines, mean line
# confidence 0.963, 142 non-space glyphs, 28 words of 2+ characters. The bounds sit
# with margin below the genuine page and far above what a page of the wrong language
# (or a blank raster) produces, so passing them is evidence, not a formality.
OSD_MIN_SCRIPT_CONFIDENCE = 2.0
DETECT_MIN_LINES = 2
DETECT_MIN_MEAN_CONF = 0.60
DETECT_MIN_GLYPHS = 80
DETECT_MIN_WORDS = 12

_OSD_SCRIPT = re.compile(r"Script:\s*([A-Za-z][A-Za-z -]{0,40}?)\s*\r?\n\s*Script confidence:\s*([0-9.]+)")


def parse_osd(stdout: str) -> tuple[str, float] | None:
    """(script, confidence) from the engine's orientation/script analyser output.

    Measured format of this build (v5.5.3): "Page number: 0 / Orientation in degrees: 0 /
    Rotate: 0 / Orientation confidence: 9.55 / Script: Latin / Script confidence: 3.89" -
    this build reports a SCRIPT estimate with confidence, no language estimate.
    """
    m = _OSD_SCRIPT.search(stdout or "")
    if not m:
        return None
    try:
        conf = float(m.group(2))
    except ValueError:
        return None
    return m.group(1).strip().lower(), conf


# ------------------------------------------------------------------ rasterize + encode
def _pdfium_buffer_rgb(bitmap: Any) -> tuple[bytes, int]:
    """Turn a pdfium FPDF_BITMAP buffer into rows in the order encode_png's
    declared PNG format states (RGB/RGBA). Two pdfium realities break a raw
    pass-through (F152 audit, 2026-11-24, both measured on this host):
      * pdfium bitmaps are BGR/BGRx in memory (FPDFBitmap_BGR 24bpp, BGRx
        32bpp, same byte order on every platform); encode_png declares
        R,G,B(A) - a raw buffer delivers every colour-bearing raster (probe
        render, region crop, visual page frame, engine input) with R and B
        exchanged. The live run proved the consequence: the violet crossing
        line reached Qwen at hue 326 degrees = PINK and the model faithfully
        answered "pink" about the pixels it was really given.
      * pdfium rows are 4-byte aligned: a 24bpp raster of width w has pitch
        (3*w + 3) & ~3, and encode_png assumes packed rows - every row drifts
        one byte, smearing tall renders diagonally (measured: G read 0 for a
        g=61 fill at row 250 of a 625x24bpp raster).
    A 1-channel Gray buffer needs no exchange."""
    nch = int(bitmap.n_channels)
    w, h = int(bitmap.width), int(bitmap.height)
    buf = bytes(bitmap.buffer)
    stride = w * nch
    if h > 0 and len(buf) // h != stride:  # pdfium 4-byte row pitch
        pitch = len(buf) // h
        buf = b"".join(buf[y * pitch:y * pitch + stride] for y in range(h))
    if nch == 3:
        swapped = bytearray(len(buf))
        swapped[0::3], swapped[1::3], swapped[2::3] = buf[2::3], buf[1::3], buf[0::3]
        return bytes(swapped), 3
    if nch == 4:
        swapped = bytearray(len(buf))
        swapped[0::4], swapped[1::4], swapped[2::4] = buf[2::4], buf[1::4], buf[0::4]
        swapped[3::4] = buf[3::4]
        return bytes(swapped), 4
    return buf, nch


def encode_png(width: int, height: int, channels: int, rows: bytes) -> bytes:
    """Minimal RGB/RGBA PNG writer (no imaging dependency, no Pillow)."""
    color = {"3": 2, "4": 6}.get(str(channels))
    if color is None or width <= 0 or height <= 0:
        raise OcrUnavailable("raster_failed", f"cannot encode {width}x{height}x{channels} bitmap")
    stride = width * channels
    raw = bytearray()
    for y in range(height):
        raw += PNG_FILTER
        raw += rows[y * stride:(y + 1) * stride]
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (len(data).to_bytes(4, "big") + tag + data
                + zlib.crc32(tag + data).to_bytes(4, "big"))
    header = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", width.to_bytes(4, "big")
              + height.to_bytes(4, "big") + bytes([8, color, 0, 0, 0])))
    level, compressobj = 9, zlib.compressobj(9, zlib.DEFLATED, zlib.MAX_WBITS, 9, zlib.Z_DEFAULT_STRATEGY)
    body = b"".join(compressobj.compress(raw[i:i + 262144]) for i in range(0, len(raw), 262144))
    body += compressobj.flush()
    return header + chunk(b"IDAT", body) + chunk(b"IEND", b"")


def render_page_png(pdf_path: str | Path, page_1based: int, *, dpi: int = DEFAULT_DPI,
                    rotation: int = 0) -> tuple[bytes, dict[str, Any]]:
    """Render ONE page to PNG at a bounded DPI. Rotation is applied at render time."""
    dpi = max(MIN_DPI, min(MAX_DPI, int(dpi)))
    state = rasterizer_state()
    if not state["present"]:
        raise OcrUnavailable("rasterizer_missing",
                             f"the pinned rasterizer is unusable here: {state.get('detail', '')}",
                             "install the documents extra (pypdfium2) into the backend venv")
    import pypdfium2                                   # noqa: PLC0415
    try:
        doc = pypdfium2.PdfDocument(str(pdf_path), autoclose=True)
    except Exception as exc:                           # noqa: BLE001
        name = type(exc).__name__
        kind = "encrypted_input" if "password" in str(exc).lower() else "corrupt_input"
        raise OcrUnavailable(kind, f"rasterizer could not open the PDF: {name}: {exc}",
                             "decrypt or repair the file before OCR") from exc
    total = len(doc)
    if not 1 <= page_1based <= total:
        raise OcrUnavailable("input_rejected",
                             f"page {page_1based} is outside the {total} page document")
    try:
        page = doc[page_1based - 1]
        requested = int(rotation) % 360
        if requested:
            # pypdfium2 renders the page's own /Rotate on top of nothing and treats this
            # parameter as ADDITIONAL ("Additional rotation in degrees", pypdfium2 5.6.0
            # render docstring). Callers pass the declared /Rotate as the orientation to
            # render, so subtract the page's intrinsic rotation to make the parameter mean
            # what callers use it for. F73 production measured the consequence of not doing
            # this: a /Rotate 90 page was turned twice (total 180°) and the engine delivered
            # upside-down garbage while the CLI - which passes no rotations - read the very
            # same page correctly.
            intrinsic = int(page.get_rotation()) % 360
            additional = (requested - intrinsic) % 360
        else:
            # No caller opinion: pdfium's own view orientation (page /Rotate applied once)
            # is the correct read, exactly as the standalone ocr_job CLI has always done.
            additional = 0
        bitmap = page.render(scale=dpi / 72.0, rotation=additional)
        buf, nch = _pdfium_buffer_rgb(bitmap)
        info = {"page": page_1based, "dpi": dpi, "rotation": requested,
                "width": bitmap.width, "height": bitmap.height,
                "channels": nch, "rasterizer": "pypdfium2", "channelOrder": "RGB"}
        png = encode_png(bitmap.width, bitmap.height, nch, buf)
    except OcrUnavailable:
        raise
    except Exception as exc:                           # noqa: BLE001 - per page
        raise OcrUnavailable("raster_failed",
                             f"page {page_1based} failed to render: {type(exc).__name__}: {exc}",
                             "lower the DPI or split the document") from exc
    finally:
        try:
            doc.close()
        except Exception:                              # noqa: BLE001
            pass
    return png, info


# ------------------------------------------------------------------ recognise
@dataclass(slots=True)
class OcrPage:
    page: int
    state: str                       # recognised | empty | raster_failed | ocr_failed | skipped
    text: str = ""
    detail: str = ""
    confidence: float | None = None
    lines: list[dict[str, Any]] = field(default_factory=list)
    raster: dict[str, Any] = field(default_factory=dict)
    engine: str = ""
    language_code: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"page": self.page, "state": self.state, "text": self.text, "detail": self.detail,
                "confidence": self.confidence, "lines": self.lines[:500], "raster": self.raster,
                "engine": self.engine, "language_code": self.language_code,
                "provenance": "ocr"}


# Adapter-level recognition counter (F152 law): every Tesseract pass that recognises
# words increments HERE - probe passes, language-verification passes and cascade
# recovery alike. Callers report evidence from these numbers, so a probe can never be
# counted as "zero engine calls" while it ran the engine. The counters are
# process-lifetime monotonic: an evidence writer snapshots a delta around its own
# section, never a total.
RECOGNITIONS = {"tesseract_ocr_png": 0, "tesseract_osd": 0}


def recognize_count() -> dict[str, int]:
    """Snapshot of the adapter's recognition-call counters (caller takes deltas)."""
    return dict(RECOGNITIONS)


def ocr_png(png: bytes, *, language: str, engine_exe: str = "") -> tuple[list[dict[str, Any]], str]:
    """Run the validated engine over one PNG and parse its TSV (the documented machine form)."""
    exe = engine_exe or binaries.path_for(BINARY)
    if not exe:
        raise OcrUnavailable("engine_missing", "no validated tesseract copy was found",
                             f"install {BINARY} or set {binaries.env_var(BINARY)} to a validated copy")
    ok, code, why = language_is_addressable(language)
    if not ok:
        raise OcrUnavailable("unsupported_language", why,
                             "install the language data for the requested language, or accept that "
                             "this document's language is not supported here")
    RECOGNITIONS["tesseract_ocr_png"] += 1
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    try:
        tmp.write(png[:64 << 20])
        tmp.close()
        cmd = [exe, tmp.name, "stdout", "-l", code, "--psm", "3", "tsv"]
        done = processes.run_captured(cmd, timeout=OCR_TIMEOUT_S)
    except subprocess.TimeoutExpired as exc:
        raise OcrUnavailable("ocr_timeout",
                             f"{BINARY} exceeded {OCR_TIMEOUT_S}s; partial output is not evidence",
                             "lower the DPI or OCR the page in regions") from exc
    except (OSError, ValueError) as exc:
        raise OcrUnavailable("engine_spawn_failed", f"{type(exc).__name__}: {exc}",
                             "the resolved engine could not be started") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    if done.returncode != 0:
        raise OcrUnavailable("engine_failed",
                             f"{BINARY} exited {done.returncode}: "
                             f"{(done.stderr or b'')[-400:]!r}", "check the language data and the image")
    tsv = (done.stdout or b"").decode("utf-8", "replace")[:MAX_TSV_BYTES]
    return parse_tsv(tsv), code


def run_osd(png: bytes, *, engine_exe: str = "") -> tuple[str, float] | None:
    """The engine's own script analysis over one PNG. None when the output is unparsable."""
    exe = engine_exe or binaries.path_for(BINARY)
    if not exe:
        raise OcrUnavailable("engine_missing", "no validated tesseract copy was found",
                             f"install {BINARY} or set {binaries.env_var(BINARY)} to a validated copy")
    RECOGNITIONS["tesseract_osd"] += 1
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    try:
        tmp.write(png[:64 << 20])
        tmp.close()
        done = processes.run_captured([exe, tmp.name, "stdout", "--psm", "0", "osd"],
                                      timeout=OCR_TIMEOUT_S)
    except subprocess.TimeoutExpired as exc:
        raise OcrUnavailable("ocr_timeout", f"the script analyser exceeded {OCR_TIMEOUT_S}s",
                             "lower the DPI") from exc
    except (OSError, ValueError) as exc:
        raise OcrUnavailable("engine_spawn_failed", f"{type(exc).__name__}: {exc}",
                             "the resolved engine could not be started") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    if done.returncode != 0:
        # The analyser needs the osd data file; its absence is a typed engine gap,
        # not a silent "no script" answer.
        raise OcrUnavailable("engine_failed",
                             f"osd exited {done.returncode}: {(done.stderr or b'')[-400:]!r}",
                             "install the engine's osd language data")
    return parse_osd((done.stdout or b"").decode("utf-8", "replace"))


def detect_language(pdf_path: str | Path, page_1based: int, *, rotation: int = 0,
                    dpi: int = DEFAULT_DPI, engine_exe: str = "",
                    verify: bool = True) -> dict[str, Any]:
    """Validated language detection from a page raster: the engine's script estimate,
    gated by a verification OCR pass at the mapped language.

    The result is NEVER a default: each refusal names what failed, and only a page
    whose verification pass reaches the measured quality bounds (module constants,
    recorded from the genuine scan page on this host) is `verified`. A page that is a
    scan of the mapped language verifies; a blank raster, a page of an unmapped script,
    or a page the mapped language reads as garbage all return verified=False with a
    reason. This is the last honest step before a scan is transcribed in a language
    nobody declared.

    F152 audit (2026-11-24): the verification pass is Tesseract WORD recognition, so
    under a Paddle-selected policy it let the fallback engine read pixels before the
    primary. `verify=False` answers from the script analyser alone (run_osd is a
    script estimate, not word recognition): the gate becomes the osd confidence +
    script mapping + addressability, the result records `verification="script-level"`
    and the primary engine's first eligible recognition IS the verification.
    """
    png, info = render_page_png(pdf_path, page_1based, dpi=dpi, rotation=rotation)
    result: dict[str, Any] = {"verified": False, "page": int(page_1based), "dpi": info["dpi"]}
    osd = run_osd(png, engine_exe=engine_exe)
    if osd is None:
        result["reason"] = "the engine's script analyser produced no parsable result"
        return result
    script, confidence = osd
    result.update(script=script, script_confidence=confidence)
    if confidence < OSD_MIN_SCRIPT_CONFIDENCE:
        result["reason"] = (f"the script estimate {script!r} scored {confidence}, below the "
                            f"validated bound {OSD_MIN_SCRIPT_CONFIDENCE}")
        return result
    code = SCRIPT_TO_TESSERACT.get(script)
    if not code:
        result["reason"] = f"no general language naming exists for the detected script {script!r}"
        return result
    ok, lang, why = language_is_addressable(code)
    if not ok:
        result["reason"] = f"the detected script {script!r} maps to {code!r}, which the engine cannot run: {why}"
        return result
    if not verify:
        # F152 audit: under a Paddle-selected policy the verification pass below is
        # Tesseract WORD recognition reading pixels before the primary. The script
        # analyser's gate (confidence bound + script map + addressability) answers
        # at script level; the primary's first eligible recognition is the verification.
        result.update(language=lang, verified=True, verification="script-level",
                      reason=(f"the script estimate {script!r} passed the validated bounds "
                              f"({confidence} >= {OSD_MIN_SCRIPT_CONFIDENCE}) and maps to the "
                              "addressable language "
                              f"{lang!r}; word-recognition verification is skipped under the "
                              "selected engine policy"))
        return result
    lines, _ = ocr_png(png, language=lang, engine_exe=engine_exe)
    confs = [ln["confidence"] for ln in lines if isinstance(ln.get("confidence"), float)]
    mean = sum(confs) / len(confs) if confs else 0.0
    text = " ".join(ln.get("text", "") for ln in lines)
    glyphs = sum(1 for ch in text if not ch.isspace())
    words = len(re.findall(r"\b\w{2,}\b", text))
    result.update(language=lang, lines=len(lines), mean_conf=round(mean, 4),
                  glyphs=glyphs, words=words)
    if (len(lines) >= DETECT_MIN_LINES and mean >= DETECT_MIN_MEAN_CONF
            and glyphs >= DETECT_MIN_GLYPHS and words >= DETECT_MIN_WORDS):
        result["verified"] = True
        result["reason"] = (f"verification passed: {len(lines)} lines, mean line confidence "
                            f"{mean:.3f}, {glyphs} glyphs, {words} words")
    else:
        result["reason"] = (f"verification did not reach the quality bounds "
                            f"(lines {len(lines)}/{DETECT_MIN_LINES}, mean conf {mean:.3f}/"
                            f"{DETECT_MIN_MEAN_CONF}, glyphs {glyphs}/{DETECT_MIN_GLYPHS}, "
                            f"words {words}/{DETECT_MIN_WORDS})")
    return result


def parse_tsv(text: str) -> list[dict[str, Any]]:
    """Parse tesseract's TSV form into word boxes plus line groupings.

    conf is kept as the engine reported it: -1/none stays None rather than becoming 0.0,
    because an unknown confidence and a zero confidence are different statements.
    """
    header: list[str] = []
    words: list[dict[str, Any]] = []
    lines: dict[tuple[int, int, int], list[dict[str, Any]]] = {}
    for row in text.splitlines()[:MAX_TSV_BYTES // 40][:200000]:
        parts = row.split("\t")
        if not header:
            if parts[:1] == ["level"]:
                header = parts
            continue
        if len(parts) < len(header):
            continue
        rec = dict(zip(header, parts))
        try:
            level = int(rec.get("level", ""))
        except ValueError:
            continue
        if level != 5:
            continue
        word = (rec.get("text") or "").strip()
        if not word:
            continue
        conf_raw = (rec.get("conf") or "").strip()
        try:
            conf = float(conf_raw)
            conf = None if conf < 0 else conf / 100.0
        except ValueError:
            conf = None
        try:
            left, top = int(rec.get("left", 0)), int(rec.get("top", 0))
            width, height = int(rec.get("width", 0)), int(rec.get("height", 0))
        except ValueError:
            left = top = width = height = 0
        item = {"text": word, "conf": conf,
                "bbox": [left, top, left + width, top + height],
                "block": rec.get("block_num", ""), "par": rec.get("par_num", ""),
                "line": rec.get("line_num", "")}
        words.append(item)
        lines.setdefault((item["block"], item["par"], item["line"]), []).append(item)
    grouped: list[dict[str, Any]] = []
    for (_b, _p, _l), items in lines.items():
        grouped.append({"text": " ".join(w["text"] for w in items),
                        "bbox": [min(w["bbox"][0] for w in items), min(w["bbox"][1] for w in items),
                                 max(w["bbox"][2] for w in items), max(w["bbox"][3] for w in items)],
                        "confidence": _mean([w["conf"] for w in items])})
    grouped.sort(key=lambda g: (g["bbox"][1], g["bbox"][0]))
    return grouped[:20000]


def _mean(values: list[float | None]) -> float | None:
    vals = [v for v in values if isinstance(v, float)]
    return sum(vals) / len(vals) if vals else None


def _cancel_flag(cancel: Any) -> bool:
    """Accept a threading.Event OR a plain callable, without guessing wrong.

    The cascade hands this module the worker's `ctx.cancel.is_set` callable, while other
    callers pass an Event. Calling `.is_set()` on a callable raises AttributeError, which
    used to abort the whole engine fallback instead of cancelling it, so both shapes are
    probed explicitly rather than assumed.
    """
    if cancel is None:
        return False
    is_set = getattr(cancel, "is_set", None)
    if callable(is_set):
        return bool(is_set())
    if callable(cancel):
        return bool(cancel())
    return False


def ocr_pdf_pages(pdf_path: str | Path, pages: list[int], *, language: str,
                  dpi: int = DEFAULT_DPI, rotations: dict[int, int] | None = None,
                  cancel: Any = None,
                  progress: Any = None) -> list[OcrPage]:
    """OCR an explicit page list, one bounded raster+recognise per page.

    Each page's failure is recorded on that page; a page that fails never aborts the run
    and never makes the surviving pages' text look like a complete extraction.
    """
    pages = sorted({int(p) for p in pages})[:MAX_OCR_PAGES]
    if not pages:
        return []
    st = engine_state()
    if not st["found"]:
        raise OcrUnavailable("engine_missing",
                             f"no validated {BINARY} copy: {st.get('detail', '')}",
                             f"install {BINARY} or set {binaries.env_var(BINARY)} to a validated copy")
    ok, code, why = language_is_addressable(language)
    if not ok:
        raise OcrUnavailable("unsupported_language", why,
                             "install the language data, or report the language as unsupported")
    results: list[OcrPage] = []
    for page in pages:
        if _cancel_flag(cancel):
            results.append(OcrPage(page=page, state="skipped", detail="cancelled before this page",
                                   engine=st["version"], language_code=code))
            continue
        if progress:
            progress("ocr", f"page {page} at {dpi} dpi")
        try:
            png, info = render_page_png(pdf_path, page, dpi=dpi,
                                        rotation=(rotations or {}).get(page, 0))
        except OcrUnavailable as exc:
            results.append(OcrPage(page=page, state="raster_failed", detail=exc.detail,
                                   engine=st["version"], language_code=code))
            continue
        try:
            grouped, used = ocr_png(png, language=language, engine_exe=binaries.path_for(BINARY))
        except OcrUnavailable as exc:
            results.append(OcrPage(page=page, state="ocr_failed", detail=exc.detail,
                                   raster=info, engine=st["version"], language_code=used or code))
            continue
        text = "\n".join(g["text"] for g in grouped).strip()
        results.append(OcrPage(page=page, state="recognised" if text else "empty",
                               text=text, lines=grouped, raster=info,
                               confidence=_mean([g["confidence"] for g in grouped]),
                               engine=st["version"], language_code=used or code))
    return results


def ocr_status() -> dict[str, Any]:
    st = engine_state()
    raster = rasterizer_state()
    if st["found"] and raster["present"]:
        return {"status": "available",
                "detail": (f"engine validated ({st['version']}); rasterizer {raster['package']} "
                           "importable; per-page OCR is executable here"),
                "languages": st["languages"], "languages_source": st["languages_source"],
                "quality": "not measured on this host until the document quality gate runs",
                "human_step": ""}
    missing = []
    if not st["found"]:
        missing.append(f"no validated {BINARY} binary")
    if not raster["present"]:
        missing.append("rasterizer pypdfium2 unavailable")
    return {"status": "not_installed",
            "detail": "; ".join(missing),
            "languages": [], "languages_source": st["languages_source"],
            "quality": "no engine, so no coverage and no quality claim",
            "human_step": f"install {BINARY} (or set {binaries.env_var(BINARY)}) and the "
                          "documents extra, then re-run the OCR quality gate"}
