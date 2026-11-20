"""Write the vector file the retrieval harness scores, from a backend that RUNS.

    python -m ruke_ml.eval.embed_vectors --mode neural --out <path>
    python -m ruke_ml.eval.embed_vectors --mode lexical --out <path>

Why this exists: `eval/methods.py:load_vectors` refuses a vector file that does not
describe itself, and until now nothing in this repository could PRODUCE such a file from a
neural backend. That left the neural rows of the registry with no measured number attached
to them - which is exactly how "neural" becomes decoration.

The produced file carries the model id, revision, provider, dim, pooling and
normalization, so the harness can reject a file whose vectors do not match the checkpoint
it claims. No network at embed time: the neural mode reads the pinned local ONNX asset and
hashes it first (nn_embed.check_assets), so a swapped checkpoint cannot be measured as if
it were the pinned one.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from . import datasets
from .harness import build_corpus


def produce(mode: str = "neural") -> dict[str, Any]:
    from ..retrieval.embeddings import LEXICAL_META, lexical_embed
    chunks = build_corpus()
    queries = [(case.qid, case.query)
               for family in datasets.FAMILIES for case in family.cases]
    if mode == "lexical":
        meta = LEXICAL_META
        chunk_vecs = {c.chunk_id: lexical_embed(c.text) for c in chunks}
        query_vecs = {qid: lexical_embed(text) for qid, text in queries}
        extra: dict[str, Any] = {"truncated": 0}
    elif mode == "neural":
        from ..retrieval.nn_embed import neural_embed_texts
        texts = [c.text for c in chunks] + [text for _qid, text in queries]
        vectors, meta, info = neural_embed_texts(texts)
        chunk_vecs = {c.chunk_id: vec for c, vec in zip(chunks, vectors[:len(chunks)])}
        query_vecs = {qid: vec for (qid, _t), vec in
                      zip(queries, vectors[len(chunks):])}
        extra = {"truncated": info.get("truncated", 0), "max_tokens": info.get("max_tokens"),
                 "backend": info.get("backend")}
    else:
        raise SystemExit(f"unknown mode {mode!r}; use neural or lexical")
    return {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": meta.model.to_dict(),
        "dim": meta.dim,
        "normalization": meta.normalization,
        "pooling": meta.pooling,
        "query_instruction": meta.query_instruction,
        "provenance": {"mode": mode, "chunk_count": len(chunk_vecs), "query_count": len(query_vecs),
                       **extra},
        "vectors": {"chunk": chunk_vecs, "query": query_vecs},
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ruke_ml.eval.embed_vectors")
    ap.add_argument("--mode", default="neural", choices=["neural", "lexical"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args(list(argv) if argv is not None else None)
    payload = produce(args.mode)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    prov = payload["provenance"]
    print(f"{args.mode} vectors: {prov['chunk_count']} chunks, {prov['query_count']} queries, "
          f"model={payload['model']['id']}@{payload['model']['revision'][:20]} "
          f"dim={payload['dim']} truncated_chunks={prov.get('truncated', 0)} -> {out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
