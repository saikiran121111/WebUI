"""ASR recommendation rows under the 2026-11-22 pivot: one runtime, Parakeet default.

Three layers, one file:
  * the PUBLISHED tag tables are data with provenance (captured from the model
    cards on a named date), never prose inside a claim string - they stay on disk
    for the families whose dedicated rows the pivot removed, as evidence;
  * the registry carries ONE recommended ASR row (Parakeet-TDT-0.6B-v3) as a
    SETTINGS DEFAULT. The dedicated Granite/Qwen production rows are gone:
    support for any checkpoint is decided by compat.py from the snapshot
    (architecture, weight format, processor, required outputs), so searching,
    downloading and selecting a compatible checkpoint needs zero registry edits;
  * language routing must never mark the Parakeet recommendation acceptable for
    a language its published table omits (Hindi must never silently reach
    Parakeet - report it directly).

Id law: the Parakeet id is the repository that EXISTS on the hub; registering a
fictional id is the documented PaddleOCR-VL failure mode this file's history
already records.
"""
from __future__ import annotations

import unittest

from ruke_ml.language_tables import candidate_language_tags, candidate_languages
from ruke_ml.models.registry import catalog
from ruke_ml.speech import asr

PARAKEET = "nvidia/parakeet-tdt-0.6b-v3"
GRANITE = "ibm-granite/granite-speech-5.0-470m-turboctc"
QWEN_06B = "Qwen/Qwen3-ASR-0.6B"
QWEN_17B = "Qwen/Qwen3-ASR-1.7B"


class PublishedTagTables(unittest.TestCase):
    """The tag tables are captured data, and the capture is traceable - kept as
    provenance even for families whose dedicated registry rows the pivot removed."""

    def test_every_former_candidate_keeps_a_provenanced_table(self):
        for model_id in (PARAKEET, GRANITE, QWEN_06B, QWEN_17B):
            payload = candidate_language_tags(model_id)
            self.assertTrue(payload, f"{model_id} has no captured language table")
            for key in ("captured", "languages", "source"):
                self.assertIn(key, payload, f"{model_id} table lacks {key!r} provenance")
            self.assertTrue(payload["languages"], f"{model_id} table is empty")

    def test_tables_say_what_their_cards_say(self):
        # Expected content from the model cards captured 2026-11-22, not from
        # the code: Parakeet v3 is 25 European languages with automatic
        # language detection; Granite turboCTC went multilingual (7 languages)
        # on 2026-10-21; Qwen3-ASR publishes 30 languages incl. Hindi.
        par = candidate_languages(PARAKEET)
        self.assertEqual(len(par), 25, "Parakeet v3 publishes 25 European languages")
        self.assertIn("en", par)
        self.assertIn("ru", par)
        self.assertNotIn("hi", par, "Hindi is NOT in Parakeet's published table")

        gran = candidate_languages(GRANITE)
        self.assertEqual(sorted(gran), sorted(["en", "fr", "de", "es", "pt", "it", "ja"]))
        self.assertNotIn("hi", gran)

        qwen = candidate_languages(QWEN_06B)
        self.assertEqual(len(qwen), 30, "Qwen3-ASR publishes 30 languages")
        self.assertIn("hi", qwen)
        self.assertIn("en", qwen)
        self.assertEqual(candidate_languages(QWEN_17B), qwen,
                         "1.7B and 0.6B publish the same language table")

    def test_unknown_id_is_empty_not_a_crash(self):
        self.assertEqual(candidate_languages("nobody/nothing"), [])
        self.assertEqual(candidate_language_tags("nobody/nothing"), {})


class RegistryRows(unittest.TestCase):
    """One recommended row as a Settings default; no dedicated per-family rows."""

    def test_parakeet_is_the_recommended_default_row(self):
        spec = catalog().get(PARAKEET, "speech.asr")
        self.assertIsNotNone(spec, "the Parakeet recommendation must stay registered")
        self.assertEqual(spec.claims.get("languages"), candidate_languages(PARAKEET),
                         "the row's claims must be the captured published table")
        self.assertIs(spec.verified.get("en"), True,
                      "English is verified by the g103 measured run on THIS host "
                      "(.data/tmp/g103/probe-result.json: CUDA text + 40 token "
                      "timestamps, CPU recovery same text)")
        self.assertIs(spec.verified.get("hi"), False,
                      "Hindi is outside the published table AND the release scope - "
                      "a verified flag here would be a fabricated measurement")
        self.assertEqual(spec.adapter, "ruke_ml.speech.transformers_asr",
                         "the ONE Transformers ASR integration (final decision 2026-11-22); "
                         "the NeMo per-runtime adapter is retired - ONE integration, not a "
                         "second runtime for the same checkpoint")
        self.assertEqual(spec.revision, "541d1f99c6b0c3cd0b11a95167540bb8edefd82b",
                         "the checkpoint is pinned to the revision MEASURED on this host "
                         "(g103 probe), not floating")

    def test_no_dedicated_granite_qwen_rows_remain(self):
        # The pivot removes dedicated per-family production dispatch: a registered
        # row with no adapter is a routing candidate that can never run, which is
        # exactly the stale-metadata state §5 orders gone.
        for model_id in (GRANITE, QWEN_06B, QWEN_17B):
            self.assertIsNone(catalog().get(model_id, "speech.asr"),
                              f"{model_id} must not be a registered production row")
            ready = catalog().readiness(model_id, "speech.asr")
            self.assertFalse(ready.executable)


class RoutingLaw(unittest.TestCase):
    """The brief's law survives the pivot: never silently send an unsupported
    language to Parakeet - report it directly."""

    def _candidate(self, route, model_id):
        return next(c for c in route["candidates"] if c["id"] == model_id)

    def test_hindi_never_finds_parakeet_acceptable(self):
        r = asr.language_route("hi")
        self.assertFalse(self._candidate(r, PARAKEET)["acceptable"],
                         f"{PARAKEET} must not be acceptable for Hindi")

    def test_english_marks_parakeet_acceptable_as_published_claim(self):
        r = asr.language_route("en")
        c = self._candidate(r, PARAKEET)
        self.assertTrue(c["acceptable"], "English is in Parakeet's published table")
        self.assertTrue(c["verified_for_language"],
                        "English quality was MEASURED on this host (g103 probe, CUDA "
                        "and CPU) - the routing layer must surface that, and route "
                        "with quality_mode measured_on_this_host")
        self.assertEqual(r["quality_mode"], "measured_on_this_host")

    def test_auto_detection_routes_only_to_publishing_backends(self):
        r = asr.language_route("auto")
        self.assertTrue(self._candidate(r, PARAKEET)["acceptable"],
                        "Parakeet v3 publishes automatic language detection")


if __name__ == "__main__":
    unittest.main()
