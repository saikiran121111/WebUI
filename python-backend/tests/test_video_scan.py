"""The READ side of scene detection: parse, offset, bounds, refusals, and a measured probe.

Before these tests existed, `ffmpeg_scene_command` was built and reported but NOTHING
parsed its output, and the command itself was wrong twice over against the pinned
ffmpeg (6.1.1): `-loglevel error` suppressed the very showinfo lines we parse, and
`-vsync v0` is rejected by that build. An unused helper plus an unparseable command is
exactly the "contract that looks implemented" failure mode, so the tests here drive the
real decoder and assert the declared schedule.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from unittest import mock

from ruke_ml.eval import temporal_probe
from ruke_ml.models import binaries
from ruke_ml.video import scenes

SHOWINFO = """
[Parsed_showinfo_1 @ 000001f8] n:   0 pts:      0 pts_time:   3.000000 ... best_eff_ts:30720 best_eff_pts_time:   3.000000
[Parsed_showinfo_1 @ 000001f8] n:   1 pts:  30720 pts_time:   6.000000 ... best_eff_ts:61440 best_eff_pts_time:   6.000000
"""


class ParseLaw(unittest.TestCase):
    def test_best_eff_pts_time_is_not_counted_twice(self):
        self.assertEqual(scenes.parse_cut_timestamps(SHOWINFO), [3.0, 6.0])

    def test_only_best_eff_lines_yield_nothing(self):
        # A clip whose frames carry no real pts must not invent a cut at every frame.
        self.assertEqual(scenes.parse_cut_timestamps(
            "best_eff_pts_time:1.500000\nbest_eff_pts_time:1.600000\n"), [])

    def test_non_numeric_and_negative_stamps(self):
        self.assertEqual(scenes.parse_cut_timestamps("pts_time:N/A pts_time:null"), [])
        # A negative stamp is kept rather than clamped: clamping would fabricate a cut
        # at zero. The offset law, not the parser, owns timeline shifts.
        self.assertEqual(scenes.parse_cut_timestamps("pts_time:-0.04"), [-0.04])

    def test_repeat_stamps_collapse_but_a_real_second_occurrence_survives(self):
        self.assertEqual(scenes.parse_cut_timestamps("pts_time:2.0 pts_time:2.000000001"), [2.0])
        self.assertEqual(scenes.parse_cut_timestamps("pts_time:2.0 pts_time:2.5"), [2.0, 2.5])

    def test_offset_moves_stamps_onto_the_media_timeline(self):
        self.assertEqual(scenes.apply_stream_offset([0.0, 2.0], 1.5), [1.5, 3.5])
        self.assertEqual(scenes.apply_stream_offset([-0.2, 1.0], 0.05), [0.0, 1.05])
        same = [1.0, 2.0]
        out = scenes.apply_stream_offset(same, 0.0)
        self.assertEqual(out, same)
        self.assertIsNot(out, same, "a copy, so a caller cannot mutate a stored list")


class Refusals(unittest.TestCase):
    def test_missing_ffmpeg_is_a_typed_refusal_not_an_empty_scan(self):
        with mock.patch.object(scenes, "path_for", return_value=""):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertFalse(scan.ok)
        self.assertEqual(scan.error, "ffmpeg_not_installed")
        self.assertEqual(scan.cuts, [])

    def test_spawn_failure_is_reported_not_swallowed(self):
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "run", side_effect=OSError("no such file")):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertEqual(scan.error, "spawn_failed")
        self.assertIn("no such file", scan.detail)

    def test_nonzero_exit_is_decode_failed_with_stderr_tail(self):
        done = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="broken stream")
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "run", return_value=done):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertEqual(scan.error, "decode_failed")
        self.assertIn("broken stream", scan.detail)
        self.assertEqual(scan.cuts, [])

    def test_cuts_arrive_from_stderr_because_showinfo_logs_there(self):
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=SHOWINFO)
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "run", return_value=done):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertEqual(scan.cuts, [3.0, 6.0])

    def test_timeout_keeps_partial_work_and_says_it_was_truncated(self):
        # 3.12 spells the partial pipes `output` (aliased to `stdout`) and `stderr`;
        # the scan reads whichever pipe the decoder actually wrote to.
        exc = subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=0.01,
                                        stderr="[Parsed_showinfo_1] pts_time:2.000000")
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "run", side_effect=exc):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0, timeout_s=0.01,
                                          stream_start_offset=0.5)
        self.assertTrue(scan.truncated)
        self.assertEqual(scan.error, "timeout")
        self.assertEqual(scan.cuts, [2.5], "partial stamps keep the stream offset")

    def test_cut_list_is_bounded_and_says_so(self):
        noisy = "\n".join("pts_time:%f" % (i * 0.1) for i in range(1, 401))
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=noisy)
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "run", return_value=done):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=40.0, max_cuts=100)
        self.assertEqual(len(scan.cuts), 100)
        self.assertTrue(scan.truncated)

    def test_the_command_we_build_is_the_command_the_registry_claims(self):
        cmd = scenes.ffmpeg_scene_command("clip.mp4", 0.3)
        # Pinned-build facts, measured on this machine: showinfo needs an INFO loglevel
        # and the modern spelling of the frame-mode option.
        self.assertEqual(cmd[cmd.index("-loglevel") + 1], "info")
        self.assertIn("-fps_mode", cmd)
        self.assertNotIn("-vsync", cmd)
        self.assertNotIn("error", cmd, "an error loglevel hides the lines we parse")


class RunnerWiring(unittest.TestCase):
    """The job boundary must surface what the scan actually saw, not a tidy plan."""

    def _request(self, payload):
        from ruke_ml.contracts import JobRequest
        return JobRequest(request_id="r1", run_id="run1", job_id="j1",
                          capability="video.scenes", payload=payload)

    def _run(self, payload, scan):
        from ruke_ml.workers import runner
        with mock.patch.object(scenes, "scan_scene_cuts", return_value=scan), \
             mock.patch.object(runner, "_emit", lambda obj: None):
            return runner._do_video_scenes(self._request(payload))

    def test_detected_cuts_drive_the_windows_and_are_reported(self):
        scan = scenes.CutScan(cuts=[3.0, 6.0], scanned_seconds=12.0, truncated=False)
        res = self._run({"duration": 12.0, "source": "clip.mp4", "detect_cuts": True}, scan)
        self.assertEqual(res.state, "ready")
        self.assertEqual(res.payload["detected_cuts"], [3.0, 6.0])
        self.assertTrue(res.payload["cut_scan"]["ok"])
        self.assertTrue(any(a["kind"] == "scene_cut" for a in res.payload["anchors"]))

    def test_a_failed_scan_downgrades_the_note_instead_of_passing_fake_cuts(self):
        scan = scenes.CutScan(error="ffmpeg_not_installed", detail="no validated copy")
        res = self._run({"duration": 12.0, "source": "clip.mp4", "detect_cuts": True}, scan)
        self.assertEqual(res.payload["detected_cuts"], [])
        self.assertIn("ffmpeg_not_installed", res.payload["note"])
        self.assertIn("head/middle/tail", res.payload["note"])
        self.assertFalse(res.coverage.complete)

    def test_a_truncated_scan_says_the_later_timeline_is_unknown(self):
        scan = scenes.CutScan(cuts=[3.0], scanned_seconds=4.0, truncated=True)
        res = self._run({"duration": 40.0, "source": "clip.mp4", "detect_cuts": True}, scan)
        self.assertIn("later cuts are unknown", res.payload["note"])

    def test_no_detect_flag_means_no_spawn(self):
        from ruke_ml.workers import runner
        with mock.patch.object(scenes, "scan_scene_cuts",
                               side_effect=AssertionError("must not spawn")), \
             mock.patch.object(runner, "_emit", lambda obj: None):
            res = runner._do_video_scenes(self._request({"duration": 5.0, "cuts": [1.0]}))
        self.assertEqual(res.state, "ready")
        self.assertIsNone(res.payload["cut_scan"])


@unittest.skipUnless(binaries.path_for("ffmpeg"), "no validated ffmpeg copy on this host")
class MeasuredProbe(unittest.TestCase):
    """Real decoder, declared schedule. Synthetic on purpose: the truth is known exactly."""

    def test_detected_cuts_land_on_the_declared_schedule(self):
        with tempfile.TemporaryDirectory(prefix="ruke-probe-") as td:
            report = temporal_probe.probe(td)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["scan"]["truncated"], False)
        self.assertEqual(report["localisation"]["n_truth"], len(temporal_probe.TRUTH_CUTS))
        self.assertEqual(report["localisation"]["hit_rate"], 1.0)
        self.assertLessEqual(report["localisation"]["mean_abs_error_s"],
                             temporal_probe.SEG_TOLERANCE_S)
        self.assertEqual(report["window_coverage"]["hit_rate"], 1.0)
        self.assertEqual(report["scan"]["spurious_cut_count"], 0)
        self.assertFalse(report["honesty"]["claims_completeness"])
        self.assertTrue(report["honesty"]["coverage_is_partial"],
                        "a 12s clip with a bounded window budget is never fully examined")

    def test_a_threshold_that_sees_nothing_cannot_pass(self):
        # Hard negative control: an insensitive threshold finds no cuts, and that must
        # read as a miss with a stated denominator, never as "no events, so perfect".
        with tempfile.TemporaryDirectory(prefix="ruke-probe-") as td:
            report = temporal_probe.probe(td, threshold=0.99)
        self.assertFalse(report["ok"])
        self.assertEqual(report["localisation"]["n_truth"], len(temporal_probe.TRUTH_CUTS))
        self.assertEqual(report["localisation"]["hit_rate"], 0.0)

    def test_probe_refuses_loudly_without_a_decoder(self):
        with tempfile.TemporaryDirectory(prefix="ruke-probe-") as td:
            with mock.patch.object(temporal_probe, "path_for", return_value=""):
                got = temporal_probe.probe(td)
                self.assertFalse(got["ok"])
                self.assertEqual(got["clip"]["error"], "ffmpeg_not_installed")
                self.assertEqual(temporal_probe.main(["--dir", td]), 3,
                                 "a blocked probe reports a blocked exit, not a pass")

    def test_exit_code_matches_the_measurement(self):
        with tempfile.TemporaryDirectory(prefix="ruke-probe-") as td:
            self.assertEqual(temporal_probe.main(["--dir", td, "--threshold", "0.3"]), 0)
            self.assertEqual(temporal_probe.main(["--dir", td, "--threshold", "0.99"]), 1)


if __name__ == "__main__":
    unittest.main()
