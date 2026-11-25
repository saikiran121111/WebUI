"""The ONE Transformers ASR integration (final decision 2026-11-22): Parakeet-TDT, English.

Seam: ruke_ml.speech.transformers_asr.transcribe - the shared adapter contract
(transcript.py). The engine modules (transformers, torch) are sys.modules
stand-ins; the live-engine behaviour on this RTX 3060 is the measured g103 probe
(checkpoint 541d1f99c6b0..., transformers 5.24.0, torch 2.14.1+cu126: CUDA text
+ 40 token timestamps in 0.4 s; CPU recovery same text), never inferred here.

The laws under test are the release law, not style:
  * English scope: a non-English request is REFUSED with the reason, before the
    model is touched - no silent language switching;
  * GPU preferred, CPU is the measured recovery path (unlike the CUDA-first
    NeMo fallback, the Transformers integration publishes CPU execution and the
    probe measured it working);
  * the worker loads ONCE per job, and GPU memory is released when the job ends;
  * token timestamps are window-relative from the engine and must come back at
    ABSOLUTE source time, merged under the shared window law;
  * no network during ordinary runs (allow_download=False pins the hub offline)
    and no model-supplied code (trust_remote_code is never enabled);
  * cancellation between windows yields a partial, honest transcript;
  * an empty hypothesis is a no_speech verdict, not a silent success;
  * F123 (2026-11-23): a CUDA placement whose .to() fails is the typed
    device_unavailable INSTALL fault (the placement's GPU is a measured
    nvidia-smi fact — the host is never blamed for the runtime's defect),
    and the legacy probe checks the nvidia-smi hardware truth before
    claiming a GPU-less host.
"""
from __future__ import annotations

import importlib
import sys
import threading
import types
import unittest
from collections import UserDict
from unittest import mock

import numpy as np

from ruke_ml.speech import transformers_asr as ta
from ruke_ml.speech.transcript import BackendUnavailable

MODEL_ID = "nvidia/parakeet-tdt-0.6b-v3"
TOKENS_A = [{"token": "Hel", "start": 0.32, "end": 0.64},
            {"token": "lo", "start": 0.64, "end": 0.96},
            {"token": " there", "start": 0.96, "end": 1.28}]
TEXT_A = "Hello there"


class FakeGeneration:
    def __init__(self, sequences, durations):
        self.sequences = sequences
        self.durations = durations


class FakeInputs(UserDict):
    """The engine returns a BatchFeature: a mapping (model.generate(**inputs)),
    carrying .device/.dtype, whose .to() is chainable - as the g103 probe ran it."""

    def __init__(self, audios):
        super().__init__({"input_features": audios[0]})
        self.device = "cpu"
        self.dtype = None

    def to(self, device=None, dtype=None):
        self.device = device
        self.dtype = dtype
        return self


class FakeModel:
    """Mirrors the surface the g103 probe measured: .to(device), .device, .dtype."""

    def __init__(self, engine):
        self.engine = engine
        self.device = "cpu"
        self.dtype = np.float32

    def to(self, device):
        if self.engine.to_raises is not None:
            raise self.engine.to_raises
        self.device = device
        return self

    def eval(self):
        return self

    def generate(self, *, max_new_tokens=None, return_dict_in_generate=False, **inputs):
        self.engine.generate_calls.append(
            {"device": self.device, "max_new_tokens": max_new_tokens,
             "audio_samples": len(inputs["input_features"])})
        idx = len(self.engine.generate_calls) - 1
        stamps = self.engine.window_tokens[idx] if idx < len(self.engine.window_tokens) else []
        text = " ".join(t["token"] for t in stamps).strip()
        return FakeGeneration([[1, 2, 3]], stamps)


class FakeProcessor:
    sampling_rate = 16000

    def __init__(self, engine):
        self.engine = engine

    def __call__(self, audios, *, sampling_rate=None, return_tensors=None):
        assert sampling_rate == self.sampling_rate
        return FakeInputs(audios)

    def decode(self, sequences, *, durations=None, skip_special_tokens=True):
        texts = [" ".join(t["token"] for t in durations).strip() if durations else ""]
        return texts, [list(durations) if durations else []]

    @property
    def feature_extractor(self):
        return self


class Engine:
    """Records everything the integration asks the engine to do."""

    def __init__(self, *, cuda: bool, window_tokens=None, load_raises: Exception | None = None,
                 to_raises: Exception | None = None):
        self.cuda = cuda
        self.window_tokens = window_tokens if window_tokens is not None else [TOKENS_A]
        self.load_raises = load_raises
        self.to_raises = to_raises
        self.from_pretrained_calls: list[dict] = []
        self.generate_calls: list[dict] = []
        self.empty_cache_calls = 0

    def modules(self) -> dict[str, types.ModuleType]:
        engine = self

        transformers = types.ModuleType("transformers")

        class AutoModelForTDT:
            @staticmethod
            def from_pretrained(model_id, **kwargs):
                engine.from_pretrained_calls.append({"model_id": model_id, **kwargs})
                if engine.load_raises:
                    raise engine.load_raises
                return FakeModel(engine)

        class AutoProcessor:
            @staticmethod
            def from_pretrained(model_id, **kwargs):
                return FakeProcessor(engine)

        transformers.AutoModelForTDT = AutoModelForTDT
        transformers.AutoProcessor = AutoProcessor

        torch = types.ModuleType("torch")
        torch.no_grad = lambda: mock.MagicMock().__enter__ and _NullCtx()

        class _Cuda:
            @staticmethod
            def is_available():
                return engine.cuda

            @staticmethod
            def empty_cache():
                engine.empty_cache_calls += 1

        torch.cuda = _Cuda()
        return {"transformers": transformers, "torch": torch}


class _NullCtx:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _tokens(offset: float, words: list[str], dur: float):
    out, t = [], offset
    for w in words:
        out.append({"token": w, "start": round(t, 3), "end": round(t + 0.32, 3)})
        t += 0.32
    if t > offset:
        out[-1]["end"] = round(min(offset + dur, offset + 0.32 * len(words)), 3)
    return out


class _Harness:
    """transcribe() with ffmpeg decode and engine modules replaced by contract fakes."""

    def __init__(self, engine: Engine):
        self.engine = engine
        self.decoded: list[tuple[float, float]] = []

    def run(self, duration: float, **over):
        def fake_decode(src, a, b, *, ffmpeg=""):
            self.decoded.append((a, b))
            return np.zeros(int((b - a) * 16000), dtype=np.float32)

        mods = self.engine.modules()
        with mock.patch.object(sys, "modules", {**sys.modules, **mods}), \
                mock.patch.object(ta, "decode_window", fake_decode), \
                mock.patch.object(ta, "audio_array",
                                  lambda src, d, *, ffmpeg="": fake_decode(src, 0.0, d)):
            return ta.transcribe("clip.mp3", model_id=MODEL_ID, duration=duration,
                                 word_timestamps=True, **over)


class EnglishScope(unittest.TestCase):
    def test_non_english_is_refused_before_the_model_is_touched(self):
        engine = Engine(cuda=True)
        with self.assertRaises(BackendUnavailable) as cm:
            _Harness(engine).run(11.0, language="hi")
        self.assertEqual(cm.exception.kind, "unsupported_language")
        self.assertEqual(engine.from_pretrained_calls, [],
                         "the refusal must not load (or let anything download) a model")

    def test_english_runs_and_reports_explicit_language(self):
        engine = Engine(cuda=True)
        t = _Harness(engine).run(11.0, language="en")
        self.assertEqual(t.state, "transcribed")
        self.assertEqual(t.language, "en")
        self.assertEqual(t.language_source, "explicit")
        self.assertEqual(t.device, "cuda")


class DeviceLaw(unittest.TestCase):
    def test_gpu_preferred_worker_loads_once_and_gpu_memory_is_released(self):
        engine = Engine(cuda=True, window_tokens=[_tokens(0, ["One", " here"], 10.0),
                                                  _tokens(0, ["Two", " there"], 10.0)])
        t = _Harness(engine).run(20.0, window_s=10.0)
        self.assertEqual(t.device, "cuda")
        self.assertEqual(len(engine.from_pretrained_calls), 1,
                         "the worker is loaded ONCE per job, not per window")
        self.assertGreaterEqual(engine.empty_cache_calls, 1,
                                "GPU memory must be released when the job ends")

    def test_cpu_is_the_recovery_path_when_no_cuda_is_available(self):
        engine = Engine(cuda=False)
        t = _Harness(engine).run(11.0, language="en")
        self.assertEqual(t.device, "cpu")
        self.assertEqual(t.state, "transcribed")
        self.assertIn("CPU", t.note + t.text,
                      "the run must REPORT that it executed on the CPU recovery path")

    def test_a_planned_gpu_device_is_used_even_though_the_bare_probe_would_say_cpu(self):
        # F91 on the live path: the planner measured CUDA works and the window
        # released the VRAM; a bare cuda.is_available() re-decision here is the
        # self-placement that silently ran workers on CPU. The plan wins.
        engine = Engine(cuda=False)
        t = _Harness(engine).run(11.0, language="en", device="gpu")
        self.assertEqual(t.device, "cuda",
                         "the planned device must reach the model, not the probe's answer")
        self.assertEqual(engine.generate_calls[0]["device"], "cuda")
        self.assertGreaterEqual(engine.empty_cache_calls, 1,
                                "a GPU run releases its VRAM back to the endpoint")

    def test_a_planned_cpu_run_reports_the_planners_reason_not_a_false_no_cuda_claim(self):
        # CUDA IS available here; the CPU placement is a measured DECISION (the
        # release was not permitted / cannot fit). Reporting "no CUDA device is
        # available" would launder the F91 policy answer into a hardware lie.
        engine = Engine(cuda=True)
        reason = ("CPU placement: releasing the resident main model would not free "
                  "enough VRAM; RAM fits")
        t = _Harness(engine).run(11.0, language="en", device="cpu", placement_reason=reason)
        self.assertEqual(t.device, "cpu")
        self.assertIn("releasing the resident main model", t.note)
        self.assertNotIn("no CUDA device is available", t.note)


class TimestampLaw(unittest.TestCase):
    def test_token_timestamps_come_back_at_absolute_source_time(self):
        # Window [10, 20): the engine's timings are window-relative (probe: the
        # first token starts 0.64 s into the clip for a window starting at 0).
        # The integration adds the window offset - the pcm_windows source-time law.
        engine = Engine(cuda=True,
                        window_tokens=[_tokens(0.0, ["Hel", "lo"], 10.0),
                                       _tokens(0.0, ["bye"], 10.0)])
        t = _Harness(engine).run(20.0, window_s=10.0, overlap_s=0.0)
        seg2 = [s for s in t.segments if s["start"] >= 10.0]
        self.assertTrue(seg2, "the second window's reading must exist at absolute time")
        self.assertAlmostEqual(seg2[0]["start"], 10.0, places=1)
        words = seg2[0].get("words") or []
        self.assertTrue(words and words[0]["start"] >= 10.0,
                        f"word spans are absolute: {words}")

    def test_empty_hypothesis_is_a_no_speech_verdict_not_a_silent_success(self):
        engine = Engine(cuda=True, window_tokens=[[]])
        t = _Harness(engine).run(11.0, language="en")
        self.assertEqual(t.state, "no_speech")
        self.assertTrue(t.note, "the no-speech verdict must explain itself")


class LoadLaw(unittest.TestCase):
    def test_ordinary_run_pins_the_hub_offline_and_never_trusts_remote_code(self):
        engine = Engine(cuda=True)
        _Harness(engine).run(11.0, language="en")
        call = engine.from_pretrained_calls[0]
        self.assertTrue(call.get("local_files_only"),
                        "allow_download=False must pin the hub offline (the manager "
                        "owns fetching; no unannounced network pull during an upload)")
        self.assertFalse(call.get("trust_remote_code", False),
                         "model-supplied code is never executed")

    def test_missing_local_snapshot_is_asset_missing_not_a_crash(self):
        engine = Engine(cuda=True,
                        load_raises=FileNotFoundError("not found locally "
                                                      "(offline mode: HF_HUB_OFFLINE)"))
        with self.assertRaises(BackendUnavailable) as cm:
            _Harness(engine).run(11.0, language="en")
        self.assertEqual(cm.exception.kind, "asset_missing")

    def test_absent_transformers_is_dependency_missing(self):
        # "transformers" cannot be imported at all (this venv HAS it installed, so
        # the import machinery itself is blocked): the typed dependency answer,
        # not an ImportError escaping into a generic internal error.
        engine = Engine(cuda=True)

        class _Blocker:
            def find_spec(self, name, path=None, target=None):
                if name == "transformers":
                    raise ModuleNotFoundError("No module named 'transformers'",
                                              name="transformers")
                return None

        def fake_decode(src, a, b, *, ffmpeg=""):
            return np.zeros(int((b - a) * 16000), dtype=np.float32)

        blocker = _Blocker()
        # Other test modules import the real transformers; drop it (with its
        # submodules) so the blocker is the only path, as on a machine where the
        # package is not installed.
        stripped = {k: v for k, v in sys.modules.items()
                    if k != "transformers" and not k.startswith("transformers.")}
        mods = {k: v for k, v in engine.modules().items() if k != "transformers"}
        with mock.patch.object(sys, "modules", {**stripped, **mods}), \
                mock.patch.object(sys, "meta_path", [blocker, *sys.meta_path]), \
                mock.patch.object(ta, "decode_window", fake_decode):
            with self.assertRaises(BackendUnavailable) as cm:
                ta.transcribe("clip.mp3", model_id=MODEL_ID, language="en", duration=11.0)
        self.assertEqual(cm.exception.kind, "dependency_missing")


class CancellationLaw(unittest.TestCase):
    def test_cancel_between_windows_yields_a_partial_honest_transcript(self):
        cancel = threading.Event()
        engine = Engine(cuda=True,
                        window_tokens=[_tokens(0, ["First"], 10.0), _tokens(0, ["Second"], 10.0)])

        def fake_decode(src, a, b, *, ffmpeg=""):
            if a >= 10.0:
                cancel.set()
            return np.zeros(int((b - a) * 16000), dtype=np.float32)

        mods = engine.modules()
        with mock.patch.object(sys, "modules", {**sys.modules, **mods}), \
                mock.patch.object(ta, "decode_window", fake_decode):
            t = ta.transcribe("clip.mp3", model_id=MODEL_ID, language="en",
                              duration=20.0, window_s=10.0, overlap_s=0.0,
                              cancel=cancel, word_timestamps=True)
        self.assertFalse(t.complete)
        self.assertIn("cancel", t.note.lower())
        self.assertEqual(len(engine.generate_calls), 1,
                         "generation stops after the cancellation is observed")
        self.assertTrue(t.text, "the already-decoded window is kept, not thrown away")


class FullTranscriptLaw(unittest.TestCase):
    """F152: the delivered text is built from the MERGED segments (the
    whisper_ct2.py law), never a raw join of the per-window decodes. A raw
    join put the overlap's evidence on the wire twice: an edge-cut fragment
    beside the full re-hearing that supersedes it, and a sentence the
    overlap re-heard verbatim beside its first reading."""

    def test_a_superseded_edge_fragment_never_appears_in_the_text(self):
        # Window [0,10) hears "final words now" cut at the window edge; the
        # overlapping window [8,18) re-hears the whole span untruncated
        # (the merge's keeper). The fragment is REPORTED, the full reading
        # is what the user reads - the raw join delivered both.
        engine = Engine(cuda=True, window_tokens=[
            _tokens(8.8, ["final", "words", "now"], 1.2),          # abs 8.8-9.76, edge-cut
            _tokens(0.4, ["final", "words", "now", "to", "remember", "clearly"], 2.4),  # abs 8.4-10.32
            _tokens(0.5, ["tail"], 0.4),                            # abs 16.5-16.9, plain
        ])
        t = _Harness(engine).run(20.0, window_s=10.0, overlap_s=2.0, language="en")
        self.assertEqual(
            len([s for s in t.superseded if s["text"] == "final words now"
                 and s["cut_at"] == "end"]), 1,
            f"the edge-cut reading must be reported as superseded: {t.superseded}")
        self.assertEqual(t.text.count("final words"), 1,
                         f"the cut fragment must not ride the wire beside the full "
                         f"re-hearing that supersedes it: {t.text!r}")
        self.assertIn("final words now to remember", t.text)
        self.assertNotIn("final words now to remember",
                         " ".join(s["text"] for s in t.superseded))

    def test_a_verbatim_rehearing_in_the_overlap_is_delivered_once(self):
        # A heavy overlap (8 s) re-hears one whole sentence verbatim; the
        # merge's _dedupe_exact drops the second reading (proven identical
        # text inside already-covered time). The raw join delivered it twice.
        # w0 [0,10) hears the sentence at abs 4.0-4.96; w1 [2,12) re-hears the
        # SAME span at the same absolute time (window-relative offset 2.0).
        engine = Engine(cuda=True, window_tokens=[
            _tokens(4.0, ["the", "same", "sentence"], 4.0),
            _tokens(2.0, ["the", "same", "sentence"], 4.0),
            [], [], [], [],
        ])
        t = _Harness(engine).run(20.0, window_s=10.0, overlap_s=8.0, language="en")
        self.assertEqual(t.text.count("the same sentence"), 1,
                         f"the verbatim overlap re-hearing is the same utterance read "
                         f"twice: {t.text!r}")
        self.assertEqual(len([s for s in t.segments if s["text"] == "the same sentence"]), 1)

    def test_legitimate_repetition_at_a_different_time_survives(self):
        # The dedupe law keeps genuine repeats: the same words at a LATER span
        # are evidence of a real repeated sentence, not a window artefact.
        engine = Engine(cuda=True, window_tokens=[
            _tokens(1.0, ["again"], 1.0),   # abs 1.0-1.32
            _tokens(1.0, ["again"], 1.0),   # window [8,18) -> abs 9.0-9.32
        ])
        t = _Harness(engine).run(20.0, window_s=10.0, overlap_s=2.0, language="en")
        self.assertEqual(t.text.count("again"), 2,
                         f"a real repeat at a different source time must survive: {t.text!r}")


class InstallFaultLaw(unittest.TestCase):
    """F123: the runtime installation fault is NAMED, never laundered into a
    claim that the host has no GPU. On this project's CUDA-capable hosts the
    observed production defect is a CPU-only torch wheel beside a real GPU."""

    def test_cuda_placement_with_a_failing_to_is_the_typed_install_fault(self):
        # The planner placed the run on CUDA (its GPU verdict is the measured
        # nvidia-smi fact). A CPU-only torch wheel makes .to("cuda") raise; the
        # raw RuntimeError must NOT escape the adapter contract, and the fault
        # must name the INSTALLATION, not the hardware.
        engine = Engine(cuda=False,  # bare probe says cpu: the placement overrode it
                        to_raises=RuntimeError("CUDA driver version is insufficient "
                                               "for CUDA runtime version"))
        with self.assertRaises(BackendUnavailable) as cm:
            _Harness(engine).run(11.0, language="en", device="gpu")
        exc = cm.exception
        self.assertEqual(exc.kind, "device_unavailable",
                         "the closed wire vocabulary carries the install fault")
        self.assertIn("this host HAS", exc.detail,
                      "the GPU is a measured fact: never blame the hardware")
        self.assertIn("installation fault", exc.detail)
        self.assertNotIn("no CUDA device", exc.detail)
        self.assertIn("install the CUDA build", exc.human_step)

    def test_cpu_placement_with_a_failing_to_is_a_plain_load_failure(self):
        engine = Engine(cuda=False,
                        to_raises=RuntimeError("out of memory allocating host tensor"))
        with self.assertRaises(BackendUnavailable) as cm:
            _Harness(engine).run(11.0, language="en", device="cpu")
        self.assertEqual(cm.exception.kind, "load_failed")

    def test_legacy_probe_on_a_gpu_host_never_claims_a_gpu_less_host(self):
        # No placement received (device=""): the probe's cuda.is_available() is
        # False because the installed torch is CPU-only. The note must consult
        # the nvidia-smi hardware truth and name the installation fault.
        engine = Engine(cuda=False)
        vram = types.SimpleNamespace(available=True,
                                     detail="1 GPU, 8188 MiB total (NVIDIA GeForce RTX 3060)")
        with mock.patch("ruke_ml.models.devices.vram_state", lambda: vram):
            t = _Harness(engine).run(11.0, language="en")
        self.assertEqual(t.device, "cpu")
        self.assertIn("this host HAS an NVIDIA GPU", t.note)
        self.assertIn("installation fault", t.note)
        self.assertNotIn("no CUDA device is available", t.note,
                         "the pre-F123 wording blamed the hardware for the runtime's defect")

    def test_legacy_probe_on_a_gpu_less_host_states_the_measured_hardware(self):
        engine = Engine(cuda=False)
        vram = types.SimpleNamespace(available=False, detail="nvidia-smi-absent")
        with mock.patch("ruke_ml.models.devices.vram_state", lambda: vram):
            t = _Harness(engine).run(11.0, language="en")
        self.assertIn("no usable CUDA device was measured (nvidia-smi-absent)", t.note)


if __name__ == "__main__":
    unittest.main()
