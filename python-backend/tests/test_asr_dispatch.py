"""speech.asr dispatch: the job runs the adapter the registry row NAMES, never a hardcoded engine.

Why this file exists: the candidate rows (Parakeet, Granite, Qwen3) were registered in B3
with an adapter field that said "no adapter code is registered", and the job layer called
whisper_ct2.transcribe unconditionally. Under that shape, selecting Parakeet in Settings
would have RUN WHISPER and REPORTED Parakeet - provenance laundering. These tests pin the
dispatch law:

  * the row's `adapter` module is the thing that runs, with the shared adapter contract;
  * the row's pinned revision is the identity reported, and the adapter's own device and
    compute_type flow into the payload;
  * an adapter's typed BackendUnavailable reaches the wire through the shared kind map;
  * a row with no adapter code is REFUSED (model_unavailable) - there is no whisper fallback;
  * cancellation during the adapter run is a cancellation, not a ready result.

The injected adapter module is a sys.modules stand-in for the real engine (nemo,
transformers, qwen_asr are not installed here); the production adapter modules themselves
are tested against their published APIs in their own files, and the live-engine behaviour
is a measured run, recorded as measured, never inferred from these fakes.
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

from ruke_ml import handoff
from ruke_ml.contracts import JobRequest
from ruke_ml.models import assets as assets_mod
from ruke_ml.models import devices, job_limits, main_model, provider_config
from ruke_ml.models.assets import AssetState
from ruke_ml.models.registry import Catalog, ModelSpec
from ruke_ml.speech import asr, levels, whisper_ct2
from ruke_ml.speech.transcript import BackendUnavailable, Transcript
from ruke_ml.workers import jobs as jobs_mod
from ruke_ml.workers import speech_jobs

FAKE_ADAPTER = "fake_asr_adapter_under_test"
ROW_ID = "fake/speech-row"


def _row(adapter: str = FAKE_ADAPTER, revision: str = "rev-pinned-1",
         asset: str = "", **spec_over) -> ModelSpec:
    # `package` names numpy because it is genuinely installed in this venv: the REAL
    # readiness gate runs on this row, and the fake satisfies it with real facts
    # (importable package, adapter module present, no asset declared, no env config).
    return ModelSpec(id=ROW_ID, revision=revision, capability="speech.asr",
                     provider="huggingface", package="numpy", adapter=adapter,
                     asset=asset, claims={"languages": ["en"]}, **spec_over)


def _probe(**over):
    base = {"ok": True, "error": "", "human_step": "", "has_audio": True,
            "audio_reason": "", "audio_state": "audio", "duration": 12.0,
            "selected_audio": {"index": 0}, "stream_start_offsets": {},
            "subtitle_tracks": [], "rotation": 0}
    base.update(over)
    return base


class _Level:
    ok, truncated, error, human_step = True, False, "", ""
    max_volume_db, noise_floor_db = -20.0, -50.0

    def is_silence(self) -> bool:
        return False

    def as_dict(self):
        return {"ok": True, "peak_dbfs": self.max_volume_db}


def _route(**over):
    base = {"language": "en", "decision": "route", "quality_mode": "measured",
            "model": ROW_ID, "note": "", "human_step": ""}
    base.update(over)
    return base


class _Harness:
    """asr_job with everything BELOW the dispatch decision replaced by contract-shaped fakes."""

    def __init__(self, row: ModelSpec, adapter_module: types.ModuleType | None):
        self.row = row
        self.adapter_module = adapter_module
        self.whisper_calls = []
        self.progress: list[tuple[str, str]] = []
        self.on_progress = None
        # The asset disk answers, as the real assets module would return them. Default:
        # absent, matching "fresh machine, weights never downloaded" - the exact state
        # the first-use provisioning law is about. Tests set them to the scenario.
        self.snapshot_present: tuple[bool, str, str] = (
            False, "no snapshot for this repo id in any configured cache root", "")
        self.prepare_present: tuple[bool, str, str] = (True, "prepared the pinned snapshot", "")
        # The endpoint's state as the real main_model.snapshot() would report it. A unit
        # test must not probe the live :8080, and the placement branch is a scenario, not
        # machine luck - Placement sets it; the default is "nothing resident" (offline host).
        self.main_model_snapshot: dict = {"provider": "", "endpoint": "", "loaded": False,
                                          "lifecycle_supported": False, "lifecycle_detail": ""}
        self.asset_calls: list[tuple] = []
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.path = self._make_file()
        self.prepare_present = (True, "prepared the pinned snapshot",
                                os.path.join(self.root, "prepared-snapshot"))

    def _make_file(self) -> str:
        path = os.path.join(self.root, "clip.mp3")
        with open(path, "wb") as fh:
            fh.write(b"ID3\x03\x00fake")
        return path

    def _record_progress(self, state: str, note: str) -> None:
        self.progress.append((state, note))
        if self.on_progress:
            self.on_progress(state, note)

    def _asset_state(self, model_id, expected_revision="", required=()):
        self.asset_calls.append(
            ("asset_state", model_id,
             {"expected_revision": expected_revision, "required": tuple(required)}))
        present, detail, path = self.snapshot_present
        return AssetState(model_id, present, detail, path)

    def _prepare(self, model_id, *, revision="", force_download=False, required=()):
        self.asset_calls.append(
            ("prepare", model_id, {"revision": revision, "required": tuple(required)}))
        present, detail, path = self.prepare_present
        return AssetState(model_id, present, detail,
                          path or os.path.join(self.root, "prepared-snapshot"))

    def run(self, cancel: threading.Event | None = None, sys_path: str | None = None,
            **payload):
        req = JobRequest(request_id="r1", run_id="run1", job_id="job1",
                         capability="speech.asr",
                         payload={"path": self.path, "root": self.root, **payload})
        ctx = jobs_mod.JobContext(req=req, cancel=cancel or threading.Event(),
                                  progress=self._record_progress)
        catalog = Catalog([self.row])
        modules = {FAKE_ADAPTER: self.adapter_module} if self.adapter_module else {}
        old_module = sys.modules.get(FAKE_ADAPTER)
        for name, mod in modules.items():
            sys.modules[name] = mod
        try:
            with mock.patch.object(speech_jobs, "catalog", lambda: catalog), \
                    mock.patch.object(asr, "probe_media", lambda path, ffprobe="": _probe()), \
                    mock.patch.object(asr, "language_route", lambda language: _route()), \
                    mock.patch.object(levels, "measure_level",
                                      lambda *a, **k: _Level()), \
                    mock.patch.object(assets_mod, "asset_state", self._asset_state), \
                    mock.patch.object(assets_mod, "prepare", self._prepare), \
                    mock.patch.object(main_model, "snapshot",
                                      lambda *a, **k: self.main_model_snapshot), \
                    mock.patch.object(provider_config, "load",
                                      lambda *a, **k: types.SimpleNamespace(
                                          automatic_handoff=True)), \
                    mock.patch.object(sys, "path",
                                      ([sys_path] + list(sys.path)) if sys_path else sys.path), \
                    mock.patch.object(whisper_ct2, "transcribe",
                                      side_effect=lambda *a, **k: self.whisper_calls.append(k)):
                return speech_jobs.asr_job(ctx)
        finally:
            if self.adapter_module:
                if old_module is None:
                    sys.modules.pop(FAKE_ADAPTER, None)
                else:
                    sys.modules[FAKE_ADAPTER] = old_module

    def close(self):
        self._tmp.cleanup()


def _fake_adapter(calls: list, result: Transcript | None = None,
                  raises: Exception | None = None, on_call=None,
                  strict: bool = False) -> types.ModuleType:
    """A sys.modules stand-in for a row's adapter.

    `strict=True` implements the shared adapter contract EXACTLY as whisper_ct2 declares
    it - no **kwargs, no snapshot_dir - which is the shape the dispatcher must respect:
    a kwarg the real signature does not declare must not be injected. The lenient form
    mirrors transformers_asr, whose published signature declares snapshot_dir.
    """
    mod = types.ModuleType(FAKE_ADAPTER)
    import importlib.machinery
    mod.__spec__ = importlib.machinery.ModuleSpec(FAKE_ADAPTER, loader=None)

    def transcribe(src, *, model_id, language, duration, word_timestamps, allow_download,
                   cancel, progress, ffmpeg="", vad_filter=True, **kwargs):
        calls.append({"src": src, "model_id": model_id, "language": language,
                      "duration": duration, "word_timestamps": word_timestamps,
                      "allow_download": allow_download, "cancel": cancel,
                      "ffmpeg": ffmpeg, "vad_filter": vad_filter, **kwargs})
        if on_call:
            on_call()
        if raises:
            raise raises
        assert result is not None
        return result

    def transcribe_strict(src, *, model_id, language, duration, word_timestamps,
                          allow_download, cancel, progress, ffmpeg="", vad_filter=True):
        calls.append({"src": src, "model_id": model_id, "language": language,
                      "duration": duration, "word_timestamps": word_timestamps,
                      "allow_download": allow_download, "cancel": cancel,
                      "ffmpeg": ffmpeg, "vad_filter": vad_filter})
        if on_call:
            on_call()
        if raises:
            raise raises
        assert result is not None
        return result

    mod.transcribe = transcribe_strict if strict else transcribe
    return mod


class Dispatch(unittest.TestCase):
    def setUp(self):
        self.calls: list = []

    def test_the_row_registered_adapter_runs_not_whisper(self):
        transcript = Transcript(text="the recorded sentence", language="en",
                                language_source="detected", duration=12.0,
                                examined=[(0.0, 12.0)], complete=True,
                                model=ROW_ID, device="cuda", compute_type="float16")
        adapter = _fake_adapter(self.calls, result=transcript)
        harness = _Harness(_row(), adapter)
        try:
            result = harness.run(window_s=8.0, ffmpeg="ffmpeg-x")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"dispatch to the row adapter failed: {result.error and result.error.to_dict()}")
        self.assertEqual(len(self.calls), 1, "the registered adapter must run exactly once")
        self.assertEqual(self.calls[0]["model_id"], ROW_ID)
        self.assertEqual(self.calls[0]["ffmpeg"], "ffmpeg-x")
        self.assertEqual(self.calls[0]["duration"], 12.0)
        self.assertEqual(result.payload["text"], "the recorded sentence")
        self.assertEqual(harness.whisper_calls, [],
                         "a row naming another adapter must never reach whisper_ct2.transcribe")

    def test_identity_and_coverage_provenance_come_from_the_row_and_the_transcript(self):
        # The payload's model identity is the ROW's pinned revision (immutable-selection
        # law), while device/compute_type are what the ADAPTER says it actually used.
        # A payload that claimed the row's identity over an engine that never ran is the
        # laundering these tests exist to stop.
        transcript = Transcript(text="hello", language="en", language_source="explicit",
                                duration=12.0, examined=[(0.0, 11.0)], complete=False,
                                model=ROW_ID, device="cuda", compute_type="float16",
                                word_timestamps=True)
        adapter = _fake_adapter(self.calls, result=transcript)
        harness = _Harness(_row(revision="deadbeef1234"), adapter)
        try:
            result = harness.run(language="en", word_timestamps=True)
        finally:
            harness.close()
        self.assertEqual(result.state, "ready")
        self.assertEqual(result.model.id, ROW_ID)
        self.assertEqual(result.model.revision, "deadbeef1234")
        self.assertEqual(result.model.quantization, "float16")
        self.assertEqual(result.payload["device"], "cuda")
        self.assertTrue(result.payload["word_timestamps"])
        # The three measured context facts the job layer adds around the adapter's work:
        for key in ("probe", "audio_level", "routing"):
            self.assertIn(key, result.payload)
        # 1.0 s at the tail was never decoded -> reported as skipped, completeness false.
        self.assertFalse(result.payload["complete"])
        self.assertEqual([tuple(g) for g in result.coverage.skipped], [(11.0, 12.0)])

    def test_an_adapter_typed_failure_reaches_the_wire_through_the_shared_kind_map(self):
        adapter = _fake_adapter(
            self.calls,
            raises=BackendUnavailable("asset_missing", "the pinned snapshot is not on disk",
                                      "prepare it explicitly"))
        harness = _Harness(_row(), adapter)
        try:
            result = harness.run()
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "model_unavailable")
        self.assertIn("asset_missing", result.error.message)

    def test_a_row_with_no_adapter_is_refused_and_never_falls_back_to_whisper(self):
        # A registered id with no adapter code is a DEVELOPMENT gap, not a licence to run
        # a different engine under the selected id's name. The refusal must name the
        # adapter gap (shared readiness law), not tell the user to prepare weights that
        # are not the problem.
        harness = _Harness(_row(adapter=""), adapter_module=None)
        try:
            result = harness.run()
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "not_configured")
        self.assertIn("no adapter code", result.error.message)
        self.assertIn("adapter", result.error.human_step)
        self.assertEqual(harness.whisper_calls, [])

    def test_an_unimportable_adapter_module_is_dependency_missing_not_a_crash(self):
        # The row's adapter FILE exists (readiness says implemented) but importing it
        # fails on its pinned runtime dependency (the nemo/torch situation on this host
        # today): the caller gets the install-the-dependency answer, not a crash.
        import os
        import shutil
        import tempfile
        d = tempfile.mkdtemp()
        name = "fractured_asr_adapter_under_test"
        try:
            with open(os.path.join(d, name + ".py"), "w") as fh:
                fh.write("import this_pinned_runtime_is_absent\n")
            row = _row(adapter=name)
            harness = _Harness(row, adapter_module=None)
            try:
                result = harness.run(sys_path=d)
            finally:
                harness.close()
        finally:
            sys.modules.pop(name, None)
            shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "not_configured")
        self.assertIn("dependency_missing", result.error.message)
        self.assertIn(name, result.error.message)
        self.assertEqual(harness.whisper_calls, [])

    def test_a_published_device_absence_maps_to_the_runtime_step(self):
        # A CUDA-first row on a CUDA-less host (the parakeet/qwen3 device law) must
        # land as not_configured with the RUNTIME step, not as an internal error -
        # and never as "re-prepare the asset", which would destroy valid weights.
        adapter = _fake_adapter(
            self.calls,
            raises=BackendUnavailable("device_unavailable",
                                      "torch.cuda.is_available() is False on this host",
                                      "install the CUDA build of the pinned runtime"))
        harness = _Harness(_row(), adapter)
        try:
            result = harness.run()
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "not_configured")
        self.assertIn("device_unavailable", result.error.message)
        self.assertIn("CUDA", result.error.human_step)
        self.assertNotIn("prepare", result.error.human_step.lower())

    def test_obsolete_model_selection_is_ignored_and_the_fixed_default_runs(self):
        # FINAL DECISION 2026-11-22: Parakeet-through-Transformers is the SOLE engine;
        # the ASR model selector is removed. A payload still carrying an obsolete
        # selection (an old Whisper choice, saved before the migration) must run the
        # FIXED DEFAULT and report ITS identity - honoring the old value would keep a
        # removed selector live through the back door, and reporting the old id over
        # the default's run is exactly the provenance laundering this file exists for.
        transcript = Transcript(text="fixed default ran", language="en",
                                language_source="explicit", duration=12.0,
                                examined=[(0.0, 12.0)], complete=True,
                                model=ROW_ID, device="cuda", compute_type="auto")
        adapter = _fake_adapter(self.calls, result=transcript)
        harness = _Harness(_row(revision="541d1f99c6b0"), adapter)
        try:
            result = harness.run(language="en", model="Systran/faster-whisper-base")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(self.calls[0]["model_id"], ROW_ID,
                         "the obsolete payload selection must not steer the engine")
        self.assertEqual(result.model.id, ROW_ID)
        self.assertEqual(result.model.revision, "541d1f99c6b0")
        self.assertEqual(harness.whisper_calls, [],
                         "an obsolete Whisper selection must never reach whisper_ct2")

    def test_engine_revision_and_device_are_recorded_per_audio_segment(self):
        # The final decision records engine, revision and device PER AUDIO SEGMENT:
        # a long job can span a device recovery, and a reader must be able to tell
        # which segment ran where. The values are the run's measured facts (the
        # adapter's own device report) and the row's pinned revision - never prose.
        transcript = Transcript(text="hello", language="en", language_source="explicit",
                                duration=12.0, examined=[(0.0, 6.0), (6.0, 12.0)],
                                complete=True, model=ROW_ID, device="cuda",
                                compute_type="auto",
                                segments=[{"start": 0.0, "end": 6.0, "text": "hello"},
                                          {"start": 6.0, "end": 12.0, "text": "world"}])
        adapter = _fake_adapter(self.calls, result=transcript)
        harness = _Harness(_row(revision="rev-pinned-1"), adapter)
        try:
            result = harness.run(language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready")
        for seg in result.payload["segments"]:
            self.assertEqual(seg["engine"], FAKE_ADAPTER,
                             "each segment records the integration that produced it")
            self.assertEqual(seg["revision"], "rev-pinned-1")
            self.assertEqual(seg["device"], "cuda")

    def test_cancellation_during_the_adapter_run_is_a_cancellation_not_a_result(self):
        cancel = threading.Event()
        adapter = _fake_adapter(self.calls,
                                on_call=lambda: cancel.set(),
                                result=Transcript(text="late", duration=12.0))
        harness = _Harness(_row(), adapter)
        try:
            result = harness.run(cancel=cancel)
        finally:
            harness.close()
        self.assertEqual(result.state, "cancelled")
        self.assertEqual(len(self.calls), 1, "the adapter must have been invoked and then cancelled")


ASSET_ID = "nvidia/parakeet-fake-under-test"


def _asset_row(**over) -> ModelSpec:
    over.setdefault("asset", ASSET_ID)
    return _row(**over)


def _ok_transcript() -> Transcript:
    return Transcript(text="provisioned run", language="en", language_source="explicit",
                      duration=12.0, examined=[(0.0, 12.0)], complete=True,
                      model=ROW_ID, device="cpu", compute_type="float32")


class Provisioning(unittest.TestCase):
    """FIRST-USE PROVISIONING (final decision 2026-11-22).

    The frozen English release ships ONE ASR engine whose weights are NOT pre-installed,
    and the Settings UI has no model page - so the job layer is the only place first use
    can happen, and transformers_asr's own failure text already PROMISES "the first upload
    prepares it automatically (progress is shown in the composer)". These tests pin that
    promise at the asr_job seam:

      * a present pinned snapshot runs with ZERO network involvement - assets.prepare
        is never called, and the adapter receives the snapshot path it must load from;
      * a missing pinned asset is provisioned FIRST, with a visible preparing_model
        progress state naming repo@pinned-revision, at the row's pinned revision -
        not a floating main-branch download;
      * failed provisioning is a typed refusal with an actionable step, and the
        adapter is NEVER invoked over weights that are not valid on disk;
      * cancelling during the (minutes-long) download cancels the run;
      * an adapter whose published signature has no snapshot_dir (the whisper_ct2
        shape) is called exactly as it declares - the dispatcher injects nothing.
    """

    def setUp(self):
        self.calls: list = []

    def test_a_present_pinned_snapshot_runs_with_zero_download(self):
        snap = os.path.join(self_root := tempfile.mkdtemp(), "snapshots", "rev-pinned-1")
        adapter = _fake_adapter(self.calls, result=_ok_transcript())
        harness = _Harness(_asset_row(revision="rev-pinned-1"), adapter)
        harness.snapshot_present = (True, "snapshot rev-pinned-1 found in the project cache root", snap)
        try:
            result = harness.run(language="en")
        finally:
            harness.close()
            import shutil
            shutil.rmtree(self_root, ignore_errors=True)
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0].get("snapshot_dir"), snap,
                         "the adapter must load from the pinned snapshot the job verified, "
                         "not re-resolve a repo id (which is how a cold cache reaches the network)")
        prepares = [c for c in harness.asset_calls if c[0] == "prepare"]
        self.assertEqual(prepares, [], "a present snapshot must never trigger a download")

    def test_a_missing_pinned_asset_is_provisioned_first_with_visible_progress(self):
        adapter = _fake_adapter(self.calls, result=_ok_transcript())
        harness = _Harness(_asset_row(revision="rev-pinned-1"), adapter)
        harness.snapshot_present = (False, "no snapshot for this repo id in any configured cache root", "")
        try:
            result = harness.run(language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"first use must provision, not refuse: {result.error and result.error.to_dict()}")
        states = [s for s, _ in harness.progress]
        self.assertIn("preparing_model", states,
                      "the composer must SEE the model being prepared - the promise the "
                      "engine's own failure text makes to the user")
        note = dict(harness.progress)["preparing_model"]
        self.assertIn(ASSET_ID, note)
        self.assertIn("rev-pinned-1", note, "the progress names the PINNED revision, not a float")
        prepares = [c for c in harness.asset_calls if c[0] == "prepare"]
        self.assertEqual(len(prepares), 1, "provision exactly once, before the run")
        self.assertEqual(prepares[0][1], ASSET_ID)
        self.assertEqual(prepares[0][2]["revision"], "rev-pinned-1",
                         "the download is pinned to the row's revision; a floating main-branch "
                         "snapshot would report the row's identity over weights nobody pinned")
        prepared = harness.prepare_present[2]
        self.assertEqual(self.calls[0].get("snapshot_dir"), prepared,
                         "the freshly validated snapshot is the path the adapter loads from - "
                         "which also proves preparation ran BEFORE the engine was invoked")

    def test_failed_provisioning_refuses_with_an_actionable_step_and_never_runs_the_engine(self):
        adapter = _fake_adapter(self.calls, result=_ok_transcript())
        harness = _Harness(_asset_row(revision="rev-pinned-1"), adapter)
        harness.snapshot_present = (False, "no snapshot for this repo id in any configured cache root", "")
        harness.prepare_present = (False, "preparation failed: OfflineModeIsEnabled: offline mode "
                                          "is enabled and the file is not cached", "")
        try:
            result = harness.run(language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "model_unavailable",
                         "the shared kind law maps an unmet asset onto model_unavailable")
        self.assertIn("asset", result.error.message.lower())
        self.assertTrue(result.error.human_step, "the refusal must be actionable, not a dead end")
        self.assertEqual(self.calls, [],
                         "the engine must NEVER be invoked over weights that are not valid on disk")

    def test_cancelling_during_provisioning_cancels_the_run(self):
        cancel = threading.Event()
        adapter = _fake_adapter(self.calls, result=_ok_transcript())
        harness = _Harness(_asset_row(revision="rev-pinned-1"), adapter)
        harness.on_progress = lambda state, note: cancel.set() if state == "preparing_model" else None
        try:
            result = harness.run(cancel=cancel)
        finally:
            harness.close()
        self.assertEqual(result.state, "cancelled",
                         "a download is minutes-long; the cancel pressed during it must not "
                         "be answered with a transcript of audio the user walked away from")
        self.assertEqual(self.calls, [])

    def test_an_adapter_without_the_snapshot_dir_kwarg_is_called_exactly_as_it_declares(self):
        # whisper_ct2's published transcribe has no snapshot_dir. Injecting one into a
        # call that declares **kwargs-free would TypeError at the first real Whisper run
        # (the B6-removal-pending legacy path), so the dispatcher checks the signature.
        adapter = _fake_adapter(self.calls, result=_ok_transcript(), strict=True)
        harness = _Harness(_asset_row(revision="rev-pinned-1"), adapter)
        harness.snapshot_present = (True, "snapshot rev-pinned-1 found in the project cache root",
                                    os.path.join(harness.root, "snapshots", "rev-pinned-1"))
        try:
            result = harness.run(language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("snapshot_dir", self.calls[0],
                         "the dispatcher injects no kwarg the adapter's signature does not declare")


def _loaded_snapshot() -> dict:
    return {"provider": "strata", "endpoint": "http://127.0.0.1:8080",
            "loaded": True, "lifecycle_supported": True, "lifecycle_detail": ""}


class Placement(unittest.TestCase):
    """GPU-first device placement for the speech job (the F91 law, Parakeet half).

    Measured figures (registry, 2026-11-22): the pinned Parakeet peaks at 2845 MiB
    VRAM; with Strata resident on the 12 GB card, free VRAM is ~2737 MiB - a shortage
    ONLY in VRAM: CUDA works, system RAM comfortably fits the run, and the idle
    resident model holds ~8.8 GB of reclaimable VRAM. Sufficient RAM for a CPU run
    must not bypass the release path: the job acquires the exclusive lease, unloads
    ONCE, the window's remeasured plan is the real gate, and the adapter runs on the
    window's device. Coexistence (fits beside the resident model) runs GPU with no
    lease; a busy owner is a typed retryable refusal (the TS caller's whisper fallback
    stays the retained path); a genuine CPU plan carries the SPECIFIC reason. The
    adapter's own reported device is the acceptance evidence - a planned "gpu" alone
    proves nothing - and the placement block must never fabricate it.

    The real device_plan / run_exclusive gates are measured machinery tested in
    test_handoff_devices.py; here the plan is the seam so every branch is
    deterministic, and the asserts pin what the JOB must do with each plan.
    """

    def setUp(self):
        self.calls: list = []

    def _row(self, **over) -> ModelSpec:
        return _row(est_peak_mib=3_142, est_peak_basis="measured: g103 cold-load peak",
                    est_peak_vram_mib=2_845,
                    est_vram_basis="measured: g103 CUDA probe 2026-11-22", **over)

    def _run(self, harness, plan: devices.DevicePlan, run_exclusive=None,
             loaded: bool = True, snapshot=None, **payload):
        """asr_job with the measured machinery replaced by THIS plan (and, when the
        scenario needs a window, a fake lease holder); everything below the placement
        decision stays the harness's contract-shaped fakes. `loaded` is the endpoint
        scenario: the harness reports it through main_model.snapshot, the policy through
        provider_config.load (automatic_handoff True - the operator default).
        `snapshot` replaces that reported state verbatim for scenarios `loaded` alone
        cannot express (restoring, unreachable endpoint)."""
        harness.main_model_snapshot = snapshot if snapshot is not None else (
            _loaded_snapshot() if loaded else {
                "provider": "", "endpoint": "", "loaded": False,
                "lifecycle_supported": False, "lifecycle_detail": ""})
        planner = mock.Mock(return_value=plan)
        exclusive = run_exclusive if run_exclusive is not None else mock.Mock(
            side_effect=AssertionError("this plan must not request the exclusive window"))
        with mock.patch.object(devices, "device_plan", planner), \
                mock.patch.object(handoff, "run_exclusive", exclusive):
            result = harness.run(**payload)
        return result, planner, exclusive

    def _transcript(self, device: str = "cuda") -> Transcript:
        return Transcript(text="the recorded sentence", language="en",
                          language_source="explicit", duration=12.0,
                          examined=[(0.0, 12.0)], complete=True,
                          model=ROW_ID, device=device, compute_type="float16")

    def test_the_measured_row_figures_are_what_the_planner_is_asked_about(self):
        # A missing VRAM estimate must reach device_plan as 0, not be guessed: the
        # planner's refusal to place GPU on an estimate-less row is only honest if the
        # job passes the row's real figures through.
        plan = devices.DevicePlan("speech.asr", "cpu", True, False,
                                  "CPU placement: no VRAM estimate; RAM fits", {})
        adapter = _fake_adapter(self.calls, result=self._transcript(device="cpu"))
        harness = _Harness(self._row(), adapter)
        try:
            _, planner, _ = self._run(harness, plan, language="en")
        finally:
            harness.close()
        args, kwargs = planner.call_args
        self.assertEqual(args[0], "speech.asr")
        self.assertEqual(kwargs["est_peak_mib"], 3_142)
        self.assertEqual(kwargs["est_peak_vram_mib"], 2_845,
                         "the row's measured VRAM peak is the figure the planner gates on")

    def test_a_gpu_plan_that_fits_beside_the_resident_model_runs_cuda_without_a_lease(self):
        # Coexistence: the release path is for shortages only. Touching the resident
        # model when the run already fits would interrupt nothing only if idle - and
        # the policy forbids unloading a model that did not need to move.
        plan = devices.DevicePlan("speech.asr", "gpu", True, False,
                                  "GPU placement: 3200 MiB free VRAM covers the 2845 MiB "
                                  "peak; the resident main model stays loaded", {})
        adapter = _fake_adapter(self.calls, result=self._transcript())
        harness = _Harness(self._row(), adapter)
        try:
            result, _, exclusive = self._run(harness, plan, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["device"], "gpu",
                         "the plan device must reach the adapter: self-placement by the "
                         "engine is the F91 bug on this path")
        self.assertFalse(exclusive.called,
                         "a fitting GPU run must not acquire the lease or unload anything")
        plc = result.payload["placement"]
        self.assertEqual(plc["plan"]["device"], "gpu")
        self.assertNotIn("handoff", plc, "no window was used; the report must not claim one")

    def test_a_fit_under_the_measured_commit_demand_is_refused_not_squeezed(self):
        # The supervisor defers its commit-ceiling refusal to this dispatcher (F91 law
        # 2026-11-23), so the "refuse, never squeeze" law has to live HERE for the runs
        # that stay in the NORMAL window. Measured batch state: the window floors to
        # 256 MiB while the Parakeet row's commit peak is 4,283 MiB - the CPU load
        # dies inside the engine's allocator, which the wire can only report as a
        # crash. The dispatcher must refuse the same fact, typed, before the engine.
        plan = devices.DevicePlan("speech.asr", "cpu", True, False,
                                  "CPU placement: the GPU cannot fit after the release "
                                  "on this card; RAM fits", {})
        adapter = _fake_adapter(self.calls, result=self._transcript(device="cpu"))
        harness = _Harness(self._row(est_peak_commit_mib=4_283), adapter)
        try:
            with mock.patch.object(job_limits, "normal_ceiling_bytes",
                                   return_value=(256 << 20, {"bound_by": "commit charge"})):
                result, _, _ = self._run(harness, plan, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed", result.to_dict())
        assert result.error is not None
        self.assertEqual(result.error.reason, "memory_pressure")
        self.assertTrue(result.error.retryable, "commit charge can free; the upload is "
                                                "worth resending once it does")
        self.assertEqual(self.calls, [],
                         "the engine must never be asked to load under a ceiling it was "
                         "measured needing more than - that is the squeeze this law bans")
        self.assertIn("4283", result.error.message)
        self.assertIn("256", result.error.message)

    def test_a_fit_above_the_measured_commit_demand_runs_and_records_the_window(self):
        # The guard must not become a blanket refusal: a window above the measured
        # demand + margin runs, and the live ceiling is recorded with the placement
        # so the evidence shows WHICH window the run was admitted under.
        plan = devices.DevicePlan("speech.asr", "cpu", True, False,
                                  "CPU placement: GPU disabled by policy; RAM fits", {})
        adapter = _fake_adapter(self.calls, result=self._transcript(device="cpu"))
        harness = _Harness(self._row(est_peak_commit_mib=4_283), adapter)
        try:
            with mock.patch.object(job_limits, "normal_ceiling_bytes",
                                   return_value=(8192 << 20, {"bound_by": "configured"})):
                result, _, _ = self._run(harness, plan, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready", f"{result.error and result.error.to_dict()}")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(result.payload["placement"]["window_ceiling_bytes"], 8192 << 20)

    def test_mid_restore_with_an_answering_endpoint_is_retryable_busy_not_terminal(self):
        # F127(d) (2026-11-23, accept-8): the live row died in ~300 ms mid-restore - a
        # window had just ended, the main model was unloaded and being restored, the
        # planner answered "none" ("the main model is not loaded, so there is nothing
        # to reclaim"), and the dispatcher answered with the PERSISTENT terminal
        # refusal (memory_pressure, retryable=False). Restore is transient: the same
        # upload minutes later runs on the same pinned engine. The refusal must be the
        # typed retryable resource_busy naming the restore as the way out.
        plan = devices.DevicePlan(
            "speech.asr", "none", False, True,
            "neither device fits: free physical RAM is 1397 MiB, under the 3398 MiB "
            "this load needs; GPU: free VRAM is 1455 MiB, under the 3101 MiB this "
            "needs; the main model is not loaded, so there is nothing to reclaim", {})
        restoring = {"provider": "strata", "endpoint": "http://127.0.0.1:8080",
                     "loaded": False, "reachable": True,
                     "lifecycle_supported": True, "lifecycle_detail": ""}
        adapter = _fake_adapter(self.calls)
        harness = _Harness(self._row(), adapter)
        try:
            result, _, exclusive = self._run(harness, plan, loaded=False,
                                             snapshot=restoring, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed", result.to_dict())
        assert result.error is not None
        self.assertEqual(result.error.reason, "resource_busy")
        self.assertTrue(result.error.retryable,
                        "a restoring endpoint is a moving state: the upload is worth "
                        "resending once the model is back")
        self.assertIn("being restored", result.error.message)
        self.assertEqual(self.calls, [], "the engine must not be touched mid-restore")
        self.assertFalse(exclusive.called,
                         "there is nothing to release mid-restore: no window may be acquired")

    def test_a_dead_endpoint_keeps_the_terminal_answer(self):
        # F127(c) control: an endpoint that never answers leaves the loaded state
        # UNKNOWN as a hardware/configuration fact - the retryable busy answer belongs
        # to a RESTORING model, not to a dead control plane. The terminal persistent
        # refusal (with the policy human step) must survive this fix.
        plan = devices.DevicePlan(
            "speech.asr", "none", False, True,
            "neither device fits: free physical RAM is 1397 MiB, under the 3398 MiB "
            "this load needs; GPU: free VRAM is 1455 MiB, under the 3101 MiB this "
            "needs; the main-model control endpoint did not answer, so its loaded "
            "state is unknown and no release can be confirmed", {})
        dead = {"provider": "strata", "endpoint": "http://127.0.0.1:8080",
                "loaded": False, "reachable": False,
                "lifecycle_supported": True, "lifecycle_detail": ""}
        adapter = _fake_adapter(self.calls)
        harness = _Harness(self._row(), adapter)
        try:
            result, _, _ = self._run(harness, plan, loaded=False,
                                     snapshot=dead, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed", result.to_dict())
        assert result.error is not None
        self.assertEqual(result.error.reason, "memory_pressure")
        self.assertFalse(result.error.retryable,
                         "an endpoint that never answers is not a transient restore")
        self.assertEqual(self.calls, [])

    def test_the_shipped_integration_declares_the_kwargs_the_worker_injects(self):
        # _accepts_kwarg only injects declared kwargs: if the real Parakeet
        # integration ever drops device/placement_reason, the worker silently
        # falls back to engine self-placement - the F91 bug returns on the live
        # path while every harness test stays green. This pin catches that.
        import inspect

        from ruke_ml.speech import transformers_asr

        params = inspect.signature(transformers_asr.transcribe).parameters
        for name in ("device", "placement_reason"):
            self.assertIn(name, params,
                          f"transcribe() must declare {name!r} so the planned "
                          "placement reaches the real adapter")

    def test_the_vram_only_shortage_acquires_one_window_and_runs_on_its_device(self):
        # The exact F91 shape: CUDA works, RAM fits, free VRAM (2737 MiB) is under the
        # 2845 MiB peak, and the idle resident model holds reclaimable VRAM. The job
        # must request exactly one exclusive window and hand the WINDOW's device to the
        # adapter - not settle for CPU because RAM sufficed.
        plan = devices.DevicePlan(
            "speech.asr", "gpu", False, True,
            "GPU placement: free VRAM is 2737 MiB, under the 2845 MiB this needs; "
            "releasing the resident main model is what would make it fit", {})
        seen: dict = {}
        window: list = []

        def fake(name: str, work, **kw):
            seen.update(name=name, **kw)
            out = work({"device": "gpu", "main_model_unloaded_by_us": True,
                        "resource_window": "exclusive"})
            window.append(out)
            return {"ok": True, "final_status": "ok", "device_used": "gpu",
                    "plan": plan.as_dict(),
                    "plan_after_unload": {"device": "gpu", "fits": True,
                                          "reason": "free VRAM 11500 MiB after the release"},
                    "freed_vram_mib": 8800, "work": out,
                    "restore": {"ok": True}, "restore_ready": {"ok": True}}

        adapter = _fake_adapter(self.calls, result=self._transcript())
        harness = _Harness(self._row(), adapter)
        try:
            result, _, _ = self._run(harness, plan, run_exclusive=fake, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(seen["name"], "speech.asr")
        self.assertEqual(seen["owner"], "job1", "the lease names the owning job")
        self.assertTrue(seen["allow_unload"],
                        "the release is authorized by the automatic-handoff policy; the "
                        "job passes that policy through, it does not hardcode it")
        self.assertEqual(len(self.calls), 1, "exactly one run, inside the one window")
        self.assertEqual(self.calls[0]["device"], "gpu",
                         "the adapter runs on the window's device, not the pre-unload plan's")
        plc = result.payload["placement"]
        self.assertEqual(plc["handoff"]["freed_vram_mib"], 8800,
                         "the report carries the measured release, the acceptance evidence")
        self.assertEqual(plc["handoff"]["plan_after_unload"]["device"], "gpu")
        self.assertEqual(plc["plan"]["device"], "gpu")

    def test_a_genuine_cpu_plan_runs_cpu_with_the_specific_reason_recorded(self):
        # No CUDA / estimate-less / release-cannot-fit: the supported CPU path runs,
        # and WHY is recorded, so a reader never confuses this with the F91 bypass.
        plan = devices.DevicePlan(
            "speech.asr", "cpu", True, False,
            "CPU placement: releasing the resident main model would not free enough "
            "VRAM for the 2845 MiB peak; RAM fits", {})
        adapter = _fake_adapter(self.calls, result=self._transcript(device="cpu"))
        harness = _Harness(self._row(), adapter)
        try:
            result, _, exclusive = self._run(harness, plan, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(self.calls[0]["device"], "cpu")
        self.assertFalse(exclusive.called)
        self.assertIn("would not free enough VRAM",
                      result.payload["placement"]["plan"]["reason"],
                      "the specific recorded reason rides into the payload")

    def test_a_busy_owner_is_a_retryable_refusal_that_never_touches_the_engine(self):
        # Strata busy with real inference: queue semantics, never an interruption.
        # Retryable is the LAW here: the TS caller keeps its whisper fallback for a
        # retryable capability failure, and a held lease is exactly that.
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB, under the "
                                  "2845 MiB this needs; releasing the resident main "
                                  "model is what would make it fit", {})
        busy = mock.Mock(return_value={"ok": False, "reason": "coordination_held",
                                       "detail": "the playwright lock is held",
                                       "holder": {"owner": "e2e"}})
        adapter = _fake_adapter(self.calls, result=self._transcript())
        harness = _Harness(self._row(), adapter)
        try:
            result = self._run(harness, plan, run_exclusive=busy, language="en")[0]
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "resource_busy")
        self.assertTrue(result.error.retryable,
                        "a held lease must map onto the caller's retained fallback")
        self.assertEqual(self.calls, [],
                         "busy Strata must never be interrupted by a speculative engine load")
        self.assertEqual(harness.whisper_calls, [])

    def test_a_strict_adapter_is_never_handed_the_device_kwarg(self):
        # whisper_ct2's published transcribe declares no device. Injecting one into a
        # **kwargs-free signature TypeErrors at the first run: the dispatcher injects
        # only kwargs the adapter declares (the snapshot_dir law, applied to device).
        plan = devices.DevicePlan("speech.asr", "gpu", True, False,
                                  "GPU placement: fits beside the resident main model", {})
        adapter = _fake_adapter(self.calls, result=self._transcript(), strict=True)
        harness = _Harness(self._row(), adapter)
        try:
            result, _, _ = self._run(harness, plan, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready",
                         f"{result.error and result.error.to_dict()}")
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("device", self.calls[0],
                         "no kwarg the adapter's signature does not declare")

    def test_cancellation_inside_the_window_is_a_cancellation_not_a_result(self):
        # The cancel arrives while the model is unloaded; the window must close, the
        # model restore (the holder's own finally), and the job answer a cancellation.
        cancel = threading.Event()
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB, under the "
                                  "2845 MiB this needs; releasing the resident main "
                                  "model is what would make it fit", {})

        def fake(name: str, work, **kw):
            out = work({"device": "gpu", "main_model_unloaded_by_us": True,
                        "resource_window": "exclusive"})
            return {"ok": True, "final_status": "ok", "device_used": "gpu",
                    "plan": plan.as_dict(),
                    "plan_after_unload": {"device": "gpu", "fits": True},
                    "work": out, "restore": {"ok": True}, "restore_ready": {"ok": True}}

        adapter = _fake_adapter(self.calls, on_call=lambda: cancel.set(),
                                result=Transcript(text="late", duration=12.0))
        harness = _Harness(self._row(), adapter)
        try:
            result, _, _ = self._run(harness, plan, run_exclusive=fake,
                                     cancel=cancel, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "cancelled")
        self.assertEqual(len(self.calls), 1)

    def test_a_typed_adapter_failure_inside_the_window_keeps_its_type(self):
        # A device_unavailable raised inside the lease must map through the shared
        # kind table (not_configured + the CUDA step), not be laundered into the
        # holder's generic handoff_failed bucket by the window's crash handling.
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB; releasing the "
                                  "resident main model is what would make it fit", {})

        def fake(name: str, work, **kw):
            out = work({"device": "gpu", "main_model_unloaded_by_us": True,
                        "resource_window": "exclusive"})
            return {"ok": True, "final_status": "ok", "device_used": "gpu",
                    "plan": plan.as_dict(),
                    "plan_after_unload": {"device": "gpu", "fits": True},
                    "work": out, "restore": {"ok": True}, "restore_ready": {"ok": True}}

        adapter = _fake_adapter(
            self.calls,
            raises=BackendUnavailable("device_unavailable",
                                      "torch.cuda.is_available() is False on this host",
                                      "install the CUDA build of the pinned runtime"))
        harness = _Harness(self._row(), adapter)
        try:
            result, _, _ = self._run(harness, plan, run_exclusive=fake, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "not_configured",
                         "the typed adapter failure must survive the window intact")
        self.assertIn("device_unavailable", result.error.message)

    def _loader_death_adapter(self, dies_on: str = "gpu") -> "types.ModuleType":
        """F135 (accept-11, 2026-11-23): the pagefile manager shrank the commit limit
        mid-import and the worker died inside the OS loader - a plain OSError
        [WinError 1455] while importing cufft64_11.dll, NOT the adapter's typed
        BackendUnavailable. This adapter raises that exact shape on `dies_on` and
        returns a CPU-run transcript on any other device."""
        import importlib.machinery

        mod = types.ModuleType(FAKE_ADAPTER)
        mod.__spec__ = importlib.machinery.ModuleSpec(FAKE_ADAPTER, loader=None)

        def transcribe(src, *, model_id, language, duration, word_timestamps,
                       allow_download, cancel, progress, ffmpeg="", vad_filter=True,
                       **kwargs):
            self.calls.append(dict(kwargs))
            if str(kwargs.get("device")) == dies_on:
                raise OSError("[WinError 1455] The paging file is too small for this "
                              "operation to complete. 'cufft64_11.dll'")
            return Transcript(text="the recorded sentence", language="en",
                              language_source="explicit", duration=12.0,
                              examined=[(0.0, 12.0)], complete=True,
                              model=ROW_ID, device=str(kwargs.get("device") or "cpu"),
                              compute_type="float32",
                              segments=[{"start": 0.0, "end": 12.0,
                                         "text": "the recorded sentence"}])

        mod.transcribe = transcribe
        return mod

    def test_f135_a_loader_death_on_gpu_reruns_the_same_model_on_cpu(self):
        # F123 (user brief 2026-11-23): "device fallback keeps the SAME model". The
        # live fr-U1 row died as handoff_failed: OSError [WinError 1455] - the loader
        # death propagated out of the window work into the window's generic crash
        # bucket and the row failed. The dispatcher must rerun the identical pinned
        # Parakeet on CPU with the OS reason as the placement reason; the adapter's
        # per-segment CPU report is the proof.
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB; releasing the "
                                  "resident main model is what would make it fit", {})

        def fake(name: str, work, **kw):
            out = work({"device": "gpu", "reason": "fits after the release",
                        "main_model_unloaded_by_us": True, "resource_window": "exclusive"})
            return {"ok": True, "final_status": "ok", "device_used": "cpu",
                    "plan_after_unload": {"device": "gpu", "fits": True},
                    "work": out, "restore": {"ok": True}, "restore_ready": {"ok": True}}

        adapter = self._loader_death_adapter(dies_on="gpu")
        harness = _Harness(self._row(est_peak_commit_mib=4_375), adapter)
        try:
            with mock.patch.object(speech_jobs, "_sleep", lambda s: None):
                result, _, _ = self._run(harness, plan, run_exclusive=fake, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready", f"{result.error and result.error.to_dict()}")
        self.assertEqual([c["device"] for c in self.calls], ["gpu", "gpu", "cpu"],
                         "F136: the GPU placement dies in the loader; the settled SAME-device "
                         "retry dies too (this adapter dies on every GPU call); only then does "
                         "the SAME model move to CPU")
        self.assertIn("retried on gpu", self.calls[1]["placement_reason"])
        self.assertIn("pagefile settled", self.calls[1]["placement_reason"])
        self.assertIn("loader died", self.calls[2]["placement_reason"])
        self.assertIn("WinError 1455", self.calls[2]["placement_reason"])
        plc = result.payload["placement"]
        self.assertEqual(plc["loader_retry"]["device"], "gpu")
        self.assertIn("WinError 1455", plc["loader_retry"]["reason"])
        self.assertEqual(plc["device_fallback"]["from_device"], "gpu")
        self.assertEqual(plc["device_fallback"]["to_device"], "cpu")
        self.assertTrue(plc["device_fallback"]["same_model"],
                        "the fallback keeps the SAME pinned model - F123's law")
        self.assertIn("WinError 1455", plc["device_fallback"]["reason"])
        self.assertIn("WinError 1455", plc["loader_death"],
                      "the loader death is evidence, not a swallowed exception")
        self.assertEqual({s["device"] for s in result.payload["segments"]}, {"cpu"},
                         "the engine reports the device it RAN on: cpu")

    def test_f135_a_loader_death_on_both_devices_is_a_typed_retryable_pressure(self):
        # The CPU fallback of the same model died too (accept-11's shape: the host
        # stayed at ~1.9 GB phys, every import died). The answer is the typed
        # memory_pressure naming the exact OS error and the retry - never the
        # window's generic "handoff_failed: internal" bucket.
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB", {})

        def fake(name: str, work, **kw):
            out = work({"device": "gpu", "reason": "fits after the release"})
            return {"ok": True, "final_status": "ok", "work": out,
                    "restore": {"ok": True}, "restore_ready": {"ok": True}}

        # Die on EVERY device this time: accept-11's host died on both axes.
        adapter_all = self._loader_death_adapter(dies_on="gpu")

        def transcribe_all(src, **kwargs):
            self.calls.append(dict(kwargs))
            raise OSError("[WinError 1455] The paging file is too small for this "
                          "operation to complete. 'cufft64_11.dll'")

        adapter_all.transcribe = transcribe_all
        harness = _Harness(self._row(est_peak_commit_mib=4_375), adapter_all)
        try:
            with mock.patch.object(speech_jobs, "_sleep", lambda s: None):
                result, _, _ = self._run(harness, plan, run_exclusive=fake, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed", result.to_dict())
        self.assertEqual([c["device"] for c in self.calls], ["gpu", "gpu", "cpu"],
                         "F136: settled same-device retry first, then the SAME model on CPU, "
                         "before the typed failure")
        assert result.error is not None
        self.assertEqual(result.error.reason, "memory_pressure")
        self.assertTrue(result.error.retryable, "the pagefile re-extends: resend the upload")
        self.assertIn("WinError 1455", result.error.message)
        self.assertIn("gpu", result.error.message)
        self.assertIn("CPU", result.error.message,
                      "the message names the same-model fallback that also died")

    def test_f135_a_cpu_placement_loader_death_does_not_retry_itself(self):
        # The near miss: the placement was already CPU. There is no lower device -
        # exactly one adapter call, and the typed memory_pressure WITHOUT the
        # fallback clause (the message must not claim a retry that never happened).
        plan = devices.DevicePlan("speech.asr", "cpu", True, False,
                                  "CPU placement: the GPU is disabled by policy", {})
        adapter = self._loader_death_adapter(dies_on="cpu")
        harness = _Harness(self._row(est_peak_commit_mib=4_375), adapter)
        slept: list[float] = []
        try:
            with mock.patch.object(job_limits, "normal_ceiling_bytes",
                                   return_value=(8192 << 20, {"bound_by": "configured"})), \
                 mock.patch.object(speech_jobs, "_sleep", slept.append):
                result, _, _ = self._run(harness, plan, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed", result.to_dict())
        self.assertEqual([c["device"] for c in self.calls], ["cpu"],
                         "CPU is the floor: no second call on the same device")
        self.assertEqual(slept, [],
                         "F136: the CPU death is the terminal fact - no settle for a device "
                         "that will not be retried")
        assert result.error is not None
        self.assertEqual(result.error.reason, "memory_pressure")
        self.assertIn("WinError 1455", result.error.message)
        self.assertNotIn("retried", result.error.message)

    def test_f136_a_loader_death_that_clears_after_settle_stays_on_the_same_device(self):
        # The F136 law's normal path (accept-12 evidence): the loader dies mid pagefile
        # collapse; the collapse settles within ~15 s (f91-host.csv: 80,543 -> 24,920 MiB
        # free commit, and the post-collapse steady state fits the measured demand); the
        # SAME pinned model on the SAME device then runs. NO device move, NO engine move.
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB", {})

        def fake(name: str, work, **kw):
            out = work({"device": "gpu", "reason": "fits after the release",
                        "main_model_unloaded_by_us": True, "resource_window": "exclusive"})
            return {"ok": True, "final_status": "ok", "device_used": "gpu",
                    "plan_after_unload": {"device": "gpu", "fits": True},
                    "work": out, "restore": {"ok": True}, "restore_ready": {"ok": True}}

        # dies_on="cpu": the base adapter never dies on GPU. This wrapper records EVERY
        # attempt (the base only records calls that reach it) and raises the collapse
        # death on the first GPU attempt only.
        adapter = self._loader_death_adapter(dies_on="cpu")
        gpu_calls: list[int] = [0]

        def transcribe(src, *, model_id, language, duration, word_timestamps,
                       allow_download, cancel, progress, **kwargs):
            self.calls.append(dict(kwargs))
            if str(kwargs.get("device")) == "gpu":
                gpu_calls[0] += 1
                if gpu_calls[0] == 1:      # only the first GPU attempt is inside the collapse
                    raise OSError("[WinError 1455] The paging file is too small for this "
                                  "operation to complete. 'cufft64_11.dll'")
            return Transcript(text="the recorded sentence", language="en",
                              language_source="explicit", duration=12.0,
                              examined=[(0.0, 12.0)], complete=True,
                              model=ROW_ID, device=str(kwargs.get("device") or "cpu"),
                              compute_type="float32",
                              segments=[{"start": 0.0, "end": 12.0,
                                         "text": "the recorded sentence"}])

        adapter.transcribe = transcribe
        harness = _Harness(self._row(est_peak_commit_mib=4_375), adapter)
        try:
            with mock.patch.object(speech_jobs, "_sleep", lambda s: None):
                result, _, _ = self._run(harness, plan, run_exclusive=fake, language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "ready", result.to_dict())
        self.assertEqual([c["device"] for c in self.calls], ["gpu", "gpu"],
                         "the settled retry runs on the SAME device; CPU is never touched")
        plc = result.payload["placement"]
        self.assertEqual(plc["loader_retry"]["device"], "gpu")
        self.assertIn("WinError 1455", plc["loader_retry"]["reason"])
        self.assertNotIn("device_fallback", plc,
                         "the transient cleared: no device fallback happened, so none is claimed")
        self.assertEqual({s["device"] for s in result.payload["segments"]}, {"gpu"},
                         "the engine ran on GPU - the per-segment device is the proof")

    def _f137_fit_driver(self, probe, slept):
        """F137 driver: GPU loader death on the first attempt only, patched fit-probe
        stream and seam-patched sleeps. Mirrors the F136 clear-after-settle trio."""
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB", {})

        def fake(name: str, work, **kw):
            out = work({"device": "gpu", "reason": "fits after the release",
                        "main_model_unloaded_by_us": True, "resource_window": "exclusive"})
            return {"ok": True, "final_status": "ok", "device_used": "gpu",
                    "plan_after_unload": {"device": "gpu", "fits": True},
                    "work": out, "restore": {"ok": True}, "restore_ready": {"ok": True}}

        adapter = self._loader_death_adapter(dies_on="cpu")   # base never dies on GPU
        gpu_calls: list[int] = [0]

        def transcribe(src, *, model_id, language, duration, word_timestamps,
                       allow_download, cancel, progress, **kwargs):
            self.calls.append(dict(kwargs))
            if str(kwargs.get("device")) == "gpu":
                gpu_calls[0] += 1
                if gpu_calls[0] == 1:      # only the first GPU attempt is inside the collapse
                    raise OSError("[WinError 1455] The paging file is too small for this "
                                  "operation to complete. 'cufft64_11.dll'")
            return Transcript(text="the recorded sentence", language="en",
                              language_source="explicit", duration=12.0,
                              examined=[(0.0, 12.0)], complete=True,
                              model=ROW_ID, device=str(kwargs.get("device") or "cpu"),
                              compute_type="float32",
                              segments=[{"start": 0.0, "end": 12.0,
                                         "text": "the recorded sentence"}])

        adapter.transcribe = transcribe
        harness = _Harness(self._row(est_peak_commit_mib=4_375), adapter)
        try:
            with mock.patch.object(speech_jobs, "_sleep", slept.append), \
                    mock.patch.object(speech_jobs, "_free_commit_mib", probe):
                result, _, _ = self._run(harness, plan, run_exclusive=fake, language="en")
        finally:
            harness.close()
        return result

    def test_f137_the_asr_settle_waits_until_free_commit_fits_the_import(self):
        # accept-13's fr-U1 shape: the 20 s settle (and the 16 s sampler grid) cannot see
        # the momentary dips inside the collapse; the ASR import demand (2 x 4,375 + 256
        # = 9,006 MiB, the gate's import_required formula) is what the settle must READ,
        # on 10 consecutive 1 s samples, before the same pinned model retries.
        slept: list[float] = []
        stream = iter([5_000, 7_000] + [12_000] * 30)
        result = self._f137_fit_driver(lambda: next(stream), slept)
        self.assertEqual(result.state, "ready", result.to_dict())
        self.assertEqual([c["device"] for c in self.calls], ["gpu", "gpu"],
                         "the fit-driven settled retry runs on the SAME device")
        self.assertEqual(slept, [1.0] * 11,
                         "2 shortage samples + 10 consecutive fit samples, the wait is "
                         "fit-driven - NOT the fixed 20 s")
        plc = result.payload["placement"]
        self.assertEqual(plc["loader_retry"]["required_commit_mib"], 9_006,
                         "the wait is sized from the pinned row's own commit demand, "
                         "the same import_required formula the handoff gate enforces")
        self.assertEqual(plc["loader_retry"]["free_commit_mib_at_retry"], 12_000,
                         "the retry records the headroom it actually measured")
        self.assertLess(plc["loader_retry"]["settle_s"], 20.0,
                        "settle_s is the MEASURED fit wait, not the F136 constant")

    def test_f137_an_unreadable_probe_keeps_the_fixed_asr_settle(self):
        # The near miss: a host whose commit charge cannot be read must NOT get an
        # invented number - the F136 fixed settle stands, unchanged.
        slept: list[float] = []
        result = self._f137_fit_driver(lambda: None, slept)
        self.assertEqual(result.state, "ready", result.to_dict())
        self.assertEqual(slept, [1.0] * int(speech_jobs._LOADER_SETTLE_S),
                         "probe unreadable -> exactly the F136 fixed settle")
        plc = result.payload["placement"]
        self.assertEqual(plc["loader_retry"]["required_commit_mib"], 9_006)
        self.assertNotIn("free_commit_mib_at_retry", plc["loader_retry"],
                         "no headroom claim without a measurement")

    def test_a_failed_restore_reports_retryable_evidence_not_a_lost_run(self):
        # The transcript ran; the model did not come back. The answer is the typed
        # restore failure with the retry step - the caller's retained fallback and a
        # later retry both need to know the run itself completed.
        plan = devices.DevicePlan("speech.asr", "gpu", False, True,
                                  "GPU placement: free VRAM is 2737 MiB; releasing the "
                                  "resident main model is what would make it fit", {})
        def failed_restore(name, work, **kw):
            # Mirrors run_exclusive's real order: the work RUNS and lands on disk,
            # then the restoration of the main model fails around it.
            out = work({"device": "gpu", "main_model_unloaded_by_us": True,
                        "resource_window": "exclusive"})
            return {"ok": False, "final_status": "restore_failed", "reason": "restore_failed",
                    "detail": "the endpoint did not come back within the window",
                    "note": "processing output is already on disk; retry recovery without "
                            "repeating the processing",
                    "plan_after_unload": {"device": "gpu", "fits": True},
                    "freed_vram_mib": 8800, "work": out,
                    "restore": {"ok": True},
                    "restore_ready": {"ok": False,
                                      "detail": "the endpoint did not come back "
                                                "within the window"}}
        adapter = _fake_adapter(self.calls, result=self._transcript())
        harness = _Harness(self._row(), adapter)
        try:
            result, _, _ = self._run(harness, plan, run_exclusive=failed_restore,
                                     language="en")
        finally:
            harness.close()
        self.assertEqual(result.state, "failed")
        # "restore_failed" is the window's journal word; the wire vocabulary is closed
        # (contracts.ERROR_REASONS, consumed by the TS/Rust readers), so the failure
        # lands as retryable resource_busy and the MESSAGE names the restore failure.
        self.assertEqual(result.error.reason, "resource_busy")
        self.assertTrue(result.error.retryable)
        self.assertIn("restore", result.error.message)
        self.assertEqual(len(self.calls), 1,
                         "the run happened once inside the window before the restore failed")


if __name__ == "__main__":
    unittest.main()
