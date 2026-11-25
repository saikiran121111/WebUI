"""F152 audit (2026-11-24): pdfium bitmaps are BGR/BGRx in memory, encode_png
declares PNG RGB/RGBA. Passing the raw buffer through delivered every
colour-bearing raster (probe render, region crop, visual page frame, engine
input) with R and B exchanged — the violet threshold-crossing line reached Qwen
at hue 326° = PINK, and the live model faithfully answered "pink" about the
pixels it was really given (results-live-f152.jsonl, "KAPPA 9 — pink").

The law: render_page_png emits pixels in the order the format it declares
states. Colour IS a fact a reader can be asked about, so the channel order is
part of the delivery contract, not a rendering detail.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ruke_ml.documents import ocr_tesseract, region_ocr  # noqa: E402

VIOLET = (0.588235, 0.239216, 0.858824)  # rgb (150, 61, 219): hue 274°, violet
VIOLET_RGB = (150, 61, 219)


def _violet_rect_pdf() -> bytes:
    """One 300x200 pt page, a solid violet rect at (20,40)-(180,120). Minimal
    writer (contiguous objects; the d1 composer's xref law)."""
    stream = f"{VIOLET[0]} {VIOLET[1]} {VIOLET[2]} rg 20 40 160 80 re f".encode("latin-1")
    objs = {
        1: b"<</Type/Catalog/Pages 2 0 R>>",
        2: b"<</Type/Pages/Count 1/Kids[7 0 R]>>",
        3: b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        4: b"<</Type/Font/Subtype/Type1/BaseFont/Courier>>",
        5: b"<</Producer(Ruke channel-order test)>>",
        6: (f"<</Length {len(stream)}>>\nstream\n").encode() + stream + b"\nendstream",
        7: (b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]"
            b"/Resources<</Font<</F1 3 0 R>>>>/Contents 6 0 R>>"),
    }
    out = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"
    off: dict[int, int] = {}
    for ref in sorted(objs):
        off[ref] = len(out)
        out += f"{ref} 0 obj\n".encode() + objs[ref] + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {max(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
    for ref in range(1, max(objs) + 1):
        out += f"{off.get(ref, 0):010d} 00000 {'n' if ref in objs else 'f'} \n".encode()
    out += (f"trailer\n<</Size {max(objs) + 1}/Root 1 0 R/Info 5 0 R>>\n"
            f"startxref\n{start}\n%%EOF\n").encode()
    return out


def _assert_violet(test: unittest.TestCase, rgb: tuple[int, int, int], where: str) -> None:
    for a, b in zip(rgb, VIOLET_RGB):
        test.assertLessEqual(abs(a - b), 6,
                             f"{where}: rgb{rgb} — R/B exchange detected "
                             f"(pdfium BGR buffer passed to an RGB writer)")


class RenderChannelOrder(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.pdf = Path(self._tmp.name) / "violet.pdf"
        self.pdf.write_bytes(_violet_rect_pdf())

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_page_render_pixels_are_the_declared_rgb_order(self) -> None:
        png, info = ocr_tesseract.render_page_png(str(self.pdf), 1, dpi=150, rotation=0)
        self.assertEqual(info["channelOrder"], "RGB")
        self.assertIn(info["channels"], (3, 4))
        dec = region_ocr._rgb_rows(png)
        self.assertIsNotNone(dec, "the page render is not a decodable 8-bit raster")
        rows, _w, _h = dec
        # rect centre (100, 80) pt at scale 150/72: px x=208, y=(200-80)*2.0833=250
        _assert_violet(self, tuple(rows[250][208 * 3:208 * 3 + 3]), "page render")

    def test_region_crop_keeps_the_source_colour(self) -> None:
        png, info = ocr_tesseract.render_page_png(str(self.pdf), 1, dpi=150, rotation=0)
        rect = region_ocr._placement_rect([20, 40, 180, 120], 300, 200,
                                          info["width"], info["height"], 0)
        self.assertIsNotNone(rect, "placement law lost a fully on-page figure")
        crop = region_ocr._crop_png(png, rect)
        self.assertIsNotNone(crop, "the production crop path failed on a plain rect")
        dec = region_ocr._rgb_rows(crop)
        self.assertIsNotNone(dec)
        rows, cw, chh = dec
        _assert_violet(self, tuple(rows[chh // 2][(cw // 2) * 3:(cw // 2) * 3 + 3]),
                       "region crop")


if __name__ == "__main__":
    unittest.main()
