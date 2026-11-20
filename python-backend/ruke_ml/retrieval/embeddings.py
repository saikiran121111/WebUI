"""Embedding backends. The only backend that runs today is lexical, and it says so.

Vectors always carry EmbeddingMeta. A stored vector whose model/dimension/normalization
does not match the live one is rejected and rebuilt - never dot-producted over the
shorter dimension, which is how silent wrong rankings get produced.
"""
from __future__ import annotations

import hashlib
import math
from typing import Iterable

from ..contracts import EmbeddingMeta, ModelIdentity
from .chunking import tokenize

LEXICAL_DIM = 512

LEXICAL_META = EmbeddingMeta(model=ModelIdentity(id="ruke-lexical-hash", revision="builtin-v1",
                                                 provider="builtin"), dim=LEXICAL_DIM,
                            normalization="l2", pooling="hashed tf, no learned representation",
                            query_instruction="")

# Quality modes this process can actually run. Anything else is refused with the
# missing piece named, rather than being answered with the lexical baseline.
LEXICAL_MODES = ("lexical", "hash", "bm25-view")
NEURAL_MODES = ("neural", "model", "minilm", "onnx")


def lexical_embed(text: str, dim: int = LEXICAL_DIM) -> list[float]:
    vec = [0.0] * dim
    for tok in tokenize(text):
        # Built-in hash() is salted per process (PYTHONHASHSEED), so a vector
        # written by one run could never be matched, reused or cache-keyed by
        # the next. The token identity has to be a stable digest.
        h = int(hashlib.sha256(tok.encode("utf-8")).hexdigest()[:16], 16)
        vec[h % dim] += 1.0 + 0.25 * (len(tok) / 12.0)
    n = math.sqrt(sum(v * v for v in vec))
    return [v / n for v in vec] if n else vec


def embed_texts(texts: Iterable[str], quality_mode: str = "lexical") -> tuple[list[list[float]], EmbeddingMeta]:
    """Returns vectors plus the meta that describes what they ACTUALLY are.

    "neural" runs the pinned ONNX checkpoint (see nn_embed). It never silently answers a
    neural request with hashed term weights: if the checkpoint or the runtime is absent,
    the caller gets a typed failure naming the missing piece.
    """
    mode = (quality_mode or "lexical").strip().lower()
    if mode in LEXICAL_MODES:
        out = [lexical_embed(t) for t in texts]
        return out, LEXICAL_META
    if mode in NEURAL_MODES:
        from .nn_embed import neural_embed_texts
        vectors, meta, _info = neural_embed_texts(list(texts))
        return vectors, meta
    known = ", ".join(sorted(LEXICAL_MODES + NEURAL_MODES))
    raise ValueError(f"embedding backend {quality_mode!r} is not a mode this process runs "
                     f"(installed modes: {known})")
    out = [lexical_embed(t) for t in texts]
    return out, LEXICAL_META


def cosine(a: list[float], b: list[float], meta_a: EmbeddingMeta, meta_b: EmbeddingMeta) -> float:
    ok, why = meta_a.compatible_with(meta_b)
    if not ok:
        raise ValueError(f"incompatible embeddings: {why}")
    if len(a) != meta_a.dim or len(b) != meta_b.dim:
        raise ValueError(f"vector length {len(a)}/{len(b)} does not match declared dim {meta_a.dim}")
    return sum(x * y for x, y in zip(a, b))
