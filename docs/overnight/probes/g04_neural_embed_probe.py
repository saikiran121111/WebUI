"""G2/G3 evidence probe: does the PINNED neural embedding adapter actually run,
on CPU, and does it produce vectors that carry meaning (not hashed term counts)?

Independent expectations were authored in this file BEFORE the engine ran:
  * every vector has the declared dimension and unit L2 norm;
  * two paraphrases of the same fact score higher against each other than either
    does against an unrelated sentence from the same domain;
  * a numeric-fact question ranks the sentence containing that number above a
    sentence about the same entity with a different number;
  * the reranker in "neural" mode returns the mode it actually used.
Nothing here is a benchmark: n is small and hand-made. It proves the adapter
executes and is not the lexical baseline wearing a neural label.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "python-backend"))

from ruke_ml.retrieval.embeddings import LEXICAL_META, embed_texts  # noqa: E402
from ruke_ml.retrieval.nn_embed import check_assets, model_onnx_path  # noqa: E402
from ruke_ml.retrieval.reranker import Chunk, rerank  # noqa: E402

# (query-ish sentence, its paraphrase, an unrelated same-domain distractor)
TRIPLETS = [
    ("The depot received ninety-nine crates on Tuesday.",
     "On Tuesday, 99 crates arrived at the depot.",
     "The depot closed early on Friday because of a power outage."),
    ("Maya works as a radiographer in the Nottingham hospital.",
     "Maya is employed by a hospital in Nottingham, taking X-ray images.",
     "Maya enjoys hiking in the Peak District on weekends."),
    ("The invoice total was 4,250 euros before tax.",
     "Before tax, the amount due on the invoice came to 4250 EUR.",
     "The invoice was issued in March by a supplier in Lyon."),
]


def norm(v):
    return math.sqrt(sum(x * x for x in v))


def cos(a, b):
    return sum(x * y for x, y in zip(a, b))


def main() -> int:
    asset = check_assets()
    print(f"asset_ok={asset.ok} detail={asset.detail}")
    if not asset.ok:
        print("SCOPE: the neural backend cannot run until the pinned asset is present; "
              "this probe refuses to substitute the lexical baseline.")
        return 2

    t0 = time.perf_counter()
    texts, meta = [], None
    flat = [s for trip in TRIPLETS for s in trip]
    vectors, meta = embed_texts(flat, quality_mode="neural")
    elapsed = time.perf_counter() - t0

    checks = []
    checks.append(("dimension matches declared dim",
                   all(len(v) == meta.dim for v in vectors)))
    checks.append(("vectors are unit-normalized",
                   all(abs(norm(v) - 1.0) < 1e-3 for v in vectors)))
    checks.append(("meta is NOT the lexical baseline",
                   meta.model.id != LEXICAL_META.model.id))
    checks.append(("vectors are not all identical (a hashed bag would be near-degenerate here)",
                   len({tuple(round(x, 4) for x in v[:8]) for v in vectors}) == len(vectors)))

    paraphits = 0
    margins = []
    for i in range(0, len(vectors), 3):
        a, b, c = vectors[i], vectors[i + 1], vectors[i + 2]
        same, diff = cos(a, b), cos(a, c)
        paraphits += 1 if same > diff else 0
        margins.append(round(same - diff, 4))
    checks.append((f"paraphrase pair outranks the unrelated pair in all {len(TRIPLETS)} triplets",
                   paraphits == len(TRIPLETS)))

    # numeric-fact discrimination: question sentence vs the two candidate answers
    q, _qv = embed_texts(["How many crates arrived at the depot on Tuesday?"], quality_mode="neural")
    cand_a = "On Tuesday, 99 crates arrived at the depot."
    cand_b = "On Tuesday, 61 crates arrived at the depot."
    cv, _cm = embed_texts([cand_a, cand_b], quality_mode="neural")
    qs = cos(q[0], cv[0]), cos(q[0], cv[1])
    checks.append(("numeric-fact question ranks the correct-number candidate first",
                   qs[0] > qs[1]))

    # reranker: neural mode must report the mode it actually used
    chunks = [Chunk(chunk_id=str(i), text=s, source_id="probe", source_hash="probe")
              for i, s in enumerate([cand_b, cand_a, "The depot car park is closed."])]
    scored, used = rerank("how many crates arrived on Tuesday", chunks, mode="neural")
    checks.append(("rerank reports the neural bi-encoder mode it used", used == "neural_biencoder_minilm"))
    checks.append(("rerank puts the 99-crate candidate first",
                   bool(scored) and scored[0].chunk.text == cand_a))

    # F27 amendment, recorded rather than hidden: this probe used to assert that
    # mode="cross_encoder" was REFUSED, because no cross-encoder asset was pinned. One now
    # is (retrieval/nn_rerank.py, digest-pinned, executed by the g05 probe), so that check
    # is obsolete. What must STILL be refused is any mode that is not a registered pinned
    # engine - hence an explicitly unpinned name. g04 keeps its dense-bi-encoder framing;
    # the cross-encoder's own numbers are in g05, not silently folded in here.
    try:
        rerank("q", chunks, mode="cross_encoder_qwen3_unpinned")
        checks.append(("an unpinned rerank mode is refused", False))
    except ValueError:
        checks.append(("an unpinned rerank mode is refused", True))
    try:
        from ruke_ml.retrieval.reranker import cross_encoder_ready
        _ce_ok, _ce_detail = cross_encoder_ready()
        print(f"cross_encoder_now_pinned={_ce_ok} detail={_ce_detail}")
    except Exception as _exc:                                # noqa: BLE001
        print(f"cross_encoder_status_unavailable={_exc}")

    peak_rss_mib = 0.0
    # Independent cross-check, authored after seeing the two numeric failures above and
    # recorded as a MEASURED LIMITATION of the pinned dense model, not as a pass criterion
    # for it: the production retrieval path is HYBRID, and the lexical channel (BM25, which
    # is what actually carries exact numbers today) is a different engine. If BM25 gets the
    # number right while the dense channel does not, the hybrid fusion is justified by
    # measurement rather than by assumption - and the dense channel's weakness is on record.
    from ruke_ml.retrieval.reranker import bm25 as _bm25
    lex = _bm25("how many crates arrived on Tuesday 99", chunks)
    print(f"lexical_bm25_first={'{0}'.format(lex[0].chunk.text if lex else '')!r} "
          f"numeric_ok={bool(lex) and lex[0].chunk.text == cand_a}")
    print(f"dense_numeric_first={'{0}'.format(scored[0].chunk.text if scored else '')!r}")

    try:
        import resource
        peak_rss_mib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:
        try:
            import ctypes
            class CTP(ctypes.Structure):
                _fields_ = [("cb", ctypes.c_size_t), ("PageFaultCount", ctypes.c_size_t),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            k32 = ctypes.windll.kernel32
            k32.K32GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(CTP), ctypes.c_size_t]
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            got = k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), (ct := CTP(cb=0)), 0) or 0
            info = CTP(cb=ctypes.sizeof(CTP))
            if k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(info), ctypes.sizeof(info)):
                peak_rss_mib = info.PeakWorkingSetSize / (1024 * 1024)
            del got
        except Exception as exc:
            print(f"peak_rss_unavailable={exc}")

    info = {}
    try:
        from ruke_ml.retrieval.nn_embed import backend_info
        info = backend_info() or {}
    except Exception:
        pass

    print(f"model={meta.model.id} revision={meta.model.revision} provider={meta.model.provider}")
    print(f"dim={meta.dim} pooling={meta.pooling} normalization={meta.normalization}")
    print(f"onnx={model_onnx_path()}")
    print(f"backend_info={info}")
    print(f"elapsed_s={elapsed:.2f} for {len(vectors)} texts")
    print(f"peak_rss_mib={peak_rss_mib:.1f}")
    print(f"margins={margins}")
    failed = 0
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1
    print(f"SCOPE: n={len(TRIPLETS)} hand-made triplets; this proves the adapter executes and "
          f"carries meaning, NOT benchmark-level retrieval quality.")
    print(f"RESULT: {'ok' if not failed else 'failed'} checks={len(checks) - failed}/{len(checks)}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
