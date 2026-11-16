"""Canonical rich structures. Text/Markdown views are DERIVED from them, never the reverse.

Every block keeps a stable identity and an addressable source location, so a later
question can recover the exact page/cell/slide instead of re-uploading the file.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..contracts import sha256_hex

BLOCK_KINDS = ("heading", "paragraph", "list_item", "table_row", "cell", "formula",
               "note", "image", "caption", "code", "page_text", "ocr_text")


@dataclass(slots=True)
class Block:
    text: str
    kind: str
    source_id: str
    source_hash: str
    loc: dict[str, Any] = field(default_factory=dict)   # page/slide/sheet/cell/section/bbox
    confidence: float | None = None                     # only if the provider genuinely reports it

    def __post_init__(self) -> None:
        if self.kind not in BLOCK_KINDS:
            raise ValueError(f"unknown block kind {self.kind!r}")

    @property
    def block_id(self) -> str:
        return sha256_hex(f"{self.source_hash}|{self.kind}|{sorted(self.loc.items())}|{self.text}")[:16]

    def to_dict(self) -> dict[str, Any]:
        return {"block_id": self.block_id, "text": self.text, "kind": self.kind,
                "source_id": self.source_id, "source_hash": self.source_hash, "loc": self.loc,
                "confidence": self.confidence}


@dataclass(slots=True)
class DocCoverage:
    """Per-page/unit honesty. Non-empty text is not proof a page was understood."""
    units_total: int = 0
    units_extracted: int = 0
    units_empty: list[int] = field(default_factory=list)
    units_needing_ocr: list[int] = field(default_factory=list)
    units_failed: list[int] = field(default_factory=list)
    method: str = ""
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"units_total": self.units_total, "units_extracted": self.units_extracted,
                "units_empty": self.units_empty, "units_needing_ocr": self.units_needing_ocr,
                "units_failed": self.units_failed, "method": self.method, "note": self.note}

    @property
    def complete(self) -> bool:
        return (self.units_total > 0 and self.units_extracted == self.units_total
                and not self.units_needing_ocr and not self.units_failed)


@dataclass(slots=True)
class Document:
    source_id: str
    source_hash: str
    kind: str
    blocks: list[Block] = field(default_factory=list)
    coverage: DocCoverage = field(default_factory=DocCoverage)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"source_id": self.source_id, "source_hash": self.source_hash, "kind": self.kind,
                "coverage": self.coverage.to_dict(), "meta": self.meta,
                "blocks": [b.to_dict() for b in self.blocks]}

    def as_text(self) -> str:
        return "\n".join(b.text for b in self.blocks)
