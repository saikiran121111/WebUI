"""An allocation refusal is a resource condition, never an asset condition.

WHY THESE TESTS EXIST, with the measurement behind them (2026-11-17, this host):
the enforceable per-worker commit ceiling was derived from a RESIDENT working-set
peak (388 MiB) while the same load measured 1,276 MiB of COMMIT charge, which is
the quantity a Windows job object actually caps. The pinned whisper worker was
therefore started under a 776 MiB ceiling it could not load inside, died in
oneMKL with "mkl_malloc: failed to allocate memory", and the caller was told
reason=model_unavailable with a human step of "re-prepare the pinned asset" -
i.e. the report told the user to destroy weights that were working on disk.
Raising the ceiling to 3,072 MiB made the SAME job transcribe for real
(see docs/overnight/logs/f54-g26-asr-{default,raised}-1.log and
f55-g26-asr-fixed-1.log, which shows the derived ceiling at 1,914 MiB and the
same real transcript with no override).

These tests pin the class of fix, not the example: the ceiling derivation, the
per-adapter classification, and the single funnel that catches any adapter which
still flattens an allocation refusal.
"""
from __future__ import annotations

import unittest
from unittest import mock

from ruke_ml import allocations
from ruke_ml.contracts import JobRequest
from ruke_ml.documents import ocr_paddle
from ruke_ml.models import lifecycle, resources
from ruke_ml.retrieval.nn_embed import NeuralEmbeddingError
from ruke_ml.retrieval.nn_rerank import CrossEncoderError
from ruke_ml.speech import whisper_ct2
from ruke_ml.workers import runner
from ruke_ml.workers.jobs import typed_from_kind

MKL = "RuntimeError: mkl_malloc: failed to allocate memory"
ASR_COMMIT_MIB = 1_276            # measured commit peak of the owned whisper tree


def fake_memory(available_mib: int, total_mib: int = 63 * 1024,
                commit_avail_mib: int = 27 * 1024) -> resources.Memory:
    return resources.Memory(total_mib=total_mib, available_mib=available_mib,
                            commit_total_mib=total_mib + commit_avail_mib,
                            commit_avail_mib=commit_avail_mib,
                            source="GlobalMemoryStatusEx")


class Classifier(unittest.TestCase):
    POSITIVES = (
        MKL,
        "OSError: [Errno 12] Cannot allocate memory",
        "MemoryError: unable to allocate 2.0 GiB",
        "terminate called after throwing an instance of 'std::bad_alloc'",
        "The paging file is too small for this operation to complete.",
        "ResourceExhaustedError: 0x8007000e",
        "CUDA out of memory. Tried to allocate 1.20 GiB",
    )
    NEGATIVES = (
        "Local files for PaddlePaddle/PaddleOCR-VL-1.6 not found in cache",
        "onnxruntime could not load model.onnx on CPU: [ErrNo 2] No such file or directory",
        "the file could not be parsed; re-export it from the source application",
        "no adapter implemented for this capability",
        "", "   ", None,
    )

    def test_every_positive_text_says_an_allocation_was_refused(self):
        for text in self.POSITIVES:
            self.assertTrue(allocations.is_allocation_failure(text), text)

    def test_a_missing_asset_is_never_read_as_an_allocation(self):
        for text in self.NEGATIVES:
            self.assertFalse(allocations.is_allocation_failure(text), text)

    def test_describe_states_the_law_and_the_evidence(self):
        d = allocations.describe()
        self.assertTrue(d["markers"])
        self.assertIn("resource condition", str(d["law"]))
        self.assertIn("e03-speech", str(d["evidence"]))


class TypedFunnel(unittest.TestCase):
    """The class-level guard: any adapter that still flattens must not reach the caller."""

    def test_load_failed_with_an_allocation_text_becomes_memory_pressure(self):
        err = typed_from_kind("load_failed", MKL, capability="speech.asr")
        self.assertEqual(err.reason, "memory_pressure")
        self.assertTrue(err.retryable)
        self.assertIn("speech.asr", err.capability)
        self.assertNotIn("re-prepare", err.human_step.lower())
        self.assertIn("do not re-download", err.human_step.lower())

    def test_an_adapter_supplied_wrong_step_is_dropped_not_kept(self):
        err = typed_from_kind("asset_missing", MKL,
                              human_step="prepare the pinned asset explicitly")
        self.assertEqual(err.reason, "memory_pressure")
        self.assertNotIn("prepare the pinned asset", err.human_step)

    def test_a_decode_oom_is_not_reported_as_corrupt_input(self):
        err = typed_from_kind("decode_failed", "ffmpeg: out of memory - cannot allocate buffer")
        self.assertEqual(err.reason, "memory_pressure")

    def test_a_genuine_asset_problem_stays_an_asset_problem(self):
        err = typed_from_kind("asset_missing",
                              "PaddlePaddle/PaddleOCR-VL-1.6 is not present in the local cache")
        self.assertEqual(err.reason, "model_unavailable")
        self.assertIn("models.prepare", err.human_step)

    def test_a_missing_engine_stays_a_configuration_problem(self):
        err = typed_from_kind("engine_missing", "no tesseract executable was found")
        self.assertEqual(err.reason, "not_configured")

    def test_an_explicit_allocation_kind_passes_through_unchanged(self):
        err = typed_from_kind("allocation_failed", MKL)
        self.assertEqual(err.reason, "memory_pressure")
        self.assertIn("mkl_malloc", err.message)   # adapter provenance survives

    def test_the_adapter_kind_stays_in_the_message_after_reclassification(self):
        err = typed_from_kind("load_failed", MKL)
        self.assertTrue(err.message.startswith("load_failed:"), err.message)


class CeilingDerivation(unittest.TestCase):
    """The ceiling must clear the quantity it is expressed in: commit, not resident RAM."""

    def setUp(self):
        self.pool = lifecycle.WorkerPool()
        self.addCleanup(self.pool.stop_all)

    def _memory(self, available_mib: int):
        patch = mock.patch.object(resources, "system_memory",
                                  return_value=fake_memory(available_mib))
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_ceiling_clears_the_measured_commit_demand(self):
        self._memory(20_000)
        limit, note = self.pool._ceiling_bytes("speech.asr", heavy=True)
        self.assertGreaterEqual(limit >> 20, ASR_COMMIT_MIB + lifecycle.COMMIT_CEILING_MARGIN_MIB,
                                "a ceiling under the measured commit demand squeezes the load")
        self.assertEqual(note["commit_estimate"], "measured")
        self.assertEqual(note["measured_commit_peak_mib"], ASR_COMMIT_MIB)
        self.assertNotIn("ceiling_below_measured_commit_demand", note)

    def test_a_tight_host_refuses_instead_of_squeezing(self):
        self._memory(1_100)              # 1,100 free - 1,024 floor = a 76 MiB ceiling
        limit, note = self.pool._ceiling_bytes("speech.asr", heavy=True)
        self.assertTrue(note.get("ceiling_below_measured_commit_demand"), note)
        self.assertEqual(note["commit_shortfall_mib"],
                         ASR_COMMIT_MIB + lifecycle.COMMIT_CEILING_MARGIN_MIB - (limit >> 20))

    def test_a_capability_without_a_measured_commit_says_so_instead_of_guessing(self):
        self._memory(20_000)
        _limit, note = self.pool._ceiling_bytes("documents.parse", heavy=False)
        self.assertEqual(note["commit_estimate"], "unmeasured")
        self.assertIn("never been measured", note["commit_basis"])

    def test_the_shortfall_is_visible_through_the_commit_helper(self):
        self._memory(1_100)
        short = self.pool._commit_ceiling_shortfall("speech.asr")
        self.assertIsNotNone(short)
        self.assertEqual(short["measured_commit_peak_mib"], ASR_COMMIT_MIB)

    def test_no_shortfall_when_the_host_can_hold_it(self):
        self._memory(20_000)
        self.assertIsNone(self.pool._commit_ceiling_shortfall("speech.asr"))


class AdmissionRefusal(unittest.TestCase):
    def setUp(self):
        self.pool = lifecycle.WorkerPool()
        self.addCleanup(self.pool.stop_all)
        patch = mock.patch.object(resources, "system_memory", return_value=fake_memory(1_100))
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_refusal_is_typed_and_names_the_commit_shortfall(self):
        req = JobRequest(request_id="t", run_id="t", job_id="t", capability="speech.asr",
                         payload={}, deadline_s=60.0)
        res = self.pool._admission_refusal(req)
        self.assertIsNotNone(res)
        assert res is not None and res.error is not None
        self.assertEqual(res.error.reason, "memory_pressure")
        self.assertTrue(res.error.retryable)
        self.assertNotIn("re-prepare", res.error.human_step.lower())
        self.assertIn("already on disk", res.error.human_step.lower())
        self.assertEqual(res.payload.get("refused_for"),
                         "commit_ceiling_below_measured_demand")
        self.assertIn("1276", res.error.message.replace(",", ""))


class AdapterClassification(unittest.TestCase):
    """Each adapter states the condition itself, so the funnel is a backstop, not the design."""

    def test_whisper_maps_an_allocation_to_allocation_failed(self):
        def boom(*_a, **_k):
            raise RuntimeError("mkl_malloc: failed to allocate memory")

        class Stub:
            WhisperModel = staticmethod(boom)

        with mock.patch.object(whisper_ct2, "import_backend", return_value=Stub):
            with self.assertRaises(whisper_ct2.BackendUnavailable) as got:
                whisper_ct2.load_model("Systran/faster-whisper-base")
        self.assertEqual(got.exception.kind, "allocation_failed")
        self.assertNotIn("prepare the pinned asset", got.exception.human_step)

    def test_whisper_still_maps_a_real_cache_miss_to_asset_missing(self):
        def boom(*_a, **_k):
            raise RuntimeError("Local file not found in cache")

        class Stub:
            WhisperModel = staticmethod(boom)

        with mock.patch.object(whisper_ct2, "import_backend", return_value=Stub):
            with self.assertRaises(whisper_ct2.BackendUnavailable) as got:
                whisper_ct2.load_model("Systran/faster-whisper-base")
        self.assertEqual(got.exception.kind, "asset_missing")

    def test_the_onnx_adapters_use_memory_pressure_for_an_allocation_refusal(self):
        for cls in (NeuralEmbeddingError, CrossEncoderError):
            message = "onnxruntime could not load model.onnx on CPU: failed to allocate memory"
            reason = ("memory_pressure" if allocations.is_allocation_failure(message)
                      else "model_unavailable")
            self.assertEqual(cls(message, reason).reason, "memory_pressure")

    def test_the_worker_handlers_answer_with_the_right_human_action(self):
        reason, step = runner._retrieval_failure("model_unavailable",
                                                 "onnxruntime could not load ... cannot allocate")
        self.assertEqual(reason, "memory_pressure")
        self.assertNotIn("prepare the pinned embedding asset", step)
        reason2, step2 = runner._retrieval_failure("model_unavailable", "not present in the cache")
        self.assertEqual(reason2, "model_unavailable")
        self.assertIn("prepare the pinned embedding asset", step2)
        reason3, step3 = runner._retrieval_failure("not_configured", "No module named 'tokenizers'")
        self.assertEqual(reason3, "not_configured")
        self.assertIn("pyproject.toml", step3)

    def test_the_ocr_parent_classifies_its_three_load_failures_by_message(self):
        refused = ocr_paddle.load_refusal("OCR worker failed to load the pipeline: "
                                          "MemoryError: unable to allocate array")
        self.assertEqual(refused.kind, "allocation_failed")
        self.assertIn("on disk", refused.human_step)
        self.assertIn("do not re-prepare", refused.human_step.lower())
        genuine = ocr_paddle.load_refusal("the OCR worker exited before reporting ready (code 1); "
                                          "Protobuf gencode version mismatch",
                                          fallback_step="verify the pinned runtime and the two "
                                                        "model directories")
        self.assertEqual(genuine.kind, "load_failed")
        self.assertIn("pinned runtime", genuine.human_step)


if __name__ == "__main__":
    unittest.main()
