"""Measured-level, CPU-device and decode-command laws (session F14).

Every test here exists because a real run on this host either proved the law or exposed
the defect: the whole-file ASR path called a faster-whisper helper that the pinned 1.2.1
release does not export, and the PCM command omitted its output target, so ffmpeg exited 1
before a single sample reached the model.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest

from ruke_ml.models import binaries
from ruke_ml.speech import asr, levels, whisper_ct2
from ruke_ml import processes


def _ffmpeg() -> str:
    return binaries.path_for("ffmpeg")


class LoudnessParsing(unittest.TestCase):
    LOG = (
        "[Parsed_volumedetect_0 @ 0x1] mean_volume: -19.3 dB\n"
        "[Parsed_volumedetect_0 @ 0x1] max_volume: -6.1 dB\n"
        "[silencedetect @ 0x2] silence_start: 10.02\n"
        "[silencedetect @ 0x2] silence_end: 20.04 | silence_duration: 10.02\n"
    )

    def test_levels_and_silence_intervals_are_parsed_from_the_filter_log(self):
        got = levels.parse_level_log(self.LOG)
        self.assertEqual(got["mean_volume_db"], -19.3)
        self.assertEqual(got["max_volume_db"], -6.1)
        self.assertEqual(got["silence_intervals"], [(10.02, 20.04)])

    def test_a_filename_containing_the_keyword_cannot_invent_a_level(self):
        got = levels.parse_level_log("mean_volume_report.wav: no such filter output")
        self.assertIsNone(got["mean_volume_db"])
        self.assertIsNone(got["max_volume_db"])
        self.assertEqual(got["silence_intervals"], [])

    def test_an_open_silence_start_without_an_end_is_not_counted(self):
        got = levels.parse_level_log("[silencedetect @ 0x2] silence_start: 33.0\n")
        self.assertEqual(got["silence_intervals"], [])

    def test_level_command_states_its_output_target(self):
        cmd = levels.level_command("in.wav")
        self.assertEqual(cmd[-3:], ["-f", "null", "-"],
                         "a null-mux without an output target exits 1: %r" % (cmd,))


class RealLoudness(unittest.TestCase):
    """Real ffmpeg execution against the project-local media corpus."""

    corpus = None

    def setUp(self):
        bins = binaries.repo_root() / ".data" / "tmp" / "e03"
        if not bins.is_dir():
            self.skipTest("e03 media corpus is not present")
        self.corpus = bins

    def test_digital_silence_measures_as_silence(self):
        got = levels.measure_level(str(self.corpus / "silence.wav"), duration_s=5.0)
        self.assertTrue(got.ok and got.measured)
        self.assertEqual(got.audio_level_state, "silence")
        self.assertTrue(got.is_silence())
        self.assertLessEqual(got.max_volume_db, levels.NOISE_FLOOR_DBFS)

    def test_an_audible_tone_is_not_silence(self):
        got = levels.measure_level(str(self.corpus / "tone.wav"), duration_s=10.0)
        self.assertTrue(got.ok)
        self.assertEqual(got.audio_level_state, "audible")
        self.assertFalse(got.is_silence())

    def test_silence_inside_a_longer_track_is_reported_as_intervals(self):
        got = levels.measure_level(str(self.corpus / "long.wav"), duration_s=29.0)
        self.assertEqual(got.audio_level_state, "audible")
        self.assertTrue(got.silence_intervals, "the 10s gap must be measured, not invented")

    def test_a_file_with_no_audio_track_yields_unknown_never_silence(self):
        got = levels.measure_level(str(self.corpus / "noaudio.mp4"), duration_s=4.0)
        self.assertFalse(got.ok)
        self.assertFalse(got.measured)
        self.assertEqual(got.audio_level_state, "unknown")
        self.assertFalse(got.is_silence(), "no level must never become a silence claim")

    def test_an_unreadable_path_is_a_failure_not_a_silence_result(self):
        got = levels.measure_level(str(self.corpus / "definitely-missing.wav"))
        self.assertFalse(got.ok)
        self.assertEqual(got.audio_level_state, "unknown")


class CPUMemoryDevicePolicy(unittest.TestCase):
    """Amendment 2: document/media workers are CPU. A GPU that EXISTS is never a reason."""

    def setUp(self):
        for key in ("RUKE_ML_DEVICE", "RUKE_ML_COMPUTE_TYPE"):
            self._saved = getattr(self, "_saved", {})
            self._saved[key] = os.environ.get(key)
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in getattr(self, "_saved", {}).items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_default_is_cpu_int8_even_on_a_host_with_cuda(self):
        try:
            import ctranslate2
        except Exception:                                    # noqa: BLE001
            self.skipTest("ctranslate2 is not installed")
        real = getattr(ctranslate2, "get_cuda_device_count", None)
        ctranslate2.get_cuda_device_count = lambda: 4        # pretend the LLM GPU exists
        try:
            self.assertEqual(whisper_ct2.device_choice(), ("cpu", "int8"))
        finally:
            if real is not None:
                ctranslate2.get_cuda_device_count = real

    def test_an_operator_override_is_honoured_and_therefore_reported(self):
        os.environ["RUKE_ML_DEVICE"] = "cuda"
        os.environ["RUKE_ML_COMPUTE_TYPE"] = "float16"
        self.assertEqual(whisper_ct2.device_choice(), ("cuda", "float16"))

    def test_a_typo_never_becomes_a_gpu_choice_or_a_crash(self):
        os.environ["RUKE_ML_DEVICE"] = "gpu-all"
        self.assertEqual(whisper_ct2.device_choice()[0], "cpu")


class DecodeCommandLaws(unittest.TestCase):
    def test_pcm_command_names_its_stdout_target(self):
        cmd = asr.pcm_command("in.mp4", start_s=1.0, duration_s=2.0)
        self.assertEqual(cmd[-3:], ["-f", "s16le", "-"],
                         "ffmpeg exits 1 with no output target: %r" % (cmd,))

    @unittest.skipUnless(_ffmpeg(), "no validated ffmpeg copy on this host")
    def test_the_command_really_decodes_pcm_at_the_model_rate(self):
        import subprocess
        import numpy as np
        src = binaries.repo_root() / ".data" / "tmp" / "e03" / "speech.wav"
        if not src.exists():
            self.skipTest("e03 media corpus is not present")
        cmd = asr.pcm_command(str(src), start_s=0.0, duration_s=2.0)
        cmd[0] = _ffmpeg()
        done = processes.run_captured(cmd, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr[-300:])
        samples = np.frombuffer(done.stdout, dtype="<i2")
        self.assertAlmostEqual(len(samples) / asr.PCM_RATE_HZ, 2.0, delta=0.15)

    def test_missing_ffmpeg_and_missing_helper_report_what_actually_exists(self):
        import types
        stub = types.SimpleNamespace(audio=types.SimpleNamespace(
            **{n: None for n in ("av", "np") if False}))
        real_path_for, real_import = binaries.path_for, whisper_ct2.import_backend
        binaries.path_for = lambda name: ""
        whisper_ct2.import_backend = lambda: stub
        try:
            with self.assertRaises(whisper_ct2.BackendUnavailable) as got:
                whisper_ct2._audio_array("x.wav", 5.0)
        finally:
            binaries.path_for, whisper_ct2.import_backend = real_path_for, real_import
        self.assertEqual(got.exception.kind, "decode_failed")
        self.assertIn("faster_whisper.audio.decode_audio", got.exception.detail)
        self.assertIn("audio module exports", got.exception.detail,
                      "the error must name what the installed module actually exports")


class SpawnIsolatesThePipesWeOwn(unittest.TestCase):
    """A tool we start must never be handed the pipes this process talks on.

    Reproduced on this host before the fix: inside a `speech.asr` worker the loudness
    pass started by ffmpeg never exited while the worker's request pipe stayed open,
    so the job burned its entire 120s deadline and answered `deadline_exceeded` with
    the model never even loaded (measured: 125.3s, worker CPU 0.06s). The grandchild
    had inherited the worker's stdin handle and was reading the owner's channel.
    """

    def test_spawn_kwargs_close_off_stdin_and_hide_the_console(self):
        kwargs = processes.spawn_kwargs()
        self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
        if os.name == "nt":
            self.assertEqual(kwargs.get("creationflags"), 0x08000000,
                             "CREATE_NO_WINDOW: a console tool must not grab the console")

    def test_ffmpeg_commands_disable_stdin_before_their_first_input(self):
        for cmd in (levels.level_command("in.wav"), asr.pcm_command("in.mp4", start_s=1.0)):
            self.assertIn("-nostdin", cmd, cmd)
            self.assertLess(cmd.index("-nostdin"), cmd.index("-i"),
                            "-nostdin only counts before the first input: %r" % (cmd,))

    def test_a_grandchild_does_not_block_on_an_open_inherited_stdin(self):
        src = binaries.repo_root() / ".data" / "tmp" / "e03" / "silence.wav"
        if not src.exists():
            self.skipTest("e03 media corpus is not present")
        # The child gets a stdin PIPE that stays open and never receives data: exactly
        # the shape of a worker's control channel. With the defect the loudness pass
        # times out (state `unknown`); with the fix it measures the silence.
        child = (
            "import sys, time;"
            "sys.path.insert(0, sys.argv[1]);"
            "from ruke_ml.speech import levels;"
            "t = time.time();"
            "g = levels.measure_level(sys.argv[2], duration_s=5.0, timeout_s=8.0);"
            "print('%s|%.1f|%s' % (g.audio_level_state, time.time() - t, g.error))"
        )
        proc = subprocess.Popen([sys.executable, "-c", child,
                                 str(binaries.repo_root() / "python-backend"), str(src)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                text=True, encoding="utf-8")
        try:
            out, _err = proc.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            proc.kill()
            self.fail("the grandchild held the open stdin pipe open past 90s")
        state, seconds, error = out.strip().split("|")
        self.assertEqual(state, "silence", "loudness pass failed inside a piped child: %ss %s"
                         % (seconds, error))
        self.assertLess(float(seconds), 6.0,
                        "a pass that waited out its own 8s bound never decoded the track")


if __name__ == "__main__":
    unittest.main()
