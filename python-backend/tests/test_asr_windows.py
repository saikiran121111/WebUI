"""Bounded decode windows: a fragment cut at a window edge must not masquerade as a sentence.

Measured defect this pins (real engine, real fixture, no mock): the frozen speech probe run
docs/overnight/logs/e03-speech-20261117T18323288777.json transcribed a 21.7 s source in
12 s windows and produced BOTH readings of one utterance:

    window [ 7.0, 19.3]  ->  16.30-19.30 s  "Embrose Finch Park, DeMarune Bicycle Behind"
    window [14.0, 21.7]  ->  16.26-21.26 s  "Embrose Finch parked a maroon bicycle behind
                                             the lighthouse at quarter past nine."

The first is the SAME audio, cut off because the window ended mid-utterance. Keeping both
put a duplicated truncated fragment in front of the model and made a tail-quality check
measure a made-up sentence (tail WER 0.538 over 13 words).

What these tests pin:
  * a span that reaches a window edge which is NOT the end of the source is a fragment,
    and it is superseded only when an uncut reading covers >= 90 % of it;
  * a fragment with no complete cover is KEPT and marked window_truncated, never dropped;
  * a reading that ends where the source ends is complete, not truncated;
  * two windows that overlap each other but are both cut by chunking supersede nothing;
  * readings from ONE window never supersede each other;
  * the superseded fragment is reported, with the window that produced it;
  * window provenance is internal and never reaches a payload.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ruke_ml.speech import whisper_ct2                     # noqa: E402
from ruke_ml.speech.asr import PCM_RATE_HZ                 # noqa: E402

FULL = ("Embrose Finch parked a maroon bicycle behind the lighthouse at quarter "
        "past nine.")
FRAGMENT = "Embrose Finch Park, DeMarune Bicycle Behind"
HEAD = "The Kestrel Depot Inventory lists 11 crates of copper cable worth 2400 euros."


def seg(start, end, text, window=None, words=None):
    out = {"start": start, "end": end, "text": text}
    if window is not None:
        out["_window"] = list(window)
    if words is not None:
        out["words"] = words
    return out


class FakeSegment:
    def __init__(self, start, end, text, words=None):
        self.start, self.end, self.text = start, end, text
        self.words = words or []


class FakeInfo:
    language = "en"
    language_probability = 0.99


class FakeWord:
    def __init__(self, start, end, word):
        self.start, self.end, self.word = start, end, word
        self.probability = 0.9


class FakeModel:
    """Returns one list of segments per window, in call order, window-relative times."""

    def __init__(self, per_window):
        self.per_window = list(per_window)
        self.calls = 0

    def transcribe(self, audio, **kwargs):
        index = self.calls
        self.calls += 1
        windows = self.per_window[index] if index < len(self.per_window) else []
        return iter(windows), FakeInfo()


def _run_adapter(windows, per_window, *, duration, vad_asset="available", **kwargs):
    """Drive the adapter over named windows, decoding each window to its real length."""
    class W:
        def __init__(self, a, b):
            self.start_s, self.end_s = a, b

    def fake_pcm_windows(duration_, *, window_s, overlap_s, src):
        return [W(a, b) for a, b in windows]

    def fake_decode(src, a, b, *, ffmpeg=""):
        return [0.0] * int(round((b - a) * PCM_RATE_HZ))

    model = FakeModel(per_window)
    with mock.patch.object(whisper_ct2, "load_model", lambda mid, allow_download=False: model), \
         mock.patch.object(whisper_ct2, "vad_asset_state", lambda: vad_asset), \
         mock.patch.object(whisper_ct2, "_decode_window", fake_decode), \
         mock.patch.object(whisper_ct2, "pcm_windows", fake_pcm_windows):
        out = whisper_ct2.transcribe("long.wav", model_id="fake/model", duration=duration,
                                     window_s=float(windows[0][1] - windows[0][0]), **kwargs)
    return out, model


class FragmentSuperseded(unittest.TestCase):
    def test_the_reproduced_long_source_artifact_merges_to_the_complete_reading(self):
        # Exactly the windows the frozen probe used (12 s windows, 5 s overlap).
        out, model = _run_adapter([(0.0, 12.0), (7.0, 19.0), (14.0, 21.717)],
                                  [[FakeSegment(0.0, 6.0, HEAD)],
                                   # window [7,19] hears the utterance only up to 19.0 s
                                   [FakeSegment(9.3, 12.3, FRAGMENT)],
                                   [FakeSegment(2.26, 7.26, FULL)]],
                                  duration=21.717)
        self.assertEqual(model.calls, 3, "every window must still be decoded")
        spans = [(s["start"], s["end"]) for s in out.segments]
        self.assertEqual(spans, [(0.0, 6.0), (16.26, 21.26)],
                         f"merged spans must be the two complete readings: {spans}")
        self.assertIn(FULL, out.text)
        self.assertNotIn(FRAGMENT, out.text)
        self.assertEqual(out.superseded[0]["cut_at"], "end")
        self.assertEqual(out.superseded[0]["window"], [7.0, 19.0])
        self.assertEqual(out.superseded[0]["superseded_by"], {"start": 16.26, "end": 21.26})
        self.assertIn("superseded", out.note)

        tail = [s for s in out.segments if s["start"] >= 0.55 * 21.717]
        self.assertEqual(len(tail), 1, "the tail must be one reading, not a fragment plus it")
        self.assertEqual(tail[0]["text"], FULL)

    def test_the_internal_window_key_never_reaches_a_payload(self):
        out, _ = _run_adapter([(0.0, 12.0), (7.0, 19.0), (14.0, 21.717)],
                              [[FakeSegment(0.0, 6.0, HEAD)],
                               [FakeSegment(9.3, 12.3, FRAGMENT)],
                               [FakeSegment(2.26, 7.26, FULL)]],
                              duration=21.717)
        payload = out.as_payload()
        for s in payload["segments"]:
            self.assertNotIn("_window", s)
        self.assertEqual(payload["superseded_fragments"], 1)

    def test_coverage_still_reports_every_decoded_window(self):
        out, _ = _run_adapter([(0.0, 12.0), (7.0, 19.0), (14.0, 21.717)],
                              [[FakeSegment(0.0, 6.0, HEAD)],
                               [FakeSegment(9.3, 12.3, FRAGMENT)],
                               [FakeSegment(2.26, 7.26, FULL)]],
                              duration=21.717)
        self.assertEqual(len(out.examined), 3)
        self.assertTrue(out.complete, f"coverage must stay complete: {out.examined}")
        self.assertEqual(out.superseded[0]["start"], 16.3)

    def test_word_timing_of_the_kept_reading_survives_the_merge(self):
        out, _ = _run_adapter([(0.0, 12.0), (14.0, 21.717)],
                              [[FakeSegment(0.0, 6.0, HEAD)],
                               [FakeSegment(2.26, 7.26, FULL,
                                           words=[FakeWord(2.26, 2.6, " Embrose")])]],
                              duration=21.717, word_timestamps=True)
        kept = [s for s in out.segments if s["text"] == FULL]
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["words"][0]["start"], 16.26)


class FragmentsStayWhenNothingCoversThem(unittest.TestCase):
    def test_a_lone_window_cut_is_kept_and_marked_not_dropped(self):
        merged, superseded = whisper_ct2._merge_windows(
            [seg(16.3, 19.3, FRAGMENT, window=(7.0, 19.0))], duration=21.7)
        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0]["window_truncated"])
        self.assertEqual(superseded, [])

    def test_two_cut_readings_of_the_same_span_supersede_nothing(self):
        # Both windows cut the utterance: neither heard the whole sentence, so neither
        # may be deleted as a duplicate of the other.
        merged, superseded = whisper_ct2._merge_windows(
            [seg(16.3, 19.3, "alpha beta gamma", window=(7.0, 19.0)),
             seg(16.2, 21.4, "alpha beta gamma delta epsilon", window=(14.0, 21.5))],
            duration=30.0)
        self.assertEqual(len(merged), 2, f"neither reading is proven complete: {merged}")
        self.assertTrue(all(s.get("window_truncated") for s in merged))
        self.assertEqual(superseded, [])

    def test_a_reading_that_ends_where_the_source_ends_is_complete(self):
        merged, superseded = whisper_ct2._merge_windows(
            [seg(16.26, 21.26, FULL, window=(14.0, 21.717))], duration=21.717)
        self.assertEqual(merged[0].get("window_truncated"), None)
        self.assertEqual(superseded, [])

    def test_a_reading_cut_at_the_START_of_a_window_is_superseded_by_an_earlier_one(self):
        merged, superseded = whisper_ct2._merge_windows(
            [seg(9.0, 13.0, "second half only", window=(9.0, 21.0)),
             seg(8.0, 13.4, "the whole first utterance here", window=(0.0, 15.0))],
            duration=30.0)
        self.assertEqual([s["text"] for s in merged], ["the whole first utterance here"])
        self.assertEqual(superseded[0]["cut_at"], "start")

    def test_partial_cover_below_the_fraction_keeps_both(self):
        merged, superseded = whisper_ct2._merge_windows(
            [seg(16.3, 20.0, FRAGMENT, window=(7.0, 20.0)),
             seg(16.2, 17.0, "embrose finch", window=(14.0, 26.0))],
            duration=30.0)
        self.assertEqual(len(merged), 2)
        self.assertEqual(superseded, [])


class WindowsNeverInventFacts(unittest.TestCase):
    def test_readings_with_no_provenance_are_never_called_truncated(self):
        merged, superseded = whisper_ct2._merge_windows([seg(16.3, 19.3, FRAGMENT)],
                                                        duration=21.7)
        self.assertEqual(merged[0].get("window_truncated"), None)
        self.assertEqual(superseded, [])

    def test_two_windows_overlapping_each_other_keep_legitimate_repetition(self):
        # The same SENTENCE said twice at different times is real evidence, not a duplicate.
        merged, superseded = whisper_ct2._merge_windows(
            [seg(1.0, 4.0, "repeat after me", window=(0.0, 10.0)),
             seg(20.0, 23.0, "repeat after me", window=(15.0, 25.0))], duration=30.0)
        self.assertEqual(len(merged), 2)
        self.assertEqual(superseded, [])

    def test_one_window_never_supersedes_its_own_overlap(self):
        merged, superseded = whisper_ct2._merge_windows(
            [seg(1.0, 6.0, "first clause", window=(0.0, 10.0)),
             seg(5.0, 9.0, "second clause", window=(0.0, 10.0))], duration=30.0)
        self.assertEqual(len(merged), 2)
        self.assertEqual(superseded, [])

    def test_identical_text_inside_covered_time_is_still_the_only_drop(self):
        merged, superseded = whisper_ct2._merge_windows(
            [seg(1.0, 6.0, HEAD, window=(0.0, 12.0)),
             seg(1.1, 5.9, HEAD, window=(7.0, 19.0))], duration=30.0)
        self.assertEqual(len(merged), 1)
        self.assertEqual(superseded, [], "the identical duplicate is not a boundary fragment")

    def test_the_edge_rule_is_a_number_not_a_guess(self):
        self.assertEqual(whisper_ct2._window_edge_clipped(
            seg(16.3, 19.3, "x", window=(7.0, 19.0)), (7.0, 19.0), 21.7), "end")
        self.assertEqual(whisper_ct2._window_edge_clipped(
            seg(16.3, 18.0, "x", window=(7.0, 19.0)), (7.0, 19.0), 21.7), "")
        self.assertEqual(whisper_ct2._window_edge_clipped(
            seg(16.3, 19.3, "x", window=(7.0, 19.0)), (7.0, 19.0), 19.1), "")


if __name__ == "__main__":
    unittest.main()
