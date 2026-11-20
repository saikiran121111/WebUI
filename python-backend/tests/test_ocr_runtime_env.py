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


if __name__ == "__main__":
    unittest.main()
