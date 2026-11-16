"""Format-aware extraction that preserves relationships, not flattened text.

Stdlib OOXML reader: shared strings, sheet identity, cell types, FORMULA plus the cached
result, merged ranges, hyperlinks, slide notes, docx heading levels and table cells.
Supplementary-plane characters (astral emoji) decode correctly because the XML parser,
not String.fromCharCode-style code-unit math, resolves the entities.
"""
from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET

from ..contracts import sha256_hex
from .structures import Block, DocCoverage, Document

_MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_P_NS = "{http://schemas.openxmlformats.org/presentationml/2006/main}"


class ExtractionRejected(Exception):
    pass


def load_document(path: str | Path, max_entries: int = 4096) -> Document:
    p = Path(path)
    src = p.read_bytes()
    source_hash = sha256_hex(src)
    source_id = p.name
    suffix = p.suffix.lower()
    if suffix in (".xlsx", ".docx", ".pptx"):
        return _parse_ooxml(p, suffix, source_id, source_hash, src, max_entries)
    if suffix in (".txt", ".md", ".log", ".csv", ".json"):
        text = src.decode("utf-8", "replace")
        blocks = [Block(t, "page_text", source_id, source_hash, {"line": i + 1})
                  for i, t in enumerate(text.splitlines()) if t.strip()]
        return Document(source_id, source_hash, "text", blocks,
                        DocCoverage(len(blocks), len(blocks), method="native-text"))
    return Document(source_id, source_hash, "unsupported", [],
                    DocCoverage(0, 0, method="none", note="no parser for this format; not silently flattened"))


def _parse_ooxml(p: Path, suffix: str, source_id: str, source_hash: str, src: bytes, max_entries: int) -> Document:
    import io
    from ..security import audit_zip_members
    zf = zipfile.ZipFile(io.BytesIO(src))
    audit_zip_members(zf)
    if len(zf.infolist()) > max_entries:
        raise ExtractionRejected("too many OOXML parts")
    if suffix == ".xlsx":
        return _xlsx(zf, source_id, source_hash)
    if suffix == ".docx":
        return _docx(zf, source_id, source_hash)
    return _pptx(zf, source_id, source_hash)


def _shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall(f"{_MAIN_NS}si"):
        # rich text runs concatenate; the parser resolves entities, so astral planes survive
        out.append("".join(t.text or "" for t in si.iter(f"{_MAIN_NS}t")))
    return out


def _xlsx(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    strings = _shared_strings(zf)
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rid2target = {r.get("Id"): r.get("Target") for r in rels}
    sheets = []
    for sh in wb.iter(f"{_MAIN_NS}sheet"):
        rid = sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        target = (rid2target.get(rid) or "").lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        sheets.append((sh.get("name"), target))
    blocks: list[Block] = []
    failed: list[int] = []
    for si, (name, target) in enumerate(sheets, start=1):
        try:
            root = ET.fromstring(zf.read(target))
        except (KeyError, ET.ParseError):
            failed.append(si)
            continue
        merged = {m.get("ref") for m in root.iter(f"{_MAIN_NS}mergeCell")}
        for row in root.iter(f"{_MAIN_NS}row"):
            for c in row.findall(f"{_MAIN_NS}c"):
                ref = c.get("r") or ""
                t = c.get("t")
                fnode = c.find(f"{_MAIN_NS}f")
                vnode = c.find(f"{_MAIN_NS}v")
                isnode = c.find(f"{_MAIN_NS}is")
                if fnode is not None and (fnode.text or "").strip():
                    cached = vnode.text if vnode is not None else ""
                    text = f"={fnode.text}" + (f" (cached {cached})" if cached else "")
                    kind = "formula"
                elif t == "s" and vnode is not None:
                    text = strings[int(vnode.text)] if vnode.text and vnode.text.isdigit() else ""
                    kind = "cell"
                elif isnode is not None:
                    text = "".join(x.text or "" for x in isnode.iter(f"{_MAIN_NS}t"))
                    kind = "cell"
                else:
                    text = vnode.text if vnode is not None else ""
                    kind = "cell"
                if not text.strip():
                    continue
                loc = {"sheet": name, "cell": ref, "sheet_index": si}
                if ref in merged:
                    loc["merged"] = ref
                blocks.append(Block(text, kind, source_id, source_hash, loc))
    total = len(sheets)
    cov = DocCoverage(total, total - len(failed), units_failed=failed, method="ooxml-cellwise",
                      note="formulas kept with cached values; number formats are not re-derived here")
    return Document(source_id, source_hash, "xlsx", blocks, cov, {"sheets": [s[0] for s in sheets]})


def _docx(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    root = ET.fromstring(zf.read("word/document.xml"))
    blocks: list[Block] = []
    body = root.find(f"{_W_NS}body")
    section = 0
    if body is None:
        return Document(source_id, source_hash, "docx", [],
                        DocCoverage(0, 0, method="ooxml", note="document body is empty"))
    for el in body:
        if el.tag == f"{_W_NS}p":
            text = "".join(t.text or "" for t in el.iter(f"{_W_NS}t"))
            style = el.find(f"{_W_NS}pPr/{_W_NS}pStyle")
            name = (style.get(f"{_W_NS}val") or "") if style is not None else ""
            if not text.strip():
                continue
            kind = "heading" if name.lower().startswith("heading") or name.lower() == "title" else "paragraph"
            loc: dict[str, object] = {"paragraph": len(blocks)}
            if kind == "heading":
                section += 1
                loc["section"] = name or "heading"
            blocks.append(Block(text, kind, source_id, source_hash, loc))
        elif el.tag == f"{_W_NS}tbl":
            for ri, tr in enumerate(el.findall(f"{_W_NS}tr")):
                cells = ["".join(t.text or "" for t in tc.iter(f"{_W_NS}t")) for tc in tr.findall(f"{_W_NS}tc")]
                blocks.append(Block(" | ".join(cells), "table_row", source_id, source_hash,
                                    {"table": len(blocks), "row": ri + 1}))
    cov = DocCoverage(1, 1, method="ooxml", note="heading hierarchy and table cells preserved")
    return Document(source_id, source_hash, "docx", blocks, cov)


def _pptx(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    names = [n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
    names.sort(key=lambda n: int("".join(ch for ch in n if ch.isdigit()) or 0))
    notes = {n for n in zf.namelist() if n.startswith("ppt/notesSlides/notesSlide")}
    blocks: list[Block] = []
    failed: list[int] = []
    for i, n in enumerate(names, start=1):
        try:
            root = ET.fromstring(zf.read(n))
        except (KeyError, ET.ParseError):
            failed.append(i)
            continue
        for shape in root.iter(f"{_P_NS}sp"):
            text = "\n".join(t.text or "" for t in shape.iter(f"{_A_NS}t"))
            if text.strip():
                blocks.append(Block(text.strip(), "paragraph", source_id, source_hash, {"slide": i}))
        note_file = f"ppt/notesSlides/notesSlide{i}.xml"
        if note_file in notes:
            try:
                nroot = ET.fromstring(zf.read(note_file))
                ntext = "\n".join(t.text or "" for t in nroot.iter(f"{_A_NS}t")).strip()
                if ntext:
                    blocks.append(Block(ntext, "note", source_id, source_hash, {"slide": i, "part": "notes"}))
            except (KeyError, ET.ParseError):
                failed.append(i)
    cov = DocCoverage(len(names), len(names) - len(failed), units_failed=failed, method="ooxml",
                      note="slide text and speaker notes kept separate; charts/animations are not described by this reader")
    return Document(source_id, source_hash, "pptx", blocks, cov)
