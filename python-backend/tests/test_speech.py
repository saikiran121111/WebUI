"""Language routing, timebase laws, word-time honesty and anonymous speakers.

These are the F13/section-8 speech laws: English-only models never carry another
language, a segment span is never read as word timing, and no audio track is not silence.
"""
from __future__ import annotations

import unittest

from ruke_ml.speech import alignment, asr, diarization

ENGLISH_ONLY = "Xenova/whisper-base.en"


def _spec_claims(model_id: str) -> str:
    from ruke_ml.models.registry import catalog
    spec = catalog().get(model_id)
    return str(spec.claims) if spec else ""


class Routing(unittest.TestCase):
    def test_english_only_model_never_carries_another_language(self):
        for lang in ("te", "hi", "unknown", "zh", "vi"):
            r = asr.language_route(lang)
            acceptable = {c["id"] for c in r["candidates"] if c["acceptable"]}
            self.assertNotIn(ENGLISH_ONLY, acceptable,
                             "%s was routed through an English-only model" % lang)
            self.assertNotEqual(r.get("model"), ENGLISH_ONLY, lang)

    def test_routing_decision_never_selects_an_unlisted_language(self):
        for lang in ("te", "hi", "en"):
            r = asr.language_route(lang)
            if r["decision"] in ("route", "route_with_warning"):
                self.assertTrue(r["model"], r)
                self.assertIn(lang, _spec_claims(r["model"]).lower(),
                              "a routed model must actually list the language")
            else:
                self.assertIsNone(r["model"], "a non-routing decision must not name a model")
                self.assertTrue(r.get("human_step"), "an unroutable language needs an exact human step")

    def test_telugu_is_reported_as_unverified_not_silently_supported(self):
        r = asr.language_route("te")
        self.assertEqual(r["language"], "te")
        self.assertNotIn(r["quality_mode"], (None, ""))
        if r["decision"] == "route":
            self.assertEqual(r["quality_mode"], "measured_on_this_host",
                             "routing without measurement must be labelled published_claim_only")
        for c in r["candidates"]:
            if c["id"] == "openai/whisper-large-v3" and c["acceptable"]:
                self.assertFalse(c["verified_for_language"],
                                 "published registry support is not measured quality")

    def test_status_reports_pcm_contract_without_loading(self):
        st = asr.speech_status()
        self.assertEqual(st["capability"], "speech.asr")
        self.assertEqual(st["pcm_contract"], {"rate_hz": 16000, "channels": 1, "width_bytes": 2})
        ids = [m["id"] for m in st["models"]]
        self.assertIn(ENGLISH_ONLY, ids)
        self.assertTrue(st["human_step"] or st["status"] == "available")


class Timebase(unittest.TestCase):
    def test_windows_carry_their_own_source_offset(self):
        wins = asr.pcm_windows(100.0, window_s=30.0, overlap_s=5.0)
        self.assertEqual([w.start_s for w in wins], [0.0, 25.0, 50.0, 75.0])
        self.assertEqual(wins[-1].end_s, 100.0)
        self.assertEqual(wins[2].to_source_time(4.5), 54.5,
                         "in-window timestamps must be mapped back to source time")
        for w in wins:
            self.assertIn("-ss", w.command)
            self.assertEqual(w.command[w.command.index("-ss") + 1], "%.3f" % w.start_s)
            self.assertGreater(w.command.index("-ss"), w.command.index("-i"),
                               "accurate seek must not reset the timebase")

    def test_window_bounds_are_enforced(self):
        self.assertEqual(asr.pcm_windows(0.0), [])
        with self.assertRaises(ValueError):
            asr.pcm_windows(60.0, window_s=30.0, overlap_s=30.0)
        with self.assertRaises(ValueError):
            asr.pcm_windows(60.0, window_s=0.0)

    def test_no_audio_track_is_not_silence(self):
        r = asr.select_audio_stream([{"index": 0, "codec_type": "video", "codec_name": "h264"}])
        self.assertEqual(r["state"], "no_audio_track")
        self.assertIsNone(r["selected"])
        self.assertIn("not silence", r["reason"])

    def test_default_flag_and_language_tag_beat_track_zero(self):
        streams = [
            {"index": 0, "codec_type": "audio", "codec_name": "aac"},
            {"index": 1, "codec_type": "audio", "codec_name": "aac", "default": 1},
            {"index": 2, "codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}},
        ]
        self.assertEqual(asr.select_audio_stream(streams)["selected"]["index"], 1)
        self.assertEqual(asr.select_audio_stream(streams, "en")["selected"]["index"], 2,
                         "an explicit language tag outranks the default flag")
        telugu = [{"index": 0, "codec_type": "audio"},
                  {"index": 3, "codec_type": "audio", "tags": {"language": "tel"}}]
        self.assertEqual(asr.select_audio_stream(telugu, "te")["selected"]["index"], 3)
        self.assertEqual(asr.select_audio_stream([streams[0]])["selected"]["index"], 0)

    def test_pcm_command_maps_an_explicit_stream_and_model_rate(self):
        cmd = asr.pcm_command("in.mp4", start_s=12.5, duration_s=10.0, stream_id=3)
        self.assertIn("0:3", cmd)
        self.assertEqual(cmd[cmd.index("-ar") + 1], "16000")
        self.assertEqual(cmd[cmd.index("-ac") + 1], "1")
        self.assertEqual(cmd[cmd.index("-f") + 1], "s16le")


class WordTimes(unittest.TestCase):
    def test_absent_word_times_are_reported_as_segment_span_only(self):
        out = alignment.accept_word_timestamps({"start": 1.0, "end": 4.0, "text": "hello there"})
        self.assertEqual(out["word_timestamps"], "segment_span_only")
        self.assertEqual(out["accepted_words"], [], "word times must never be fabricated")
        self.assertIn("must not be read as word timing", out["note"])

    def test_provider_word_times_are_validated(self):
        seg = {"start": 1.0, "end": 4.0, "words": [
            {"word": "hello", "start": 1.0, "end": 1.6},
            {"word": "there", "start": 1.7, "end": 2.2},
        ]}
        out = alignment.accept_word_timestamps(seg)
        self.assertEqual(out["word_timestamps"], "provider_supplied")
        self.assertEqual([w["word"] for w in out["accepted_words"]], ["hello", "there"])

    def test_out_of_segment_and_non_monotonic_words_are_rejected_not_repaired(self):
        seg = {"start": 1.0, "end": 4.0, "words": [
            {"word": "outside", "start": 9.0, "end": 9.5},
            {"word": "b", "start": 3.0, "end": 3.4},
            {"word": "a", "start": 2.0, "end": 2.4},
        ]}
        out = alignment.accept_word_timestamps(seg)
        self.assertEqual(out["word_timestamps"], "partially_valid")
        self.assertEqual(len(out["rejected_words"]), 2, out)
        self.assertEqual([w["word"] for w in out["accepted_words"]], ["b"])
        reasons = " ".join(str(r.get("why")) for r in out["rejected_words"])
        self.assertIn("outside", reasons)
        self.assertIn("monotonic", reasons)

    def test_inverted_segment_is_flagged(self):
        out = alignment.accept_word_timestamps({"start": 5.0, "end": 1.0, "words": []})
        self.assertEqual(out["word_timestamps"], "invalid_segment_span")

    def test_aligner_exclusions_are_respected(self):
        for model in ("Qwen/Qwen3-ASR-1.7B", "Qwen/Qwen3-ASR-0.6B"):
            for lang in ("te", "hi"):
                ok, why = alignment.alignment_supported(model, lang)
                self.assertFalse(ok, "%s/%s must not claim word timing: %s" % (model, lang, why))
                self.assertIn("does not list", why)
        ok, why = alignment.alignment_supported("no/such-model", "en")
        self.assertFalse(ok)
        self.assertIn("no aligner", why)
        st = alignment.alignment_status()
        self.assertEqual(st["exclusions"]["Qwen/Qwen3-ASR-1.7B"], ["hi", "te"])


class Speakers(unittest.TestCase):
    def test_labels_are_anonymous_and_never_claim_identity(self):
        rel, mapping = diarization.speaker_labels([
            {"start": 0.0, "end": 2.0, "speaker": "spk_77"},
            {"start": 2.0, "end": 4.0, "speaker": "spk_03"},
            {"start": 4.0, "end": 6.0, "speaker": "spk_77"},
        ])
        self.assertEqual([t["speaker"] for t in rel], ["S1", "S2", "S1"])
        self.assertEqual(sorted(mapping.values()), ["S1", "S2"])
        self.assertTrue(all(t["identity_claimed"] is False for t in rel))

    def test_overlap_is_evidence_not_an_error(self):
        v = diarization.validate_turns([
            {"start": 1.0, "end": 3.0, "speaker": "A"},
            {"start": 2.0, "end": 4.0, "speaker": "B"},
            {"start": 9.0, "end": 8.0},
        ], duration_s=5.0)
        self.assertEqual(len(v["turns"]), 2)
        self.assertEqual(v["overlapping_turns"], 1)
        self.assertTrue(v["problems"])
        self.assertIn("overlapping turns are kept", v["note"])

    def test_clock_errors_are_reported_not_silently_stretched(self):
        v = diarization.validate_turns([{"start": 1.0, "end": 6.0}], duration_s=5.0)
        self.assertEqual(v["turns"], [], v)
        self.assertIn("provider clock is wrong", " ".join(v["problems"]))
        v2 = diarization.validate_turns([{"start": 1.0, "end": 5.2}], duration_s=5.0)   # within the 0.5s clamp
        self.assertEqual(v2["turns"][0]["end"], 5.0)
        self.assertEqual(v2["clamped"], 1)

    def test_missing_provider_package_never_crashes_capability_reporting(self):
        from ruke_ml.models.registry import catalog
        for cap in ("speech.diarize", "documents.parse", "documents.ocr", "speech.asr", "embeddings"):
            st = catalog().status_for(cap)
            self.assertIn(st["status"], ("not_installed", "evaluation_required",
                                         "license_acceptance_required", "not_configured", "available"))
            self.assertTrue(st["models"] or st["detail"], cap)

    def test_diarization_is_licence_gated_without_blocking_startup(self):
        st = diarization.diarization_status()
        self.assertEqual(st["status"], "license_acceptance_required")
        self.assertTrue(st["license_acceptance_required"])
        self.assertTrue(st["human_step"])
        err = asr.license_required_error("speech.diarize")
        self.assertEqual(err.reason, "license_acceptance_required")
        self.assertFalse(err.retryable)
        self.assertIn("will not accept terms", err.human_step)

    def test_heavy_stages_run_sequentially(self):
        self.assertEqual(diarization.stage_plan(True, True, True),
                         ["speech.asr", "speech.align", "speech.diarize"])
        self.assertEqual(diarization.stage_plan(True, False, False), ["speech.asr"])
        self.assertEqual(diarization.stage_plan(False, False, False), [])


if __name__ == "__main__":
    unittest.main()
