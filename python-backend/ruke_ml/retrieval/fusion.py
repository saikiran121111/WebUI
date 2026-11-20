"""Hybrid candidate fusion: BM25 plus the hashed lexical vector view.

In `hybrid_lexical` both views are lexical and both are labelled as such. In
`hybrid_neural` the dense view comes from the pinned MiniLM ONNX embedder (nn_embed),
and the reported method plus coverage say which embedder actually ran. Asking for a
mode whose backend cannot execute raises a typed failure instead of quietly ranking
worse and calling it the same quality.

The fusion is reciprocal-rank, not a weighted sum, because the two view scores
are not on a comparable scale (BM25 is unbounded, cosine is not). Reciprocal rank
only asks each view WHERE it would place a chunk, which is all either view can
actually support.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from .chunking import Chunk, tokenize
from .embeddings import LEXICAL_META, cosine, lexical_embed
from .reranker import Scored, bm25

RRF_K = 60.0
LEXICAL_WEIGHT = 1.0
DENSE_WEIGHT = 0.6
# A term occurring in more than this share of chunks cannot discriminate, so a
# hit on such terms alone is not evidence of relevance. This is what makes an
# honest "I found nothing relevant" possible instead of always returning top-K.
MAX_DF_RATIO = 0.25
MAX_CANDIDATES = 4000
# A single corpus-unique term may carry a result set by itself only when it is
# most of what the user asked (an identifier, a name, a code). If it covers only
# a minority of a longer query, it is incidental glue, not evidence.
MIN_UNIQUE_TERM_QUERY_COVERAGE = 0.5
# Dense-view evidence rule, stated as what it is: a DISTRIBUTION-RELATIVE check on the
# similarities this corpus actually produced, not a calibrated confidence. A dense hit
# counts as evidence only when the top cosine clears this corpus's median cosine by the
# margin below. The numbers are an auditable heuristic floor, not a probability; whether
# the mode is actually better is decided by the eval harness, not by this constant.
DENSE_TOP_SIM_MIN = 0.20
DENSE_MARGIN_MIN = 0.05
# The modes this module actually implements. `hybrid_neural` had to be added here on
# 2026-11-17: the branch existed and was measured by the eval harness, but the guard
# still rejected the mode, so the neural dense view was unreachable from any caller.
# Anything else is refused rather than silently served by a different embedder.
_MODES = ("lexical", "hybrid_lexical", "hybrid_neural")


@dataclass(slots=True)
class Retrieval:
    """Ranked candidates plus what the run can actually claim about them."""
    results: list[Scored] = field(default_factory=list)
    method: str = "hybrid_lexical"
    abstained: bool = False
    reasons: list[str] = field(default_factory=list)
    coverage: dict[str, Any] = field(default_factory=dict)
    # Which embedder produced the dense view, so a report can never blur the two.
    dense_view: str = "hashed-lexical-vector"

    def to_dict(self) -> dict[str, Any]:
        return {
            "results": [{"chunk_id": s.chunk.chunk_id, "score": s.score} for s in self.results],
            "method": self.method,
            "abstained": self.abstained,
            "reasons": list(self.reasons),
            "coverage": dict(self.coverage),
            "dense_view": self.dense_view,
        }


def document_frequency(query_tokens: Sequence[str], chunks: Sequence[Chunk]) -> dict[str, int]:
    wanted = set(query_tokens)
    df: dict[str, int] = {}
    for c in chunks:
        for tok in set(tokenize(c.text)):
            if tok in wanted:
                df[tok] = df.get(tok, 0) + 1
    return df


def informative_terms(query: str, chunks: Sequence[Chunk]) -> list[str]:
    """Query terms rare enough in this corpus to carry meaning. Corpus-relative, so
    the same rule works for a 5-chunk test and a 5000-chunk book."""
    q = list(dict.fromkeys(tokenize(query)))
    if not q or not chunks:
        return []
    df = document_frequency(q, chunks)
    return _select(q, df, len(chunks))


def _informative(df_count: int, n_chunks: int) -> bool:
    """A term is discriminating when it occurs in the corpus but not everywhere.

    df == 0 means the corpus has no such word, which is evidence about the corpus,
    not relevance evidence for a candidate. df above MAX_DF_RATIO of the corpus
    means the word is this corpus's ordinary glue, so a hit on it proves nothing.
    Both ends are excluded for the same reason: the term cannot separate anything.
    """
    return 0 < df_count <= max(1, int(n_chunks * MAX_DF_RATIO))


def _select(q: Sequence[str], df: dict[str, int], n_chunks: int) -> list[str]:
    return [t for t in dict.fromkeys(q) if _informative(df.get(t, 0), n_chunks)]


def _shared_terms(query_tokens: set[str], candidate_tokens: dict[str, set[str]],
                  results: Sequence["Scored"]) -> tuple[set[str], int]:
    """Term set shared with the best-supported candidate, plus that overlap size."""
    best: set[str] = set()
    best_size = 0
    for s in results:
        shared = query_tokens & candidate_tokens.get(s.chunk.chunk_id, set())
        if len(shared) > best_size:
            best, best_size = shared, len(shared)
    return best, best_size


def reciprocal_rank_fusion(view_ranks: Sequence[Sequence[str]], weights: Sequence[float],
                           k: float = RRF_K) -> dict[str, float]:
    if len(view_ranks) != len(weights):
        raise ValueError("every fused view needs a weight")
    fused: dict[str, float] = {}
    for ranks, w in zip(view_ranks, weights):
        for pos, cid in enumerate(ranks):
            fused[cid] = fused.get(cid, 0.0) + w / (k + float(pos + 1))
    return fused


def hybrid_retrieve(query: str, chunks: Sequence[Chunk], top_k: int = 5,
                    mode: str = "hybrid_lexical") -> Retrieval:
    """Search the corpus and report what the search can support.

    abstained=True means: no candidate matched a discriminating term, so the
    caller must NOT present these chunks as relevant evidence. Top-K exhausted is
    still not proof that nothing exists - it is coverage, not completeness.
    """
    if mode not in _MODES:
        raise ValueError(f"retrieval mode {mode!r} is not a mode this process runs "
                         f"(installed modes: {', '.join(sorted(_MODES))})")
    if not chunks or top_k <= 0:
        return Retrieval(method=mode, abstained=True,
                         reasons=["empty_corpus" if not chunks else "invalid_top_k"],
                         coverage={"corpus_chunks": len(chunks), "candidate_chunks": 0})

    pool = list(chunks[:MAX_CANDIDATES])
    truncated = len(chunks) > MAX_CANDIDATES
    by_id = {c.chunk_id: c for c in pool}

    lexical = [s for s in bm25(query, pool) if s.score > 0.0]
    lexical_ids = [s.chunk.chunk_id for s in lexical]

    dense_ids: list[str] = []
    dense_view = "hashed-lexical-vector"
    dense_stats: dict[str, float] = {}
    if mode == "hybrid_lexical":
        qvec = lexical_embed(query)
        scored = []
        for c in pool:
            sim = cosine(qvec, lexical_embed(c.text), LEXICAL_META, LEXICAL_META)
            if sim > 0.0:
                scored.append((sim, c.chunk_id))
        scored.sort(key=lambda x: (-x[0], x[1]))
        dense_ids = [cid for _, cid in scored]
    elif mode == "hybrid_neural":
        # The dense view is the pinned checkpoint, run for real. No fallback to hashed
        # vectors here: a caller that asked for neural and cannot get it must see the
        # failure (nn_embed raises a typed NeuralEmbeddingError).
        from .nn_embed import MODEL_ID, PINNED_REVISION, neural_embed_texts
        vectors, _meta, embed_info = neural_embed_texts([query] + [c.text for c in pool])
        qvec, dense_vectors = vectors[0], vectors[1:]
        sims = [(sum(a * b for a, b in zip(qvec, dv)), c) for c, dv in zip(pool, dense_vectors)]
        scored = [(sim, c.chunk_id) for sim, c in sims if sim > 0.0]
        scored.sort(key=lambda x: (-x[0], x[1]))
        dense_ids = [cid for _, cid in scored]
        values = sorted(sim for sim, _ in sims)
        top = values[-1] if values else 0.0
        median = values[len(values) // 2] if values else 0.0
        dense_stats = {"dense_top_similarity": round(top, 4),
                       "dense_median_similarity": round(median, 4),
                       "dense_margin_over_median": round(top - median, 4),
                       "dense_chunks_truncated_at_max_tokens": float(
                           embed_info.get("truncated", 0) or 0)}
        dense_view = f"{MODEL_ID}@{PINNED_REVISION.split(':', 1)[-1][:12]} onnxruntime-cpu"

    weights = [LEXICAL_WEIGHT, DENSE_WEIGHT] if dense_ids else [LEXICAL_WEIGHT]
    views = [lexical_ids, dense_ids] if dense_ids else [lexical_ids]
    fused = reciprocal_rank_fusion(views, weights)

    ranked = sorted(fused.items(), key=lambda kv: (-kv[1], kv[0]))
    results = [Scored(chunk=by_id[cid], score=score) for cid, score in ranked[:top_k] if cid in by_id]

    inf = informative_terms(query, pool)
    qtok = set(tokenize(query))
    distinct = len(qtok)
    # Candidate evidence is measured against the candidate, never against the query
    # in the abstract. Every candidate token set is computed once and reused.
    cand_tokens = {s.chunk.chunk_id: set(tokenize(s.chunk.text)) for s in results}
    df = document_frequency(qtok, pool)
    inf_set = set(inf)
    best_shared_all, best_shared = _shared_terms(qtok, cand_tokens, results)
    best_shared_inf, inf_shared_count = _shared_terms(inf_set, cand_tokens, results)
    # Term-overlap floor: even when a term looks rare for this corpus, a candidate
    # must share a meaningful SHARE of what the user actually asked, capped by how
    # many terms the query has (a one-token identifier can only match once).
    min_shared = min(distinct, max(2, (distinct + 3) // 4)) if distinct else 0
    # How much of the query the matched discriminating terms account for. An
    # identifier-only query is fully covered by its one term; a sentence-length
    # query that survives on one incidental word is not.
    inf_coverage = (len(inf_set) / distinct) if distinct and inf_set else 0.0
    unique_shared = [t for t in best_shared_inf if df.get(t, 0) == 1]
    single_evidence_ok = bool(unique_shared) and (
        inf_coverage >= MIN_UNIQUE_TERM_QUERY_COVERAGE or distinct <= 1)

    coverage = {
        "corpus_chunks": len(chunks),
        "candidate_chunks": len(pool),
        "lexical_hits": len(lexical_ids),
        "dense_hits": len(dense_ids),
        "returned": len(results),
        "query_tokens": distinct,
        "query_terms_shared_by_best_candidate": best_shared,
        "min_shared_query_terms": min_shared,
        "discriminating_terms_matched_by_best_candidate": inf_shared_count,
        "corpus_unique_term_matched": bool(unique_shared),
        "informative_terms": len(inf),
        "pool_truncated": truncated,
        "exhaustive": bool(truncated),
    }
    coverage["dense_view"] = dense_view
    if dense_stats:
        coverage.update(dense_stats)
        coverage["dense_evidence_rule"] = (f"dense hit counts only when top cosine >= "
                                           f"{DENSE_TOP_SIM_MIN} AND it clears the corpus median "
                                           f"by >= {DENSE_MARGIN_MIN}; distribution-relative, "
                                           "not a calibrated confidence")
    coverage["coverage_note"] = ("top_k exhausted is not proof that no further match exists; "
                                 "the run reports what it inspected, not what the corpus contains")

    reasons: list[str] = []
    if not results:
        reasons.append("no_candidate_shared_a_query_term")
    if not inf:
        # Nothing in the query is rare enough to mean anything, or no query term
        # occurs in this corpus at all. Either way top-K proves nothing.
        reasons.append("no_discriminating_term_exists_in_this_corpus")
    elif inf_shared_count == 0:
        reasons.append("no_candidate_matched_a_discriminating_term")
    elif inf_shared_count < 2 and not single_evidence_ok:
        # One shared ordinary word is coincidence-prone: the corpus is full of
        # candidates that share exactly one word with almost anything. A single
        # corpus-unique term IS allowed (that is what an identifier does), but only
        # when it really is what the user asked for, not an incidental particle.
        reasons.append("only_one_common_term_matched_the_candidates")
    if best_shared < min_shared:
        reasons.append("no_candidate_shared_enough_query_terms")
    if truncated:
        reasons.append(f"candidate_pool_capped_at_{MAX_CANDIDATES}_chunks")

    abstain_notes = {f"candidate_pool_capped_at_{MAX_CANDIDATES}_chunks"}
    abstain_reasons = [r for r in reasons if r not in abstain_notes]
    # Term-overlap reasons are LEXICAL evidence tests. In hybrid_neural they stay in the
    # report, but a dense view that clears its own margin rule is independent evidence, so
    # a paraphrase that shares no query term is not automatically treated as "nothing found".
    dense_evidence = bool(dense_stats) and (
        dense_stats["dense_top_similarity"] >= DENSE_TOP_SIM_MIN
        and dense_stats["dense_margin_over_median"] >= DENSE_MARGIN_MIN)
    coverage["dense_evidence"] = dense_evidence
    lexical_evidence_failed = bool(abstain_reasons)
    if mode == "hybrid_neural" and dense_evidence and results:
        abstain_reasons = []
    if mode == "hybrid_neural" and lexical_evidence_failed and not dense_evidence:
        reasons.append("dense_view_gave_no_independent_evidence")
    return Retrieval(results=results, method=mode, abstained=bool(not results or abstain_reasons),
                     reasons=reasons, coverage=coverage, dense_view=dense_view)
