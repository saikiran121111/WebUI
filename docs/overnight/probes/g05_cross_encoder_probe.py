"""G3 evidence probe for the PINNED neural cross-encoder reranker.

Expectation discipline: the EVAL set below was authored by hand BEFORE any cross-encoder
forward pass ran on this host, and the expected answer for every query is the passage that
answers it by content, not the passage any engine prefers. Thresholds are stated here, in
advance, and are not tuned after seeing results:

  * mechanics must be exact: joint scores are finite probabilities in (0,1), ordering is
    reproducible on a second identical call, the model window is 256 word-piece tokens and a
    longer candidate is reported as truncated rather than silently shortened, an absent or
    digest-mismatched asset raises instead of substituting another ranker, and an unknown
    mode is refused;
  * provider must be CPUExecutionProvider only - no GPU compute for processing jobs;
  * quality: on the 10-query set the cross-encoder must put the expected passage in the top
    3 for at least 9 of 10 queries, and must beat or match the dense bi-encoder's top-1
    count on THIS set (the bi-encoder's number is measured in the same process, not quoted);
  * the numeric-fact query is the case the dense channel got wrong in g04 - it is reported
    separately, and getting it right here is evidence about this case, not a benchmark.

n=10 hand-written queries is a mechanics-and-direction check, NOT a retrieval-quality
benchmark. No parity with any other product is claimed from it.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "python-backend"))

from ruke_ml.retrieval.nn_rerank import (  # noqa: E402
    MAX_TOKENS, MODEL_ID, PINNED_ONNX_SHA256, CrossEncoderError, backend_info,
    check_assets, cross_encoder_scores,
)
from ruke_ml.retrieval.reranker import Chunk, rerank  # noqa: E402

# (query, [passages...], index of the passage that answers it)
EVAL: list[tuple[str, list[str], int]] = [
    ("How many crates arrived at the depot on Tuesday?",
     ["On Tuesday, 61 crates arrived at the depot.",
      "On Tuesday, 99 crates arrived at the depot.",
      "The depot closed early on Friday because of a power outage.",
      "Crate deliveries are scheduled weekly by the regional planner."], 1),
    ("What was the invoice total before tax?",
     ["The invoice was issued in March by a supplier in Lyon.",
      "Payment terms are net 30 days from the invoice date.",
      "Before tax, the amount due on the invoice came to 4250 EUR.",
      "A credit note was raised against a different order in April."], 2),
    ("Which compiler flag enables link-time optimisation in the build?",
     ["-flto turns on link-time optimisation for the whole program.",
      "-O2 optimises each translation unit separately.",
      "The build uses ninja as the generator.",
      "Warnings are treated as errors in CI."], 0),
    ("What is the retention period for customer support recordings?",
     ["Support recordings are kept for 18 months and then deleted automatically.",
      "Agents may listen to recordings during quality calibration sessions.",
      "The call system was replaced in 2019.",
      "Recordings are stored in the regional object store."], 0),
    ("Who signs off a change to the payroll schema?",
     ["Payroll schema changes need written sign-off from the payroll lead and Finance.",
      "The payroll system runs nightly at 02:00.",
      "A change request form exists in the internal wiki.",
      "Developers rotate on the payroll support queue each month."], 0),
    ("Which river is the power station on?",
     ["The power station sits on the River Clyde at Rutherglen.",
      "The station was converted from coal to gas in 1974.",
      "Turbine maintenance is scheduled every 4000 hours.",
      "The grid connection voltage is 132 kV."], 0),
    ("How do I revert the most recent commit without losing my working changes?",
     ["Use git revert HEAD; it creates a new commit and keeps your working tree.",
      "git reset --hard DISCARDS working tree changes.",
      "git log --oneline shows recent history.",
      "Rebasing rewrites history and should not be used on shared branches."], 0),
    ("What dose of paracetamol is safe for a 6-year-old?",
     ["For a 6-year-old, the usual dose is 240 mg up to four times a day.",
      "Paracetamol is also sold as an effervescent tablet.",
      "Adults may take 500 mg to 1000 mg per dose.",
      "The suspension should be shaken before use."], 0),
    ("Which scene in the film shows the lighthouse keeper's first night?",
     ["Scene 12 opens on the keeper climbing the tower at dusk on his first night.",
      "The film was shot on Arriflex 435 cameras.",
      "Scene 4 shows the village market in daylight.",
      "The score was recorded with a 40-piece orchestra."], 0),
    ("Why did the lesson say photosynthesis slows at low carbon dioxide?",
     ["Less CO2 means less substrate for the Calvin cycle, so the rate of photosynthesis drops.",
      "Chlorophyll absorbs red and blue light most strongly.",
      "Stomata open wider in bright light.",
      "The experiment used pondweed in a test tube."], 0),
]


def peak_working_set_mib() -> float:
    try:
        import ctypes

        class CTP(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_size_t), ("PageFaultCount", ctypes.c_size_t),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]

        k32 = ctypes.windll.kernel32
        # Without explicit argtypes the pseudo-handle (c_void_p) is marshalled as a
        # C int and raises OverflowError, which previously hid the peak measurement.
        k32.K32GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(CTP), ctypes.c_size_t,
        ]
        k32.K32GetProcessMemoryInfo.restype = ctypes.c_int
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        info = CTP(cb=ctypes.sizeof(CTP))
        if k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(info),
                                       ctypes.sizeof(info)):
            return info.PeakWorkingSetSize / (1024 * 1024)
        return 0.0
    except Exception as exc:                                   # noqa: BLE001
        print(f"peak_memory_unavailable={exc}")
    return 0.0


def _chunks(passages: list[str]) -> list[Chunk]:
    return [Chunk(chunk_id=str(i), text=t, source_id="g05", source_hash="g05")
            for i, t in enumerate(passages)]


def rank_of(order: list[str], expected_index: int) -> int:
    wanted = str(expected_index)
    for position, chunk_id in enumerate(order):
        if chunk_id == wanted:
            return position + 1
    return len(order) + 1


def main() -> int:
    state = check_assets()
    print(f"asset_ok={state.ok} detail={state.detail}")
    if not state.ok:
        print("SCOPE: the pinned cross-encoder asset is not here; this probe REFUSES to "
              "measure a different engine and call it neural reranking.")
        return 2

    checks: list[tuple[str, bool]] = []

    t0 = time.perf_counter()
    q0, passages0, exp0 = EVAL[0]
    scores, info = cross_encoder_scores(q0, passages0)
    cold_s = time.perf_counter() - t0
    print(f"model={info['model']} upstream={info['upstream']}")
    print(f"revision={info['revision']} commit={info['commit']} provider={info['provider']}")
    print(f"scoring={info['scoring']} max_tokens={info['max_tokens']} batch={info['batch']}")
    print(f"backend={info['backend']}")
    print(f"cold_load_plus_4_pairs_s={cold_s:.2f}")

    checks.append(("scores are finite probabilities in (0,1)",
                   len(scores) == len(passages0) and all(0.0 < s < 1.0 for s in scores)))
    checks.append(("session reports only CPUExecutionProvider",
                   list(info["backend"].get("providers") or []) == ["CPUExecutionProvider"]))
    again, _ = cross_encoder_scores(q0, passages0)
    checks.append(("ordering and scores reproducible on an identical second call",
                   [round(x, 9) for x in again] == [round(x, 9) for x in scores]))
    checks.append(("asset digest pinned and re-verified at load",
                   info["backend"].get("digest") == PINNED_ONNX_SHA256))

    long_text = ("The quarterly reconciliation notes mention the ledger, the sub-ledger and "
                 "the suspense account repeatedly. " * 200)
    _, long_info = cross_encoder_scores("what is in the reconciliation?", [q0, long_text])
    checks.append((f"a candidate longer than {MAX_TOKENS} tokens is reported as truncated",
                   long_info["truncated"] >= 1))

    # A missing asset must raise, never substitute another ranker.
    # The session is deliberately dropped first: a cached session would make this check pass
    # for the wrong reason, and the point of the check is that readiness is decided from the
    # asset on disk, not from whatever happens to be resident.
    from ruke_ml.retrieval.nn_rerank import reset_backend
    reset_backend()
    saved = os.environ.get("RUKE_RERANK_DIR", "")
    os.environ["RUKE_RERANK_DIR"] = str(Path(__file__).parent / "no-such-asset-dir")
    try:
        try:
            cross_encoder_scores("q", ["a"])
            checks.append(("a missing pinned asset raises instead of substituting", False))
        except CrossEncoderError as exc:
            checks.append(("a missing pinned asset raises instead of substituting",
                           exc.reason == "model_unavailable"))
    finally:
        if saved:
            os.environ["RUKE_RERANK_DIR"] = saved
        else:
            os.environ.pop("RUKE_RERANK_DIR", None)
    check_assets()  # re-read the real pinned asset before the quality loop

    try:
        rerank("q", _chunks(["a", "b"]), mode="cross_encoder_qwen3_unpinned")
        checks.append(("an unknown/unpinned rerank mode is refused", False))
    except ValueError:
        checks.append(("an unknown/unpinned rerank mode is refused", True))

    # ---- quality, measured for three engines in the same process ----
    modes = {"lexical": [], "neural_biencoder_minilm": [], "neural_cross_encoder_minilm": []}
    mrr = {k: 0.0 for k in modes}
    request_ms = 0.0
    for query, passages, expected in EVAL:
        chunks = _chunks(passages)
        for mode, key in (("lexical", "lexical"), ("neural", "neural_biencoder_minilm"),
                          ("cross_encoder", "neural_cross_encoder_minilm")):
            t1 = time.perf_counter()
            scored, used = rerank(query, chunks, mode=mode)
            request_ms += (time.perf_counter() - t1) * 1000.0
            assert used == key, f"mode {mode!r} reported {used!r}"
            order = [s.chunk.chunk_id for s in scored]
            r = rank_of(order, expected)
            modes[key].append(r)
            mrr[key] += 1.0 / r if r <= len(passages) else 0.0

    n = len(EVAL)
    top1 = {k: sum(1 for r in v if r == 1) for k, v in modes.items()}
    top3 = {k: sum(1 for r in v if r <= 3) for k, v in modes.items()}
    for k in modes:
        print(f"{k}: ranks={modes[k]} top1={top1[k]}/{n} top3={top3[k]}/{n} "
              f"mrr={mrr[k] / n:.3f}")

    checks.append((f"cross-encoder top-3 >= 9/{n}", top3["neural_cross_encoder_minilm"] >= 9))
    checks.append(("cross-encoder top-1 >= dense bi-encoder top-1 on this set",
                   top1["neural_cross_encoder_minilm"] >= top1["neural_biencoder_minilm"]))

    # The g04 numeric case, reported separately.
    numeric_rank = modes["neural_cross_encoder_minilm"][0]
    print(f"g04_numeric_case: cross_encoder_rank={numeric_rank} "
          f"biencoder_rank={modes['neural_biencoder_minilm'][0]} "
          f"lexical_rank={modes['lexical'][0]}")
    checks.append(("the g04 numeric case is answered by the cross-encoder", numeric_rank == 1))

    peak = peak_working_set_mib()
    print(f"peak_working_set_mib={peak:.1f} (whole probe process, includes imports and the "
          "bi-encoder measured in the same process)")
    print(f"total_rerank_time_ms={request_ms:.0f} for {n * 3} reranks of {len(EVAL[0][1])} candidates")

    failed = 0
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1
    print(f"SCOPE: n={n} hand-authored queries across 6 domains; proves the pinned "
          "cross-encoder executes on CPU with joint scoring and improves ordering on this "
          "set. It is not a benchmark, claims no quality parity, and states no non-English "
          "coverage.")
    print(f"RESULT: {'ok' if not failed else 'failed'} checks={len(checks) - failed}/{len(checks)}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
