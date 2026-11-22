"""OpenDocument (ODS/ODT/ODP), EPUB and RTF readers, stdlib only.

Why a separate module: these three families share one law the OOXML reader never
faced — the FORMAT addresses content indirectly. ODS repeats rows/columns
(`table:number-rows-repeated="40"` is row 41, not row 2), EPUB orders chapters by
the spine (a filename sort inverts reading order), RTF hides text inside `\v`
groups (visible-only extraction is the whole point). Each reader keeps that
identity explicit in the block `loc` so a citation names the real address.

Repeat counts are expanded only up to MAX_REPEAT; a beyond-cap spacer row advances
the address without emitting blocks, and the cap is declared in meta.
"""
from __future__ import annotations

import html
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

from .structures import Block, DocCoverage, Document

_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
_DRAW = "{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}"
_PRES = "{urn:oasis:names:tc:opendocument:xmlns:presentation:1.0}"
_CONTAINER = "{urn:oasis:names:tc:opendocument:xmlns:container}"
_OPF = "http://www.idpf.org/2007/opf"
_DC = "http://purl.org/dc/elements/1.1/"

MAX_REPEAT = 1000
MAX_CELLS = 50_000


class OpendocRejected(Exception):
    pass


def _col_letter(col: int) -> str:
    """1-based column index -> A1 letters."""
    letters = ""
    while col > 0:
        col, rem = divmod(col - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def _a1(col: int, row: int) -> str:
    return f"{_col_letter(col)}{row}"


def _int_attr(el, name: str, default: int = 1) -> int:
    raw = el.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= 1 else default


def _text_of(el) -> str:
    """Text content of an element, honoring line breaks and tabs."""
    parts: list[str] = []
    for node in el.iter():
        if node.tag == f"{_TEXT}s":
            parts.append(" ")
        elif node.tag == f"{_TEXT}tab":
            parts.append("\t")
        elif node.tag == f"{_TEXT}line-break":
            parts.append("\n")
        elif node.tag == f"{_TEXT}c" and (node.text or "").strip():
            parts.append(node.text.strip())
        elif node.tag.endswith("}p") and node.text and parts:
            parts.append("\n")
        if node.text:
            parts.append(node.text)
        if node.tail:
            parts.append(node.tail)
    return "".join(parts)


def _para_text(p) -> str:
    """Direct-content text of a paragraph element (no descendant double-visits)."""
    out = [p.text or ""]
    for child in p:
        if child.tag == f"{_TEXT}s":
            out.append(" ")
        elif child.tag == f"{_TEXT}tab":
            out.append("\t")
        elif child.tag == f"{_TEXT}line-break":
            out.append("\n")
        elif child.tag == f"{_TEXT}c":
            out.append(child.text or "")
        out.extend(_para_text(child))
        out.append(child.tail or "")
    return "".join(out)


def _ods(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    root = ET.fromstring(zf.read("content.xml"))
    blocks: list[Block] = []
    sheets: list[str] = []
    truncated_sheets: list[str] = []
    cell_count = 0
    tables = [t for sheet in root.iter(f"{_OFFICE}spreadsheet") for t in sheet.findall(f"{_TABLE}table")]
    for si, table in enumerate(tables, start=1):
        name = str(table.get(f"{_TABLE}name") or f"sheet{si}")
        sheets.append(name)
        row = 0
        for tr in table.findall(f"{_TABLE}table-row"):
            row += _int_attr(tr, f"{_TABLE}number-rows-skipped", 0)
            repeat = _int_attr(tr, f"{_TABLE}number-rows-repeated", 1)
            if repeat > MAX_REPEAT:
                truncated_sheets.append(name)
            col = 0
            for tc in tr:
                if tc.tag not in (f"{_TABLE}table-cell", f"{_TABLE}covered-table-cell"):
                    continue
                col += _int_attr(tc, f"{_TABLE}number-columns-skipped", 0)
                crepeat = _int_attr(tc, f"{_TABLE}number-columns-repeated", 1)
                if crepeat > MAX_REPEAT:
                    truncated_sheets.append(name)
                    col += crepeat
                    continue
                value = tc.get(f"{_OFFICE}value")
                vtype = tc.get(f"{_OFFICE}value-type")
                formula = tc.get(f"{_TABLE}formula")
                strings = [_para_text(p) for p in tc.findall(f"{_TEXT}p")]
                shown = " ".join(s for s in strings if s.strip())
                for _ in range(crepeat):
                    col += 1
                    if cell_count >= MAX_CELLS:
                        break
                    if not (value or shown.strip()):
                        continue  # a blank repeat is a spacer, not content
                    ref = _a1(col, row + 1)
                    loc = {"sheet": name, "sheet_index": si, "cell": ref}
                    if vtype:
                        loc["value_type"] = vtype
                    if formula:
                        # Same law as the xlsx reader: formula TEXT and CACHED RESULT stay
                        # separate; the rendering carries "=<formula> (cached <value>)".
                        loc["formula"] = formula
                        loc["cached_value"] = value
                        text = f"={formula}" + (f" (cached {value})" if value else "")
                        blocks.append(Block(text, "formula", source_id, source_hash, loc))
                    else:
                        text = value if value and not shown.strip() else shown
                        blocks.append(Block(text, "cell", source_id, source_hash, loc))
                    cell_count += 1
            row += repeat
            if row > 2_000_000:
                break
    cov = DocCoverage(len(tables), len(tables), method="opendoc-spreadsheet",
                      note="sheet names, A1 addresses, cached values and formulas preserved")
    cov.units_succeeded = list(range(1, len(tables) + 1))
    meta: dict = {"sheets": sheets, "unit_numbering": "1-based sheet index",
                  "cells": cell_count}
    if truncated_sheets:
        meta["repeat_cap_note"] = (f"row/column repeat counts above {MAX_REPEAT} were advanced "
                                   f"without emitting blocks in: {', '.join(sorted(set(truncated_sheets)))}")
    return Document(source_id, source_hash, "ods", blocks, cov, meta)


def _notes_of(el) -> tuple[str, str]:
    """(citation, body) of a text:note element."""
    citation = ""
    body_parts: list[str] = []
    for node in el.iter(f"{_TEXT}note-citation"):
        citation = (node.text or "").strip()
    for note_body in el.iter(f"{_TEXT}note-body"):
        for p in note_body.findall(f"{_TEXT}p"):
            t = _para_text(p).strip()
            if t:
                body_parts.append(t)
    return citation, "\n".join(body_parts)


def _odt(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    root = ET.fromstring(zf.read("content.xml"))
    # The real hierarchy is document-content/office:body/office:text; a direct-child
    # find sees nothing in a genuine file and refuses a readable document.
    body = root.find(f"{_OFFICE}body/{_OFFICE}text")
    if body is None:
        body = root.find(f".//{_OFFICE}text")
    if body is None:
        raise OpendocRejected("content.xml has no office:text body")
    blocks: list[Block] = []
    notes_found = 0
    list_no = 0
    for el in body:
        if el.tag == f"{_TEXT}list":
            # "Close valve Delta." lives in a list-item paragraph; a reader that
            # only walks direct text:p/text:h children loses every bulleted
            # instruction in the document.
            list_no += 1
            for li_no, p in enumerate(el.iter(f"{_TEXT}p"), start=1):
                text = _para_text(p).strip()
                if text:
                    blocks.append(Block(text, "list_item", source_id, source_hash,
                                        {"paragraph": len(blocks) + 1,
                                         "list": list_no, "item": li_no}))
            continue
        if el.tag in (f"{_TEXT}p", f"{_TEXT}h"):
            text = _para_text(el).strip()
            # A note lives INSIDE its paragraph; the citation belongs to the paragraph
            # text, the body becomes its own citable block.
            for note in el.iter(f"{_TEXT}note"):
                citation, note_text = _notes_of(note)
                if note_text:
                    notes_found += 1
                    text = (text + f" [footnote {citation}]" if citation else text + " [footnote]")
            if text:
                outline = el.get(f"{_TEXT}outline-level")
                kind = "heading" if el.tag == f"{_TEXT}h" else "paragraph"
                loc: dict = {"paragraph": len(blocks) + 1}
                if kind == "heading":
                    loc["section"] = f"heading {outline}" if outline and outline.isdigit() else "heading"
                blocks.append(Block(text, kind, source_id, source_hash, loc))
            for note in el.iter(f"{_TEXT}note"):
                citation, note_text = _notes_of(note)
                if note_text:
                    blocks.append(Block(note_text, "note", source_id, source_hash,
                                        {"part": "footnote", "citation": citation,
                                         "paragraph": len(blocks)}))
    cov = DocCoverage(1, 1, method="opendoc-text",
                      note="headings keep outline level; footnote/annotation bodies are separate citable blocks")
    cov.units_succeeded = [1]
    return Document(source_id, source_hash, "odt", blocks, cov,
                    {"unit_numbering": "1-based block/paragraph index",
                     "footnotes": notes_found,
                     "not_extracted": ["table:table cell grid", "draw:frame text boxes"]})


def _odp(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    root = ET.fromstring(zf.read("content.xml"))
    blocks: list[Block] = []
    page_names: dict[str, str] = {}
    pages = [p for dr in root.iter(f"{_OFFICE}presentation") for p in dr.findall(f"{_DRAW}page")]
    for pi, page in enumerate(pages, start=1):
        name = str(page.get(f"{_DRAW}name") or f"page{pi}")
        page_names[str(pi)] = name
        emitted = False
        for frame in page.findall(f"{_DRAW}frame"):
            box = frame.find(f"{_DRAW}text-box")
            if box is None:
                continue
            text = "\n".join(t for p in box.findall(f"{_TEXT}p") if (t := _para_text(p).strip()))
            if text.strip():
                emitted = True
                blocks.append(Block(text.strip(), "paragraph", source_id, source_hash,
                                    {"page": pi, "page_name": name}))
        notes = page.find(f"{_PRES}notes")
        if notes is not None:
            text = "\n".join(t for p in notes.iter(f"{_TEXT}p") if (t := _para_text(p).strip()))
            if text.strip():
                emitted = True
                # Presenter notes are a SEPARATE kind: the "Instructor only" gate facts
                # must never blend into the slide body a viewer can see.
                blocks.append(Block(text.strip(), "note", source_id, source_hash,
                                    {"page": pi, "page_name": name, "part": "presenter-notes"}))
    empty = [pi for pi in range(1, len(pages) + 1) if not any(b.loc.get("page") == pi for b in blocks)]
    cov = DocCoverage(len(pages), len(pages) - len(empty), units_empty=empty,
                      method="opendoc-presentation",
                      note="page order, page names and presenter notes kept distinct from slide text")
    cov.units_succeeded = [pi for pi in range(1, len(pages) + 1) if pi not in set(empty)]
    return Document(source_id, source_hash, "odp", blocks, cov,
                    {"unit_numbering": "1-based draw:page order (presentation order)",
                     "pages": len(pages), "page_names": page_names})


def _html_to_text(raw: bytes) -> str:
    text = raw.decode("utf-8", "replace")
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<(br|/p|/div|/h[1-6]|/li|/title|/tr)[^>]*>", "\n", text)
    text = re.sub(r"(?s)<[^>]*>", "", text)
    text = html.unescape(text)
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n")]
    return "\n".join(ln for ln in lines if ln)


def _epub(zf: zipfile.ZipFile, source_id: str, source_hash: str) -> Document:
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(f".//{_CONTAINER}rootfile")
    if rootfile is None:
        raise OpendocRejected("container.xml declares no rootfile (the OPF package is unnamed)")
    opf_path = (rootfile.get("full-path") or "").lstrip("/")
    opf = ET.fromstring(zf.read(opf_path))
    base = posixpath.dirname(opf_path)
    manifest: dict[str, tuple[str, str]] = {}
    for item in opf.iter(f"{{{_OPF}}}item"):
        href = (item.get("href") or "").split("#")[0]
        if item.get("id") and href:
            resolved = posixpath.normpath(posixpath.join(base, href)) if base else posixpath.normpath(href)
            manifest[item.get("id")] = (resolved.replace("\\", "/"), item.get("media-type") or "")
    title = ""
    for t in opf.iter(f"{{{_DC}}}title"):
        title = (t.text or "").strip()
        if title:
            break
    spine = [(ir.get("idref") or "", ir.get("linear") != "no") for ir in opf.iter(f"{{{_OPF}}}itemref")]
    blocks: list[Block] = []
    failed: list[int] = []
    chapters: dict[str, str] = {}
    for ui, (idref, linear) in enumerate(spine, start=1):
        href, media = manifest.get(idref, ("", ""))
        if not href:
            failed.append(ui)
            continue
        try:
            raw = zf.read(href)
        except KeyError:
            failed.append(ui)
            continue
        text = _html_to_text(raw)
        chapters[str(ui)] = href
        if not text.strip():
            continue
        for para in text.split("\n"):
            blocks.append(Block(para, "paragraph", source_id, source_hash,
                                {"unit": ui, "spine_id": idref, "part": href,
                                 **({} if linear else {"nonlinear": True})}))
    cov = DocCoverage(len(spine), len(spine) - len(failed), units_failed=failed,
                      method="epub-spine",
                      note="reading order is the OPF spine, not filename order")
    cov.units_succeeded = [ui for ui in range(1, len(spine) + 1) if ui not in set(failed)]
    return Document(source_id, source_hash, "epub", blocks, cov,
                    {"unit_numbering": "1-based spine (reading) ordinal",
                     "package": opf_path, "title": title, "chapters": chapters,
                     "not_extracted": ["inline images", "CSS layout", "NCX page targets"]})


_RTF_DEST_SKIP = frozenset({
    "stylesheet", "info", "generator", "fonttbl", "colortbl", "styles", "listtable",
    "listoverridetable", "pict", "shppict", "nonshppict", "header", "footer",
    "headerl", "headerr", "footerl", "footerr", "xmlopen", "xmlnoview", "themedata",
    "datastore", "latentstyles", "colorscheme",
})


def _rtf(src: bytes, source_id: str, source_hash: str) -> Document:
    """Visible-text RTF decoder. Hidden (\\v) text is EXCLUDED, by design.

    `\\v` is not decoration: an RTF can carry author-only content (the fixture's
    "PRIVATE ALTERNATE" group). A reader that prints it leaks text the document
    formats as not-visible; a reader that drops it silently lies about coverage.
    This decoder excludes the group AND reports the count.
    """
    data = src.decode("latin-1")
    out: list[str] = []
    groups: list[dict] = [{"skip": False, "hidden": False}]
    uc_skip = 1
    hidden_groups = 0
    i, n = 0, len(data)
    while i < n:
        ch = data[i]
        if ch == "{":
            parent = groups[-1]
            groups.append({"skip": parent["skip"], "hidden": parent["hidden"]})
            i += 1
        elif ch == "}":
            if len(groups) > 1:
                groups.pop()
            i += 1
        elif ch in "\r\n":
            if not groups[-1]["skip"] and not groups[-1]["hidden"]:
                out.append("\n")
            i += 1
        elif ch == "\\":
            nxt = data[i + 1] if i + 1 < n else ""
            if nxt in "{}\\":
                if not groups[-1]["skip"] and not groups[-1]["hidden"]:
                    out.append(nxt)
                i += 2
                continue
            j = i + 1
            star = j < n and data[j] == "*"
            if star:
                j += 1
            word = ""
            while j < n and data[j].isalpha():
                word += data[j]
                j += 1
            if not word:
                i += 2 if j == i + 1 else 1
                continue
            num: int | None = None
            if j < n and (data[j].isdigit() or data[j] == "-"):
                sign = -1 if data[j] == "-" else 1
                if data[j] == "-":
                    j += 1  # only the minus sign is consumed; a leading digit belongs to the number
                digits = ""
                while j < n and data[j].isdigit():
                    digits += data[j]
                    j += 1
                num = sign * int(digits) if digits else None
            if j < n and data[j] == " ":
                j += 1
            grp = groups[-1]
            if star:
                grp["skip"] = True
            if word in _RTF_DEST_SKIP:
                grp["skip"] = True
            if word == "uc" and num is not None:
                uc_skip = max(0, num)
            if word == "v":
                if not grp["hidden"]:
                    grp["hidden"] = True
                    hidden_groups += 1
            if not grp["skip"]:
                if word in ("par", "sect", "line", "row", "cell"):
                    if not grp["hidden"]:
                        out.append("\n")
                elif word == "tab" and not grp["hidden"]:
                    out.append("\t")
                elif word == "u" and num is not None and not grp["hidden"]:
                    out.append(chr(num & 0xFFFF))
                    i = j + uc_skip  # the unicode escape is followed by uc_skip ANSI chars
                    continue
                elif word == "'" and j + 1 < n:
                    hexbyte = data[j:j + 2]
                    if all(c in "0123456789abcdefABCDEF" for c in hexbyte):
                        if not grp["hidden"]:
                            out.append(bytes([int(hexbyte, 16)]).decode("cp1252", "replace"))
                        j += 2
            i = j
        else:
            if not groups[-1]["skip"] and not groups[-1]["hidden"]:
                out.append(ch)
            i += 1
    text = "".join(out).replace("\r\n", "\n")
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    if not paragraphs:
        raise OpendocRejected("RTF contains no visible text (all content is control words, "
                              "destinations or hidden groups)")
    blocks = [Block(p, "paragraph", source_id, source_hash, {"paragraph": pi})
              for pi, p in enumerate(paragraphs, start=1)]
    cov = DocCoverage(1, 1, method="rtf-visible",
                      note=f"visible text only; {hidden_groups} hidden (\\v) group(s) excluded by design")
    cov.units_succeeded = [1]
    return Document(source_id, source_hash, "rtf", blocks, cov,
                    {"unit_numbering": "1-based paragraph index",
                     "hidden_groups_excluded": hidden_groups})


def rtf_document(src: bytes, source_id: str, source_hash: str) -> Document:
    """Public entry for the RTF reader; RTF is not zip-backed, so it is not on
    load_opendoc's dispatcher."""
    return _rtf(src, source_id, source_hash)


def load_opendoc(zf: zipfile.ZipFile, suffix: str, source_id: str, source_hash: str) -> Document:
    """Zip-backed OpenDocument/EPUB routing; raises OpendocRejected when the
    package claims the format but carries none of its required parts."""
    if suffix == ".ods":
        return _ods(zf, source_id, source_hash)
    if suffix == ".odt":
        return _odt(zf, source_id, source_hash)
    if suffix == ".odp":
        return _odp(zf, source_id, source_hash)
    return _epub(zf, source_id, source_hash)
