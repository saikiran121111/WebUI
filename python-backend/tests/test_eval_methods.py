"""Tests for the measured method comparison (ruke_ml.eval.methods).

What these guard is the CONTRACT around somebody else's vectors. An embedder's
file has to describe itself truthfully before its numbers mean anything: a
truncated, stale, un-normalized or non-finite vector produces a confident wrong
ranking, which is exactly how a bad model looks good on a gate. The second half
checks that a method's own weakness stays visible instead of being averaged away
(a dense view cannot abstain, so it must score 0.0 on abstention cases).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ruke_ml.eval.datasets import Case, Family
from ruke_ml.eval.methods import (VectorContractError, compare, dense_ranked,
                                  fuse_views, load_vectors)
from ruke_ml.retrieval.chunking import Chunk


def _chunk(cid: str, doc: str, text: str) -> Chunk:
    return Chunk(chunk_id=cid, text=text, source_id=doc, source_hash=f"h-{cid}")


CORPUS = [
    _chunk("c1", "d_alpha", "the alpha widget rotates at ninety revolutions"),
    _chunk("c2", "d_beta", "the beta widget is bolted to a static plate"),
]


def _write(payload: dict) -> str:
    path = Path(tempfile.mkdtemp()) / "vectors.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def _valid_payload(dim: int = 2) -> dict:
    return {
        "model": {"id": "test/embedder", "revision": "r1", "provider": "test",
                  "pooling": "mean"},
        "dim": dim,
        "normalization": "l2",
        "vectors": {
            "chunk": {"c1": [1.0, 0.0], "c2": [0.0, 1.0]},
            "query": {"q_hit": [0.99988, 0.01562], "q_none": [0.70711, 0.70711]},
        },
    }


QUERIES = [("q_hit", "which widget rotates at ninety revolutions"),
           ("q_none", "frobnicate the unobtainium sprocket")]


class TestVectorContract(unittest.TestCase):
    def test_valid_vectors_load_with_their_own_meta(self) -> None:
        vs = load_vectors(_write(_valid_payload()), CORPUS, QUERIES)
        self.assertEqual(vs.meta.dim, 2)
        self.assertEqual(vs.meta.model.id, "test/embedder")
        self.assertEqual(vs.meta.normalization, "l2")
        self.assertEqual(sorted(vs.chunks), ["c1", "c2"])

    def test_missing_chunk_vector_is_refused(self) -> None:
        payload = _valid_payload()
        del payload["vectors"]["chunk"]["c2"]
        with self.assertRaisesRegex(VectorContractError, "have no"):
            load_vectors(_write(payload), CORPUS, QUERIES)

    def test_stale_vector_naming_an_unknown_chunk_is_refused(self) -> None:
        payload = _valid_payload()
        payload["vectors"]["chunk"]["c_ghost"] = [1.0, 0.0]
        with self.assertRaisesRegex(VectorContractError, "not in this corpus"):
            load_vectors(_write(payload), CORPUS, QUERIES)

    def test_missing_query_vector_is_refused(self) -> None:
        payload = _valid_payload()
        del payload["vectors"]["query"]["q_none"]
        with self.assertRaisesRegex(VectorContractError, "frozen queries have no"):
            load_vectors(_write(payload), CORPUS, QUERIES)

    def test_declared_dim_must_match_actual_length(self) -> None:
        payload = _valid_payload()
        payload["vectors"]["chunk"]["c1"] = [1.0]
        with self.assertRaisesRegex(VectorContractError, "does not match|length"):
            load_vectors(_write(payload), CORPUS, QUERIES)

    def test_non_finite_value_is_refused(self) -> None:
        payload = _valid_payload()
        payload["vectors"]["chunk"]["c1"] = [float("nan"), 0.0]
        with self.assertRaisesRegex(VectorContractError, "non-finite"):
            load_vectors(_write(payload), CORPUS, QUERIES)

    def test_claimed_l2_must_actually_be_unit_norm(self) -> None:
        payload = _valid_payload()
        payload["vectors"]["chunk"]["c1"] = [0.3, 0.0]
        with self.assertRaisesRegex(VectorContractError, "declares l2 normalization"):
            load_vectors(_write(payload), CORPUS, QUERIES)

    def test_untrustworthy_header_is_refused(self) -> None:
        for mutate, pattern in (
            (lambda p: p.pop("normalization"), "normalization"),
            (lambda p: p.update(dim=0), "positive integer"),
            (lambda p: p.update(model={}), "name the model"),
        ):
            payload = _valid_payload()
            mutate(payload)
            with self.assertRaisesRegex(VectorContractError, pattern):
                load_vectors(_write(payload), CORPUS, QUERIES)


class TestRanking(unittest.TestCase):
    def test_dense_ranking_puts_the_aligned_vector_first(self) -> None:
        vs = load_vectors(_write(_valid_payload()), CORPUS, QUERIES)
        self.assertEqual(dense_ranked(vs.check_query("q_hit"), CORPUS, vs, 2), ["c1", "c2"])

    def test_fusion_keeps_the_lexical_view_in_charge_when_dense_disagrees(self) -> None:
        """RRF weights are the shipped ones: the lexical support view carries more."""
        self.assertEqual(fuse_views(["c2", "c1"], ["c1", "c2"], 2), ["c1", "c2"])

    def test_unknown_query_id_is_a_contract_error_not_a_crash(self) -> None:
        vs = load_vectors(_write(_valid_payload()), CORPUS, QUERIES)
        with self.assertRaisesRegex(VectorContractError, "no vector supplied"):
            vs.check_query("q_missing")


class TestComparisonStaysHonest(unittest.TestCase):
    def _family(self) -> list[Family]:
        return [Family(
            name="unit_test_family",
            description="synthetic two-document corpus for the comparison contract",
            floor={"mrr": 0.5},
            cases=(
                Case(qid="q_hit", query="which widget rotates at ninety revolutions",
                     relevant=("d_alpha",), forbidden_top1=("d_beta",), language="en"),
                Case(qid="q_none", query="frobnicate the unobtainium sprocket",
                     relevant=(), language="en"),
            ),
        )]

    def test_dense_only_scores_its_missing_support_test_as_zero(self) -> None:
        vs = load_vectors(_write(_valid_payload()), CORPUS, QUERIES)
        report = compare(self._family(), CORPUS, vs, top_k=2)
        dense = report["methods"]["dense_only"]["overall"]
        hybrid = report["methods"]["hybrid_dense_lexical"]["overall"]
        self.assertEqual(dense["n"], 2)
        self.assertEqual(dense["abstention_accuracy"], 0.0)
        self.assertEqual(hybrid["abstention_accuracy"], 1.0)
        self.assertEqual(dense["recall_at_5"], 1.0)
        self.assertEqual(dense["forbidden_top1_rate"], 0.0)

    def test_denominators_are_stated_per_method_and_per_language(self) -> None:
        vs = load_vectors(_write(_valid_payload()), CORPUS, QUERIES)
        report = compare(self._family(), CORPUS, vs, top_k=2)
        for name, row in report["methods"].items():
            self.assertEqual(row["overall"]["n"], 2, name)
            self.assertEqual(row["per_language"]["en"]["n"], 2, name)
            fam = row["per_family"]["unit_test_family"]
            self.assertEqual(fam["n"], 2, name)
            self.assertIn("recall_at_5", fam["case_count_with_mean_denominators"], name)
            self.assertEqual(fam["case_count_with_mean_denominators"]["recall_at_5"], 1, name)
        self.assertIn("not compared against the frozen floors", report["note"])

    def test_abstention_law_is_written_into_the_report(self) -> None:
        vs = load_vectors(_write(_valid_payload()), CORPUS, QUERIES)
        report = compare(self._family(), CORPUS, vs, top_k=2)
        self.assertIn("cannot test corpus support", report["abstention_law"]["dense_only"])
        self.assertEqual(report["vectors_from"]["model"]["id"], "test/embedder")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
