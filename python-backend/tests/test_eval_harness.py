"""The held-out suite is itself under test.

A scoring harness is only useful if the suite cannot drift: denominators frozen,
gated capabilities incapable of counting as passes, no family green on a missing
denominator. These tests guard the measuring stick, not the product. Every
non-ASCII literal here is written with escapes so a well-meaning text editor or
shell round-trip cannot silently mangle the writing systems under test.
"""
from __future__ import annotations

import json
import tempfile
import unittest
import unicodedata
from pathlib import Path

from ruke_ml.eval import datasets, harness, metrics
from ruke_ml.models.registry import catalog
from ruke_ml.retrieval import chunking, fusion

HINDI_RAIN = "\u092c\u093e\u0930\u093f\u0936"                 # ba + matra + ra + matra + sha
AR_VOWELLED = "\u0627\u0650\u062c\u062a\u0645\u0627\u0639\u064f"   # ijtamaa(u) with harakat
AR_BARE = "\u0627\u062c\u062a\u0645\u0627\u0639"               # ijtamaa, no harakat
JA_LINE = "\u5c71\u624b\u7dda"                                # Yamanote line (3 Han chars)


class MetricTests(unittest.TestCase):
    def test_empty_denominators_are_none_not_zero(self) -> None:
        self.assertIsNone(metrics.ratio(0, 0))
        self.assertIsNone(metrics.recall_at_k(["a"], [], 5))
        self.assertIsNone(metrics.precision_at_k([], [], 5))
        self.assertIsNone(metrics.ndcg_at_k(["a"], {"a": 0.0}, 5))
        self.assertIsNone(metrics.error_rate("hello", "", "word"))
        loc = metrics.temporal_localization([], [], 2.0)
        self.assertIsNone(loc["hit_rate"])
        self.assertEqual(loc["n_truth"], 0)

    def test_ranking_metrics_have_known_values(self) -> None:
        self.assertEqual(metrics.recall_at_k(["b", "x", "a"], ["a", "b"], 2), 0.5)
        self.assertEqual(metrics.precision_at_k(["a", "x"], ["a"], 2), 0.5)
        self.assertEqual(metrics.reciprocal_rank(["x", "a", "b"], ["b"]), 1.0 / 3.0)
        perfect = metrics.ndcg_at_k(["a", "b"], {"a": 2.0, "b": 2.0}, 2)
        worse = metrics.ndcg_at_k(["b", "x", "a"], {"a": 2.0}, 3)
        self.assertIsNotNone(perfect)
        self.assertIsNotNone(worse)
        assert perfect is not None and worse is not None
        self.assertAlmostEqual(perfect, 1.0, places=9)
        self.assertLess(worse, 1.0)

    def test_error_rates_measure_the_declared_unit(self) -> None:
        # The denominator is the REFERENCE length, never the hypothesis length.
        self.assertAlmostEqual(metrics.error_rate("the cat sat", "the cat sat on", "word"), 0.25)
        self.assertAlmostEqual(metrics.error_rate("the cat sat on mat", "the cat sat", "word"), 2 / 3)
        self.assertAlmostEqual(metrics.error_rate("abc", "abd", "char"), 1 / 3)

    def test_temporal_localization_hits_and_misses(self) -> None:
        out = metrics.temporal_localization([(10.0, 14.0), (40.0, 44.0)],
                                            [(10.0, 13.0), (80.0, 83.0), (41.0, 44.0)], 2.0)
        self.assertAlmostEqual(out["hit_rate"], 2 / 3)
        self.assertIsNotNone(out["mean_abs_error_s"])

    def test_counts_keep_their_denominators(self) -> None:
        c = metrics.Counts(n=2)
        c.add_mean("recall_at_5", None)
        self.assertNotIn("recall_at_5", c.metrics)
        c.add_mean("recall_at_5", 1.0)
        c.add_mean("recall_at_5", 0.0)
        self.assertEqual(c.metrics["recall_at_5"], 0.5)
        self.assertEqual(int(c.metrics["_n_recall_at_5"]), 2)


class FrozenSuiteTests(unittest.TestCase):
    """Denominators are frozen. Changing them is a decision, not a fix."""

    def test_family_and_case_counts_are_frozen(self) -> None:
        self.assertEqual(len(datasets.FAMILIES), 7)
        self.assertEqual(sum(len(f.cases) for f in datasets.FAMILIES), 38)
        self.assertEqual(len(datasets.GATED), 7)
        self.assertEqual(len(datasets.CORPUS), 29)

    def test_case_ids_unique_and_judgements_reference_real_documents(self) -> None:
        seen: set[str] = set()
        docs = set(datasets.CORPUS)
        for fam in datasets.FAMILIES:
            for case in fam.cases:
                self.assertNotIn(case.qid, seen, "duplicated qid silently changes the denominator")
                seen.add(case.qid)
                self.assertTrue(case.query.strip())
                self.assertTrue(set(case.relevant) <= docs, f"{case.qid} judges an unknown doc")
                self.assertTrue(set(case.forbidden_top1) <= docs, f"{case.qid} forbids an unknown doc")
                if fam.name == "abstention_no_answer_in_corpus":
                    self.assertEqual(case.relevant, ())
                else:
                    self.assertTrue(case.relevant, f"{case.qid} declares no answer-bearing doc")

    def test_floors_are_stated_and_are_fractions(self) -> None:
        for fam in datasets.FAMILIES:
            self.assertTrue(fam.floor, f"{fam.name} states no floor")
            for metric_name, floor in fam.floor.items():
                self.assertGreaterEqual(floor, 0.0)
                self.assertLessEqual(floor, 1.0)

    def test_corpus_documents_are_distinct_and_nontrivial(self) -> None:
        texts = list(datasets.CORPUS.values())
        self.assertEqual(len(set(texts)), len(texts))
        for doc_id, text in datasets.CORPUS.items():
            self.assertGreaterEqual(len(chunking.tokenize(text)), 5, f"{doc_id} is too thin to judge")

    def test_gated_capabilities_are_real_capability_names(self) -> None:
        for gated in datasets.GATED:
            self.assertTrue(catalog().for_capability(gated.capability),
                            f"{gated.name} names capability {gated.capability!r}, for which no "
                            f"adapter is registered - the gate would report a made-up status")
            self.assertTrue(gated.what_would_be_measured)
            # Each gate must name ONE registered candidate. Without this, a gate could sit
            # on a capability that has only an unrelated baseline adapter and still print a
            # plausible-looking reason string.
            self.assertTrue(gated.model, f"{gated.name} must name the candidate it would measure")
            spec = catalog().get(gated.model)
            self.assertIsNotNone(spec, f"{gated.name} names unregistered model {gated.model!r}")
            self.assertEqual(spec.capability, gated.capability, gated.name)

    def test_every_declared_capability_has_an_honest_registry_entry(self) -> None:
        """A capability listed in the contract must not be reportable as a mystery status."""
        from ruke_ml.contracts import CAPABILITIES
        from ruke_ml.models.registry import (AVAILABLE, EVALUATION_REQUIRED, LICENSE_REQUIRED,
                                             NOT_CONFIGURED, NOT_INSTALLED, NOT_SUPPORTED_BY_HOST)
        for cap in CAPABILITIES:
            st = catalog().status_for(cap)
            self.assertIn(st["status"], (AVAILABLE, EVALUATION_REQUIRED, LICENSE_REQUIRED,
                                         NOT_CONFIGURED, NOT_INSTALLED, NOT_SUPPORTED_BY_HOST), cap)
            self.assertTrue(st["models"], f"{cap} has no registered adapter at all")
            for entry in st["models"]:
                self.assertTrue(entry["id"] and entry["revision"], entry)
        # Things that genuinely run here must not be reported as missing...
        self.assertEqual(catalog().status_for("rerank")["status"], AVAILABLE,
                         "the BM25 baseline runs, so claiming it is not installed hides a real capability")
        self.assertEqual(catalog().status_for("embeddings")["status"], AVAILABLE,
                         "the hashed-lexical embedding path runs, so it must be registered")
        # ...and things that do not exist here must not look merely "not installed yet".
        for cap in ("artifacts.xlsx", "artifacts.docx", "artifacts.pptx"):
            self.assertEqual(catalog().status_for(cap)["status"], NOT_CONFIGURED,
                             f"{cap} is served by the verified TypeScript engine, not by a "
                             f"Python writer that could simply be installed")


class HarnessHonestyTests(unittest.TestCase):
    def test_a_missing_denominator_can_never_be_a_pass(self) -> None:
        fam = datasets.Family(name="x", description="d", floor={"recall_at_5": 0.5}, cases=())
        status, misses = harness._status(fam, {"recall_at_5": None})
        self.assertEqual(status, "failed")
        self.assertTrue(misses)

    def test_forbidden_top1_floor_is_a_ceiling_not_a_target(self) -> None:
        fam = datasets.Family(name="x", description="d", floor={"forbidden_top1_rate": 0.0}, cases=())
        self.assertEqual(harness._status(fam, {"forbidden_top1_rate": 0.0})[0], "passed")
        self.assertEqual(harness._status(fam, {"forbidden_top1_rate": 0.2})[0], "failed")

    def test_gated_rows_never_claim_a_result_and_come_from_the_catalog(self) -> None:
        report = harness.evaluate(top_k=5)
        self.assertEqual(len(report["gated_not_run"]), len(datasets.GATED))
        for row in report["gated_not_run"]:
            self.assertEqual(row["status"], "not_run")
            self.assertFalse(row["counted_in_denominator"])
            entry = next((m for m in catalog().status_for(row["capability"])["models"]
                          if m["id"] == row["model"]), None)
            self.assertIsNotNone(entry, row["model"])
            self.assertEqual(row["install_status"], entry["status"], row["name"])
            if entry["status"] == "available":
                # An installed candidate is still not a measured quality result.
                self.assertEqual(row["reason"], "installed_but_unmeasured", row["name"])
            else:
                self.assertEqual(row["reason"], entry["status"], row["name"])
            self.assertNotEqual(row["reason"], "available",
                                "a gated row must never read like a passing result")
        agg = report["aggregate"]
        self.assertIn("NOT part of this denominator", agg["denominator"])
        self.assertEqual(agg["gated_cases_not_run"], len(datasets.GATED))
        self.assertEqual(agg["cases_scored"], sum(len(f.cases) for f in datasets.FAMILIES))

    def test_a_pass_needs_measured_values_for_every_floor_metric(self) -> None:
        report = harness.evaluate(top_k=5)
        for fam in report["families"]:
            if fam["status"] != "passed":
                continue
            for metric_name in fam["floor"]:
                self.assertIsNotNone(fam["measured"].get(metric_name),
                                     f"{fam['name']} passed on a missing metric")
                self.assertGreaterEqual(fam["case_count_with_mean_denominators"][metric_name], 1)

    def test_abstention_cases_never_present_a_ranking(self) -> None:
        chunks = harness.build_corpus()
        fam = next(f for f in datasets.FAMILIES if f.name == "abstention_no_answer_in_corpus")
        for case in fam.cases:
            res = fusion.hybrid_retrieve(case.query, chunks, top_k=10)
            self.assertTrue(res.abstained,
                            f"{case.qid} presented top-K for a question the corpus cannot answer")
            self.assertTrue([r for r in res.reasons if not r.startswith("candidate_pool")])
            self.assertIn("coverage_note", res.coverage)

    def test_abstention_reasons_are_specific_not_generic_ok(self) -> None:
        chunks = harness.build_corpus()
        res = fusion.hybrid_retrieve("what causes crazing in a kiln-fired ceramic glaze",
                                     chunks, top_k=10)
        self.assertIn("only_one_common_term_matched_the_candidates", res.reasons)
        res2 = fusion.hybrid_retrieve("Zzyzx quarkonium spectroscopy", chunks, top_k=10)
        self.assertTrue(res2.abstained)
        self.assertIn("no_discriminating_term_exists_in_this_corpus", res2.reasons)

    def test_a_corpus_unique_identifier_may_stand_alone(self) -> None:
        chunks = harness.build_corpus()
        res = fusion.hybrid_retrieve("INV-2024-0007", chunks, top_k=5)
        self.assertFalse(res.abstained)
        self.assertEqual([s.chunk.source_id for s in res.results][0], "d_invoice_number")
        self.assertTrue(res.coverage["corpus_unique_term_matched"])

    def test_cli_exit_code_matches_the_report(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "eval.json"
            code = harness.main(["--out", str(out)])
            report = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(code, 0 if report["aggregate"]["overall_pass"] else 1)
            self.assertEqual(report["corpus"]["unit_of_relevance"], "document")


class TokenizerMechanismTests(unittest.TestCase):
    """Regression guard for the mark-gluing fix.

    A word that shreds at every combining mark makes retrieval in Devanagari,
    Telugu or vowelled Arabic impossible, and it manufactures single-letter
    "discriminating terms" that let an unanswerable query look answerable.
    """

    def test_indic_word_stays_one_token(self) -> None:
        toks = chunking.tokenize(HINDI_RAIN)
        self.assertEqual(toks, [HINDI_RAIN])
        for part in ("\u092c", "\u0930", "\u0936"):
            self.assertNotIn(part, toks)

    def test_marks_from_every_mark_category_glue_to_the_base_letter(self) -> None:
        rx = chunking._tokens_re()
        pairs = (("\u0915", "\u093F"), ("\u0915", "\u0940"), ("\u0628", "\u0652"),
                 ("e", "\u0301"), ("\u0430", "\u0488"))
        for base, mark in pairs:
            # tokenize NFC-normalizes first, so the glue must hold for the
            # composed and the decomposed spelling of the same mark alike.
            word = unicodedata.normalize("NFC", base + mark)
            self.assertEqual(rx.findall(word), [word],
                             f"U+{ord(mark):04X} ({unicodedata.category(mark)}) split the run")
        self.assertEqual(chunking.tokenize("e\u0301"), ["\u00e9", "e"],
                         "an accent is searchable with and without the mark")

    def test_vowelled_arabic_is_searchable_in_both_forms(self) -> None:
        vowelled = chunking.tokenize(AR_VOWELLED)
        self.assertIn(AR_BARE, vowelled)
        self.assertEqual(chunking.tokenize(AR_BARE), [AR_BARE])
        self.assertNotIn("\u062c", vowelled, "harakat must not slice the word into fragments")

    def test_spaceless_scripts_still_get_bigrams(self) -> None:
        toks = chunking.tokenize(JA_LINE)
        self.assertIn(JA_LINE[0:2], toks)
        self.assertIn(JA_LINE[1:3], toks)
        self.assertNotIn(JA_LINE, toks)

    def test_symbol_bearing_identifiers_survive(self) -> None:
        toks = chunking.tokenize("C++ and C# are not C; rustc 1.83")
        self.assertIn("C++", toks)
        self.assertIn("C#", toks)
        self.assertIn("1.83", toks)
        self.assertEqual(toks.count("c"), 1)

    def test_accented_latin_keeps_both_forms_as_one_token(self) -> None:
        toks = chunking.tokenize("na\u00efve \u00e9cole")
        self.assertIn("na\u00efve", toks)
        self.assertIn("naive", toks)
        self.assertIn("\u00e9cole", toks)
        self.assertIn("ecole", toks)
        for fragment in ("ve", "ve", "na", "cole"):
            self.assertNotIn(fragment, toks)


class FusionContractTests(unittest.TestCase):
    def test_neural_modes_refuse_instead_of_ranking_worse(self) -> None:
        chunks = harness.build_corpus()
        for mode in ("neural", "neural_rerank"):
            with self.assertRaises(ValueError):
                fusion.hybrid_retrieve("rustc", chunks, top_k=5, mode=mode)

    def test_informative_terms_exclude_both_ends_of_document_frequency(self) -> None:
        chunks = harness.build_corpus()
        inf = set(fusion.informative_terms("the rustc edition zzzzqqq", chunks))
        self.assertIn("rustc", inf)
        self.assertNotIn("zzzzqqq", inf, "a term absent from the corpus proves nothing")
        for term in inf:
            self.assertLessEqual(fusion.document_frequency([term], chunks)[term],
                                 max(1, int(len(chunks) * fusion.MAX_DF_RATIO)))

    def test_coverage_is_reported_on_every_run(self) -> None:
        chunks = harness.build_corpus()
        res = fusion.hybrid_retrieve("pip freeze pins exact versions", chunks, top_k=5)
        self.assertFalse(res.abstained)
        for key in ("corpus_chunks", "candidate_chunks", "returned", "coverage_note",
                    "discriminating_terms_matched_by_best_candidate"):
            self.assertIn(key, res.coverage)
        self.assertIs(res.coverage["exhaustive"], False)

    def test_empty_corpus_abstains_with_a_reason(self) -> None:
        res = fusion.hybrid_retrieve("anything", [], top_k=5)
        self.assertTrue(res.abstained)
        self.assertEqual(res.reasons, ["empty_corpus"])

    def test_invalid_top_k_abstains_instead_of_returning_nothing_quietly(self) -> None:
        chunks = harness.build_corpus()
        res = fusion.hybrid_retrieve("rustc edition", chunks, top_k=0)
        self.assertTrue(res.abstained)
        self.assertEqual(res.reasons, ["invalid_top_k"])

    def test_rrf_prefers_agreement_between_views(self) -> None:
        # "b" is mid-ranked in both views; "a" is first in one and last in the other.
        # Reciprocal rank rewards the consensus candidate, which a best-view rank would not.
        fused = fusion.reciprocal_rank_fusion([["a", "b", "c"], ["b", "c", "a"]], [1.0, 1.0])
        self.assertGreater(fused["b"], fused["a"])
        self.assertGreater(fused["b"], fused["c"])
        with self.assertRaises(ValueError):
            fusion.reciprocal_rank_fusion([["a"], ["b"]], [1.0])


if __name__ == "__main__":
    unittest.main()
