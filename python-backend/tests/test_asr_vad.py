"""Speech gating (VAD) on the ASR path: on by default, reported, bounded retry only.

The measured reason this behaviour is pinned here (docs/overnight/logs
/f58-g33-asr-vad-1.log and f58b-g35-vad-e03-1.log, both real engine runs): the pinned
faster-whisper default leaves the voice-activity filter OFF, and ungated the model emits
"You" across digital silence and six "." segments across an audible tone, while gated it
keeps the same words on real speech. So gating is the quality choice, not a preference.

What these tests pin:
  * gating is requested by default and the run SAYS which state it ended in;
  * a caller can turn it off and the report says the run can emit text over silence;
  * a backend that refuses its own filter gets ONE ungated retry, no more, and the
    refusal is named rather than hidden;
  * an allocation refusal is never retried as if it were a VAD problem;
  * a missing local VAD asset is reported, never repaired by a download.
"""
from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ruke_ml import allocations                      # noqa: E402
from ruke_ml.speech import whisper_ct2               # noqa: E402


class FakeSegment:
    def __init__(self, start: float, end: float, text: str) -> None:
        self.start, self.end, self.text = start, end, text
        self.words = None


class FakeInfo:
    language = None
    language_probability = None


class FakeModel:
    """Records the kwargs of every call, and fails on the calls the test chooses."""

    def __init__(self, failures=None, segments=None) -> None:
        self.calls: list[dict] = []
        self.failures = dict(failures or {})
        self.segments = list(segments if segments is not None
                            else [FakeSegment(0.5, 1.0, "real words")])

    def transcribe(self, audio, **kwargs):
        index = len(self.calls)
        self.calls.append(kwargs)
        boom = self.failures.get(index)
        if boom is not None:
            raise boom
        return iter(self.segments), FakeInfo()


def _run(model, vad_asset="available", duration=1.0, **kwargs):
    """Call the adapter the way the worker does, without touching ffmpeg or the network."""
    def fake_windows(duration_, *, window_s, overlap_s, src):
        class W:
            def __init__(self, a, b):
                self.start_s, self.end_s = a, b
        return [W(a, a + window_s) for a in range(0, int(duration_), int(window_s))]
    with mock.patch.object(whisper_ct2, "load_model", lambda mid, allow_download=False: model), \
         mock.patch.object(whisper_ct2, "vad_asset_state", lambda: vad_asset), \
         mock.patch.object(whisper_ct2, "_audio_array", lambda src, dur, *, ffmpeg="": [0.0] * 16000), \
         mock.patch.object(whisper_ct2, "_decode_window", lambda src, a, b, *, ffmpeg="": [0.0] * 16000), \
         mock.patch.object(whisper_ct2, "pcm_windows", fake_windows):
        return whisper_ct2.transcribe("x.wav", model_id="fake/model", duration=duration, **kwargs)


class GatingIsTheDefault(unittest.TestCase):
    def test_gating_is_requested_by_default_and_the_run_says_it_applied(self):
        model = FakeModel()
        out = _run(model)
        self.assertEqual(len(model.calls), 1, "no failure means no retry")
        self.assertIs(model.calls[0].get("vad_filter"), True)
        self.assertEqual(out.vad_state, "applied")
        self.assertTrue(out.vad_filter)
        payload = out.as_payload()
        self.assertEqual(payload["vad_state"], "applied")
        self.assertTrue(payload["vad_filter"])
        self.assertIn("speech-activity gating was applied", out.note)
        # The words are the point: gating must not cost the transcript anything.
        self.assertEqual(out.text, "real words")

    def test_coverage_still_reports_decoded_audio_not_speech(self):
        out = _run(FakeModel())
        self.assertTrue(out.complete)
        self.assertEqual([[round(a, 3), round(b, 3)] for a, b in out.examined], [[0.0, 1.0]])

    def test_a_caller_can_turn_it_off_and_the_report_says_what_that_means(self):
        model = FakeModel()
        out = _run(model, vad_filter=False)
        self.assertNotIn("vad_filter", model.calls[0],
                         "an off request must not smuggle the kwarg through")
        self.assertEqual(out.vad_state, "not_requested")
        self.assertFalse(out.vad_filter)
        self.assertIn("turned speech gating off", out.note)

    def test_a_missing_asset_is_reported_and_never_downloaded(self):
        for state in ("asset_missing", "runtime_missing"):
            model = FakeModel()
            out = _run(model, vad_asset=state)
            self.assertNotIn("vad_filter", model.calls[0])
            self.assertEqual(out.vad_state, state)
            self.assertIn("never", out.note)
            self.assertIn("silero", out.note)


class BoundedCorrectionOnly(unittest.TestCase):
    def test_a_signature_that_lacks_the_kwarg_gets_one_ungated_retry(self):
        boom = TypeError("transcribe() got an unexpected keyword argument 'vad_filter'")
        model = FakeModel(failures={0: boom})
        out = _run(model)
        self.assertEqual(len(model.calls), 2, "exactly one correction attempt")
        self.assertIs(model.calls[0].get("vad_filter"), True)
        self.assertNotIn("vad_filter", model.calls[1])
        self.assertEqual(out.vad_state, "unsupported_by_backend")
        self.assertEqual(out.text, "real words", "the retry must preserve the evidence")

    def test_a_vad_runtime_failure_gets_one_retry_and_says_backend_rejected(self):
        boom = RuntimeError("Applying the VAD filter requires the onnxruntime package")
        model = FakeModel(failures={0: boom})
        out = _run(model)
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(out.vad_state, "backend_rejected")

    def test_once_refused_no_later_window_asks_again(self):
        boom = RuntimeError("onnxruntime failed to load the silero vad model")
        model = FakeModel(failures={0: boom})
        out = _run(model, duration=60.0, window_s=30.0)
        # window 1 gated (refused) -> one ungated retry -> window 2 must NOT ask again.
        self.assertEqual(len(model.calls), 3, f"expected 3 calls, got {model.calls}")
        self.assertIs(model.calls[0].get("vad_filter"), True)
        self.assertNotIn("vad_filter", model.calls[1])
        self.assertNotIn("vad_filter", model.calls[2])
        self.assertEqual(out.vad_state, "backend_rejected")
        self.assertFalse(out.vad_filter)
        self.assertIn("every window was re-run ungated", out.note)

    def test_gating_that_succeeds_then_refuses_reports_the_mixed_run(self):
        boom = RuntimeError("silero vad session failed")
        model = FakeModel(failures={1: boom})
        out = _run(model, duration=60.0, window_s=30.0)
        self.assertEqual(len(model.calls), 3)
        self.assertTrue(out.vad_filter, "one window really did run gated")
        self.assertEqual(out.vad_state, "backend_rejected")
        self.assertIn("the windows after the refusal ran ungated", out.note)

    def test_an_unrelated_failure_is_not_a_vad_problem_and_gets_no_retry(self):
        model = FakeModel(failures={0: ValueError("some engine fault")})
        with self.assertRaises(whisper_ct2.BackendUnavailable) as got:
            _run(model)
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(got.exception.kind, "transcription_failed")

    def test_an_allocation_refusal_is_never_retried_as_a_vad_problem(self):
        model = FakeModel(failures={0: MemoryError()})
        with self.assertRaises(whisper_ct2.BackendUnavailable) as got:
            _run(model)
        self.assertEqual(len(model.calls), 1, "re-running ungated would hide the real cause")
        self.assertEqual(got.exception.kind, "allocation_failed")
        # The remedy must be a resource remedy. The old wrong answer told the user to
        # re-prepare weights that were already on disk.
        self.assertIn("free RAM/commit", got.exception.human_step)
        self.assertNotIn("prepare the pinned asset", got.exception.human_step)


class TheClassifierSeesWhatActuallyFailed(unittest.TestCase):
    def test_an_exception_with_no_message_still_names_its_class(self):
        self.assertTrue(allocations.is_allocation_failure(MemoryError()),
                        "str(MemoryError()) is empty, so the class name is the evidence")
        self.assertFalse(allocations.is_allocation_failure(FileNotFoundError("model.bin")))
        self.assertFalse(allocations.is_allocation_failure(""))
        self.assertFalse(allocations.is_allocation_failure(None))

    def test_vad_refusal_detection_does_not_swallow_other_faults(self):
        self.assertTrue(whisper_ct2._is_vad_refusal(TypeError("unexpected kwarg vad_filter")))
        self.assertTrue(whisper_ct2._is_vad_refusal(RuntimeError("silero vad asset unreadable")))
        self.assertFalse(whisper_ct2._is_vad_refusal(ValueError("bad tensor shape")))
        self.assertFalse(whisper_ct2._is_vad_refusal(TypeError("argument of type 'int'")))


class TheAssetProbeNeverFetchesAnything(unittest.TestCase):
    def _probe_with(self, asset_dir: Path, create: bool, spec_found=True) -> str:
        if create:
            (asset_dir / whisper_ct2.VAD_ASSET).write_bytes(b"onnx-ish")
        fake = types.SimpleNamespace(utils=types.SimpleNamespace(
            get_assets_path=lambda: str(asset_dir)))
        with mock.patch.object(whisper_ct2, "import_backend", lambda: fake), \
             mock.patch("importlib.util.find_spec",
                        return_value=object() if spec_found else None):
            return whisper_ct2.vad_asset_state()

    def test_available_only_when_the_packaged_asset_is_actually_on_disk(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(self._probe_with(Path(td), create=False, spec_found=False),
                             "asset_missing", "a missing asset is reported, not downloaded")
            self.assertEqual(self._probe_with(Path(td), create=True, spec_found=False),
                             "runtime_missing")
            self.assertEqual(self._probe_with(Path(td), create=True, spec_found=True),
                             "available")

    def test_every_state_the_adapter_can_produce_is_a_declared_state(self):
        produced = set()
        model = FakeModel()
        produced.add(_run(model).vad_state)
        produced.add(_run(FakeModel(), vad_filter=False).vad_state)
        produced.add(_run(FakeModel(), vad_asset="asset_missing").vad_state)
        produced.add(_run(FakeModel(failures={0: TypeError("vad_filter")})).vad_state)
        produced.add(_run(FakeModel(failures={0: RuntimeError("silero onnxruntime")})).vad_state)
        self.assertEqual(produced, {"applied", "not_requested", "asset_missing",
                                    "unsupported_by_backend", "backend_rejected"})
        self.assertTrue(produced <= set(whisper_ct2.VAD_STATES),
                        f"undocumented vad_state: {produced - set(whisper_ct2.VAD_STATES)}")


if __name__ == "__main__":
    unittest.main()
