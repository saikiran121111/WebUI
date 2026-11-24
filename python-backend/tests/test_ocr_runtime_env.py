"""The OCR environment must be judged BEFORE an exclusive resource window opens.

Measured 2026-11-17 15:44:37: a real coordinated OCR window - main model unloaded, 51,079 MiB of
physical RAM measured freed, lease held, device re-planned to CPU - died 30 seconds in with

    load_failed: VersionError: Detected incompatible Protobuf Gencode/Runtime versions when
    loading sentencepiece_model.proto: gencode 7.36.1 runtime 6.33.4

At that moment readiness had answered `ready=True, blockers=[]`: the pinned paddle distributions
were installed and BOTH pinned model snapshots were on disk. The environment could not build the
pipeline at all, and nothing we checked could see it, because the failure lives in a generated
stub that only runs while the VLM tokenizer is being constructed.

These tests build a FAKE venv tree on disk - a directory shaped like an environment, never an
interpreter, never a model - so the gate is exercised with no RAM cost, no network and no paddle.
"""
from __future__ import annotations

import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml.documents import ocr_paddle
from ruke_ml.models import ocr_runtime

_STUB = """\
from google.protobuf import runtime_version as _runtime_version
from google.protobuf import symbol_database as _symbol_database

_runtime_version.ValidateProtobufRuntimeVersion(
    _runtime_version.Domain.PUBLIC,
    {major},
    {minor},
    {patch},
    '',
    'sentencepiece_model.proto'
)
"""

def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name or "").strip().lower()


def _fake_env(root: Path, *, protobuf: str, gencode: tuple[int, int, int],
              pins: dict[str, str] | None = None) -> str:
    """Create a venv-shaped directory tree and return the interpreter path it advertises."""
    scripts = root / "Scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    exe = scripts / "python.exe"
    exe.write_bytes(b"MZ-not-an-interpreter")
    site = root / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    (site / "protobuf-{0}.dist-info".format(protobuf)).mkdir()
    for name, version in (pins if pins is not None else ocr_runtime.PINNED).items():
        if _norm(name) == "protobuf":
            continue
        (site / "{0}-{1}.dist-info".format(name, version)).mkdir()
    pkg = site / "sentencepiece"
    pkg.mkdir(exist_ok=True)
    (pkg / "sentencepiece_model_pb2.py").write_text(
        _STUB.format(major=gencode[0], minor=gencode[1], patch=gencode[2]), encoding="utf-8")
    return str(exe)


class GencodeFloor(unittest.TestCase):
    def test_the_stub_that_raises_is_found_without_importing_anything(self):
        with tempfile.TemporaryDirectory() as td:
            site = Path(td) / "site-packages"
            (site / "sentencepiece").mkdir(parents=True)
            (site / "sentencepiece" / "sentencepiece_model_pb2.py").write_text(
                _STUB.format(major=7, minor=36, patch=1), encoding="utf-8")
            floor, origin = ocr_runtime.gencode_floor([site])
            self.assertEqual((7, 36, 1), floor)
            self.assertIn("sentencepiece_model_pb2.py", origin.replace("\\", "/"))

    def test_a_tree_with_no_validating_stub_has_no_floor(self):
        with tempfile.TemporaryDirectory() as td:
            site = Path(td) / "site-packages"
            (site / "thing").mkdir(parents=True)
            (site / "thing" / "other_pb2.py").write_text("# no validator here\n", encoding="utf-8")
            self.assertEqual(((0,), ""), ocr_runtime.gencode_floor([site]))

    def test_only_the_highest_requirement_counts(self):
        with tempfile.TemporaryDirectory() as td:
            site = Path(td) / "site-packages"
            (site / "a").mkdir(parents=True)
            (site / "b").mkdir(parents=True)
            (site / "a" / "old_pb2.py").write_text(
                _STUB.format(major=4, minor=25, patch=0), encoding="utf-8")
            (site / "b" / "new_pb2.py").write_text(
                _STUB.format(major=7, minor=36, patch=1), encoding="utf-8")
            self.assertEqual((7, 36, 1), ocr_runtime.gencode_floor([site])[0])

    def test_version_tuples_compare_numerically_not_lexically(self):
        self.assertLess(ocr_runtime._version_tuple("6.33.4"), ocr_runtime._version_tuple("7.36.1"))
        # A string comparison would put "10.0.0" BELOW "9.9.9"; a numeric one does not.
        self.assertLess("10.0.0", "9.9.9")
        self.assertGreater(ocr_runtime._version_tuple("10.0.0"), ocr_runtime._version_tuple("9.9.9"))
        self.assertLess(ocr_runtime._version_tuple("7.36"), ocr_runtime._version_tuple("7.36.1"))
        self.assertEqual((0,), ocr_runtime._version_tuple(""))


class AbiGate(unittest.TestCase):
    """The exact failure shape measured on this host, replayed against a fake environment."""

    def _status(self, root: Path, **kwargs) -> ocr_runtime.RuntimeStatus:
        exe = _fake_env(root, **kwargs)
        ocr_runtime.clear_cache()
        with mock.patch.dict(os.environ, {ocr_runtime.ENV_INTERPRETER: exe}, clear=False):
            return ocr_runtime.status()

    def test_an_older_runtime_than_the_gencode_refuses_the_environment(self):
        with tempfile.TemporaryDirectory() as td:
            status = self._status(Path(td), protobuf="6.33.4", gencode=(7, 36, 1))
            self.assertFalse(status.found)
            self.assertEqual(1, len(status.abi_issues))
            issue = status.abi_issues[0]
            self.assertIn("sentencepiece_model_pb2.py", issue.replace("\\", "/"))
            self.assertIn("demands protobuf >=7.36.1", issue)
            self.assertIn("protobuf 6.33.4", issue)
            self.assertIn("VersionError", status.detail)
            self.assertIn("sentencepiece_model_pb2.py", status.as_dict()["abi_issues"][0])

    def test_a_runtime_at_or_above_the_gencode_clears_the_gate(self):
        with tempfile.TemporaryDirectory() as td:
            status = self._status(Path(td), protobuf="7.36.2", gencode=(7, 36, 1))
            self.assertEqual([], status.abi_issues)
            self.assertTrue(status.found)

    def test_the_pinned_environment_is_the_one_that_clears_it(self):
        # The pin and the gate must agree, or preparation would install an environment that
        # readiness then refuses.
        with tempfile.TemporaryDirectory() as td:
            pin = ocr_runtime.PINNED["protobuf"]
            status = self._status(Path(td), protobuf=pin, gencode=(7, 36, 1))
            self.assertEqual([], status.mismatched)
            self.assertEqual([], status.abi_issues)
            self.assertTrue(status.found)

    def test_readiness_reports_the_abi_as_a_blocker_not_only_as_detail(self):
        # A blocker list an operator can act on: the reason must be its own line, because a
        # cascade reason that says only "ready=False" cannot be turned into a next action.
        with tempfile.TemporaryDirectory() as td:
            exe = _fake_env(Path(td), protobuf="6.33.4", gencode=(7, 36, 1))
            ocr_runtime.clear_cache()
            with mock.patch.dict(os.environ, {ocr_runtime.ENV_INTERPRETER: exe}, clear=False):
                state = ocr_paddle.engine_state()
            ocr_runtime.clear_cache()
            self.assertFalse(state["ready"])
            abi = [b for b in state["blockers"] if "dependency ABI" in b]
            self.assertEqual(1, len(abi))
            self.assertIn("7.36.1", abi[0])

    def test_the_abi_check_costs_no_interpreter_and_no_model(self):
        # Nothing in this module may import paddle: readiness is answered by the supervisor, and
        # loading the framework to answer "can this engine run" spends the RAM the answer is about.
        import sys
        with tempfile.TemporaryDirectory() as td:
            self._status(Path(td), protobuf="7.36.2", gencode=(7, 36, 1))
        self.assertFalse(any(name == "paddle" or name.startswith("paddle.") for name in sys.modules))

    def tearDown(self) -> None:
        ocr_runtime.clear_cache()


class GpuFirstRuntime(unittest.TestCase):
    """B9 (2026-11-22): the release law is GPU-first for Paddle.

    The isolated runtime's PINNED wheel is the CUDA 12.6 build
    (`paddlepaddle-gpu==3.2.1`, cu126 index); the CPU wheel stays an ACCEPTED FALLBACK for a
    host the preparer could not build for GPU, and the manifest then records that fact. What
    the runtime must never do is CLAIM a placement it did not probe: the device the preparation
    probe recorded is reported verbatim, and an unprobed environment is a reported gap.
    Placement between the two is devices.device_plan's job at run time, from measured VRAM.
    """

    def _status(self, root: Path, *, pins: dict[str, str] | None = None,
                manifest: dict | None = None) -> ocr_runtime.RuntimeStatus:
        exe = _fake_env(root, protobuf=ocr_runtime.PINNED["protobuf"], gencode=(7, 36, 1),
                        pins=pins)
        ocr_runtime.clear_cache()
        with mock.patch.dict(os.environ, {ocr_runtime.ENV_INTERPRETER: exe}, clear=False), \
                mock.patch.object(ocr_runtime, "read_manifest",
                                  return_value=manifest or {}):
            return ocr_runtime.status()

    def test_the_pinned_runtime_names_the_cuda_build(self):
        self.assertEqual("3.2.1", ocr_runtime.PINNED.get("paddlepaddle-gpu"),
                         "the pinned paddle wheel is the CUDA 12.6 GPU build (cu126 index)")
        self.assertNotIn("paddlepaddle", ocr_runtime.PINNED,
                         "the CPU wheel is not a co-equal pin; it is the recorded fallback "
                         "path, handled in code, not a second pin the manifest must mirror")

    def test_the_runtime_id_does_not_claim_a_device(self):
        # Placement is a run-time plan from measured resources, so the runtime ID must not
        # hardcode "cpu": that claim was true of the old CPU wheel and is a lie about this one.
        self.assertNotIn("cpu", ocr_runtime.RUNTIME_ID.lower())

    def test_a_gpu_build_venv_is_validated_and_its_probe_is_reported(self):
        with tempfile.TemporaryDirectory() as td:
            probe = {"device": "gpu:0", "compiled_with_cuda": True, "paddle": "3.2.1"}
            status = self._status(Path(td), manifest={"device_probe": probe})
            self.assertEqual([], status.missing)
            self.assertTrue(status.found, status.detail)
            self.assertEqual("gpu:0", status.recorded_device)
            self.assertTrue(status.placement_verified)
            self.assertEqual("gpu:0", status.as_dict()["recorded_device"])

    def test_the_cpu_wheel_is_accepted_as_a_recorded_fallback(self):
        cpu_pins = {("paddlepaddle" if k == "paddlepaddle-gpu" else k): v
                    for k, v in ocr_runtime.PINNED.items()}
        with tempfile.TemporaryDirectory() as td:
            status = self._status(Path(td), pins=cpu_pins,
                                  manifest={"device_probe": {"device": "cpu",
                                                             "compiled_with_cuda": False}})
            self.assertEqual([], status.missing,
                             "a host that fell back to the CPU wheel is a validated runtime, "
                             "not a broken one: GPU is preferred, CPU proceeds when it must")
            self.assertTrue(status.found, status.detail)
            self.assertIn("fallback", status.detail.lower())
            self.assertEqual("cpu", status.recorded_device)
            # The paddle slot must resolve through the fallback wheel, not stay an empty string.
            self.assertEqual("3.2.1", status.pinned["paddlepaddle-gpu"])

    def test_an_environment_that_recorded_no_probe_is_a_gap_not_a_claim(self):
        with tempfile.TemporaryDirectory() as td:
            status = self._status(Path(td), manifest={})
            self.assertTrue(status.found)
            self.assertEqual("", status.recorded_device)
            self.assertFalse(status.placement_verified)
            self.assertIn("device probe", status.detail.lower())

    def tearDown(self) -> None:
        ocr_runtime.clear_cache()


if __name__ == "__main__":
    unittest.main()
