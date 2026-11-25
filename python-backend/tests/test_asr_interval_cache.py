"""F152 (2026-11-24): question-driven interval inspection + the durable source+range record.

Why this file exists: a follow-up question ("what is said around 12:40?") used to
re-transcribe the WHOLE track, and a repeat of the same question re-ran minutes of
GPU inference for an answer the machine already had. The two laws pinned here:

  * interval: `start_s`/`end_s` bound the DECODED span. The level pass measures that
    span (accurate seek, source-time intervals), the adapter that declares the
    kwargs decodes that span, and the coverage then speaks ONLY about the span:
    head/tail gaps in `skipped`, `complete` False. An adapter that does not declare
    the kwargs is never handed them (the published-signature dispatch law) and its
    whole-file answer keeps whole-file coverage claims.
  * geometry refusals: a span that does not fit the probe's duration is
    input_rejected, and one WIDER THAN 3 hours (MAX_INSPECT_S) is refused outright -
    windows tile the span, so an unbounded span is unbounded memory and an answer
    nobody can read.
  * record: the OCR record law mirrored for audio (speech/asr_cache.py). A repeat of
    the SAME bytes (sha256, mtime excluded), the SAME span and the SAME engine row is
    answered from the durable record with ZERO engine invocations; edited bytes are a
    miss; a span is NEVER served from a different span's record; the record file
    names its request identity so a reader can attribute the answer.

The cache root is redirected per test (RUKE_ASR_RESULT_DIR, the e2e launcher's
RUKE_OCR_RESULT_DIR isolation law): every fake source here is a handful of identical
bytes, so on a shared root one test's record would answer the next test's request and
make these assertions vacuous.
"""
from __future__ import annotations

import glob
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

from ruke_ml.contracts import JobRequest
from ruke_ml.models import assets as assets_mod
from ruke_ml.models import main_model, provider_config
from ruke_ml.models.assets import AssetState
from ruke_ml.models.registry import Catalog, ModelSpec
from ruke_ml.speech import asr, levels, whisper_ct2
from ruke_ml.speech.transcript import Transcript
from ruke_ml.workers import jobs as jobs_mod
from ruke_ml.workers import speech_jobs

FAKE_ADAPTER = "fake_asr_adapter_f152"
ROW_ID = "fake/speech-row"
DURATION = 12.0


def _isolate_asr_cache(case: unittest.TestCase) -> None:
    """Fresh durable-record root per test; the environment is restored verbatim."""
    root = tempfile.TemporaryDirectory(prefix="f152-interval-cache-")
    previous = os.environ.get("RUKE_ASR_RESULT_DIR")
    os.environ["RUKE_ASR_RESULT_DIR"] = root.name

    def restore() -> None:
        if previous is None:
            os.environ.pop("RUKE_ASR_RESULT_DIR", None)
        else:
            os.environ["RUKE_ASR_RESULT_DIR"] = previous
        root.cleanup()
    case.addCleanup(restore)
    case.cache_root = root.name


def _row() -> ModelSpec:
    return ModelSpec(id=ROW_ID, revision="rev-pinned-1", capability="speech.asr",
                     provider="huggingface", package="numpy", adapter=FAKE_ADAPTER,
                     asset="", claims={"languages": ["en"]})


def _probe(**over):
    base = {"ok": True, "error": "", "human_step": "", "has_audio": True,
            "audio_reason": "", "audio_state": "audio", "duration": DURATION,
            "selected_audio": {"index": 0}, "stream_start_offsets": {},
            "subtitle_tracks": [], "rotation": 0}
    base.update(over)
    return base


def _route(**over):
    base = {"language": "en", "decision": "route", "quality_mode": "measured",
            "model": ROW_ID, "note": "", "human_step": ""}
    base.update(over)
    return base


class _Audible:
    ok, truncated, error, human_step = True, False, "", ""
    max_volume_db, noise_floor_db = -20.0, -50.0

    def is_silence(self) -> bool:
        return False

    def as_dict(self):
        return {"ok": True, "state": "audible", "max_volume_db": self.max_volume_db,
                "noise_floor_db": self.noise_floor_db}


class _Silent:
    ok, truncated, error, human_step = True, False, "", ""
    max_volume_db, noise_floor_db = -91.0, -60.0

    def is_silence(self) -> bool:
        return True

    def as_dict(self):
        return {"ok": True, "state": "silence", "max_volume_db": self.max_volume_db,
                "noise_floor_db": self.noise_floor_db}


def _interval_transcript(**over) -> Transcript:
    """What a span-decoding adapter reports for the 2.0-7.0s span of a 12.0s track:
    examined is the span, the head/tail are not claimed, complete is False."""
    base = dict(text="the words inside the span", language="en",
                language_source="detected", duration=DURATION,
                segments=[{"start": 2.1, "end": 6.9, "text": "the words inside the span"}],
                examined=[(2.0, 7.0)], complete=False, model=ROW_ID,
                device="cpu", compute_type="float16",
                note="bounded interval inspection 2.0-7.0s: audio outside the span was "
                     "never decoded, so this run says nothing about it")
    base.update(over)
    return Transcript(**base)


def _whole_transcript(**over) -> Transcript:
    base = dict(text="the whole recording", language="en",
                language_source="detected", duration=DURATION,
                segments=[{"start": 0.2, "end": 11.8, "text": "the whole recording"}],
                examined=[(0.0, DURATION)], complete=True, model=ROW_ID,
                device="cpu", compute_type="float16", note="")
    base.update(over)
    return Transcript(**base)


class _Harness:
    """asr_job with the engine, the loudness pass and the disk answers replaced by
    contract-shaped fakes; the dispatch, cache and coverage laws run for real."""

    def __init__(self, transcript: Transcript, *, strict: bool = False,
                 probe_over: dict | None = None, level: type = _Audible,
                 cache_root: str = ""):
        self.calls: list = []
        self.cache_root = cache_root
        self.level_calls: list = []
        self.level = level()
        self.probe_over = probe_over or {}
        self.transcript = transcript
        self.strict = strict
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.path = os.path.join(self.root, "clip.mp3")
        with open(self.path, "wb") as fh:
            fh.write(b"ID3\x03\x00fake")
        self.module = self._make_adapter()

    def _make_adapter(self) -> types.ModuleType:
        mod = types.ModuleType(FAKE_ADAPTER)
        import importlib.machinery
        mod.__spec__ = importlib.machinery.ModuleSpec(FAKE_ADAPTER, loader=None)
        transcript = self.transcript
        calls = self.calls

        if self.strict:
            # The whisper_ct2 shape: NO **kwargs, NO start_s/end_s. Handing this
            # adapter a span kwarg must raise TypeError inside the call, which the
            # dispatch law forbids - the test passes only if the job never injects.
            def transcribe(src, *, model_id, language, duration, word_timestamps,
                           allow_download, cancel, progress, ffmpeg="", vad_filter=True):
                calls.append({"src": src, "model_id": model_id, "duration": duration})
                return transcript
        else:
            def transcribe(src, *, model_id, language, duration, word_timestamps,
                           allow_download, cancel, progress, ffmpeg="", vad_filter=True,
                           **kwargs):
                calls.append({"src": src, "model_id": model_id, "duration": duration,
                              **kwargs})
                return transcript

        mod.transcribe = transcribe
        return mod

    def _asset_state(self, model_id, expected_revision="", required=()):
        return AssetState(model_id, True, "snapshot present",
                          os.path.join(self.root, "snap"))

    def _prepare(self, model_id, *, revision="", force_download=False, required=()):
        return AssetState(model_id, True, "prepared",
                          os.path.join(self.root, "prepared-snapshot"))

    def measure_level(self, path, **kw):
        self.level_calls.append(kw)
        return self.level

    def run(self, **payload):
        req = JobRequest(request_id="r1", run_id="run1", job_id="job1",
                         capability="speech.asr",
                         payload={"path": self.path, "root": self.root, **payload})
        ctx = jobs_mod.JobContext(req=req, cancel=threading.Event(),
                                  progress=lambda state, note: None)
        catalog = Catalog([_row()])
        old = sys.modules.get(FAKE_ADAPTER)
        sys.modules[FAKE_ADAPTER] = self.module
        try:
            with mock.patch.object(speech_jobs, "catalog", lambda: catalog), \
                    mock.patch.object(asr, "probe_media",
                                      lambda path, ffprobe="": _probe(**self.probe_over)), \
                    mock.patch.object(asr, "language_route", lambda language: _route()), \
                    mock.patch.object(levels, "measure_level", self.measure_level), \
                    mock.patch.object(assets_mod, "asset_state", self._asset_state), \
                    mock.patch.object(assets_mod, "prepare", self._prepare), \
                    mock.patch.object(main_model, "snapshot",
                                      lambda *a, **k: {"provider": "", "endpoint": "",
                                                       "loaded": False,
                                                       "lifecycle_supported": False,
                                                       "lifecycle_detail": ""}), \
                    mock.patch.object(provider_config, "load",
                                      lambda *a, **k: types.SimpleNamespace(
                                          automatic_handoff=True)), \
                    mock.patch.object(whisper_ct2, "transcribe",
                                      side_effect=lambda *a, **k: None):
                return speech_jobs.asr_job(ctx)
        finally:
            if old is None:
                sys.modules.pop(FAKE_ADAPTER, None)
            else:
                sys.modules[FAKE_ADAPTER] = old

    def records(self) -> list[dict]:
        out = []
        for f in glob.glob(os.path.join(self.cache_root, "*.json")):
            with open(f, encoding="utf-8") as fh:
                out.append(json.loads(fh.read()))
        return out

    def edit_bytes(self) -> None:
        with open(self.path, "ab") as fh:
            fh.write(b"more")

    def close(self):
        self._tmp.cleanup()


class IntervalDecodeLaw(unittest.TestCase):
    def setUp(self):
        _isolate_asr_cache(self)

    def test_the_span_reaches_the_adapter_the_level_pass_and_the_coverage(self):
        harness =   _Harness(_interval_transcript(), cache_root=self.cache_root)
        try:
            result = harness.run(start_s=2.0, end_s=7.0)
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"interval run refused: {result.error and result.error.to_dict()}")
        self.assertEqual((harness.calls[0]["start_s"], harness.calls[0]["end_s"]),
                         (2.0, 7.0), "the span-declaring adapter must receive the span")
        lvl = harness.level_calls[0]
        self.assertEqual((lvl["start_s"], lvl["duration_s"]), (2.0, 5.0),
                         "the loudness pass must measure the SPAN, not the whole track")
        self.assertEqual([tuple(g) for g in result.coverage.skipped],
                         [(0.0, 2.0), (7.0, 12.0)],
                         "head and tail were never decoded: they are gaps, not silence")
        self.assertFalse(result.coverage.complete,
                         "a bounded run is never a complete verdict on the track")
        self.assertEqual(result.payload["cache"]["state"], "stored")
        self.assertEqual(result.payload["cache"]["span"], [2.0, 7.0])
        rec = harness.records()
        self.assertEqual(len(rec), 1, "one successful run stores exactly one record")
        self.assertEqual(rec[0]["request"]["span"], [2.0, 7.0])

    def test_a_span_equal_to_the_track_is_the_whole_file_pass(self):
        harness = _Harness(_whole_transcript(), cache_root=self.cache_root)
        try:
            result = harness.run(start_s=0.0, end_s=12.0)
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual([tuple(g) for g in result.coverage.skipped], [],
                         "a span covering the whole track leaves no gaps")
        self.assertTrue(result.coverage.complete)

    def test_an_adapter_without_the_span_kwargs_is_never_handed_them(self):
        # The published-signature dispatch law: start_s/end_s go only to adapters
        # that declare them (the retired whisper_ct2 reference stays callable).
        harness = _Harness(_whole_transcript(), strict=True, cache_root=self.cache_root)
        try:
            result = harness.run(start_s=2.0, end_s=7.0)
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"strict adapter run refused: {result.error and result.error.to_dict()}")
        self.assertNotIn("start_s", harness.calls[0],
                         "the dispatcher injected a kwarg the signature does not declare")

    def test_a_span_that_does_not_fit_the_track_is_refused(self):
        for over in ({"start_s": 7.0, "end_s": 7.0},      # end at/before start
                     {"start_s": 12.0, "end_s": 13.0},    # start at/after the end
                     {"start_s": -1.0, "end_s": 3.0},     # negative start
                     {"start_s": 1.0, "end_s": 60.0}):    # end past duration+1s
            harness =   _Harness(_interval_transcript(), cache_root=self.cache_root)
            try:
                result = harness.run(**over)
            finally:
                harness.close()
            self.assertEqual(result.state, "failed", f"{over} must be refused")
            self.assertEqual(result.error.reason, "input_rejected")
            self.assertIn("does not fit", result.error.message)
            self.assertEqual(harness.calls, [], "a refused span never touches the engine")

    def test_a_span_wider_than_three_hours_is_refused(self):
        harness = _Harness(_whole_transcript(), probe_over={"duration": 20000.0}, cache_root=self.cache_root)
        try:
            result = harness.run(start_s=0.0, end_s=12000.0)
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "input_rejected")
        self.assertIn("10800", result.error.message)
        self.assertIn("3 hours", result.error.message)
        self.assertEqual(harness.calls, [],
                         "the bound refuses BEFORE decode: no unbounded memory pass")


class DurableRecordLaw(unittest.TestCase):
    def setUp(self):
        _isolate_asr_cache(self)

    def test_a_repeat_request_is_served_from_the_record_with_zero_engine_calls(self):
        harness =   _Harness(_interval_transcript(), cache_root=self.cache_root)
        try:
            first = harness.run(start_s=2.0, end_s=7.0)
            second = harness.run(start_s=2.0, end_s=7.0)
        finally:
            harness.close()
        self.assertEqual(first.state, "ready",
                         f"{first.error and first.error.to_dict()}")
        self.assertEqual(len(harness.calls), 1,
                         "the second identical request must not invoke the engine at all")
        self.assertEqual(second.payload["cache"]["state"], "hit")
        self.assertEqual(second.payload["cache"]["key"], first.payload["cache"]["key"])
        self.assertEqual(second.payload["text"], first.payload["text"],
                         "the record answers with the recorded transcript")
        self.assertIn("zero engine invocations", second.coverage.note)
        self.assertEqual([tuple(g) for g in second.coverage.skipped],
                         [(0.0, 2.0), (7.0, 12.0)],
                         "the record's coverage keeps the span honesty")

    def test_edited_bytes_are_a_miss(self):
        harness =   _Harness(_interval_transcript(), cache_root=self.cache_root)
        try:
            first = harness.run(start_s=2.0, end_s=7.0)
            harness.edit_bytes()
            second = harness.run(start_s=2.0, end_s=7.0)
        finally:
            harness.close()
        self.assertEqual(len(harness.calls), 2,
                         "the record is keyed by CONTENT: edited bytes must re-run the engine")
        self.assertNotEqual(second.payload["cache"]["key"], first.payload["cache"]["key"])

    def test_a_span_is_never_served_from_another_span_record(self):
        harness =   _Harness(_interval_transcript(), cache_root=self.cache_root)
        try:
            harness.run(start_s=2.0, end_s=7.0)
            other = harness.run(start_s=4.0, end_s=9.0)
        finally:
            harness.close()
        self.assertEqual(len(harness.calls), 2,
                         "a slice of a different span's pass is a different answer")
        self.assertEqual(other.payload["cache"]["state"], "stored")
        self.assertEqual(other.payload["cache"]["span"], [4.0, 9.0])

    def test_the_record_names_the_engine_identity_and_judges_staleness_on_content(self):
        harness =   _Harness(_interval_transcript(), cache_root=self.cache_root)
        try:
            harness.run(start_s=2.0, end_s=7.0)
        finally:
            harness.close()
        rec = harness.records()[0]
        self.assertEqual(rec["schema"], "ruke.asr-result.v1")
        self.assertEqual(rec["request"]["model"], ROW_ID,
                         "the record stays attributable to the row that ran (F122 law)")
        ident = rec["request"]["source"]
        self.assertIn("sha256", ident)
        self.assertNotIn("mtime", ident,
                         "staleness is CONTENT; a touch is not a content change (OCR law)")


class BoundedSilenceVerdictLaw(unittest.TestCase):
    def setUp(self):
        _isolate_asr_cache(self)

    def test_a_silent_span_is_a_verdict_about_the_span_only(self):
        harness = _Harness(_interval_transcript(), level=_Silent, cache_root=self.cache_root)
        try:
            result = harness.run(start_s=2.0, end_s=7.0)
        finally:
            harness.close()
        self.assertEqual(result.state, "ready")
        self.assertEqual(result.payload["state"], "silence")
        self.assertFalse(result.payload["asr_ran"])
        self.assertFalse(result.payload["complete"],
                         "a silent span is not a silence verdict on the whole track")
        self.assertIn("audio outside 2.0-7.0s was never decoded", result.payload["note"])
        self.assertEqual([tuple(g) for g in result.coverage.skipped],
                         [(0.0, 2.0), (7.0, 12.0)])

    def test_a_silent_whole_track_stays_a_complete_verdict(self):
        harness = _Harness(_interval_transcript(), level=_Silent, cache_root=self.cache_root)
        try:
            result = harness.run()
        finally:
            harness.close()
        self.assertEqual(result.payload["state"], "silence")
        self.assertTrue(result.payload["complete"])
        self.assertNotIn("never decoded", result.payload["note"])


if __name__ == "__main__":
    unittest.main()
