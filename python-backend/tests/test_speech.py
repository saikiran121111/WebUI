"""Language routing, timebase laws, word-time honesty and anonymous speakers.

These are the F13/section-8 speech laws: English-only models never carry another
language, a segment span is never read as word timing, and no audio track is not
silence. Reworked 2026-11-22 for the frozen English release: the registry carries
ONE ASR row (Parakeet through Transformers), so the routing law is now "the fixed
English default is named only for English/auto, and every non-English request is
REFUSED with a human step" - no Whisper candidate exists to route to.
"""
from __future__ import annotations

import unittest

from ruke_ml.speech import alignment, asr, diarization
from ruke_ml.models.registry import catalog

PARAKEET = "nvidia/parakeet-tdt-0.6b-v3"


def _spec_claims(model_id: str) -> str:
    from ruke_ml.models.registry import catalog
    spec = catalog().get(model_id)
    return str(spec.claims) if spec else ""


class Routing(unittest.TestCase):
    def test_non_english_never_routes_the_english_default(self):
        # The English freeze (final decision 2026-11-22): with ONE row, a non-English
        # request must be REFUSED, never routed through the English default. (The
        # integration refuses a second time at load; routing must not name it either.)
        for lang in ("te", "hi", "zh", "vi"):
            r = asr.language_route(lang)
            self.assertNotEqual(r.get("model"), PARAKEET,
                                "%s was routed through the English-only default" % lang)
            self.assertNotIn(r["decision"], ("route", "route_with_warning"), lang)

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

    def test_telugu_is_refused_not_silently_supported(self):
        r = asr.language_route("te")
        self.assertEqual(r["language"], "te")
        self.assertNotIn(r["quality_mode"], (None, ""))
        self.assertNotEqual(r.get("model"), PARAKEET,
                            "the English release must not claim Telugu support")
        self.assertTrue(r.get("human_step"), "the refusal tells the user what to do")

    def test_status_reports_pcm_contract_without_loading(self):
        st = asr.speech_status()
        self.assertEqual(st["capability"], "speech.asr")
        self.assertEqual(st["pcm_contract"], {"rate_hz": 16000, "channels": 1, "width_bytes": 2})
        ids = [m["id"] for m in st["models"]]
        self.assertEqual(ids, [PARAKEET],
                         "the frozen registry carries exactly the one English ASR row")
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


class Coverage(unittest.TestCase):
    """A run is complete when the decoded windows cover the source, at the resolution the
    numbers are actually reported at. Both error directions are bugs: an 84 us resampler
    tail is not "unexamined audio", and a real shortfall must never be hidden."""

    def test_reporting_rounding_is_not_reported_as_unexamined_audio(self):
        from ruke_ml.speech import whisper_ct2
        # Measured in the F17 E03 run: a 6.543084 s track decoded end to end, and the
        # span arithmetic left an 84 us "skipped" interval, so an honest complete run
        # was reported as partial.
        gaps = whisper_ct2.uncovered_gaps(6.543084, [(0.0, 6.543)])
        self.assertEqual(gaps, [], "resampler drift was reported as unexamined audio")

    def test_a_real_shortfall_is_still_reported_in_full(self):
        from ruke_ml.speech import whisper_ct2
        gaps = whisper_ct2.uncovered_gaps(120.0, [(0.0, 30.0), (35.0, 60.0)])
        self.assertEqual([(round(a, 3), round(b, 3)) for a, b in gaps],
                         [(30.0, 35.0), (60.0, 120.0)],
                         "an undecoded middle and an undecoded tail must both survive")

    def test_tolerance_is_documented_and_smaller_than_any_real_gap(self):
        from ruke_ml.speech import whisper_ct2
        self.assertLess(whisper_ct2.COVERAGE_TOLERANCE_S, 0.01,
                        "a tolerance big enough to hide a tenth of a second is not a tolerance")
        self.assertGreater(whisper_ct2.COVERAGE_TOLERANCE_S, 1.0 / asr.PCM_RATE_HZ)

    def test_the_job_and_the_adapter_use_the_same_gap_rule(self):
        # One rule, one place: the job's `skipped` field and the adapter's `complete`
        # flag must never disagree about the same spans.
        from ruke_ml.speech import whisper_ct2
        from ruke_ml.workers import speech_jobs
        spans = [(0.0, 6.543)]
        self.assertEqual(speech_jobs._uncovered(6.543084, spans),
                         whisper_ct2.uncovered_gaps(6.543084, spans))


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
        # D-034 test law: exclusions are keyed by the REGISTERED ALIGNER, not by whichever
        # ASR produced the transcript. The transcript family -> aligner map is published so
        # the routing stays checkable.
        self.assertEqual(st["exclusions"]["Qwen/Qwen3-ForcedAligner-0.6B"], ["hi", "te"])
        self.assertEqual(st["aligner_for"]["Qwen/Qwen3-ASR-1.7B"], "Qwen/Qwen3-ForcedAligner-0.6B")
        self.assertEqual(st["exclusions_by_transcript_family"]["Qwen/Qwen3-ASR-1.7B"], ["hi", "te"])


class AlignerTruth(unittest.TestCase):
    """Word timing belongs to the aligner, and its support claim is its own table."""

    def test_the_aligners_table_decides_not_the_asrs(self):
        # openai/whisper-large-v3 publishes Telugu as an ASR, but the aligner registered
        # for that transcript family publishes no captured table at all, so word timing
        # must be refused rather than borrowed from the ASR's multilingual claim.
        got = alignment.decide("openai/whisper-large-v3", "te")
        self.assertEqual(got["aligner"], "whisperx/whisper-alignment")
        self.assertFalse(got["ok"])
        self.assertEqual(got["kind"], alignment.KIND_UNSUPPORTED_LANGUAGE, got)
        self.assertIn("language table", got["detail"])
        self.assertTrue(got["human_step"])

    def test_automatic_language_never_reaches_an_aligner(self):
        for lang in ("", "auto", "unknown", "und", "mul", "-", "n/a"):
            got = alignment.decide("Systran/faster-whisper-base", lang)
            self.assertFalse(got["ok"], lang)
            self.assertEqual(got["kind"], alignment.KIND_UNKNOWN_LANGUAGE,
                             "%s must go through real detection first" % lang)
            self.assertTrue(got["human_step"], lang)

    def test_advertised_word_timing_and_executability_never_disagree(self):
        rows = catalog().for_capability("speech.align")
        self.assertTrue(rows, "speech.align must have registered rows to reason about")
        seen_executable_case = False
        for spec in rows:
            tags = spec.claims.get("languages") or []
            if not tags:
                continue
            lang = next((t for t in tags
                         if t not in alignment.ALIGNER_EXCLUSIONS.get(spec.id, set())), "")
            if not lang:
                continue
            got = alignment.decide(spec.id, lang)
            executable = catalog().readiness(spec.id, "speech.align").executable
            self.assertEqual(got["ok"], executable,
                             "%s: word-timing support must equal readiness" % spec.id)
            if not got["ok"]:
                seen_executable_case = True
                self.assertEqual(got["kind"], alignment.KIND_NOT_EXECUTABLE, got)
                self.assertTrue(got["blockers"], "a refused row must name its blocker")
                self.assertTrue(got["human_step"])
        self.assertTrue(seen_executable_case or any(
            catalog().readiness(s.id, "speech.align").executable for s in rows))

    def test_status_reports_per_aligner_readiness_without_loading(self):
        st = alignment.alignment_status()
        self.assertEqual(st["capability"], "speech.align")
        for a in st["aligners"]:
            self.assertIsInstance(a["executable"], bool)
            self.assertIsInstance(a["published_languages"], int)
            if not a["executable"]:
                self.assertTrue(a["blockers"], "%s must say why it cannot run" % a["id"])
        self.assertIn("the aligner's table", st["detail"])


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
