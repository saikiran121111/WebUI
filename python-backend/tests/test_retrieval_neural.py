"""The neural retrieval backend must EXECUTE, stay labelled, and fail typed.

These are real-engine tests: they load the pinned ONNX checkpoint (CPU provider) and
assert what it actually produced. They are not mocks. They do NOT claim quality parity
or a neural advantage over the lexical baseline - the frozen harness numbers in
docs/overnight/TEST-RESULTS.md carry the ranking claims, together with their sample
sizes and the explicit note that this suite does not discriminate the two backends.

The repo's python suite is unittest-based (pytest is not installed in .venv), so the
stub-seam below is an explicit attribute swap plus addCleanup restore.
"""
from __future__ import annotations

import gc
import json
import math
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from ruke_ml.eval import datasets
from ruke_ml.eval.embed_vectors import produce
from ruke_ml.eval.harness import build_corpus
from ruke_ml.eval.methods import load_vectors
from ruke_ml.models.registry import catalog
from ruke_ml.retrieval import fusion
from ruke_ml.retrieval import nn_embed
from ruke_ml.retrieval import nn_rerank
from ruke_ml.retrieval.chunking import Chunk
from ruke_ml.retrieval.embeddings import embed_texts, lexical_embed
from ruke_ml.retrieval.reranker import rerank


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _chunks() -> list[Chunk]:
    return [
        Chunk(chunk_id="c-paraphrase", text="revenue rose four percent compared with last year",
              source_id="s1", source_hash="h1", loc={"page": 1}),
        Chunk(chunk_id="c-table", text="Appendix B lists the spare-part catalogue numbers",
              source_id="s1", source_hash="h1", loc={"page": 2}),
        Chunk(chunk_id="c-answer", text="the quarterly revenue grew by four percent year over year",
              source_id="s2", source_hash="h2", loc={"page": 3}),
    ]


class AssetIdentity(unittest.TestCase):
    """Readiness is a verified digest, not a nonempty folder."""

    def test_pinned_asset_verifies_by_digest_not_by_being_a_nonempty_folder(self):
        state = nn_embed.check_assets()
        self.assertTrue(state.ok, state.detail)
        self.assertEqual(state.digest, nn_embed.PINNED_ONNX_SHA256)

    def test_swapped_checkpoint_is_refused_rather_than_measured(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            onnx = root / nn_embed.MODEL_ID / "onnx"
            onnx.mkdir(parents=True)
            (onnx / "model.onnx").write_bytes(b"not the pinned weights, but definitely not empty")
            (root / nn_embed.MODEL_ID / "tokenizer.json").write_text("{}", encoding="utf-8")
            state = nn_embed.check_assets(root=root)
            self.assertFalse(state.ok)
            self.assertEqual(state.reason, "model_unavailable")
            self.assertIn("expected", state.detail)

    def test_weights_without_tokenizer_are_not_ready(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            onnx = root / nn_embed.MODEL_ID / "onnx"
            onnx.mkdir(parents=True)
            (onnx / "model.onnx").write_bytes(b"x")
            state = nn_embed.check_assets(expected_sha256="", root=root)
            self.assertFalse(state.ok)
            self.assertIn("tokenizer", state.detail)


class RealEngineExecution(unittest.TestCase):
    def test_neural_vectors_are_real_normalized_and_stable(self):
        vectors, meta, info = nn_embed.neural_embed_texts(
            ["the turbine bearing failed at 41 hours", "the turbine bearing failed at 41 hours"])
        self.assertEqual(meta.dim, 384)
        self.assertEqual(len(vectors[0]), 384)
        self.assertEqual(meta.model.provider, "onnxruntime-cpu")
        self.assertEqual(info["backend"]["providers"], ["CPUExecutionProvider"])
        for v in vectors:
            self.assertAlmostEqual(math.sqrt(sum(x * x for x in v)), 1.0, places=9)
        self.assertEqual(vectors[0], vectors[1],
                         "the same text must not produce two different vectors")

    def test_paraphrase_scores_above_unrelated_on_this_host(self):
        vecs = nn_embed.neural_embed_texts([
            "the quarterly revenue grew by four percent year over year",
            "revenue rose four percent compared with last year",
            "a kiln-fired ceramic glaze crazes when the clay body shrinks more than the glaze",
        ])[0]
        paraphrase, unrelated = _cos(vecs[0], vecs[1]), _cos(vecs[0], vecs[2])
        self.assertGreater(paraphrase, unrelated + 0.2, (paraphrase, unrelated))

    def test_embed_texts_labels_the_mode_that_actually_ran(self):
        lex_vectors, lex_meta = embed_texts(["revenue grew"], quality_mode="lexical")
        self.assertEqual(lex_meta.model.id, "ruke-lexical-hash")
        self.assertEqual(len(lex_vectors[0]), 512)
        nn_vectors, nn_meta = embed_texts(["revenue grew"], quality_mode="neural")
        self.assertEqual(nn_meta.model.id, nn_embed.MODEL_ID)
        self.assertEqual(nn_meta.model.revision, nn_embed.PINNED_REVISION)
        self.assertEqual(len(nn_vectors[0]), 384)

    def test_unknown_embedding_mode_lists_what_this_process_runs(self):
        with self.assertRaises(ValueError) as ctx:
            embed_texts(["x"], quality_mode="sentis")
        self.assertIn("installed modes", str(ctx.exception))
        self.assertIn("neural", str(ctx.exception))


class LabellingAndRefusals(unittest.TestCase):
    def test_neural_reranker_ranks_by_dense_similarity_and_names_itself(self):
        scored, used = rerank("how much did quarterly revenue grow", _chunks(), mode="neural")
        self.assertEqual(used, "neural_biencoder_minilm")
        top = [s.chunk.chunk_id for s in scored][:2]
        self.assertIn("c-answer", top)
        self.assertIn("c-paraphrase", top)
        self.assertEqual(scored[-1].chunk.chunk_id, "c-table")
        self.assertGreaterEqual(scored[0].score, -1.0)
        self.assertLessEqual(scored[0].score, 1.0)

    def test_lexical_rerank_stays_labelled_lexical(self):
        _scored, used = rerank("revenue", _chunks(), mode="lexical")
        self.assertEqual(used, "lexical")

    def test_cross_encoder_rerank_is_not_claimed_without_a_pinned_asset(self):
        # This expectation is stale as of F27: the cross-encoder asset IS pinned and present,
        # so an unknown/unpinned ranker is the correct refusal case. An unpinned candidate
        # (Qwen3-Reranker) must never be reachable through a similar-sounding mode string.
        with self.assertRaises(ValueError) as ctx:
            rerank("q", _chunks(), mode="cross_encoder_qwen3_unpinned")
        self.assertIn("installed modes", str(ctx.exception))
        self.assertIn("neural_cross_encoder", str(ctx.exception))
        self.assertIn("cross-encoder", str(ctx.exception))

    def test_cross_encoder_mode_refuses_rather_than_running_bm25_when_asset_absent(self):
        # Point the adapter at a directory with no weights. The neural mode must raise typed,
        # NOT quietly run the bi-encoder or BM25 and publish the result as neural.
        previous = os.environ.get(nn_rerank.ENV_RERANK_DIR)
        with tempfile.TemporaryDirectory() as raw:
            os.environ[nn_rerank.ENV_RERANK_DIR] = raw
            nn_rerank.reset_backend()
            try:
                with self.assertRaises(nn_rerank.CrossEncoderError) as ctx:
                    rerank("q", _chunks(), mode="cross_encoder")
            finally:
                if previous is None:
                    os.environ.pop(nn_rerank.ENV_RERANK_DIR, None)
                else:
                    os.environ[nn_rerank.ENV_RERANK_DIR] = previous
                nn_rerank.reset_backend()
        self.assertEqual(ctx.exception.reason, "model_unavailable")
        self.assertIn("cross-encoder", str(ctx.exception).lower())
        self.assertIn("pinned", str(ctx.exception))

    def test_cross_encoder_asset_checks_are_specific_not_a_nonempty_folder(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            onnx = root / nn_rerank.MODEL_ID / "onnx"
            onnx.mkdir(parents=True)
            (onnx / "model.onnx").write_bytes(b"truncated download")
            (root / nn_rerank.MODEL_ID / "tokenizer.json").write_text("{}", encoding="utf-8")
            short = nn_rerank.check_assets(root=root)
        self.assertFalse(short.ok)
        self.assertIn("below the pinned minimum", short.detail)
        # Same file identity check against the real project asset: a different digest is a
        # different model, whatever the folder or tag claims.
        mismatch = nn_rerank.check_assets(expected_sha256="0" * 64)
        self.assertFalse(mismatch.ok)
        self.assertEqual(mismatch.digest, nn_rerank.PINNED_ONNX_SHA256)
        self.assertIn("refusing to score with an unverified checkpoint", mismatch.detail)


class CrossEncoderExecution(unittest.TestCase):
    """Real engine: the pinned cross-encoder ONNX checkpoint, CPU provider, joint scoring."""

    def test_cross_encoder_ranks_and_names_its_own_mode(self):
        scored, used = rerank("how much did quarterly revenue grow", _chunks(),
                              mode="cross_encoder")
        self.assertEqual(used, nn_rerank.MODE_NAME)
        self.assertNotEqual(used, "neural_biencoder_minilm")
        self.assertNotEqual(used, "lexical")
        self.assertEqual(len(scored), len(_chunks()))
        for s in scored:
            self.assertGreaterEqual(s.score, 0.0)
            self.assertLessEqual(s.score, 1.0)
        self.assertGreater(scored[0].score, scored[-1].score)

    def test_cross_encoder_backend_reports_digest_inputs_and_cpu_only(self):
        rerank("q", _chunks(), mode="cross_encoder")
        info = nn_rerank.backend_info()
        self.assertTrue(info["loaded"])
        self.assertEqual(info["providers"], ["CPUExecutionProvider"])
        self.assertEqual(info["digest"], nn_rerank.PINNED_ONNX_SHA256)
        self.assertIn("input_ids", info["inputs"])
        self.assertIn("token_type_ids", info["inputs"],
                      "this graph declares token_type_ids; not feeding it changes the scores")

    def test_cross_encoder_scores_are_deterministic_and_pair_joint(self):
        a, _ = nn_rerank.cross_encoder_scores("the turbine stalled",
                                              ["the turbine stalled", "a kiln glaze crazes"])
        b, _ = nn_rerank.cross_encoder_scores("the turbine stalled",
                                              ["the turbine stalled", "a kiln glaze crazes"])
        self.assertEqual(a, b)
        self.assertGreater(a[0], a[1])
        # Joint scoring means the SAME passage scores differently against different queries -
        # something a bi-encoder vector dot product cannot express.
        c, _ = nn_rerank.cross_encoder_scores("what kind of pottery glaze fails?",
                                              ["the turbine stalled", "a kiln glaze crazes"])
        self.assertGreater(c[1], a[1])

    def test_empty_query_is_typed_input_rejection_not_a_model_run(self):
        with self.assertRaises(nn_rerank.CrossEncoderError) as ctx:
            nn_rerank.cross_encoder_scores("", ["some passage"])
        self.assertEqual(ctx.exception.reason, "input_rejected")

    def test_registry_publishes_the_cross_encoder_row_as_executable(self):
        specs = {s.id: s for s in catalog().executable_for("rerank")}
        self.assertIn(nn_rerank.MODEL_ID, specs)
        row = specs[nn_rerank.MODEL_ID]
        self.assertEqual(row.adapter, "ruke_ml.retrieval.nn_rerank")
        self.assertEqual(row.provider, "onnxruntime-cpu")
        self.assertEqual(row.revision, nn_rerank.PINNED_REVISION_COMMIT)
        # Truthfulness: the registry must not claim what the probe did not measure.
        self.assertIs(row.verified.get("beats_dense_biencoder_on_g05_set"), False)
        self.assertIs(row.verified.get("numeric_fact_case_fixed"), False)
        # In the other direction too: the caller stopped being hypothetical at D-058 and was
        # executed end-to-end through POST /api/ruke/ml/job at F66
        # (logs/f66-rerank-live-route-1.log). If this flips back to False, either the wiring
        # regressed or the registry went stale - fix the truth, not the assertion.
        self.assertIs(row.verified.get("production_caller_wired"), True)
        self.assertEqual(row.claims.get("languages"), [])
        self.assertNotIn("Qwen/Qwen3-Reranker-0.6B", specs)

    def test_worker_rerank_payload_reports_engine_quality_and_truncation(self):
        from ruke_ml.contracts import JobRequest
        from ruke_ml.workers.runner import _do_rerank
        chunks = [{"chunk_id": "c1", "text": "the quarterly revenue grew by four percent",
                   "source_id": "s1"},
                  {"chunk_id": "c2", "text": "Appendix B lists spare-part catalogue numbers",
                   "source_id": "s1"}]
        for mode, expect_engine in (("lexical", False), ("neural", True),
                                   ("cross_encoder", True)):
            res = _do_rerank(JobRequest(request_id="r", run_id="run", job_id="j-" + mode,
                                        capability="rerank",
                                        payload={"query": "how much did revenue grow",
                                                 "chunks": chunks, "mode": mode}))
            self.assertEqual(res.state, "ready", res.error)
            used = res.payload["mode_actually_used"]
            self.assertEqual(used, {"lexical": "lexical", "neural": "neural_biencoder_minilm",
                                    "cross_encoder": nn_rerank.MODE_NAME}[mode])
            self.assertTrue(res.payload["quality_note"])
            self.assertEqual(bool(res.payload["engine"]), expect_engine)
            if used == nn_rerank.MODE_NAME:
                self.assertEqual(res.payload["engine"]["id"], nn_rerank.MODEL_ID)
                self.assertTrue(res.payload["truncation_note"])
            else:
                self.assertEqual(res.payload["truncation_note"], "")
            self.assertIn("cannot recover", res.coverage.note)
        # An unknown mode must answer typed-failed, never ready-with-lexical-scores.
        bad = _do_rerank(JobRequest(request_id="r", run_id="run", job_id="j-bad",
                                    capability="rerank",
                                    payload={"query": "q", "chunks": chunks,
                                             "mode": "cross_encoder_qwen3_unpinned"}))
        self.assertEqual(bad.state, "failed")
        self.assertEqual(bad.error.reason, "evaluation_required")

    def test_hybrid_neural_reports_the_embedder_that_ran(self):
        res = fusion.hybrid_retrieve("the bearing stopped working after 41 hours of operation",
                                    _chunks(), top_k=3, mode="hybrid_neural")
        self.assertEqual(res.method, "hybrid_neural")
        self.assertIn(nn_embed.MODEL_ID, res.dense_view)
        self.assertIn("dense_top_similarity", res.coverage)
        self.assertIn("dense_margin_over_median", res.coverage)
        self.assertEqual(res.coverage["dense_view"], res.dense_view)

    def test_hybrid_lexical_is_never_relabelled_as_neural(self):
        res = fusion.hybrid_retrieve("the bearing stopped working", _chunks(), top_k=3,
                                    mode="hybrid_lexical")
        self.assertEqual(res.method, "hybrid_lexical")
        self.assertEqual(res.dense_view, "hashed-lexical-vector")
        self.assertNotIn("Xenova", json.dumps(res.coverage))

    def test_hybrid_neural_never_falls_back_to_hashed_vectors_silently(self):
        original = nn_embed.neural_embed_texts

        def boom(_texts):
            raise nn_embed.NeuralEmbeddingError("asset gone", "model_unavailable")

        nn_embed.neural_embed_texts = boom
        self.addCleanup(setattr, nn_embed, "neural_embed_texts", original)
        with self.assertRaises(nn_embed.NeuralEmbeddingError):
            fusion.hybrid_retrieve("anything at all", _chunks(), top_k=3, mode="hybrid_neural")

    def test_weak_dense_view_still_abstains_on_a_bogus_query(self):
        res = fusion.hybrid_retrieve("Zzyzx quarkonium spectroscopy", _chunks(), top_k=3,
                                    mode="hybrid_neural")
        self.assertTrue(res.abstained, res.coverage)
        self.assertIs(res.coverage["dense_evidence"], False)
        self.assertIn("dense_view_gave_no_independent_evidence", res.reasons)


class HarnessContract(unittest.TestCase):
    def test_produced_vector_file_passes_the_harness_vector_contract(self):
        payload = produce("neural")
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / ("vectors-" + uuid.uuid4().hex + ".json")
            path.write_text(json.dumps(payload), encoding="utf-8")
            chunks = build_corpus()
            queries = [(c.qid, c.query) for fam in datasets.FAMILIES for c in fam.cases]
            vs = load_vectors(path, chunks, queries)
            self.assertEqual(vs.meta.dim, 384)
            self.assertEqual(vs.meta.model.id, nn_embed.MODEL_ID)


class RegistryTruthfulness(unittest.TestCase):
    def test_registry_rows_for_retrieval_are_executable_not_decorative(self):
        ids = {s.id for s in catalog().executable_for("embeddings")}
        self.assertIn(nn_embed.MODEL_ID, ids)
        self.assertIn("ruke-lexical-hash", ids)
        self.assertIn("ruke-neural-biencoder-minilm",
                      {s.id for s in catalog().executable_for("rerank")})
        # The unpinned candidates must NOT be executable, or "available" would be a lie.
        self.assertNotIn("Qwen/Qwen3-Embedding-0.6B", ids)

    def test_lexical_baseline_is_still_importable_and_unchanged(self):
        vec = lexical_embed("revenue grew four percent")
        self.assertEqual(len(vec), 512)
        self.assertGreater(math.sqrt(sum(x * x for x in vec)), 0.99)


def tearDownModule():
    """Release the ONNX session this file loaded, so ~300 MiB of weights is not held
    for the rest of the discovery run. Deliberately NOT a sys.modules reset: numpy and
    onnxruntime are C-extension packages and a second import in the same process raises
    "cannot load module more than once per process" - that mistake broke the audio
    decode test on 2026-11-17. The supervisor's startup contract is now a snapshot of
    its own import time (see ruke_ml.supervisor.HEAVY_AT_IMPORT), so a legitimately
    loaded engine here cannot be mistaken for a supervisor import."""
    nn_embed.reset_backend()
    nn_rerank.reset_backend()
    gc.collect()


if __name__ == "__main__":
    unittest.main()
