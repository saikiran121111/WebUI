"""Lexical reranking baseline plus the slot a neural reranker occupies later.

A reranker only reorders candidates it was given: it cannot recover evidence that was
already dropped, so candidate recall is measured before this stage, not after.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from .chunking import Chunk, tokenize

# The name the worker publishes for joint cross-encoder scoring. Importing the module here is
# cheap: nn_rerank pulls no heavy dependency at import time (onnxruntime is imported at load),
# so the lexical path never pays for it.
from .nn_rerank import MODE_NAME as CROSS_ENCODER_MODE


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
    mode = (mode or "lexical").strip().lower()
    if mode in ("lexical", "bm25"):
        return bm25(query, chunks), "lexical"
    if mode in ("neural", "biencoder", "neural_biencoder"):
        # A dense bi-encoder: query and candidate are embedded independently and scored by
        # cosine. That IS a neural ranker, and it is ALSO not a cross-encoder - it never
        # sees query and candidate jointly, so it cannot do the fine-grained interaction a
        # cross-encoder does. Both facts go in the returned mode name; the worker publishes
        # it, so the UI can never show "reranked" while hiding which ranker ran.
        return _dense_score(query, chunks), "neural_biencoder_minilm"
    if mode in ("cross_encoder", "cross-encoder", "neural_cross_encoder",
                "cross_encoder_minilm", "neural_cross_encoder_minilm"):
        # The pinned cross-encoder asset (see retrieval/nn_rerank.py): one forward pass over
        # (query, passage) jointly, which is the thing the bi-encoder above cannot do. It
        # raises instead of quietly degrading to a bi-encoder when the asset is absent.
        return _cross_encode(query, chunks), CROSS_ENCODER_MODE
    known = "lexical, neural (dense bi-encoder), neural_cross_encoder (pinned cross-encoder)"
    raise ValueError(f"reranker {mode!r} is not a mode this process runs (installed modes: {known}; "
                     "any other ranker would need its own pinned asset, adapter and protocol, "
                     "and none is registered)")


def cross_encoder_ready(root=None) -> tuple[bool, str]:
    """Is the PINNED cross-encoder asset actually here? Never loads the model."""
    from .nn_rerank import cross_encoder_available
    return cross_encoder_available(root)


def _cross_encode(query: str, chunks: Sequence[Chunk]) -> list[Scored]:
    """Joint query/passage scoring by the pinned cross-encoder. Raises if it cannot run."""
    from .nn_rerank import cross_encoder_scores
    scores, _info = cross_encoder_scores(query, [c.text for c in chunks])
    return sorted((Scored(chunk=c, score=s) for c, s in zip(chunks, scores)),
                  key=lambda x: -x.score)


def _dense_score(query: str, chunks: Sequence[Chunk]) -> list[Scored]:
    """Cosine over normalized MiniLM vectors. Raises if the checkpoint cannot run."""
    from .nn_embed import neural_embed_texts
    texts = [query] + [c.text for c in chunks]
    vectors, _meta, _info = neural_embed_texts(texts)
    q, docs = vectors[0], vectors[1:]
    scored = [Scored(chunk=c, score=max(-1.0, min(1.0, sum(a * b for a, b in zip(q, d)))))
              for c, d in zip(chunks, docs)]
    return sorted(scored, key=lambda x: -x.score)
