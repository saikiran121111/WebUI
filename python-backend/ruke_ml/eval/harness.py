"""Runs the frozen families against the retrieval path that is actually implemented.

    python -m ruke_ml.eval [--top-k 5] [--out PATH]
                           [--dump-corpus PATH] [--vectors PATH]

What this proves and what it does not:
* It measures the offline lexical path (BM25 + hashed-lexical view, RRF fusion)
  on a frozen suite, with every denominator stated.
* It does NOT measure any capability that needs an uninstalled model. Those are
  reported not_run with the reason read from the live model catalog, so a gate
  can never be greened by an average over families that were never executed.
* ``--dump-corpus`` writes the frozen corpus + queries as JSON so a REAL embedder
  (the production TS/onnx MiniLM path, or any candidate model) can produce
  vectors; ``--vectors`` scores those vectors over the identical cases. That turns
  "which retriever is better" from a model-card argument into a measurement,
  without moving the frozen floors.
"""
from __future__ import annotations

import argparse
import json
import time
from typing import Any, Sequence

from ..contracts import sha256_hex
from ..documents.structures import Block
from ..models.registry import AVAILABLE, catalog
from ..retrieval.chunking import Chunk, chunk_blocks
from ..retrieval.fusion import Retrieval, hybrid_retrieve
from . import datasets
from .methods import compare, load_vectors
from .metrics import Counts, ndcg_at_k, precision_at_k, recall_at_k, reciprocal_rank


def build_corpus() -> list[Chunk]:
    """One chunk per frozen document: a document IS the retrieval unit here, which
    keeps the relevance judgement unambiguous."""
    blocks: list[Block] = []
    for doc_id, text in datasets.CORPUS.items():
        blocks.append(Block(text=text, kind="page_text", source_id=doc_id,
                            source_hash=sha256_hex(f"{doc_id}|{text}"), loc={"doc": doc_id}))
    return chunk_blocks(blocks, max_tokens=2000, overlap_tokens=0)


def _status(family: datasets.Family, measured: dict[str, float | None]) -> tuple[str, list[str]]:
    misses: list[str] = []
    for metric, floor in family.floor.items():
        value = measured.get(metric)
        if value is None:
            misses.append(f"{metric}: no scored case (cannot compare against a floor)")
        elif metric == "forbidden_top1_rate":
            if value > floor:
                misses.append(f"{metric}: {value:.3f} > {floor:.3f}")
        elif value + 1e-9 < floor:
            misses.append(f"{metric}: {value:.3f} < {floor:.3f}")
    return ("failed", misses) if misses else ("passed", [])


def dump_corpus(path: str) -> dict[str, Any]:
    """Publish the frozen corpus and queries so an embedder can vectorize them.

    This is the only supported way to feed an external vector file: the ids in the
    file must be exactly the ids of this corpus, which load_vectors then enforces.
    """
    payload = {
        "suite": "python-retrieval-holdout-v1 (frozen 2026-11-16, hand-authored)",
        "unit_of_relevance": "document",
        "chunks": [{"chunk_id": c.chunk_id, "source_id": c.source_id, "text": c.text}
                   for c in build_corpus()],
        "queries": [{"qid": case.qid, "query": case.query, "language": case.language,
                     "family": family.name}
                    for family in datasets.FAMILIES for case in family.cases],
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
    return payload


def evaluate(top_k: int = 5, vectors_path: str | None = None) -> dict[str, Any]:
    chunks = build_corpus()
    per_family: list[dict[str, Any]] = []
    per_language: dict[str, Counts] = {}
    cases_scored = 0
    abstained_cases = 0

    for family in datasets.FAMILIES:
        c = Counts(n=len(family.cases))
        bad: list[dict[str, Any]] = []
        for case in family.cases:
            res: Retrieval = hybrid_retrieve(case.query, chunks, top_k=top_k * 2)
            # Judgements are about DOCUMENTS, so the ranked list is ranked by the
            # document a candidate came from (deduplicated, first best hit wins).
            # Scoring raw chunk ids instead would make every recall zero, because a
            # chunk id is a content hash, not something a person could name.
            ranked: list[str] = []
            if not res.abstained:
                for s in res.results:
                    if s.chunk.source_id not in ranked:
                        ranked.append(s.chunk.source_id)
            if res.abstained:
                abstained_cases += 1
            lang = per_language.setdefault(case.language, Counts())
            lang.n += 1
            if case.relevant:
                rel = list(case.relevant)
                c.add_mean("recall_at_5", recall_at_k(ranked, rel, top_k))
                c.add_mean("mrr", reciprocal_rank(ranked, rel))
                c.add_mean("ndcg_at_5", ndcg_at_k(ranked, {r: 2.0 for r in rel}, top_k))
                c.add_mean("precision_at_5", precision_at_k(ranked, rel, top_k))
                lang.add_mean("recall_at_5", recall_at_k(ranked, rel, top_k))
                lang.add_mean("mrr", reciprocal_rank(ranked, rel))
                if not ranked or ranked[0] not in rel:
                    bad.append({"qid": case.qid, "why": "answer_bearing_unit_not_top_1",
                                "top": ranked[:top_k]})
            else:
                c.add_mean("abstention_accuracy", 1.0 if res.abstained else 0.0)
                lang.add_mean("abstention_accuracy", 1.0 if res.abstained else 0.0)
                if not res.abstained:
                    bad.append({"qid": case.qid, "why": "presented_top_k_without_support",
                                "top": ranked[:top_k], "reasons": res.reasons})
            if case.forbidden_top1:
                violated = bool(ranked) and ranked[0] in set(case.forbidden_top1)
                c.add_mean("forbidden_top1_rate", 1.0 if violated else 0.0)
                if violated:
                    bad.append({"qid": case.qid, "why": "hard_negative_ranked_first",
                                "top": ranked[:top_k]})
            cases_scored += 1
        measured = {k: v for k, v in c.metrics.items() if not k.startswith("_n_")}
        status, misses = _status(family, measured)
        per_family.append({
            "name": family.name,
            "description": family.description,
            "n": c.n,
            "status": status,
            "floor": dict(family.floor),
            "measured": measured,
            "case_count_with_mean_denominators": {k: int(c.metrics.get(f"_n_{k}", 0))
                                                  for k in measured},
            "failures": bad,
            "floor_misses": misses,
        })

    gated: list[dict[str, Any]] = []
    for g in datasets.GATED:
        # The gate names the candidate it WOULD measure. A capability-level status would
        # say "rerank: available" only because the lexical BM25 baseline is registered,
        # which would wrongly imply the neural reranking gate had a runnable candidate.
        cap = catalog().status_for(g.capability)
        if g.model:
            spec = catalog().get(g.model)
            if spec is None:
                raise ValueError(f"gated row {g.name!r} names model {g.model!r}, which is not "
                                 f"registered - the gate would report a made-up status")
            assert spec.capability == g.capability, (g.model, spec.capability, g.capability)
            entry = next((m for m in cap["models"] if m["id"] == g.model), None)
            install_status = entry["status"] if entry else cap["status"]
        else:
            entry, install_status = None, cap["status"]
        reason = ("installed_but_unmeasured" if install_status == AVAILABLE
                  else str(install_status))
        gated.append({
            "name": g.name,
            "capability": g.capability,
            "model": g.model,
            "status": "not_run",
            "would_measure": g.what_would_be_measured,
            "install_status": install_status,
            "reason": reason,
            "detail": entry if entry else cap,
            "counted_in_denominator": False,
        })

    families_run = len(per_family)
    families_passed = sum(1 for f in per_family if f["status"] == "passed")
    report: dict[str, Any] = {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "suite": "python-retrieval-holdout-v1 (frozen 2026-11-16, hand-authored)",
        "method": "bm25 + hashed-lexical cosine, reciprocal-rank fusion, corpus-relative abstention",
        "top_k": top_k,
        "corpus": {"documents": len(datasets.CORPUS), "chunks": len(chunks),
                   "unit_of_relevance": "document"},
        "families": per_family,
        "languages": {lang: {"n": lc.n,
                             **{k: v for k, v in lc.metrics.items() if not k.startswith("_n_")}}
                      for lang, lc in sorted(per_language.items())},
        "gated_not_run": gated,
        "aggregate": {
            "families_run": families_run,
            "families_passed": families_passed,
            "cases_scored": cases_scored,
            "abstained_cases": abstained_cases,
            "gated_cases_not_run": len(gated),
            "denominator": f"{cases_scored} frozen cases across {families_run} families; "
                           f"the {len(gated)} gated capabilities are NOT part of this denominator",
            "overall_pass": families_passed == families_run,
        },
    }
    if vectors_path:
        queries = [(case.qid, case.query)
                   for family in datasets.FAMILIES for case in family.cases]
        vs = load_vectors(vectors_path, chunks, queries)
        report["method_comparison"] = compare(datasets.FAMILIES, chunks, vs, top_k=top_k)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ruke_ml.eval")
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--out", default=None, help="write the full JSON report here")
    ap.add_argument("--dump-corpus", default=None,
                    help="write the frozen corpus + queries as JSON and exit")
    ap.add_argument("--vectors", default=None,
                    help="score an embedder's vectors over the same frozen cases")
    args = ap.parse_args(list(argv) if argv is not None else None)
    if args.dump_corpus:
        payload = dump_corpus(args.dump_corpus)
        print(f"corpus dumped: {len(payload['chunks'])} chunks, {len(payload['queries'])} queries "
              f"-> {args.dump_corpus}")
        return 0
    report = evaluate(top_k=args.top_k, vectors_path=args.vectors)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
    for fam in report["families"]:
        meas = ", ".join(f"{k}={v:.3f}" if isinstance(v, float) else f"{k}=n/a"
                         for k, v in sorted(fam["measured"].items()))
        print(f"{fam['status']:8s} {fam['name']:32s} n={fam['n']:2d} {meas}")
        for miss in fam["floor_misses"]:
            print(f"         floor miss: {miss}")
    for g in report["gated_not_run"]:
        print(f"not_run  {g['name']:32s} model={g.get('model') or '-':38s} "
              f"install={g['install_status']} reason={g['reason']}")
    agg = report["aggregate"]
    print(f"families {agg['families_passed']}/{agg['families_run']} passed; "
          f"cases={agg['cases_scored']} gated_not_run={agg['gated_cases_not_run']}")
    print(f"denominator: {agg['denominator']}")
    comp = report.get("method_comparison")
    if comp:
        print(f"\nmeasured method comparison (top_k={comp['top_k']}, vectors from "
              f"{comp['vectors_from'].get('model', {}).get('id', '?')}):")
        for name, row in comp["methods"].items():
            o = row["overall"]
            vals = ", ".join(f"{k}={v:.3f}" if isinstance(v, float) else f"{k}=n/a"
                             for k, v in sorted(o.items()) if k != "n")
            print(f"  {name:22s} n={o['n']:2d} {vals}")
            for lang, lc in row["per_language"].items():
                rec = lc.get("recall_at_5")
                print(f"      {lang:8s} n={lc['n']:2d} recall_at_5="
                      f"{'n/a' if rec is None else format(rec, '.3f')}")
    return 0 if agg["overall_pass"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
