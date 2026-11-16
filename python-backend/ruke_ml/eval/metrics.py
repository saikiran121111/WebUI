"""Evaluation metrics. Pure functions over ids and strings: no model, no I/O.

Every aggregate keeps its denominator explicit, because "99%" without a stated
denominator is a slogan. A ratio with an empty denominator returns None and the
caller must report the family as not_run rather than as a zero or a pass.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence


def ratio(num: float, den: float) -> float | None:
    return None if not den else float(num) / float(den)


def relevant_in_top_k(ranked: Sequence[str], relevant: Iterable[str], k: int) -> bool:
    rel = set(relevant)
    return any(cid in rel for cid in ranked[:k])


def recall_at_k(ranked: Sequence[str], relevant: Iterable[str], k: int) -> float | None:
    """Fraction of the answer-bearing units that made the top-k. None when the
    case declares no relevant unit (abstention cases have no recall)."""
    rel = set(relevant)
    if not rel:
        return None
    return len(rel & set(ranked[:k])) / len(rel)


def precision_at_k(ranked: Sequence[str], relevant: Iterable[str], k: int) -> float | None:
    rel = set(relevant)
    if not rel and not ranked:
        return None
    if k <= 0:
        return None
    hits = len(rel & set(ranked[:k]))
    return hits / float(k)


def reciprocal_rank(ranked: Sequence[str], relevant: Iterable[str]) -> float:
    rel = set(relevant)
    for pos, cid in enumerate(ranked):
        if cid in rel:
            return 1.0 / (pos + 1)
    return 0.0


def dcg_at_k(ranked: Sequence[str], gains: Mapping[str, float], k: int) -> float:
    total = 0.0
    for pos, cid in enumerate(ranked[:k]):
        g = gains.get(cid, 0.0)
        if g:
            total += g / math.log2(pos + 2.0)
    return total


def ndcg_at_k(ranked: Sequence[str], gains: Mapping[str, float], k: int) -> float | None:
    ideal = sorted(gains.values(), reverse=True)[:k]
    best = sum(g / math.log2(i + 2.0) for i, g in enumerate(ideal))
    if best <= 0.0:
        return None
    return dcg_at_k(ranked, gains, k) / best


def edit_distance(a: Sequence[str], b: Sequence[str]) -> int:
    """Iterative Levenshtein over token sequences (words for WER, chars for CER)."""
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ca == cb else 1)))
        prev = cur
    return prev[-1]


def error_rate(hypothesis: str, reference: str, unit: str = "word") -> float | None:
    """WER (unit="word") or CER (unit="char"): edit distance / reference length.

    An empty reference has no denominator, so it returns None rather than 0.0 -
    silence scored as perfection is exactly how a bad ASR model passes a gate.
    """
    ref = reference.split() if unit == "word" else list(reference)
    hyp = hypothesis.split() if unit == "word" else list(hypothesis)
    if not ref:
        return None
    return edit_distance(hyp, ref) / float(len(ref))


def temporal_localization(pred: Sequence[tuple[float, float]],
                          truths: Sequence[tuple[float, float]],
                          tolerance_s: float) -> dict[str, float | None]:
    """Did a predicted interval land on each real event within tolerance?

    Reported as hit rate plus mean absolute error on the matched start times.
    An empty truth list has no denominator, hence None - "the clip contained no
    event and I said none" is not evidence about localisation quality.
    """
    if not truths:
        return {"hit_rate": None, "mean_abs_error_s": None, "n_truth": 0}
    hits, errs = 0, []
    for lo, hi in truths:
        best = None
        for plo, phi in pred:
            overlap = min(hi, phi) - max(lo, plo)
            centre_err = abs((plo + phi) / 2.0 - (lo + hi) / 2.0)
            if overlap > 0 or centre_err <= tolerance_s:
                if best is None or centre_err < best:
                    best = centre_err
        if best is not None:
            hits += 1
            errs.append(best)
    return {"hit_rate": ratio(hits, len(truths)),
            "mean_abs_error_s": (sum(errs) / len(errs)) if errs else None,
            "n_truth": len(truths)}


@dataclass(slots=True)
class Counts:
    """One family's scored totals. n is always the number of SCORED cases, and
    gated cases are tracked separately so they can never inflate a pass rate."""
    n: int = 0
    not_run: int = 0
    blocked: int = 0
    metrics: dict[str, float | None] = field(default_factory=dict)

    def add_mean(self, name: str, value: float | None) -> None:
        if value is None:
            return
        prev = self.metrics.get(name)
        if prev is None:
            self.metrics[name] = float(value)
            self.metrics[f"_n_{name}"] = 1.0
        else:
            n = int(self.metrics.get(f"_n_{name}", 1)) + 1
            self.metrics[name] = prev + (float(value) - prev) / n
            self.metrics[f"_n_{name}"] = float(n)
