"""The READ side of scene detection: parse, offset, bounds, refusals, and a measured probe.

Before these tests existed, `ffmpeg_scene_command` was built and reported but NOTHING
parsed its output, and the command itself was wrong twice over against the pinned
ffmpeg (6.1.1): `-loglevel error` suppressed the very showinfo lines we parse, and
`-vsync v0` is rejected by that build. An unused helper plus an unparseable command is
exactly the "contract that looks implemented" failure mode, so the tests here drive the
real decoder and assert the declared schedule.
"""
from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ruke_ml.eval import temporal_probe
from ruke_ml.models import binaries
from ruke_ml.video import scenes

SHOWINFO = """
[Parsed_showinfo_1 @ 000001f8] n:   0 pts:      0 pts_time:   3.000000 ... best_eff_ts:30720 best_eff_pts_time:   3.000000
[Parsed_showinfo_1 @ 000001f8] n:   1 pts:  30720 pts_time:   6.000000 ... best_eff_ts:61440 best_eff_pts_time:   6.000000
"""
PROGRESS = ("frame=1 fps=0.0 q=-0.0 size=N/A time=00:00:03.00 bitrate=N/A\n"
            "out_time_us=3000000\nout_time_ms=3000000\nout_time=00:00:03.000000\n"
            "out_time_us=11900000\nout_time_ms=11900000\nout_time=00:00:11.900000\n")


class _FakePipe:
    def __init__(self, data: bytes) -> None:
        self._buf = io.BytesIO(data)

    def read(self, size: int = -1) -> bytes:
        return self._buf.read(size)

    def close(self) -> None:
        pass


class _FakePopen:
    """Stands in for Popen with exactly the surface scan_scene_cuts uses.

    `subprocess.run` mocks used to be enough. They stopped being enough the moment the
    scan needed LIVE pipes: the whole point of the rewrite is that both pipes drain
    continuously and progress is read while the child is still running.
    """

    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0,
                 wait_error: Exception | None = None) -> None:
        self.stdout = _FakePipe(stdout)
        self.stderr = _FakePipe(stderr)
        self.returncode = returncode
        self._wait_error = wait_error
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        if self._wait_error is not None:
            raise self._wait_error
        return self.returncode

    def kill(self) -> None:
        self.killed = True


def _fake_popen_factory(**kwargs):
    return lambda *a, **k: _FakePopen(**kwargs)


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
             mock.patch.object(scenes.subprocess, "Popen", side_effect=OSError("no such file")):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertEqual(scan.error, "spawn_failed")
        self.assertIn("no such file", scan.detail)

    def test_nonzero_exit_is_decode_failed_with_stderr_tail(self):
        fake = _fake_popen_factory(stderr=b"broken stream", returncode=1)
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertEqual(scan.error, "decode_failed")
        self.assertIn("broken stream", scan.detail)
        self.assertEqual(scan.cuts, [])

    def test_cuts_arrive_from_stderr_because_showinfo_logs_there(self):
        fake = _fake_popen_factory(stderr=SHOWINFO.encode(), stdout=b"")
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=10.0)
        self.assertEqual(scan.cuts, [3.0, 6.0])
        # No progress stream, no proven prefix. Cuts found is not the same claim as
        # "how much of the timeline the decoder reached".
        self.assertFalse(scan.prefix_measured)
        self.assertEqual(scan.scanned_seconds, 0.0)

    def test_timeout_reports_the_measured_prefix_not_the_clip_length(self):
        # The reproduced defect: a 120s source, a scan that decoded ~46s, and a scan
        # result that claimed 120s examined. Duration is not evidence of decode depth.
        exc = subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=0.01)
        fake = lambda *a, **k: _FakePopen(stderr=b"[Parsed_showinfo_1] pts_time:2.000000\n",
                                          stdout=b"out_time_us=46000000\n",
                                          wait_error=exc)
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=120.0, timeout_s=0.01,
                                          stream_start_offset=0.5)
        self.assertTrue(scan.truncated)
        self.assertEqual(scan.error, "timeout")
        self.assertEqual(scan.cuts, [2.5], "partial stamps keep the stream offset")
        self.assertEqual(scan.scanned_seconds, 46.0)
        self.assertTrue(scan.prefix_measured)
        self.assertIn("46.0s", scan.detail)

    def test_timeout_without_progress_reports_an_unknown_prefix(self):
        # Unmeasured must stay unknown. Guessing "half the clip" or "the whole clip"
        # is the same fabrication wearing a more conservative hat.
        exc = subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=0.01)
        fake = lambda *a, **k: _FakePopen(stderr=b"[Parsed_showinfo_1] pts_time:2.000000\n",
                                          stdout=b"", wait_error=exc)
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=120.0, timeout_s=0.01)
        self.assertEqual(scan.scanned_seconds, 0.0)
        self.assertFalse(scan.prefix_measured)
        self.assertTrue(scan.truncated)
        self.assertIn("unmeasured", scan.detail)

    def test_progress_is_decoder_depth_not_the_last_selected_cut(self):
        # Measured on the pinned build with the declared 12s clip: the select branch
        # freezes progress at the last selected frame (9.0s), while the all-frames null
        # branch reports 11.9s. Both numbers are real; only one describes the decoder.
        fake = _fake_popen_factory(stderr=SHOWINFO.encode(), stdout=PROGRESS.encode())
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=12.0)
        self.assertEqual(scan.cuts, [3.0, 6.0])
        self.assertEqual(scan.scanned_seconds, 11.9)
        self.assertTrue(scan.prefix_measured)
        self.assertGreater(scan.scanned_seconds, max(scan.cuts))

    def test_chatty_decoder_cannot_park_a_parent_on_one_pipe(self):
        # Both pipes are drained, so a huge stderr log neither deadlocks the scan nor
        # silently truncates the claim: the cap is reported as truncated.
        noisy = b"".join(b"pts_time:%f\n" % (i * 0.1) for i in range(1, 5)) + b"x" * (
            scenes.MAX_CUT_SCAN_CHARS + 10)
        fake = _fake_popen_factory(stderr=noisy, stdout=PROGRESS.encode())
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
            scan = scenes.scan_scene_cuts("clip.mp4", duration=40.0)
        self.assertTrue(scan.log_capped)
        self.assertTrue(scan.truncated)
        self.assertLessEqual(len(scan.cuts), 4)

    def test_cut_list_is_bounded_and_says_so(self):
        noisy = "\n".join("pts_time:%f" % (i * 0.1) for i in range(1, 401))
        fake = _fake_popen_factory(stderr=noisy.encode(), stdout=b"")
        with mock.patch.object(scenes, "path_for", return_value="ffmpeg"), \
             mock.patch.object(scenes.subprocess, "Popen", side_effect=fake):
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
        # Machine-readable progress, and the branch that makes it mean decode depth:
        # a muxed-output-only progress stream stops at the last SELECTED frame.
        self.assertIn("-progress", cmd)
        self.assertEqual(cmd[cmd.index("-progress") + 1], "pipe:1")
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("split=2", graph)
        self.assertIn("null[progress]", graph)
        self.assertIn("showinfo[cuts]", graph)
        self.assertEqual(cmd.count("-f"), 2, "one null sink per branch, so both are muxed")


class ProgressLaws(unittest.TestCase):
    def test_measured_prefix_end_only_trusts_a_measurement(self):
        self.assertEqual(scenes.measured_prefix_end(46.0, 120.0, measured=True), 46.0)
        self.assertEqual(scenes.measured_prefix_end(46.0, 120.0, measured=False), 0.0)
        self.assertEqual(scenes.measured_prefix_end(None, 120.0, measured=True), 0.0)
        self.assertEqual(scenes.measured_prefix_end(True, 120.0, measured=True), 0.0,
                         "bool is an int; True must not measure as one decoded second")
        self.assertEqual(scenes.measured_prefix_end(float("inf"), 120.0, measured=True), 0.0)
        self.assertEqual(scenes.measured_prefix_end("nonsense", 120.0, measured=True), 0.0)
        self.assertEqual(scenes.measured_prefix_end(float("nan"), 120.0, measured=True), 0.0)
        # Clamps at both ends: a decoder reporting past the container length, and one
        # reporting a negative prefix, are both bounded by what the source actually is.
        self.assertEqual(scenes.measured_prefix_end(200.0, 120.0, measured=True), 120.0)
        self.assertEqual(scenes.measured_prefix_end(-3.0, 120.0, measured=True), 0.0)
        self.assertEqual(scenes.measured_prefix_end(5.0, float("nan"), measured=True), 0.0)

    def test_decoder_progress_prefers_the_microsecond_field(self):
        self.assertEqual(scenes.parse_decoder_progress(PROGRESS), (11.9, 2))
        # An interrupted write can cut a `out_time_us=` line mid-token; the older
        # complete line is what may be claimed.
        self.assertEqual(scenes.parse_decoder_progress("out_time=00:01:30.500000\n"),
                         (90.5, 1))
        self.assertEqual(scenes.parse_decoder_progress("frame=1\n"), (0.0, 0),
                         "no progress line at all is UNMEASURED, not zero decoded")
        self.assertEqual(scenes.parse_decoder_progress("out_time_us=not-a-number\n"), (0.0, 0))


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
        self.assertIn("unmeasured amount", res.payload["note"])
        self.assertFalse(res.payload["cut_scan"]["prefix_measured"])

    def test_a_measured_truncated_prefix_is_reported_as_a_number(self):
        scan = scenes.CutScan(cuts=[3.0], scanned_seconds=17.5, prefix_measured=True,
                              truncated=True)
        res = self._run({"duration": 40.0, "source": "clip.mp4", "detect_cuts": True}, scan)
        self.assertIn("17.5s decoded of 40.0s", res.payload["note"])
        self.assertTrue(res.payload["cut_scan"]["prefix_measured"])
        self.assertEqual(res.payload["stages"]["decode_scan"]["measured_prefix_s"], 17.5)

    def test_a_plan_never_borrows_coverage_from_its_own_windows(self):
        # The reproduced defect: a duration-only request on a 120s source reported
        # "examined 46s" because the PLANNED windows were copied into Coverage.examined.
        res = self._run({"duration": 120.0, "max_windows": 4},
                        scenes.CutScan(error="ffmpeg_not_installed", detail="none"))
        self.assertEqual(res.coverage.examined, [])
        self.assertEqual([tuple(s) for s in res.coverage.skipped], [(0.0, 120.0)])
        self.assertFalse(res.coverage.complete)
        self.assertEqual(res.payload["stages"]["sampling_plan"]["claims_inspected_coverage"],
                         False)
        self.assertIn("Sampling plan only", res.coverage.note)
        self.assertNotIn("examined", res.coverage.note)

    def test_cut_anchors_are_points_and_say_their_window_is_a_suggestion(self):
        scan = scenes.CutScan(cuts=[3.0], scanned_seconds=12.0, prefix_measured=True)
        res = self._run({"duration": 12.0, "source": "clip.mp4", "detect_cuts": True}, scan)
        cuts = [a for a in res.payload["anchors"] if a["kind"] == "scene_cut"]
        self.assertTrue(cuts)
        self.assertIn("sampling suggestion", cuts[0]["reason"])
        self.assertIn("cut point at 3.000s", cuts[0]["reason"])

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
        # The invariant is about what the plan CLAIMS, not how many seconds it happened to
        # plan: a plan is never inspected coverage, whatever its arithmetic. (Test-law
        # change D-033: asserting coverage_is_partial here conflated a plan length with a
        # measurement, and the anchors()/budget rework legitimately plans ~12.0s of a 12.0s
        # clip at budget 12.)
        self.assertTrue(report["honesty"]["planning_is_never_inspection"])
        self.assertIn("does not establish inspected-content coverage",
                      report["honesty"]["note"])
        self.assertNotIn("examined", report["honesty"]["note"])
        self.assertAlmostEqual(report["honesty"]["planned_seconds"],
                               sum(w["end"] - w["start"] for w in report["windows"]), places=6)

    def test_a_tight_budget_plans_less_than_the_source(self):
        # Kept separate from the honesty invariant on purpose: this one IS a numeric claim,
        # so it gets an explicit budget instead of riding on the default.
        with tempfile.TemporaryDirectory(prefix="ruke-probe-") as td:
            report = temporal_probe.probe(td, budget=3)
        self.assertTrue(report["honesty"]["coverage_is_partial"],
                        "3 windows cannot plan the whole 12s clip")
        self.assertLess(report["honesty"]["planned_seconds"],
                        report["honesty"]["total_seconds"])
        self.assertFalse(report["honesty"]["claims_completeness"])

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


class MeasuredPrefixContractTests(unittest.TestCase):
    """The cross-language answer key for the decoded-prefix rule (brief 3-D).

    `rust-backend/fixtures/media/measured-prefix-v1.json` is the ONE table both sides
    bind to: the producer here (`measured_prefix_end`) and the consumer in
    `lib/server/attachindex/timeline.ts` (`measuredPrefixEnd`, driven by the same file
    from `__tests__/attach-timeline-f04.test.ts`). Change the rule on one side and the
    other side's suite fails, which is the point: the defect this pins was a truncated
    scan quietly claiming the clip length as inspected coverage.
    """

    FIXTURE = (Path(__file__).resolve().parents[2]
               / "rust-backend" / "fixtures" / "media" / "measured-prefix-v1.json")

    def test_shared_table_exists(self):
        self.assertTrue(self.FIXTURE.is_file(), f"missing shared contract fixture {self.FIXTURE}")

    def test_producer_matches_the_shared_table(self):
        data = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(data["$schema"], "ruke-measured-prefix/v1")
        self.assertGreaterEqual(len(data["cases"]), 10)
        for case in data["cases"]:
            with self.subTest(case["id"]):
                got = scenes.measured_prefix_end(case["value"], case["duration"],
                                                 measured=case["measured"])
                self.assertEqual(got, case["expected"])

    def test_contract_fields_are_documented(self):
        # The TS consumer treats an ABSENT prefix_measured as unknown, so the field
        # must be part of the published payload contract, not an implementation detail.
        data = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        for field in ("cut_scan.prefix_measured", "cut_scan.scanned_seconds", "cut_scan.truncated"):
            self.assertIn(field, data["contract_fields"])


if __name__ == "__main__":
    unittest.main()
