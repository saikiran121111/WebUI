"""Structural chunking with stable ids, and an ATOMIC generation publish.

A generation is written into a staging directory and only then pointed at by a manifest
that is renamed into place (os.replace). A reader never sees half a corpus, and a crash
leaves the previous generation intact. Per-file replacement is not a transaction; this is.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from ..config import LIMITS
from ..contracts import EmbeddingMeta, ModelIdentity, canon_json, sha256_hex
from ..documents.structures import Block

# Token grammar (see _tokens_re): ASCII identifiers and numbers keep their
# symbols verbatim (C++, C#, 1.83, svchost.exe, an invoice number); every
# other run is letters plus the combining marks clinging to them, and a
# mixed accented Latin word stays ONE token instead of being cut in half.
# The mark part is not decoration: Python's \w does NOT match combining marks
# (their isalnum() is False), so a plain "[^\W\d_]+" run shreds a Devanagari or
# Telugu word at every matra and a vowelled Arabic word at every haraka.
# Fragmented words match nothing useful, and they also invent fake
# "discriminating terms" out of single letters, which is exactly how a corpus
# that contains no answer at all can still look like it has one.
_MARK_CACHE: dict[str, object] = {}


def _mark_class() -> str:
    """Character class of every Unicode combining mark (categories Mn/Mc/Me).

    Derived from the general category instead of a hand-written script list, so
    no writing system is forgotten and none is special-cased. Computed once and
    memoized.
    """
    cached = _MARK_CACHE.get("cls")
    if isinstance(cached, str):
        return cached
    ranges: list[tuple[int, int]] = []
    start: int | None = None
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        is_mark = unicodedata.category(chr(cp))[0] == "M"
        if is_mark and start is None:
            start = cp
        elif not is_mark and start is not None:
            ranges.append((start, cp - 1))
            start = None
    if start is not None:
        ranges.append((start, 0x10FFFF))
    parts = [chr(lo) if lo == hi else f"{chr(lo)}-{chr(hi)}" for lo, hi in ranges]
    cls = "[" + "".join(parts) + "]"
    _MARK_CACHE["cls"] = cls
    return cls


def _tokens_re() -> re.Pattern[str]:
    """Letter runs keep their marks; ASCII identifiers keep their symbols."""
    cached = _MARK_CACHE.get("re")
    if isinstance(cached, re.Pattern):
        return cached
    letter, mark = r"[^\W\d_]", _mark_class()
    rx = re.compile(
        r"[A-Za-z][A-Za-z0-9+#._-]*(?![^\W\d_])"
        r"|\d+(?:[.,]\d+)?(?!\w)"
        rf"|(?:{letter}|{mark})(?:{letter}|{mark}|\d)*"
    )
    _MARK_CACHE["re"] = rx
    return rx

# Script ranges that decide HOW a run becomes searchable. Deliberately generic:
# these are writing-system properties, never per-example word lists.
_BIGRAM_RANGES = (
    (0x3041, 0x309F), (0x30A0, 0x30FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF), (0x2F800, 0x2FA1F),                       # Han, kana
    (0x0E00, 0x0E7F), (0x0E80, 0x0EFF), (0x1000, 0x109F), (0x1780, 0x17FF),
    (0x19E0, 0x19FF),                                          # Thai, Lao, Myanmar, Khmer
)
# Writing systems whose optional marks readers routinely omit when searching:
# Arabic harakat, Hebrew niqqud, and Latin/Vietnamese accents and tone marks.
# Indic matras are deliberately NOT here - in Devanagari or Telugu a matra is
# part of the word's identity, so folding it would merge distinct words.
_DIACRITIC_OPTIONAL_RANGES = (
    (0x0591, 0x05FF), (0x0600, 0x06FF), (0x0750, 0x077F), (0x0870, 0x08FF),
    (0x5900, 0x5FFF), (0xFB1D, 0xFB4F), (0xFB50,0xFDFF), (0xFE70, 0xFEFF),
    (0x00C0, 0x024F), (0x1E00, 0x1EFF),                       # Latin-1 Supp, Ext-A/B, Ext Additional
)
_MAX_RUN = 200       # bounded: a 5 MB line does not become a 5 MB token


def _in_ranges(cp: int, ranges) -> bool:
    return any(lo <= cp <= hi for lo, hi in ranges)


def strip_marks(text: str) -> str:
    """Drop combining marks after decomposition. The base letters, and therefore
    the word identity, survive; a run with no marks is returned unchanged."""
    decomposed = unicodedata.normalize("NFD", text)
    out = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", out)


def _emit(run: str, out: list[str]) -> None:
    """One run of letters -> the tokens that can match a query.

    Bigram expansion is a segmentation-free fallback for scripts written without
    spaces (Han/kana/Thai/Lao/Myanmar/Khmer); it is not a claim of word analysis.
    Mark-folding makes a vowelled Arabic or niqqud Hebrew query match the same
    document without the vowels, which is how readers actually type.
    Space-separated scripts (Indic, Greek, Cyrillic, Arabic-in-Latin, Thai words
    typed with spaces, Vietnamese, Korean) keep whole-word identity."""
    # Classified by the first NON-ASCII letter: "école" starts with an ASCII 'e'
    # yet still needs the accent rule, while a pure-ASCII run never gets here.
    # Classified by the first non-ASCII LETTER, never by a clinging mark (a mark
    # says nothing about the writing system) and never by an ASCII letter, which
    # would send an accented word down the plain-word path.
    cp = next((ord(c) for c in run if not c.isascii()
               and unicodedata.category(c)[0] == "L"), 0)
    if _in_ranges(cp, _BIGRAM_RANGES):
        if len(run) == 1:
            out.append(run)
            return
        for i in range(len(run) - 1):
            out.append(run[i:i + 2])
        return
    if _in_ranges(cp, _DIACRITIC_OPTIONAL_RANGES):
        # Both forms are indexed: the exact word (so an accented query keeps its
        # precision) and the mark-free form (so "maintenimiento" and "cafedera"
        # style searches reach text typed with or without the marks).
        exact = run.lower()
        out.append(exact)
        folded = strip_marks(run).lower()
        if folded and folded != exact:
            out.append(folded)
        return
    out.append(run.lower())


def tokenize(text: str) -> list[str]:
    """Symbol-preserving: C++, C#, versions and identifiers survive. No substring folding:
    collapsing 'C++' to 'c' is what let C-language evidence answer a C++ question.
    Scripts are matched by writing system, so a spaceless or vowelled script is
    still searchable instead of one giant unmatchable token."""
    out: list[str] = []
    for t in _tokens_re().findall(unicodedata.normalize("NFC", text))[:4000]:
        if len(t) > _MAX_RUN:
            t = t[:_MAX_RUN]
        if t.isascii():
            out.append(t if (any(c in t for c in "+#._-") and any(c.isupper() for c in t))
                       else t.lower())
            continue
        _emit(t, out)
    return out


@dataclass(slots=True)
class Chunk:
    chunk_id: str
    text: str
    source_id: str
    source_hash: str
    loc: dict[str, Any] = field(default_factory=dict)
    block_ids: list[str] = field(default_factory=list)
    tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"chunk_id": self.chunk_id, "text": self.text, "source_id": self.source_id,
                "source_hash": self.source_hash, "loc": self.loc, "block_ids": self.block_ids, "tokens": self.tokens}


def chunk_blocks(blocks: Iterable[Block], max_tokens: int = 380, overlap_tokens: int = 40) -> list[Chunk]:
    """Never split a table cell, formula or code block across chunks: block boundaries win.

    A chunk also never spans two sources. Provenance, recovery and citation all
    address a chunk through its source, so a chunk carrying blocks from two files
    would attribute one document's text to the other - and would silently merge a
    whole corpus into one chunk when max_tokens is large."""
    chunks: list[Chunk] = []
    cur: list[Block] = []
    count = 0
    for b in blocks:
        n = len(tokenize(b.text))
        same_source = bool(cur) and (b.source_id == cur[-1].source_id
                                     and b.source_hash == cur[-1].source_hash)
        if cur and (not same_source or count + n > max_tokens
                    or b.loc.get("page") != cur[-1].loc.get("page")):
            chunks.append(_flush(cur))
            carry = cur[-1:] if (overlap_tokens and same_source and n < overlap_tokens * 4) else []
            cur, count = list(carry), sum(len(tokenize(x.text)) for x in carry)
        cur.append(b)
        count += n
        if n >= max_tokens:            # an oversized single block becomes its own chunk
            chunks.append(_flush(cur))
            cur, count = [], 0
    if cur:
        chunks.append(_flush(cur))
    return chunks


def _flush(cur: list[Block]) -> Chunk:
    text = "\n".join(b.text for b in cur)
    source_id = cur[0].source_id
    source_hash = cur[0].source_hash
    ids = [b.block_id for b in cur]
    cid = sha256_hex(f"{source_hash}|{','.join(ids)}|{text}")[:16]
    loc = dict(cur[0].loc)
    loc["block_range"] = [ids[0], ids[-1]]
    return Chunk(chunk_id=cid, text=text, source_id=source_id, source_hash=source_hash,
                 loc=loc, block_ids=ids, tokens=len(tokenize(text)))


def publish_generation(index_dir: Path, chunks: list[Chunk], vectors: list[list[float]] | None,
                       meta: EmbeddingMeta, pipeline: str) -> dict[str, Any]:
    """Write-then-switch. Returns the published manifest."""
    index_dir = Path(index_dir)
    index_dir.mkdir(parents=True, exist_ok=True)
    # Two publishes inside the same millisecond must not collide (same pid, same clock tick).
    gen = f"gen-{int(time.time() * 1000)}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    stage = index_dir / (gen + ".staging")
    final = index_dir / gen
    stage.mkdir(parents=True, exist_ok=False)
    with (stage / "chunks.jsonl").open("w", encoding="utf-8") as fh:
        for c in chunks:
            fh.write(canon_json(c.to_dict()) + "\n")
    vectors_path = None
    if vectors is not None:
        if len(vectors) != len(chunks):
            raise ValueError("vector count must equal chunk count before publication")
        dim = {len(v) for v in vectors}
        if len(dim) != 1:
            raise ValueError(f"ragged vector dimensions: {sorted(dim)}")
        if dim and next(iter(dim)) != meta.dim:
            raise ValueError(f"vector dim {next(iter(dim))} != declared meta dim {meta.dim}")
        with (stage / "vectors.jsonl").open("w", encoding="utf-8") as fh:
            for v in vectors:
                fh.write(json.dumps(v) + "\n")
        vectors_path = "vectors.jsonl"
    manifest = {"generation": gen, "schema_version": 1, "chunk_count": len(chunks),
                "vectors": vectors_path, "embedding": meta.to_dict(), "pipeline": pipeline,
                "fingerprint": sha256_hex(canon_json({"meta": meta.to_dict(), "pipeline": pipeline,
                                                      "chunks": [c.chunk_id for c in chunks]}))}
    (stage / "manifest.json").write_text(canon_json(manifest), encoding="utf-8")
    os.replace(stage, final)                                  # atomic directory switch
    (index_dir / "CURRENT.json").write_text(
        canon_json({"generation": gen, "path": gen, "published_at": time.time()}), encoding="utf-8")
    return manifest


def load_current(index_dir: Path) -> tuple[dict[str, Any], list[Chunk], list[list[float]] | None]:
    index_dir = Path(index_dir)
    cur = json.loads((index_dir / "CURRENT.json").read_text(encoding="utf-8"))
    gdir = index_dir / cur["path"]
    manifest = json.loads((gdir / "manifest.json").read_text(encoding="utf-8"))
    chunks = [json.loads(l) for l in (gdir / "chunks.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    vectors = None
    if manifest.get("vectors"):
        vectors = [json.loads(l) for l in (gdir / manifest["vectors"]).read_text(encoding="utf-8").splitlines() if l.strip()]
    return manifest, chunks, vectors


def garbage_collect(index_dir: Path, keep: int = 2) -> list[str]:
    """Bounded disk use: keep the newest N generations, never the live one."""
    index_dir = Path(index_dir)
    if not index_dir.exists():
        return []
    cur = None
    try:
        cur = json.loads((index_dir / "CURRENT.json").read_text(encoding="utf-8"))["path"]
    except (OSError, ValueError, KeyError):
        pass
    gens = sorted([p.name for p in index_dir.iterdir() if p.is_dir() and p.name.startswith("gen-")])
    stale = [g for g in gens if g != cur][: max(0, len(gens) - keep)]
    for g in stale:
        import shutil
        shutil.rmtree(index_dir / g, ignore_errors=True)
    staged = [p.name for p in index_dir.iterdir() if p.name.endswith(".staging")]
    for s in staged:
        import shutil
        shutil.rmtree(index_dir / s, ignore_errors=True)
    return stale
