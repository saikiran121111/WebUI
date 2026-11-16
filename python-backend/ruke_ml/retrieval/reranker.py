"""Lexical reranking baseline plus the slot a neural reranker occupies later.

A reranker only reorders candidates it was given: it cannot recover evidence that was
already dropped, so candidate recall is measured before this stage, not after.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from .chunking import Chunk, tokenize


@dataclass(slots=True)
class Scored:
    chunk: Chunk
    score: float


def bm25(query: str, chunks: Sequence[Chunk], k1: float = 1.5, b: float = 0.75) -> list[Scored]:
    q = tokenize(query)
    if not q or not chunks:
        return []
    docs = [tokenize(c.text) for c in chunks]
    avg = sum(len(d) for d in docs) / len(docs)
    df: dict[str, int] = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    out = []
    for c, d in zip(chunks, docs):
        tf: dict[str, int] = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        s = 0.0
        for t in q:
            n = df.get(t, 0)
            if not n:
                continue
            idf = math.log(1 + (len(docs) - n + 0.5) / (n + 0.5))
            s += idf * (tf.get(t, 0) * (k1 + 1)) / (tf.get(t, 0) + k1 * (1 - b + b * len(d) / avg))
        out.append(Scored(chunk=c, score=s))
    return sorted(out, key=lambda x: -x.score)


def rerank(query: str, chunks: Sequence[Chunk], mode: str = "lexical") -> tuple[list[Scored], str]:
    """Returns scores AND the mode actually used, so callers can report real quality."""
    if mode != "lexical":
        raise ValueError(f"reranker {mode!r} is not installed (evaluation_required)")
    return bm25(query, chunks), mode
