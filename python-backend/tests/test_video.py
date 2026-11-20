"""Temporal evidence: durable baselines, honest coverage, separate ranges, hints that reach search.

These are the F13/F14 laws. A bounded sample never proves absence, no transcript never
means no audio evidence, and two asked-about intervals never collapse into one span.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ruke_ml.contracts import Coverage
from ruke_ml.video import scenes, search_hints, timeline
from ruke_ml.video.observations import Observation, audio_state


def _meta(duration=120.0, has_audio=True):
    return timeline.MediaMeta(source_id="clip.mp4", source_hash="ab" * 32, duration=duration,
                              streams=[{"index": 0, "codec_type": "video"},
                                       {"index": 1, "codec_type": "audio", "tags": {"language": "eng"}}],
                              rotation_deg=270, has_audio_track=has_audio,
                              subtitle_tracks=["eng"], stream_start_offsets={"1": 0.042})


class EvidenceStore(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="ruke-tl-"))
        self.store = timeline.TimelineStore(self.dir)

    def test_upload_baseline_is_cheap_and_survives_a_reload(self):
        rec = self.store.init_baseline(_meta())
        self.assertEqual(rec["observations"], [])
        self.assertEqual(rec["meta"]["rotation_deg"], 270)
        self.assertEqual(rec["meta"]["streams"][1]["tags"]["language"], "eng")
        self.assertEqual(rec["meta"]["stream_start_offsets"]["1"], 0.042)
        again = self.store.load("ab" * 32)
        self.assertEqual(again["meta"]["duration"], 120.0)
        self.assertIn("no modality has been analysed", timeline.coverage_reply(again))

    def test_observations_need_a_baseline_first(self):
        with self.assertRaises(FileNotFoundError):
            self.store.add_observations("ff" * 32, [Observation(0, 1, "visual")],
                                        Coverage(units="seconds", total_source=120.0), "x")

    def test_coverage_accumulates_and_names_the_gaps(self):
        self.store.init_baseline(_meta())
        self.store.add_observations(
            "ab" * 32,
            [Observation(10.0, 12.0, "ocr", text="ACME  invoice #41"),
             Observation(70.0, 74.0, "speech", text="the quarterly result", audio_state="speech")],
            Coverage(units="seconds", total_source=120.0, examined=[(10.0, 12.0), (70.0, 74.0)]), "ocr")
        self.store.add_observations(
            "ab" * 32, [Observation(11.0, 13.0, "speech", text="invoice number 41", audio_state="speech")],
            Coverage(units="seconds", total_source=120.0, examined=[(11.0, 13.0)]), "asr")
        rec = self.store.load("ab" * 32)
        cov = rec["meta"]["coverage"]
        self.assertEqual([tuple(s) for s in cov["examined"]], [(10.0, 13.0), (70.0, 74.0)])
        self.assertEqual([tuple(s) for s in cov["skipped"]][:2], [(0.0, 10.0), (13.0, 70.0)], cov)
        self.assertFalse(cov["complete"])
        self.assertIn("never proves absence", cov["note"])
        self.assertEqual(rec["meta"]["processed"], ["asr", "ocr"], "stages are recorded, sorted and deduped")
        self.assertEqual(len(rec["observations"]), 3)
        rep = timeline.coverage_reply(rec)
        self.assertIn("examined 7.0s of 120.0s", rep)
        self.assertIn("not examined", rep)

    def test_full_coverage_is_the_only_complete_claim(self):
        self.store.init_baseline(_meta(duration=60.0))
        self.store.add_observations("ab" * 32, [],
                                    Coverage(examined=[(0.0, 60.0)], units="seconds", total_source=60.0), "frames")
        rec = self.store.load("ab" * 32)
        self.assertTrue(rec["meta"]["coverage"]["complete"], rec["meta"]["coverage"])
        self.assertEqual(rec["meta"]["coverage"]["skipped"], [])

    def test_coverage_units_must_match(self):
        with self.assertRaises(ValueError):
            timeline.merge_coverage(Coverage(units="seconds", total_source=10.0),
                                    Coverage(units="pages", total_source=10.0), "x")

    def test_publish_is_atomic_and_leaves_no_temp_files(self):
        self.store.init_baseline(_meta())
        files = list(self.store._dir("ab" * 32).iterdir())
        self.assertEqual([f.name for f in files], ["timeline.json"])
        self.assertEqual([f for f in files if ".tmp" in f.name], [])
        loaded = json.loads((self.store._dir("ab" * 32) / "timeline.json").read_text(encoding="utf-8"))
        self.assertEqual(loaded["schema_version"], 1)


class AudioState(unittest.TestCase):
    def test_missing_track_silence_and_music_are_different_facts(self):
        self.assertEqual(audio_state(has_track=False, speech_spans=0, rms=None), "no_audio_track")
        self.assertEqual(audio_state(True, 0, 0.0), "silence")
        self.assertEqual(audio_state(True, 0, None), "unknown")
        self.assertEqual(audio_state(True, 2, 0.01), "speech")
        self.assertEqual(audio_state(True, 0, 0.02, failed=True), "processing_failed")

    def test_unknown_states_are_rejected(self):
        with self.assertRaises(ValueError):
            Observation(0.0, 1.0, "visual", audio_state="quiet")
        with self.assertRaises(ValueError):
            Observation(0.0, 1.0, "frame")
        with self.assertRaises(ValueError):
            Observation(5.0, 1.0, "visual")
        obs = Observation(0.0, 1.0, "speech", text="x")
        self.assertIsNone(obs.confidence, "confidence is only present when a provider genuinely reports it")
        self.assertNotIn("confidence", [k for k, v in obs.to_dict().items() if v is not None])


class Sampling(unittest.TestCase):
    def test_comparative_requests_stay_separate_ranges(self):
        plan = scenes.sample_windows(600.0, query_windows=[(60.0, 70.0), (420.0, 430.0)],
                                     budget=4, separate_ranges=True)
        asked = [(w.start, w.end) for w in plan.windows if w.kind == "interval_query"]
        self.assertEqual(asked, [(60.0, 70.0), (420.0, 430.0)],
                         "merging two compared intervals would invent evidence in the gap")

    def test_continuous_request_may_merge_but_still_reports_gaps(self):
        plan = scenes.sample_windows(600.0, query_windows=[(60.0, 70.0), (90.0, 100.0)], budget=4)
        asked = [(w.start, w.end) for w in plan.windows if w.kind == "interval_query"]
        self.assertEqual(asked, [(60.0, 100.0)])
        # The note used to read "examined 7.0s of 120.0s" for a plan that had decoded
        # nothing. A plan schedules; it does not inspect, and the wording must not let a
        # reader (or a citation) treat it as coverage.
        self.assertIn("Planned 4 sampling windows across 600.0s", plan.honest_note)
        self.assertIn("does not establish inspected-content coverage", plan.honest_note)
        self.assertNotIn("examined", plan.honest_note)
        self.assertFalse(plan.claims_inspected_coverage)
        self.assertLess(plan.planned_seconds, 600.0)
        # The seconds the plan reports are the SELECTED windows, not the pre-trim list.
        self.assertAlmostEqual(plan.planned_seconds,
                               sum(w.end - w.start for w in plan.windows), places=6)

    def test_budget_and_head_middle_tail_coverage(self):
        plan = scenes.sample_windows(3600.0, budget=8)
        self.assertLessEqual(len(plan.windows), 8)
        ann = scenes.anchors(3600.0, [10.0, 20.0, 15.0], max_anchors=8)
        self.assertTrue(ann)
        self.assertTrue({a.kind for a in ann} <= {"head", "middle", "tail", "scene_cut", "novelty"})
        for label in ("head", "middle", "tail"):
            self.assertTrue(any(label in (a.kind + a.reason) for a in ann),
                            "%s coverage must survive bounded merging" % label)
        self.assertLessEqual(len(scenes.anchors(0.0)), 1)
        self.assertEqual(audio_state(True, 0, 0.0), "silence")

    def test_expensive_analysis_dedupe_keeps_every_occurrence(self):
        k1 = scenes.observation_key("frame-digest-1", "scene-3")
        self.assertEqual(k1, scenes.observation_key("frame-digest-1", "scene-3"))
        self.assertNotEqual(k1, scenes.observation_key("frame-digest-1", "scene-4"))
        prov = scenes.provenance("frames/000123.jpg", 41.1, "vision")
        self.assertEqual(prov["timebase"], "presentation")
        self.assertEqual(prov["start"], 41.1)

    def test_scene_command_is_a_real_seek_decode(self):
        cmd = scenes.ffmpeg_scene_command("clip.mp4", 0.3)
        self.assertIn("-i", cmd)
        self.assertTrue(any("scene" in part for part in cmd))


class SearchHints(unittest.TestCase):
    def _timeline(self):
        return {"meta": {"source_hash": "ab" * 32,
                         "coverage": {"note": "examined 3 of 120s", "examined": [(0.0, 3.0)],
                                      "skipped": [(3.0, 120.0)]}},
                "observations": [
                    {"start": 12.0, "end": 14.0, "kind": "ocr", "text": "see https://acme.example/terms",
                     "provider": "ocr"},
                    {"start": 30.0, "end": 33.0, "kind": "speech", "text": "the Zephyr Ninjas reunion tour",
                     "provider": "asr"},
                    {"start": 40.0, "end": 42.0, "kind": "audio_event", "text": "sounds like a trumpet solo",
                     "provider": "clap"},
                    {"start": 50.0, "end": 52.0, "kind": "speech", "text": 'they shouted "carry the torch" loudly',
                     "provider": "asr"},
                ]}

    def test_hints_carry_provenance_and_timestamps(self):
        h = search_hints.build_hints(self._timeline())
        self.assertEqual(h.source_hash, "ab" * 32)
        self.assertIn("examined 3 of 120s", h.coverage_note)
        for hint in h.hints:
            self.assertTrue(hint.provenance, hint)
            self.assertGreaterEqual(hint.end, hint.start)

    def test_queries_reach_the_search_tool_ranked(self):
        h = search_hints.build_hints(self._timeline())
        queries = h.to_queries(limit=8)
        self.assertTrue(queries)
        self.assertEqual(queries[0], "https://acme.example/terms", "an observed URL outranks prose")
        joined = " ".join(queries)
        self.assertIn("Zephyr Ninjas", joined, "distinctive speech must reach the search arguments")
        self.assertIn("carry the torch", joined)

    def test_uncorroborated_audio_is_a_quoted_probe_never_an_assertion(self):
        h = search_hints.build_hints(self._timeline())
        audio = [x for x in h.hints if x.kind == "uncertain_audio"]
        self.assertTrue(audio)
        probes = [q for q in h.to_queries() if q.startswith('"')]
        self.assertTrue(probes, "an uncorroborated audio candidate must be quoted")
        self.assertFalse(any(x.kind == "uncertain_audio" and x.corroborated_by for x in audio))
        one = self._timeline()
        one["observations"].append({"start": 40.0, "end": 42.0, "kind": "visual",
                                    "text": "a trumpet solo on stage", "provider": "vision"})
        h2 = search_hints.build_hints(one)
        cor = [x for x in h2.hints if x.value.startswith("sounds like") or x.value.startswith("a trumpet")]
        self.assertTrue(any(x.corroborated_by for x in cor), cor)
        self.assertTrue(all(not q.startswith('"') for q in h2.to_queries()
                            if "trumpet" in q), "corroborated clues stop being probes")

    def test_round_trip_and_limits(self):
        h = search_hints.build_hints(self._timeline())
        back = search_hints.MediaSearchHints.from_dict(h.to_dict())
        self.assertEqual([x.value for x in back.hints], [x.value for x in h.hints])
        self.assertLessEqual(len(h.to_queries(limit=2)), 2)
        self.assertTrue(all(len(q) >= 3 for q in h.to_queries()))


if __name__ == "__main__":
    unittest.main()
