"""Measured method comparison on the SAME frozen cases, without touching the floor.

    python -m ruke_ml.eval --vectors vectors.json

The frozen suite's pass/fail floors stay attached to the method that ships today
(the lexical baseline). This module adds MEASURED rows for other methods over the
identical cases so a migration decision is evidence-based instead of a model card:

  * ``dense_only``              - the vectors handed in, ranked by cosine.
  * ``hybrid_dense_lexical``    - reciprocal-rank fusion of both views.

Honesty rules baked in here:
  * A vector file is validated before use: declared dim, exact length, finite
    values, declared normalization actually true, full corpus coverage. A mismatch
    raises; it is never silently truncated or dot-producted over the shorter dim.
  * A dense view has no corpus-relative support test, so it cannot abstain. Its
    abstention-family cases therefore score 0.0, which is the honest number, not a
    skipped case. ``hybrid_dense_lexical`` inherits the lexical support test.
  * Rows carry their own denominators, and no row is compared against a floor that
    belongs to a different method.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..contracts import EmbeddingMeta, ModelIdentity
from ..retrieval.chunking import Chunk
from ..retrieval.embeddings import cosine
from ..retrieval.fusion import DENSE_WEIGHT, LEXICAL_WEIGHT, RRF_K, hybrid_retrieve
from ..retrieval.fusion import reciprocal_rank_fusion
from .metrics import Counts, ndcg_at_k, precision_at_k, recall_at_k, reciprocal_rank


class VectorContractError(ValueError):
    """The vector file does not describe itself truthfully."""


@dataclass(slots=True)
class VectorSet:
    """Validated external vectors plus the meta that describes where they came from."""
    meta: EmbeddingMeta
    chunks: dict[str, list[float]]
    queries: dict[str, list[float]]
    provenance: dict[str, Any] = field(default_factory=dict)

    def check_query(self, qid: str) -> list[float]:
        try:
            return self.queries[qid]
        except KeyError as exc:
            raise VectorContractError(f"no vector supplied for query {qid!r}") from exc


def _finite(vec: Sequence[float]) -> bool:
    return all(isinstance(x, (int, float)) and math.isfinite(float(x)) for x in vec)


def load_vectors(path: str | Path, chunks: Sequence[Chunk],
                 queries: Sequence[tuple[str, str]]) -> VectorSet:
    """Read + validate a vector file produced by the real embedder.

    Shape: {"model": {id, revision, provider}, "dim": int, "normalization": "l2",
            "pooling": str, "vectors": {"chunk": {chunk_id: [...]},
                                        "query": {qid: [...]}}}
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    model = raw.get("model") or {}
    dim = raw.get("dim")
    norm = raw.get("normalization")
    if not isinstance(dim, int) or dim <= 0:
        raise VectorContractError(f"declared dim {dim!r} is not a positive integer")
    if norm not in ("l2", "none"):
        raise VectorContractError(f"declared normalization {norm!r} is not l2/none")
    if not model.get("id"):
        raise VectorContractError("vector file does not name the model that produced it")
    meta = EmbeddingMeta(model=ModelIdentity(id=str(model["id"]),
                                             revision=str(model.get("revision", "unpinned")),
                                             provider=str(model.get("provider", "unknown"))),
                         dim=dim, normalization=norm,
                         pooling=str(model.get("pooling", "unspecified")),
                         query_instruction=str(model.get("query_instruction", "")))
    body = raw.get("vectors") or {}
    chunk_vecs = {str(k): [float(x) for x in v] for k, v in (body.get("chunk") or {}).items()}
    query_vecs = {str(k): [float(x) for x in v] for k, v in (body.get("query") or {}).items()}

    want_chunks = {c.chunk_id for c in chunks}
    missing = sorted(want_chunks - set(chunk_vecs))
    if missing:
        raise VectorContractError(f"{len(missing)} of {len(want_chunks)} corpus chunks have no "
                                  f"vector (first: {missing[0]}) - partial vectors would silently "
                                  f"rank an incomplete corpus")
    extra = sorted(set(chunk_vecs) - want_chunks)
    if extra:
        raise VectorContractError(f"{len(extra)} vectors name chunks that are not in this corpus "
                                  f"(first: {extra[0]}) - stale vectors must not join a live corpus")
    want_queries = {qid for qid, _ in queries}
    missing_q = sorted(want_queries - set(query_vecs))
    if missing_q:
        raise VectorContractError(f"{len(missing_q)} of {len(want_queries)} frozen queries have no "
                                  f"vector (first: {missing_q[0]})")

    for label, table in (("chunk", chunk_vecs), ("query", query_vecs)):
        for key, vec in table.items():
            if len(vec) != dim:
                raise VectorContractError(f"{label} vector {key!r} has length {len(vec)} but the "
                                          f"file declares dim {dim}")
            if not _finite(vec):
                raise VectorContractError(f"{label} vector {key!r} contains a non-finite value")
            if norm == "l2":
                n = math.sqrt(sum(x * x for x in vec))
                if abs(n - 1.0) > 1e-3:
                    raise VectorContractError(
                        f"{label} vector {key!r} declares l2 normalization but its norm is {n:.6f} "
                        f"- cosine ranking over un-normalized vectors is a silent ranking bug")
    return VectorSet(meta=meta, chunks=chunk_vecs, queries=query_vecs,
                     provenance={k: v for k, v in raw.items() if k not in ("vectors",)})


def dense_ranked(query_vec: Sequence[float], chunks: Sequence[Chunk], vs: VectorSet,
                 top_k: int) -> list[str]:
    """Best-first chunk ids by cosine against one query vector. No support test."""
    scored = [(cosine(query_vec, vs.chunks[c.chunk_id], vs.meta, vs.meta), c.chunk_id)
              for c in chunks]
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [cid for _, cid in scored[:max(top_k, 1)]]


def fuse_views(dense_ids: Sequence[str], lexical_ids: Sequence[str], top_k: int) -> list[str]:
    """Measured fusion: RRF over the two ranked views, same law as the shipped path."""
    fused = reciprocal_rank_fusion([list(dense_ids), list(lexical_ids)],
                                   [DENSE_WEIGHT, LEXICAL_WEIGHT], RRF_K)
    ordered = sorted(fused, key=lambda cid: (-fused[cid], cid))
    return ordered[:max(top_k, 1)]


def _dedupe_docs(chunk_ids: Sequence[str], owner: dict[str, str]) -> list[str]:
    """Relevance is judged per DOCUMENT, so a document keeps its best position."""
    out: list[str] = []
    for cid in chunk_ids:
        doc = owner.get(cid, cid)
        if doc not in out:
            out.append(doc)
    return out


def compare(families: Sequence[Any], chunks: Sequence[Chunk], vs: VectorSet,
            top_k: int = 5) -> dict[str, Any]:
    """Score dense-only and hybrid-dense-lexical over the identical frozen cases."""
    owner = {c.chunk_id: c.source_id for c in chunks}
    methods = ("dense_only", "hybrid_dense_lexical")
    per_family: dict[str, dict[str, dict[str, Any]]] = {m: {} for m in methods}
    per_language: dict[str, dict[str, Counts]] = {m: {} for m in methods}
    overall: dict[str, Counts] = {m: Counts() for m in methods}
    failures: dict[str, list[dict[str, Any]]] = {m: [] for m in methods}

    for family in families:
        counters = {m: Counts(n=len(family.cases)) for m in methods}
        for case in family.cases:
            qvec = vs.check_query(case.qid)
            dense = dense_ranked(qvec, chunks, vs, top_k * 2)
            lexical_run = hybrid_retrieve(case.query, chunks, top_k=top_k * 2)
            lexical = [s.chunk.chunk_id for s in lexical_run.results]
            ranked = {
                "dense_only": _dedupe_docs(dense, owner),
                "hybrid_dense_lexical": _dedupe_docs(
                    fuse_views(dense, lexical, top_k * 2), owner),
            }
            abstained = {"dense_only": False,
                         "hybrid_dense_lexical": lexical_run.abstained}
            for m in methods:
                overall[m].n += 1
                order = ranked[m]
                c, lang = counters[m], per_language[m].setdefault(case.language, Counts())
                lang.n += 1
                if case.relevant:
                    rel = list(case.relevant)
                    for name, value in (("recall_at_5", recall_at_k(order, rel, top_k)),
                                        ("mrr", reciprocal_rank(order, rel)),
                                        ("ndcg_at_5", ndcg_at_k(order, {r: 2.0 for r in rel}, top_k)),
                                        ("precision_at_5", precision_at_k(order, rel, top_k))):
                        c.add_mean(name, value)
                        overall[m].add_mean(name, value)
                    lang.add_mean("recall_at_5", recall_at_k(order, rel, top_k))
                    lang.add_mean("mrr", reciprocal_rank(order, rel))
                    if not order or order[0] not in rel:
                        failures[m].append({"qid": case.qid, "family": family.name,
                                            "why": "answer_bearing_unit_not_top_1",
                                            "top": order[:top_k]})
                else:
                    score = 1.0 if abstained[m] else 0.0
                    c.add_mean("abstention_accuracy", score)
                    overall[m].add_mean("abstention_accuracy", score)
                    lang.add_mean("abstention_accuracy", score)
                    if not abstained[m]:
                        failures[m].append({"qid": case.qid, "family": family.name,
                                            "why": "presented_top_k_without_support",
                                            "top": order[:top_k]})
                if case.forbidden_top1:
                    violated = bool(order) and order[0] in set(case.forbidden_top1)
                    c.add_mean("forbidden_top1_rate", 1.0 if violated else 0.0)
                    overall[m].add_mean("forbidden_top1_rate", 1.0 if violated else 0.0)
                    if violated:
                        failures[m].append({"qid": case.qid, "family": family.name,
                                            "why": "hard_negative_ranked_first",
                                            "top": order[:top_k]})
        for m in methods:
            measured = {k: v for k, v in counters[m].metrics.items() if not k.startswith("_n_")}
            per_family[m][family.name] = {
                "n": counters[m].n,
                "measured": measured,
                "case_count_with_mean_denominators": {
                    k: int(counters[m].metrics.get(f"_n_{k}", 0)) for k in measured},
            }

    def clean(counts: Counts) -> dict[str, Any]:
        return {"n": counts.n,
                **{k: v for k, v in counts.metrics.items() if not k.startswith("_n_")}}

    return {
        "vectors_from": vs.provenance,
        "top_k": top_k,
        "abstention_law": {
            "dense_only": "none - a dense view cannot test corpus support, so every "
                          "abstention-family case scores 0.0 (honest, not skipped)",
            "hybrid_dense_lexical": "inherited from the lexical support test",
        },
        "note": "These rows are MEASUREMENTS on the frozen cases. They are deliberately "
                "not compared against the frozen floors, which belong to the shipped "
                "lexical method; comparing a different method to another method's floor "
                "would be a category error.",
        "methods": {
            m: {"per_family": per_family[m],
                "per_language": {lang: clean(lc) for lang, lc in sorted(per_language[m].items())},
                "overall": clean(overall[m]),
                "failures": failures[m]}
            for m in methods
        },
    }
