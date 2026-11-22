"""Structure-preserving text rendering of already-parsed blocks, one text per unit.

Why this exists: the wire payload carries every block with its `loc` (cell reference,
merged area, table/row identity, heading level, sheet index), but a caller that only
concatenates `block.text` throws all of that away. The office merge layer then measured
the capability body as SMALLER than the TS reader's body - because the TS reader prints
`A1=value`, worksheet headers and merged-range facts inline - and kept the weaker text.
Losing the reader's structure on the way out is the same fidelity bug as never parsing it.

Laws:
  * The blocks stay the raw evidence. A rendering is DERIVED text, never a replacement:
    `blocks` keeps its exact text, kind and loc in the payload.
  * A rendering states only what the reader actually parsed. It never guesses a merged
    value into a second cell, never invents a heading level, never describes a chart.
  * Unit ids are the 1-based ids used by coverage, Rust, TS and citations.
  * PDF page text is deliberately NOT rendered here: page units already arrive as one
    text per page and the page-level merge needs byte-exact text layer evidence. Rendering
    office units only also keeps the payload from duplicating a large document's text.
"""
from __future__ import annotations

import re
from typing import Any

from .structures import Block, Document

# Only these kinds benefit from a structure-preserving rendering on the wire.
RENDERED_KINDS = ("xlsx", "docx", "pptx",
                  "ods", "odt", "odp", "epub", "rtf",
                  "doc", "ppt", "xls", "mat")

# A single unit's rendering is bounded. Truncation is STATED in the payload and in the
# text itself, so a caller can never mistake a capped rendering for the whole unit.
MAX_UNIT_CHARS = 200_000

_HEADING_LEVEL = re.compile(r"heading\s*([1-6])", re.IGNORECASE)


def unit_of(block: Block) -> int:
    """The 1-based unit (page / sheet / slide) a block belongs to, or 1 when unnamed."""
    for key in ("sheet_index", "slide", "page", "unit"):
        value = block.loc.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value >= 1:
            return value
        if isinstance(value, str) and value.strip().isdigit() and int(value) >= 1:
            return int(value)
    return 1


def _heading_prefix(block: Block) -> str:
    """Markdown depth ONLY when the producer named a heading level. No level -> no depth."""
    match = _HEADING_LEVEL.search(str(block.loc.get("section") or ""))
    if match is None:
        return ""
    return "#" * min(int(match.group(1)), 6) + " "


def render_block(block: Block) -> str:
    """One block, one line, with the identity the reader parsed attached to it."""
    text = block.text.strip()
    loc = block.loc
    kind = block.kind
    ref = str(loc.get("cell") or "").strip()

    if kind in ("cell", "formula"):
        # The formula block's text already carries its leading "=", so the reference is joined
        # without a second one: "C1==A1*2" is not spreadsheet syntax, and a reader that copies
        # the rendered line back into a sheet gets a broken formula.
        if not ref:
            line = text
        elif text.startswith("="):
            line = f"{ref}{text}"
        else:
            line = f"{ref}={text}"
        merged = str(loc.get("merged") or "").strip()
        if merged:
            line += f" [merged {merged}]"
        return line

    if kind == "table_row":
        cells = loc.get("cells")
        n = len(cells) if isinstance(cells, list) else 0
        table = loc.get("table")
        row = loc.get("row")
        where = f" [table {table} row {row} of {n} cell(s)]" if table is not None and row is not None else ""
        return f"| {text} |{where}"

    if kind == "heading":
        section = str(loc.get("section") or "").strip()
        tail = f" [style: {section}]" if section and not _HEADING_LEVEL.fullmatch(section) else ""
        return f"{_heading_prefix(block)}{text}{tail}"

    if kind == "note":
        part = str(loc.get("part") or "note")
        return f"[{part}] {text}"

    if kind == "list_item":
        return f"- {text}"

    if kind == "code":
        return f"[code] {text}"

    return text


def _sheet_name(doc: Document, unit: int) -> str:
    names = doc.meta.get("sheets")
    if isinstance(names, list) and 1 <= unit <= len(names):
        return str(names[unit - 1])
    return ""


def _describe_corrupt(entry: Any, sheet: str) -> str:
    """One corrupt cell as `REF: reason (sheet ...)` - never a raw dict repr.

    The rendering is what a text reader sees, so a dict repr like
    `{'sheet': 'S', 'cell': 'A1', 'why': ...}` is both unreadable and a citation
    hazard: it looks like document content while being reader plumbing.
    """
    if isinstance(entry, dict):
        ref = str(entry.get("cell") or entry.get("ref") or "").strip() or "?"
        why = str(entry.get("why") or "unreadable").strip()
        where = str(entry.get("sheet") or "").strip()
        suffix = f" (sheet {where})" if where and where != sheet else ""
        return f"{ref}: {why}{suffix}"
    text = str(entry).strip()
    return text


def _unit_headers(doc: Document, unit: int, blocks: list[Block]) -> list[str]:
    """Structure the reader knows about a unit that no single block carries."""
    headers: list[str] = []
    if doc.kind == "xlsx":
        name = _sheet_name(doc, unit)
        if name:
            headers.append(f"### worksheet: {name}")
        ranges = doc.meta.get("merged_ranges")
        merged = []
        if isinstance(ranges, dict):
            found = ranges.get(name) if name else None
            if isinstance(found, list):
                merged = [str(r) for r in found]
        if merged:
            headers.append(
                f"### merged cells ({len(merged)}): {', '.join(merged[:40])}"
                + (f" +{len(merged) - 40} more" if len(merged) > 40 else "")
                + " - a merged block carries ONE value; the other cells in it are blank, not zero")
        corrupt = doc.meta.get("corrupt_cells")
        if isinstance(corrupt, list) and corrupt:
            named = [_describe_corrupt(entry, name) for entry in corrupt[:40]]
            named = [line for line in named if line]
            if named:
                more = len(corrupt) - len(named)
                headers.append(
                    "### cells this reader could NOT read: " + "; ".join(named)
                    + (f" (+{more} more)" if more > 0 else "")
                    + " - reported by reference and reason; they are NOT blank and NOT zero"
                )
        failures = doc.meta.get("sheet_failures")
        if isinstance(failures, list):
            for failure in failures:
                if not isinstance(failure, dict):
                    continue
                if int(failure.get("sheet_index") or 0) != unit:
                    continue
                part = str(failure.get("part") or "").strip()
                headers.append(
                    f"### worksheet: {failure.get('sheet') or name or unit} - this sheet could NOT be read: "
                    f"{failure.get('why') or 'the sheet part failed to parse'}"
                    + (f" (part {part})" if part else "")
                    + " - no cell value from this part may be treated as read"
                )
        empties = doc.meta.get("empty_cells")
        if isinstance(empties, dict):
            info = empties.get(name) if name else None
            if isinstance(info, dict) and int(info.get("count") or 0) > 0:
                refs = [str(ref) for ref in (info.get("refs") or [])][:40]
                count = int(info["count"])
                headers.append(
                    f"### declared-empty cells in this worksheet ({count}): {', '.join(refs)}"
                    + (f" (+{count - len(refs)} more not listed)" if count > len(refs) else "")
                    + " - these cells exist and hold no value; an empty cell is not zero"
                )
    elif doc.kind in ("pptx", "ppt"):
        headers.append(f"### slide {unit}")
    elif doc.kind == "odp":
        names = doc.meta.get("page_names")
        name = str(names[str(unit)]) if isinstance(names, dict) and str(unit) in names else ""
        headers.append(f"### page {unit}" + (f": {name}" if name else ""))
    elif doc.kind in ("xls", "ods"):
        name = _sheet_name(doc, unit)
        if name:
            headers.append(f"### worksheet: {name}")
        if doc.kind == "xls" and doc.meta.get("cells_truncated"):
            headers.append("### cell cap reached: only the first 50,000 cells are listed; "
                           "cells after the cap are NOT included")
    elif doc.kind == "epub":
        chapters = doc.meta.get("chapters")
        part = str(chapters[str(unit)]) if isinstance(chapters, dict) and str(unit) in chapters else ""
        headers.append(f"### chapter {unit} (spine reading order)" + (f" - {part}" if part else ""))
    elif doc.kind == "mat":
        variables = doc.meta.get("variables")
        if isinstance(variables, list) and variables:
            headers.append("### variables: " + ", ".join(map(str, variables)) +
                           " (values are column-major, rows/cols are 1-based)")
    elif doc.kind == "rtf":
        hidden = doc.meta.get("hidden_groups_excluded")
        if hidden:
            headers.append(f"### {hidden} hidden (\\v) group(s) EXCLUDED by design: "
                           "the document formats their text as not-visible")
    elif doc.kind == "docx":
        tables = {b.loc.get("table") for b in blocks if b.kind == "table_row" and b.loc.get("table") is not None}
        if tables:
            headers.append(f"### tables in this document: {len(tables)}; table rows are kept row-by-row")
    not_extracted = doc.meta.get("not_extracted")
    if isinstance(not_extracted, list) and not_extracted:
        headers.append("### this reader did NOT extract: " + ", ".join(map(str, not_extracted)))
    return headers


def render_units(doc: Document) -> list[dict[str, Any]]:
    """One rendering per unit, in unit order, with provenance named."""
    if doc.kind not in RENDERED_KINDS:
        return []
    grouped: dict[int, list[Block]] = {}
    for block in doc.blocks:
        if not block.text.strip():
            continue
        grouped.setdefault(unit_of(block), []).append(block)

    method = doc.coverage.method or f"{doc.kind} reader"
    out: list[dict[str, Any]] = []
    # A unit with NO blocks still gets a rendering when the reader knows something about
    # it (a sheet part that failed to parse, a slide with no text). Dropping the unit
    # entirely is how a failed sheet turned into "the workbook contains no cells".
    known: set[int] = set(grouped)
    if doc.kind in ("xlsx", "pptx", "ppt", "ods", "odp", "xls", "epub"):
        total = doc.coverage.units_total if isinstance(doc.coverage.units_total, int) else 0
        known |= {unit for unit in range(1, max(0, total) + 1)}
    for unit in sorted(known):
        blocks = grouped.get(unit, [])
        headers = _unit_headers(doc, unit, blocks)
        if not blocks and not headers:
            continue
        rendered: list[str] = []
        for block in blocks:
            line = render_block(block)
            if line:
                rendered.append(line)
        text = "\n".join([*headers, *rendered])
        truncated = False
        if len(text) > MAX_UNIT_CHARS:
            text = text[:MAX_UNIT_CHARS]
            truncated = True
            text += (f"\n[unit rendering truncated at {MAX_UNIT_CHARS} characters by the reader; "
                     "the block list still carries every extracted block]")
        provenance = "ocr" if blocks and all(b.kind == "ocr_text" for b in blocks) else "text-layer"
        out.append({"unit": unit, "text": text, "provenance": provenance, "engine": method,
                    "blocks": len(blocks), "truncated": truncated})
    return out
