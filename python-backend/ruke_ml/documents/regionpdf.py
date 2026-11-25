"""Wrap ONE embedded raster (PNG/JPEG bytes) as a one-page PDF.

Why: the OCR cascade's whole resource law (engine policy, per-worker ceilings, the
busy-window wait, engine fallback only after release) is built around
``ocr_cascade.run(pdf_path, pages, ...)``. Office documents carry their image-only
regions as package rasters, and standalone images are rasters. Rather than invent a
second OCR entry point with its own resource behaviour (which the engine-settings law
forbids), the region's bytes are re-wrapped as a one-page PDF and the EXISTING cascade
runs it unchanged. pdfium renders the page back to a raster pixel-faithfully, so the
engine sees exactly the region's pixels.

Pure stdlib: no PIL (the backend venv has none), no new pins. Formats outside the
supported set answer with a typed refusal; the caller records the region as
unreadable/retryable with the reason - never silently drops it.
"""
from __future__ import annotations

import struct
import zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"


class RegionDecode(Exception):
    """Typed: this raster cannot be wrapped for OCR. detail names WHY."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _defilter(raw: bytes, w: int, h: int, bpp: int, stride: int) -> bytes:
    """Undo PNG row filters (0-4); returns h rows of `stride` bytes, no filter bytes."""
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(h):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if len(line) != stride:
            raise RegionDecode("corrupt_input", "PNG row is truncated")
        if f == 0:
            pass
        elif f == 1:                                   # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 0 + 2:                               # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:                                   # Average
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:                                   # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p, pa, pb, pc = a + b - c, abs(b - c), abs(a - c), abs(a - b)
                line[i] = (line[i] + (c if (pa <= pb and pa <= pc) else (a if pb <= pc else b))) & 0xFF
        else:
            raise RegionDecode("corrupt_input", f"PNG filter type {f} is not defined")
        out += line
        prev = line
    return bytes(out)


def _refilter_none(rows: bytes, stride: int, h: int) -> bytes:
    """Re-emit rows with filter-type 0 bytes so Predictor 15 can read them."""
    out = bytearray()
    for y in range(h):
        out.append(0)
        out += rows[y * stride:(y + 1) * stride]
    return bytes(out)


def _png_chunks(data: bytes) -> tuple[dict, list[tuple[bytes, bytes]]]:
    if not data.startswith(PNG_SIG):
        raise RegionDecode("not_png", "the raster does not start with the PNG signature")
    pos = len(PNG_SIG)
    ihdr: dict = {}
    chunks: list[tuple[bytes, bytes]] = []
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise RegionDecode("corrupt_input", "PNG chunk is truncated")
        chunks.append((ctype, body))
        pos += 12 + length
        if ctype == b"IHDR":
            w, h, bd, ct, comp, filt, inter = struct.unpack(">IIBBBBB", body[:13])
            ihdr = {"w": w, "h": h, "bitdepth": bd, "colortype": ct,
                    "interlace": inter, "palette": b"", "trns": False}
        elif ctype == b"PLTE":
            ihdr["palette"] = body
    return ihdr, chunks


def _png_to_pdf_image(data: bytes) -> tuple[bytes, dict]:
    """Return (stream, dict for the /XObject entries). Raises RegionDecode."""
    ihdr, chunks = _png_chunks(data)
    w, h = int(ihdr["w"]), int(ihdr["h"])
    bd, ct, inter = int(ihdr["bitdepth"]), int(ihdr["colortype"]), int(ihdr["interlace"])
    if inter:
        raise RegionDecode("decode_unsupported",
                           "interlaced (Adam7) PNGs are not wrapped; the region is retryable "
                           "after de-interlacing")
    idat = b"".join(body for ctype, body in chunks if ctype == b"IDAT")
    if not idat:
        raise RegionDecode("corrupt_input", "the PNG carries no IDAT image data")
    if ct in (0, 2, 3) and bd == 8:
        # The IDAT stream already speaks Predictor 15; embed it untouched.
        colors = {0: 1, 2: 3, 3: 1}[ct]
        cs = {0: "/DeviceGray", 2: "/DeviceRGB", 3: None}[ct]
        if ct == 3:
            pal = ihdr["palette"]
            if not pal or len(pal) % 3:
                raise RegionDecode("corrupt_input", "palette PNG has a malformed PLTE")
            cs = f"[/Indexed /DeviceRGB {len(pal) // 3 - 1} <{pal.hex()}>"
            cs += "]"
        stream = zlib.compress(zlib.decompress(idat), 9)
        params = f"/DecodeParms << /Predictor 15 /Colors {colors} /BitsPerComponent 8 /Columns {w} >>"
        return stream, {"cs": cs, "bpc": 8, "params": params, "filter": "/FlateDecode"}
    if ct in (4, 6) and bd == 8:
        # Gray/RGB + alpha: defilter, drop the alpha channel, re-emit filter-0 rows.
        ch = 2 if ct == 4 else 4
        stride = w * ch
        try:
            raw = zlib.decompress(idat)
        except zlib.error as exc:
            raise RegionDecode("corrupt_input", f"PNG IDAT stream is corrupt: {exc}") from exc
        rows = _defilter(raw, w, h, ch, stride)
        keep = 1 if ct == 4 else 3
        kept = b"".join(rows[y * stride + 0:y * stride + w * keep]
                        for y in range(h)) if keep == 3 else \
               b"".join(rows[y * stride + 0:y * stride + w] for y in range(h))
        stream = zlib.compress(_refilter_none(kept, w * keep, h), 9)
        params = f"/DecodeParms << /Predictor 15 /Colors {keep} /BitsPerComponent 8 /Columns {w} >>"
        return stream, {"cs": "/DeviceGray" if keep == 1 else "/DeviceRGB",
                        "bpc": 8, "params": params, "filter": "/FlateDecode"}
    raise RegionDecode("decode_unsupported",
                       f"PNG colour type {ct} at {bd}-bit depth is not wrapped; "
                       "the region is retryable after re-encoding to 8-bit")


def _jpeg_to_pdf_image(data: bytes) -> tuple[bytes, dict]:
    if not data.startswith(b"\xff\xd8"):
        raise RegionDecode("not_jpeg", "the raster does not start with the JPEG signature")
    pos = 2
    w = h = 0
    ncomp = 0
    adobe_cmyk = False
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            pos += 1
            continue
        marker = data[pos + 1]
        seglen = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w, ncomp = struct.unpack(">HHB", data[pos + 5:pos + 10])
            break
        if marker == 0xDA:                              # start of scan: no SOF seen
            break
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        if marker == 0xEE:                              # APP14
            if data[pos + 4:pos + 9] == b"Adobe" and seglen >= 14:
                adobe_cmyk = data[pos + 11 + 2] in (65, 67)   # 'A'/'C' transform
        pos += 2 + seglen
    if not w or not h:
        raise RegionDecode("corrupt_input", "no SOF segment was found in the JPEG")
    if ncomp == 1:
        return data, {"cs": "/DeviceGray", "bpc": 8, "params": "", "filter": "/DCTDecode"}
    if ncomp == 3:
        return data, {"cs": "/DeviceRGB", "bpc": 8, "params": "", "filter": "/DCTDecode"}
    if ncomp == 4 and adobe_cmyk:
        # PDF wants CMYK inverted; the stream stays byte-identical.
        return data, {"cs": "/DeviceCMYK", "bpc": 8, "filter": "/DCTDecode",
                      "params": "/Decode [1 0 1 0 1 0 1 0] /DecodeParms << /ColorTransform 0 >>"}
    raise RegionDecode("decode_unsupported",
                       f"a {ncomp}-component JPEG is not wrapped; the region is "
                       "retryable after re-encoding")


def wrap_raster(data: bytes) -> tuple[bytes, dict]:
    """Return (pdf_bytes, {"width":w,"height":h}) for one PNG/JPEG raster.

    Raises RegionDecode(kind, detail) for anything this wrapper cannot carry.
    """
    if data.startswith(PNG_SIG):
        stream, spec = _png_to_pdf_image(data)
    elif data.startswith(b"\xff\xd8"):
        stream, spec = _jpeg_to_pdf_image(data)
    else:
        raise RegionDecode("decode_unsupported",
                           "only PNG and JPEG rasters are wrapped for region OCR")
    # Recover the pixel size from the encoded stream's IHDR/SOF for the report.
    if data.startswith(PNG_SIG):
        w, h = struct.unpack(">II", data[16:24])
    else:
        w, h = _jpeg_size(data)
    cs = spec["cs"]
    params = f" {spec['params']}" if spec.get("params") else ""
    content = f"q {w} 0 0 {h} 0 0 cm /Im0 Do Q".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] "
        f"/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>".encode(),
        f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
        f"/ColorSpace {cs} /BitsPerComponent {spec['bpc']} /Filter {spec['filter']}"
        f"{params} /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1, xref_pos)
    return bytes(out), {"width": int(w), "height": int(h)}


def _jpeg_size(data: bytes) -> tuple[int, int]:
    pos = 2
    while pos + 10 <= len(data):
        if data[pos] == 0xFF and data[pos + 1] in (0xC0, 0xC1, 0xC2, 0xC3):
            h, w = struct.unpack(">HH", data[pos + 5:pos + 9])
            return int(w), int(h)
        if data[pos] == 0xFF and data[pos + 1] not in (0xD8, 0xD9) and not 0xD0 <= data[pos + 1] <= 0xD7:
            pos += 2 + struct.unpack(">H", data[pos + 2:pos + 4])[0]
        else:
            pos += 1
    return 1, 1
