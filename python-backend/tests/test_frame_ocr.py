"""video.frame_ocr: the frame-reading stage, tested at the DISPATCH layer.

What these tests establish (and what they deliberately do NOT):

  * they prove the bookkeeping is honest: which instants were decoded, which were
    recognised, which carried no glyph, which failed, which were never run, and that the
    counters keep those facts apart;
  * they do NOT establish OCR quality. No test here runs a model, and the injected
    frame/ocr functions are stand-ins for the ffmpeg + tesseract pair the production caller
    actually uses. Frame-OCR quality is only established by the media quality gate on a real
    recording, which is an attended run and is recorded as not_run, not as passed.

The behaviours below are the ones that were missing by construction: before this module
existed nothing in the pipeline ever read a frame, so an "observation" about on-screen text
could only be typed in by a caller.
"""
from __future__ import annotations

import base64
import struct
from unittest import mock
import threading
import unittest
import zlib

from ruke_ml.contracts import JobRequest
from ruke_ml.documents.ocr_tesseract import OcrUnavailable
from ruke_ml.video import frame_ocr
from ruke_ml.workers import jobs as jobs_mod


def _png(width: int = 4, height: int = 3, fill: bytes = b"\x00\x80\xff") -> bytes:
    """A real, minimal PNG (IHDR + one IDAT) so geometry parsing is tested on real bytes."""
    raw = b"".join(b"\x00" + fill * width for _ in range(height))
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def _lines(*texts: str) -> list[dict]:
    return [{"text": t, "bbox": [0, 0, 10, 10], "confidence": 0.9} for t in texts]


def _job(capability: str = "video.frame_ocr", **payload) -> JobRequest:
    return JobRequest(request_id="r1", run_id="run1", job_id="job1", capability=capability,
                      payload=payload)


def _ctx(req: JobRequest, cancel: threading.Event | None = None) -> jobs_mod.JobContext:
    return jobs_mod.JobContext(req=req, cancel=cancel or threading.Event(),
                               progress=lambda state, note: None)


class CommandShape(unittest.TestCase):
    def test_the_command_we_build_is_the_command_the_decoder_accepts(self) -> None:
        cmd = frame_ocr.ffmpeg_frame_command("clip.mp4", 12.345, ffmpeg="ffmpeg")
        self.assertEqual(cmd[0], "ffmpeg")
        # `-ss` BEFORE `-i` is the fast input seek; after `-i` it would decode from zero.
        self.assertLess(cmd.index("-ss"), cmd.index("-i"))
        self.assertIn("12.345", cmd)
        self.assertEqual(cmd[cmd.index("-frames:v") + 1], "1")
        # Measured on the pinned ffmpeg 6.1.1: `-vsync v0` is rejected outright.
        self.assertIn("-fps_mode", cmd)
        self.assertEqual(cmd[cmd.index("-fps_mode") + 1], "passthrough")
        self.assertNotIn("-vsync", cmd)
        self.assertEqual(cmd[cmd.index("-f") + 1], "image2pipe")
        self.assertEqual(cmd[-1], "-")
        # `-loglevel error` hides the only lines that explain a failed seek (measured).
        self.assertEqual(cmd[cmd.index("-loglevel") + 1], "error")
        self.assertIn("-nostdin", cmd)

    def test_png_geometry_is_read_from_the_header(self) -> None:
        self.assertEqual(frame_ocr.png_dimensions(_png(640, 360)), (640, 360))
        self.assertEqual(frame_ocr.png_dimensions(b"not a png"), (0, 0))

    def test_an_oversize_frame_is_a_resource_limit_not_a_frame_to_keep(self) -> None:
        self.assertLess(frame_ocr.MAX_PNG_BYTES, 64 << 20)


class StageSeparation(unittest.TestCase):
    """planned / decoded / recognised / glyph-free / failed stay different facts."""

    def test_recognised_and_glyph_free_are_both_measurements(self) -> None:
        seen: list[float] = []

        def ocr(_png_bytes: bytes, _lang: str):
            return (_lines("hello") if len(seen) == 1 else []), "eng"

        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0], language="en", duration=10.0,
            # Distinct pixels per instant: identical bytes would hit the duplicate rule, and
            # that behaviour has its own test below.
            frame_fn=lambda _s, t: (seen.append(t), _png(8, 6, bytes([int(t * 7)])))[1],
            ocr_fn=ocr)
        self.assertEqual([r.state for r in readings], ["recognised", "empty"])
        self.assertEqual(report["planned"], 2)
        self.assertEqual(report["decoded"], 2)
        self.assertEqual(report["recognised"], 1)
        self.assertEqual(report["glyph_free"], 1)
        self.assertEqual(report["unresolved"], [])
        self.assertEqual(readings[0].text, "hello")
        self.assertEqual(readings[0].width, 8)          # geometry came from the real IHDR
        self.assertAlmostEqual(readings[0].confidence, 0.9)

    def test_a_timestamp_outside_the_container_is_never_reported_as_no_text(self) -> None:
        called: list[float] = []
        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [99.0], language="en", duration=10.0,
            frame_fn=lambda _s, t: called.append(t) or _png(), ocr_fn=lambda _p, _l: ([], "eng"))
        self.assertEqual([r.state for r in readings], ["out_of_range"])
        self.assertEqual(called, [], "nothing should be decoded outside the measured duration")
        self.assertEqual(report["unresolved"], [99.0])
        self.assertIn("outside the measured", readings[0].detail)

    def test_a_decoded_frame_that_fails_to_recognise_stays_unresolved(self) -> None:
        def ocr(_png_bytes: bytes, _lang: str):
            raise OcrUnavailable("engine_failed", "tesseract exited 1")
        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0], language="en", duration=10.0,
            frame_fn=lambda _s, _t: _png(fill=b"\x01\x02\x03"), ocr_fn=ocr)
        self.assertEqual([r.state for r in readings], ["ocr_failed"])
        self.assertTrue(readings[0].digest, "the frame really was decoded, and says so")
        self.assertEqual(report["decoded"], 1)
        self.assertEqual(report["recognised"], 0)
        self.assertEqual(report["unresolved"], [1.0])
        self.assertEqual(report["failure_kinds"].get("engine_failed"), 1)

    def test_one_frame_decode_failure_does_not_end_the_sample(self) -> None:
        def frame(_s: str, t: float) -> bytes:
            if t == 2.0:
                raise frame_ocr.FrameDecodeFailed("decode_failed", "no frame at 2s")
            return _png(fill=bytes([int(t * 5)]))
        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0, 3.0], language="en", duration=10.0,
            frame_fn=frame, ocr_fn=lambda _p, _l: (_lines("x"), "eng"))
        self.assertEqual([r.state for r in readings], ["recognised", "frame_failed", "recognised"])
        self.assertEqual(report["recognised"], 2)
        self.assertEqual(report["unresolved"], [2.0])

    def test_a_capability_level_condition_is_reported_once_not_once_per_frame(self) -> None:
        def frame(_s: str, _t: float) -> bytes:
            raise frame_ocr.FrameDecodeFailed("ffmpeg_not_installed", "no validated ffmpeg copy")
        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0, 3.0], language="en", duration=10.0,
            frame_fn=frame, ocr_fn=lambda _p, _l: (_lines("x"), "eng"))
        self.assertEqual([r.state for r in readings],
                         ["not_run", "not_run", "not_run"])
        self.assertEqual(report["decoded"], 0)
        self.assertEqual(report["failure_kinds"].get("ffmpeg_not_installed"), 1,
                         "one cause, one failure count - not three invented failures")


class CostHonesty(unittest.TestCase):
    def test_identical_frames_are_not_recognised_twice(self) -> None:
        calls: list[float] = []
        png = _png()

        def ocr(_png_bytes: bytes, _lang: str):
            calls.append(1.0)
            return _lines("slide title"), "eng"

        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0, 3.0], language="en", duration=10.0,
            frame_fn=lambda _s, _t: png, ocr_fn=ocr)
        self.assertEqual([r.state for r in readings], ["recognised", "duplicate", "duplicate"])
        self.assertEqual(len(calls), 1, "a byte-identical frame must not be re-OCR'd")
        self.assertEqual(readings[1].copy_of_time, 1.0)
        self.assertEqual(readings[1].detail.count("byte-identical"), 1)
        self.assertEqual(report["duplicates"], 2)
        self.assertEqual(report["decoded"], 3, "decoded and read are separate counts")

    def test_cancelling_mid_sample_marks_the_rest_as_never_run(self) -> None:
        cancel = threading.Event()

        def frame(_s: str, t: float) -> bytes:
            if t >= 3.0:
                raise frame_ocr.FrameDecodeFailed("cancelled", "cancelled before the frame")
            return _png(fill=bytes([int(t * 11)]))

        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0, 3.0, 4.0], language="en", duration=10.0,
            frame_fn=frame, ocr_fn=lambda _p, _l: (_lines("x"), "eng"), cancel=cancel.is_set)
        self.assertEqual(readings[0].state, "recognised", "work already done is kept")
        self.assertEqual([r.state for r in readings[1:]], ["recognised", "skipped", "not_run"])
        self.assertEqual(report["recognised"], 2)
        self.assertEqual(report["planned"], 4)

    def test_a_passed_deadline_leaves_the_rest_unrun_rather_than_half_read(self) -> None:
        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0], language="en", duration=10.0,
            frame_fn=lambda _s, _t: _png(), ocr_fn=lambda _p, _l: (_lines("x"), "eng"),
            deadline_at=-1.0)
        self.assertEqual([r.state for r in readings], ["not_run", "not_run"])
        self.assertEqual(report["decoded"], 0)

    def test_a_sampling_plan_never_claims_visual_coverage(self) -> None:
        _readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0], language="en", duration=600.0,
            frame_fn=lambda _s, _t: _png(), ocr_fn=lambda _p, _l: (_lines("x"), "eng"))
        self.assertIn("cannot establish visual coverage", report["note"])
        self.assertIn("TEXT only", report["note"])
        self.assertEqual(report["character_limit_per_frame"], frame_ocr.MAX_CHARS_PER_FRAME)


class RegistryWiring(unittest.TestCase):
    def test_the_row_requires_decoder_AND_recogniser(self) -> None:
        from ruke_ml.models.registry import catalog
        spec = catalog().get("ruke-video-frame-ocr", "video.frame_ocr")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.requires_binary, "ffmpeg")
        self.assertEqual(spec.also_requires_binaries, ("tesseract",))
        self.assertEqual(spec.adapter, "ruke_ml.video.frame_ocr")
        self.assertEqual(spec.claims["languages"], [],
                         "language coverage is probed from the binary, never copied from a card")
        self.assertFalse(spec.verified, "no frame-OCR quality has been measured on this host")

    def test_a_row_is_not_installed_when_only_one_of_its_two_programs_exists(self) -> None:
        from ruke_ml.models import binaries, registry
        spec = registry.ModelSpec(id="x", revision="builtin-v1", capability="video.frame_ocr",
                                  provider="builtin", package="", builtin=True,
                                  requires_binary="ffmpeg", also_requires_binaries=("nope-xyz",),
                                  adapter="ruke_ml.video.frame_ocr")
        self.assertIn("nope-xyz", spec.missing_binaries())
        self.assertFalse(spec.installed())

    def test_the_worker_dispatches_the_new_capability(self) -> None:
        from ruke_ml.workers import runner
        self.assertIn("video.frame_ocr", runner.HANDLERS)
        self.assertIn("video.frame_ocr", runner.GATED,
                      "the readiness gate is what keeps a decoder-only host from advertising "
                      "a capability that cannot run")




class JobWiring(unittest.TestCase):
    """The dispatch/routing layer of video.frame_ocr, with the engine pair stubbed.

    These prove the STRUCTURAL decisions: an audio-only container is refused rather than
    reported as "no text on screen"; an unaddressable language is refused before any pixel
    is decoded; partial evidence survives a cancel. None of it measures OCR quality.
    """

    def setUp(self) -> None:
        import tempfile
        from pathlib import Path
        self.dir = Path(tempfile.mkdtemp(prefix="ruke-frameocr-"))
        self.media = self.dir / "clip.mp4"
        self.media.write_bytes(b"ftypisom not really media")
        self.root = str(self.dir)

    def _payload(self, **over) -> dict:
        base = {"path": str(self.media), "root": self.root, "language": "en",
                "times": [1.0, 2.0]}
        base.update(over)
        return base

    def _run(self, payload: dict, probe: dict | None = None, readings=None, report=None):
        from ruke_ml.workers.video_jobs import frame_ocr_job
        probe = probe or {"ok": True, "error": "", "duration": 10.0, "video_streams": 1,
                          "audio_state": "speech", "audio_streams": 1,
                          "rotation_deg": 0, "stream_start_offsets": {},
                          "subtitle_tracks": [], "has_audio": True}
        readings = readings if readings is not None else []
        report = report or {"planned": 2, "decoded": 0, "recognised": 0, "glyph_free": 0,
                            "duplicates": 0, "unresolved": [], "failure_kinds": {},
                            "engine": "stub", "engine_languages": ["eng"],
                            "requested_language": "en", "seek": "stub",
                            "character_limit_per_frame": 100, "note": "stub note"}
        with mock.patch("ruke_ml.speech.asr.probe_media", return_value=probe), \
             mock.patch("ruke_ml.video.frame_ocr.ocr_frames",
                        return_value=(readings, report)) as ocr_calls:
            result = frame_ocr_job(_ctx(_job(**payload)))
        return result, ocr_calls

    def test_an_audio_only_container_is_refused_structurally(self) -> None:
        probe = {"ok": True, "error": "", "duration": 10.0, "video_streams": 0,
                 "audio_state": "speech", "audio_streams": 1, "rotation_deg": 0,
                 "stream_start_offsets": {}, "subtitle_tracks": [], "has_audio": True}
        result, calls = self._run(self._payload(), probe=probe)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "unsupported_input")
        self.assertIn("no video stream", result.error.message)
        self.assertEqual(call_count(calls), 0, "nothing may be decoded when there is no picture")

    def test_an_unprobeable_file_is_corrupt_input_not_an_empty_result(self) -> None:
        probe = {"ok": False, "error": "ffprobe exited 1", "human_step": "re-export it"}
        result, _calls = self._run(self._payload(), probe=probe)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "corrupt_input")

    def test_the_language_is_never_defaulted(self) -> None:
        payload = self._payload()
        del payload["language"]
        result, calls = self._run(payload)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "input_rejected")
        self.assertIn("explicit text language", result.error.message)
        self.assertEqual(call_count(calls), 0)

    def test_a_path_outside_the_allowed_root_never_reaches_the_decoder(self) -> None:
        result, calls = self._run(self._payload(path=str(self.dir.parent / "elsewhere.mp4")))
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "input_rejected")
        self.assertEqual(call_count(calls), 0)

    def test_no_times_is_an_input_error_rather_than_a_zero_frame_success(self) -> None:
        payload = self._payload()
        del payload["times"]
        result, calls = self._run(payload)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.error.reason, "input_rejected")
        self.assertEqual(call_count(calls), 0)

    def test_read_frames_become_time_stamped_blocks_and_partial_coverage(self) -> None:
        readings = [_FrameReading(1.0, "recognised", text="quarterly result"),
                    _FrameReading(2.0, "ocr_failed", detail="engine_failed: tesseract exited 1")]
        report = {"planned": 2, "decoded": 2, "recognised": 1, "glyph_free": 0, "duplicates": 0,
                  "unresolved": [2.0], "failure_kinds": {"engine_failed": 1},
                  "engine": "5.5.3", "engine_languages": ["eng", "osd"],
                  "requested_language": "en",
                  "seek": "input seek + accurate decode", "character_limit_per_frame": 20000,
                  "note": "reads visible TEXT only; sampling does not establish coverage"}
        result, _calls = self._run(self._payload(), readings=readings, report=report)
        self.assertEqual(result.state, "ready", "one read frame is real evidence and is kept")
        self.assertEqual(len(result.payload["blocks"]), 1)
        block = result.payload["blocks"][0]
        self.assertEqual((block["start"], block["end"]), (1.0, 1.0))
        self.assertEqual(result.payload["stage_counts"]["unresolved"], 1)
        self.assertFalse(result.coverage.complete)
        self.assertEqual(result.coverage.units, "instants")
        self.assertEqual(result.coverage.skipped, [(0.0, 10.0)],
                         "sampled instants examine no interval, so the timeline stays unexamined")
        self.assertEqual(result.coverage.examined, [(1.0, 1.0)],
                         "a frame that decoded but was never recognised is not an examined instant")

    def test_a_cancel_with_nothing_read_is_a_cancellation_not_an_empty_success(self) -> None:
        cancel = threading.Event()
        cancel.set()
        from ruke_ml.workers.video_jobs import frame_ocr_job
        with mock.patch("ruke_ml.speech.asr.probe_media",
                        return_value={"ok": True, "error": "", "duration": 10.0,
                                      "video_streams": 1, "audio_state": "speech",
                                      "audio_streams": 1, "rotation_deg": 0,
                                      "stream_start_offsets": {}, "subtitle_tracks": [],
                                      "has_audio": True}), \
             mock.patch("ruke_ml.video.frame_ocr.ocr_frames") as never:
            result = frame_ocr_job(_ctx(_job(**self._payload()), cancel=cancel))
        self.assertEqual(result.state, "cancelled")
        self.assertEqual(call_count(never), 0)


def call_count(mock_obj) -> int:
    return mock_obj.call_count


def _FrameReading(time_s: float, state: str, text: str = "", detail: str = ""):
    from ruke_ml.video.frame_ocr import FrameReading
    return FrameReading(time_s, state, text=text, detail=detail, engine="5.5.3",
                        language_code="eng", digest="d" * 32 if state != "ocr_failed" else "")


if __name__ == "__main__":
    unittest.main()


class CarryPixels(unittest.TestCase):
    """F153 item 4 (2026-11-25): a chat-time seek of a visual moment must deliver PIXELS to
    the answering request, not only OCR text — a color, a layout, a diagram has no glyphs.
    `include_image` rides the payload; frames that decoded carry base64 PNG; the default
    stays the byte-identical digest-only contract (no new key), so every existing consumer
    of video.frame_ocr is untouched.
    """

    def _frames(self, **over):
        seen: list[float] = []

        def png_at(_s, t):
            seen.append(t)
            return _png(8, 6, bytes([int(t * 7) % 256]))

        def ocr(_b, _lang):
            return _lines("on screen label"), "eng"

        return frame_ocr.ocr_frames(
            "clip.mp4", [1.0], language="en", duration=10.0,
            frame_fn=png_at, ocr_fn=ocr, **over)

    def test_pixels_ride_the_frame_when_requested(self) -> None:
        readings, _report = self._frames(include_image=True)
        d = readings[0].to_dict()
        self.assertEqual(d["state"], "recognised")
        self.assertIn("image_b64", d, "a requested frame carried no pixels")
        self.assertEqual(base64.b64decode(d["image_b64"]), _png(8, 6, bytes([7])),
                         "the pixels must be the EXACT decoded frame, not a re-encode")

    def test_pixels_are_absent_by_default_the_digest_contract_stands(self) -> None:
        readings, _report = self._frames()
        self.assertNotIn("image_b64", readings[0].to_dict(),
                         "the default payload shape changed: every existing consumer pays")

    def test_a_duplicate_still_carries_its_pixels(self) -> None:
        def ocr(_b, _lang):
            return _lines("on screen label"), "eng"

        readings, _report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0, 2.0], language="en", duration=10.0,
            frame_fn=lambda _s, _t: _png(8, 6, b"\x01\x02\x03"),
            ocr_fn=ocr, include_image=True)
        self.assertEqual([r.state for r in readings], ["recognised", "duplicate"])
        d = readings[1].to_dict()
        self.assertIn("image_b64", d,
                      "a seek of the duplicate instant needs the pixels AT that instant; "
                      "skipping OCR text twice is fine, hiding the picture is not")

    def test_an_oversize_frame_is_not_shipped_as_pixels(self) -> None:
        with mock.patch.object(frame_ocr, "MAX_IMAGE_B64_BYTES", 8):
            readings, _report = self._frames(include_image=True)
        d = readings[0].to_dict()
        self.assertNotIn("image_b64", d)
        self.assertIn("transport bound", d["detail"],
                      "the omission must be STATED, never left for the caller to guess")

    def test_the_job_passes_include_image_through_and_bounds_the_pixel_budget(self) -> None:
        import tempfile
        from pathlib import Path
        from ruke_ml.workers.video_jobs import frame_ocr_job
        d = Path(tempfile.mkdtemp(prefix="ruke-frameocr-img-"))
        media = d / "clip.mp4"
        media.write_bytes(b"ftypisom not really media")
        probe = {"ok": True, "error": "", "duration": 10.0, "video_streams": 1,
                 "audio_state": "speech", "audio_streams": 1, "rotation_deg": 0,
                 "stream_start_offsets": {}, "subtitle_tracks": [], "has_audio": True}
        report = {"planned": 1, "decoded": 0, "recognised": 0, "glyph_free": 0,
                  "duplicates": 0, "unresolved": [], "failure_kinds": {},
                  "engine": "stub", "engine_languages": ["eng"],
                  "requested_language": "en", "seek": "stub",
                  "character_limit_per_frame": 100, "note": "stub note"}
        payload = {"path": str(media), "root": str(d), "language": "en",
                   "times": [1.0], "include_image": True, "max_frames": 64}
        with mock.patch("ruke_ml.speech.asr.probe_media", return_value=probe), \
             mock.patch("ruke_ml.video.frame_ocr.ocr_frames",
                        return_value=([], report)) as ocr_calls:
            frame_ocr_job(_ctx(_job(**payload)))
        kwargs = ocr_calls.call_args.kwargs
        self.assertTrue(kwargs.get("include_image"), "the payload flag never reached the decoder")
        self.assertLessEqual(kwargs.get("max_frames", 99), 8,
                             "64 frames of pixels over one RPC response is a transport bomb; "
                             "the pixel mode bounds its own frame count")


class PixelsOnly(unittest.TestCase):
    """F153 item 4 (2026-11-25): the picture IS the evidence for a chat-time visual
    follow-up ("what color was the background at 02:10?"). A color has no glyphs, so a
    pixels-only seek (include_image, no text language) must deliver the decoded frames
    and must never claim the text was absent — the recogniser never ran, so on-screen
    text is UNMEASURED. Without include_image the language contract is byte-identical:
    an empty language stays an input_rejected refusal (pinned in JobWiring).
    """

    def test_pixels_only_skips_the_recogniser_entirely(self) -> None:
        def never_ocr(_png_bytes, _lang):
            raise AssertionError("a pixels-only pass may not invoke the OCR engine")

        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0], language="", duration=10.0,
            frame_fn=lambda _s, _t: _png(8, 6, b"\x01\x02\x03"),
            ocr_fn=never_ocr, include_image=True)
        self.assertEqual([r.state for r in readings], ["pixels"])
        d = readings[0].to_dict()
        self.assertEqual(base64.b64decode(d["image_b64"]), _png(8, 6, b"\x01\x02\x03"),
                         "a pixels-only seek must deliver the EXACT decoded frame")
        self.assertIn("text not read", d["detail"],
                      "the frame must STATE that its text was not read — a stated scope, "
                      "never a silent one")
        self.assertFalse(report["text_pass"],
                         "a consumer must be able to tell recognised==0 means the pass "
                         "never ran, not that the screen had no text")

    def test_pixels_only_does_not_require_an_ocr_engine(self) -> None:
        # The engine/language pre-checks exist to stop a wasted OCR pass. With no
        # OCR pass planned, a missing engine must not kill a pixel seek.
        def no_engine():
            raise OcrUnavailable("engine_missing", "stub: no tesseract installed", "")

        def no_lang(_l):
            raise AssertionError("stub: language check must not run in pixels-only mode")

        with mock.patch("ruke_ml.documents.ocr_tesseract.engine_state", no_engine), \
             mock.patch("ruke_ml.documents.ocr_tesseract.language_is_addressable", no_lang):
            readings, report = frame_ocr.ocr_frames(
                "clip.mp4", [1.0], language="", duration=10.0,
                frame_fn=lambda _s, _t: _png(8, 6, b"\x04\x05\x06"),
                include_image=True)
        self.assertEqual([r.state for r in readings], ["pixels"])
        self.assertIn("image_b64", readings[0].to_dict())
        self.assertFalse(report["text_pass"])

    def test_a_pixels_only_job_reports_text_as_unmeasured_and_keeps_coverage(self) -> None:
        import tempfile
        from pathlib import Path
        from ruke_ml.workers.video_jobs import frame_ocr_job
        d = Path(tempfile.mkdtemp(prefix="ruke-frameocr-px-"))
        media = d / "clip.mp4"
        media.write_bytes(b"ftypisom not really media")
        probe = {"ok": True, "error": "", "duration": 10.0, "video_streams": 1,
                 "audio_state": "none", "audio_streams": 0, "rotation_deg": 0,
                 "stream_start_offsets": {}, "subtitle_tracks": [], "has_audio": False}
        readings = [frame_ocr.FrameReading(1.0, "pixels", digest="d" * 32,
                                           image_b64="aW1hZ2U=",
                                           detail="decoded: pixels delivered; on-screen text "
                                                  "not read (no text language configured)")]
        report = {"planned": 1, "decoded": 1, "recognised": 0, "glyph_free": 0,
                  "duplicates": 0, "unresolved": [], "failure_kinds": {},
                  "engine": "", "engine_languages": [], "requested_language": "",
                  "text_pass": False, "seek": "stub",
                  "character_limit_per_frame": 100, "note": "stub note"}
        payload = {"path": str(media), "root": str(d), "times": [1.0],
                   "include_image": True}
        with mock.patch("ruke_ml.speech.asr.probe_media", return_value=probe), \
             mock.patch("ruke_ml.video.frame_ocr.ocr_frames",
                        return_value=(readings, report)):
            result = frame_ocr_job(_ctx(_job(**payload)))
        self.assertEqual(result.state, "ready",
                         "an empty language with pixels requested is a legal pixels-only seek")
        self.assertEqual(result.payload["frames"][0]["state"], "pixels")
        self.assertIn("pixels-only pass", result.payload["note"])
        self.assertIn("UNMEASURED", result.payload["note"],
                      "'0 of 1 yielded text; 0 carried no glyph' would claim the "
                      "recogniser ran — it never did")
        self.assertEqual(result.coverage.examined, [(1.0, 1.0)],
                         "the instant WAS decoded and delivered: it is examined")

    def test_a_language_alongside_pixels_still_reads_the_text(self) -> None:
        readings, report = frame_ocr.ocr_frames(
            "clip.mp4", [1.0], language="en", duration=10.0,
            frame_fn=lambda _s, _t: _png(8, 6, b"\x07\x08\x09"),
            ocr_fn=lambda _p, _l: (_lines("quarterly result"), "eng"),
            include_image=True)
        self.assertEqual([r.state for r in readings], ["recognised"],
                         "configuring a language must not downgrade a pixel seek to no OCR")
        self.assertIn("image_b64", readings[0].to_dict())
        self.assertTrue(report["text_pass"])
