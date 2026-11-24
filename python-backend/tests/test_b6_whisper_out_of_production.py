"""B6 (final decision 2026-11-22): Whisper is out of production.

The frozen English release names ONE transcription engine (Parakeet-TDT-0.6B-v3 through
Transformers). Whisper was already unreachable as an ASR ROW (B5), but three implicit
paths kept it alive in the production transcription flow:

  * the ASR worker's startup prelude imported `faster_whisper` (the CT2 native lib) on
    every transcription worker, before the selected-model dispatch ever ran;
  * the `speech` extra was in [tool.ruke].capability_extras, so `npm run dev`'s
    `uv sync --inexact --extra speech` downloaded faster-whisper/ctranslate2 on every
    fresh machine - an implicit Whisper download for an engine the release never runs;
  * the speech.asr capability REPORT answered from Whisper's language table, so the
    product's own status surface quoted the retired engine as its provenance.

This file pins the law at each seam: the registry (execution), the runner prelude
(startup imports), pyproject (installation/downloads), the capability report
(provenance) and the explicit preparer's help (the human-facing example). Segment
times, channels, cancellation and provenance stay pinned by the existing dispatch and
transcript suites; this file only closes the Whisper doors.
"""
from __future__ import annotations

import contextlib
import io
import json
import tomllib
import unittest
from pathlib import Path

from ruke_ml.models import prepare
from ruke_ml.models.registry import PARAKEET_ID, catalog
from ruke_ml.speech import asr
from ruke_ml.language_tables import candidate_language_tags, candidate_languages
from ruke_ml.workers.runner import _PRELUDE

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


class Execution(unittest.TestCase):
    def test_no_registered_asr_row_names_whisper(self):
        """Dispatch law: the engine that runs is the module the ROW names. If no ASR row
        names Whisper, no ASR job can execute Whisper, whatever a payload claims."""
        for spec in catalog().for_capability("speech.asr"):
            for field, value in (("id", spec.id), ("package", spec.package),
                                 ("adapter", spec.adapter)):
                self.assertNotIn("whisper", value.lower(),
                                 f"speech.asr row {spec.id} names whisper in {field}={value}")
            self.assertEqual(spec.adapter, "ruke_ml.speech.transformers_asr",
                             "the SOLE ASR engine's adapter is the only ASR adapter")

    def test_the_asr_worker_prelude_imports_the_engine_graph_not_whisper(self):
        """Startup law: the prelude builds the capability worker's heavy native graph.
        For speech.asr that graph is the ENGINE's (numpy, then torch, then transformers,
        single-threaded per the measured hang law) - it must never import faster_whisper,
        which put CT2's native library into every transcription worker."""
        graph = _PRELUDE["speech.asr"]
        self.assertNotIn("faster_whisper", graph,
                         f"the ASR prelude must not preload whisper: {graph}")
        for name in ("numpy", "torch", "transformers"):
            self.assertIn(name, graph, f"{name} belongs to the SOLE engine's graph: {graph}")
        self.assertEqual(graph[0], "numpy", "the base numeric extension builds its pool alone")


class Installation(unittest.TestCase):
    def setUp(self):
        self.py = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
        self.extras = self.py["project"]["optional-dependencies"]
        self.synced = self.py["tool"]["ruke"]["capability_extras"]

    def test_the_bootstrapped_extras_install_no_whisper(self):
        """Download law: dev-supervisor syncs exactly capability_extras. No extra that
        list installs may pin faster-whisper/ctranslate2, so a fresh machine's bootstrap
        cannot download a Whisper runtime the release never executes."""
        for name in self.synced:
            pins = " ".join(self.extras[name]).lower()
            for retired in ("faster-whisper", "ctranslate2"):
                self.assertNotIn(retired, pins,
                                 f"capability_extras {name!r} installs {retired}")

    def test_the_bootstrapped_extras_still_install_the_release_engine(self):
        """The removal must not starve the engine: the pinned Transformers/torch extra
        stays bootstrapped, so the release's ONLY transcription engine provisions on a
        fresh machine without any Whisper present."""
        self.assertIn("asr", self.synced)
        pins = " ".join(self.extras["asr"]).lower()
        self.assertIn("transformers", pins)
        self.assertIn("torch", pins)


class Provenance(unittest.TestCase):
    def test_the_asr_capability_report_answers_from_the_engine_table(self):
        """Report law: the speech.asr capability report's language table is the SOLE
        engine's published table (Parakeet's captured card), not Whisper's. The product's
        status surface must never quote the retired engine as its provenance."""
        st = asr.speech_status()
        table = st["language_table"]
        self.assertEqual(table["count"], len(candidate_languages(PARAKEET_ID)),
                         "the count is the engine's published tag count")
        self.assertEqual(table["provenance"], candidate_language_tags(PARAKEET_ID),
                         "the provenance is the engine's captured table, verbatim")
        self.assertNotIn("whisper", json.dumps(table).lower(),
                         "the ASR report's language provenance must not name Whisper")
        self.assertIn("en", st["known_language_tags"],
                      "the English release tag is published by the engine table")


class HumanSurface(unittest.TestCase):
    def test_the_asset_preparer_help_names_the_release_engine(self):
        """The explicit preparer is the only download owner; its help example is the
        human-facing instruction. Pointing it at a Whisper repo id advertises the retired
        engine on the command that provisions models."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            prepare.main(["--help"])
        help_text = out.getvalue()
        self.assertIn("nvidia/parakeet-tdt-0.6b-v3", help_text)
        self.assertNotIn("faster-whisper", help_text.lower())


if __name__ == "__main__":
    unittest.main()
