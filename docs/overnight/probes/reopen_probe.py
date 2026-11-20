"""Reopen artifacts written by the TypeScript engines with the Python readers.

Usage:
    python docs/overnight/probes/reopen_probe.py [--expect TEXT]... <file> [<file ...]

Prints one JSON object on stdout:
    {"files": [{"path","ok","kind","blocks","kinds","matched","formula_cells","meta",
                "coverage","meta_keys","blocks_sample","notes","error"}]}

`--expect TEXT` repeats. For each file the probe reports how many extracted blocks
contain that exact text and where the first hit sits, so a caller can assert presence
and unit location without shipping a whole document through stdout.

This is a cross-engine reopen check: the bytes a TS writer produced are parsed by
`ruke_ml.documents.parser.load_document`, the same reader the production upload
path uses. It reports structure (block kinds, unit coverage, location refs), not
an aesthetic judgement. No model, no network, no heavy dependency: the readers are
stdlib zip/XML plus pypdf/pypdfium2 where a PDF is passed.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python-backend"))

from ruke_ml.documents.parser import load_document  # noqa: E402


def _sample(doc, limit: int = 14) -> list[dict]:
    out = []
    for b in doc.blocks[:limit]:
        text = b.text if len(b.text) <= 160 else b.text[:157] + "..."
        out.append({"kind": b.kind, "text": text, "loc": b.loc})
    return out


def _matched(doc, expects: list[str]) -> dict:
    """Exact-substring presence per expected string, with where the first hit lives.

    A test asserts "this string is readable in this unit" through this, instead of
    dumping every extracted block into its own assertion list.
    """
    out: dict[str, dict] = {}
    for want in expects:
        hits = [b for b in doc.blocks if want in b.text]
        out[want] = {"count": len(hits),
                     "first_kind": hits[0].kind if hits else None,
                     "first_loc": hits[0].loc if hits else None}
    return out


def _formula_cells(doc, limit: int = 50) -> list[dict]:
    return _kind_rows(doc, "formula", limit)


def _notes(doc, limit: int = 24) -> list[dict]:
    """Every speaker-note block, in slide order.

    The block sample is only the first few blocks, so notes on a later slide would
    never be visible there — and whether a notesSlide's managed placeholders (slide
    number, footer, date) leaked into the note text is exactly what has to be checkable
    (D-071).
    """
    return _kind_rows(doc, "note", limit)


def _kind_rows(doc, kind: str, limit: int) -> list[dict]:
    """Blocks of one kind with their text and location.

    For "formula" the reader keeps the FORMULA TEXT apart from its CACHED RESULT, so both
    are named explicitly and a caller can assert the formula was not replaced by its
    value. For "note" the text itself is the payload, and loc carries the slide.
    """
    out = []
    for b in doc.blocks:
        if b.kind != kind:
            continue
        row: dict = {"kind": b.kind, "text": b.text, "loc": b.loc}
        if kind == "formula":
            row.update({
                "sheet": b.loc.get("sheet"), "cell": b.loc.get("cell"),
                "formula": b.loc.get("formula"),
                "cached_value": b.loc.get("cached_value"),
            })
        out.append(row)
        if len(out) >= limit:
            break
    return out


def _small_meta(meta: dict) -> dict:
    """Only scalars and short lists: enough to check provenance without a huge payload."""
    out: dict[str, object] = {}
    for key, value in (meta or {}).items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value
        elif (isinstance(value, list) and len(value) <= 12
              and all(isinstance(v, (str, int, float)) or v is None for v in value)):
            out[key] = value
    return out


def main(paths: list[str], expects: list[str]) -> int:
    report = []
    for raw in paths:
        entry: dict = {"path": raw, "ok": False}
        try:
            doc = load_document(raw)
            entry.update({
                "ok": True,
                "kind": doc.kind,
                "blocks": len(doc.blocks),
                "kinds": dict(Counter(b.kind for b in doc.blocks)),
                "matched": _matched(doc, expects),
                "formula_cells": _formula_cells(doc),
                "notes": _notes(doc),
                "meta": _small_meta(doc.meta),
                "coverage": {
                    "units_total": doc.coverage.units_total,
                    "units_extracted": doc.coverage.units_extracted,
                    "units_succeeded": doc.coverage.units_succeeded,
                    "units_empty": doc.coverage.units_empty,
                    "units_needing_ocr": doc.coverage.units_needing_ocr,
                    "units_failed": doc.coverage.units_failed,
                    "method": doc.coverage.method,
                    "note": doc.coverage.note,
                },
                "meta_keys": sorted(doc.meta.keys()),
                "blocks_sample": _sample(doc),
            })
        except Exception as exc:  # honest typed failure, never a silent pass
            entry["error"] = f"{type(exc).__name__}: {exc}"
        report.append(entry)
    print(json.dumps({"files": report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):  # Windows cp1252 mangles extracted text
        sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    expects: list[str] = []
    paths: list[str] = []
    i = 0
    while i < len(args):
        if args[i] == "--expect":
            i += 1
            if i >= len(args):
                print(json.dumps({"error": "--expect needs a value"}))
                raise SystemExit(2)
            expects.append(args[i])
        else:
            paths.append(args[i])
        i += 1
    if not paths:
        print(json.dumps({"error": "usage: reopen_probe.py [--expect TEXT]... <file> [...]"}))
        raise SystemExit(2)
    raise SystemExit(main(paths, expects))
