"""Binary resolution and the capability claims that hang off it (F13 honesty).

PATH-only probing reported a capability that really runs on this host as not_installed,
because the ffmpeg copy that exists is project-local (npm ffmpeg-static / the Playwright
download) rather than on PATH. So resolution must be provenance-aware AND validated:
an unusable override or a same-named stub must never flip a status on its own, and a
status may not leak the user's absolute host layout to the browser.
"""
from __future__ import annotations

import os
import sys
import shutil
import tempfile
import unittest
from pathlib import Path

from ruke_ml.models import binaries
from ruke_ml.models.registry import AVAILABLE, NOT_INSTALLED, catalog
from ruke_ml.video import scenes

WATCHED_ENV = ("RUKE_FFMPEG", "RUKE_REPO_ROOT", "PLAYWRIGHT_BROWSERS_PATH", "PATH")


class _Fixture(unittest.TestCase):
    """A validated ffmpeg copy placed inside a synthetic repo root.

    Skipped (never silently passed) when this host has no runnable ffmpeg at all: the
    claims under test would then be unverifiable rather than false.
    """

    skip_reason = "not initialised"

    @classmethod
    def setUpClass(cls):
        binaries.clear_cache()
        # Resolve from the REAL checkout first, then rebuild the same copy elsewhere so
        # the resolution logic is what is under test, not this repository's layout.
        src = binaries.path_for("ffmpeg")
        if not src:
            cls.skip_reason = "no validated ffmpeg binary exists in this checkout"
            return
        cls.tmp = Path(tempfile.mkdtemp(prefix="ruke-bin-"))
        cls.repo = cls.tmp / "repo"
        cls.inside = cls.repo / "node_modules" / "ffmpeg-static" / Path(src).name
        cls.inside.parent.mkdir(parents=True)
        shutil.copy2(src, cls.inside)
        cls.outside = cls.tmp / "elsewhere" / Path(src).name
        cls.outside.parent.mkdir(parents=True)
        shutil.copy2(src, cls.outside)
        cls.empty_bin = cls.tmp / "empty-bin"
        cls.empty_bin.mkdir()
        reason = binaries.validate(str(cls.inside), "ffmpeg")
        cls.skip_reason = reason or ""

    @classmethod
    def tearDownClass(cls):
        binaries.clear_cache()
        if getattr(cls, "tmp", None):
            shutil.rmtree(str(cls.tmp), ignore_errors=True)

    def setUp(self):
        if self.skip_reason:
            raise unittest.SkipTest(self.skip_reason)
        binaries.clear_cache()
        self.saved = {k: os.environ.get(k) for k in WATCHED_ENV}
        os.environ["RUKE_REPO_ROOT"] = str(self.repo)
        os.environ["PATH"] = str(self.empty_bin)      # proves PATH is not required
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = ""
        os.environ.pop("RUKE_FFMPEG", None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        binaries.clear_cache()


class Resolution(_Fixture):
    def test_project_local_copy_found_without_path(self):
        res = binaries.resolve("ffmpeg")
        self.assertTrue(res.found, res.detail)
        self.assertEqual(res.source, "project-local")
        self.assertEqual(Path(res.path), self.inside)
        self.assertIn("validated", res.detail)

    def test_explicit_override_is_preferred_and_recorded(self):
        os.environ["RUKE_FFMPEG"] = str(self.outside)
        res = binaries.resolve("ffmpeg")
        self.assertEqual(res.source, "env")
        self.assertEqual(Path(res.path), self.outside)

    def test_playwright_download_counts_as_project_local(self):
        pw = self.tmp / "pw-browsers"
        target = pw / "ffmpeg-1011" / "ffmpeg-win64.exe"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.inside, target)
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(pw)
        # remove the other project-local copy so THIS is the one that resolves
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp / "empty-repo")
        res = binaries.resolve("ffmpeg")
        self.assertTrue(res.found, res.detail)
        self.assertEqual(res.source, "project-local")
        self.assertEqual(Path(res.path).name, "ffmpeg-win64.exe")

    def test_unusable_override_is_named_and_never_reported_as_the_binary(self):
        junk = self.tmp / "notes.txt"
        junk.write_text("not a program", encoding="utf-8")
        os.environ["RUKE_FFMPEG"] = str(junk)
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp / "empty-repo")
        res = binaries.resolve("ffmpeg")
        self.assertFalse(res.found)
        self.assertEqual(res.path, "")
        self.assertIn("RUKE_FFMPEG", res.detail)
        self.assertIn("not usable", res.detail)

    def test_missing_override_path_is_reported_not_crashed(self):
        os.environ["RUKE_FFMPEG"] = str(self.tmp / "nope" / "ffmpeg.exe")
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp / "empty-repo")
        res = binaries.resolve("ffmpeg")
        self.assertFalse(res.found)
        self.assertIn("RUKE_FFMPEG", res.detail)

    def test_same_named_non_program_on_path_is_rejected(self):
        fake = self.empty_bin / "ffmpeg.exe"
        fake.write_bytes(b"this is not an executable image")
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp / "empty-repo")
        res = binaries.resolve("ffmpeg")
        self.assertFalse(res.found, "a stub named ffmpeg.exe must not make a claim available")
        self.assertIn("PATH candidate", res.detail)

    def test_a_path_like_name_is_refused(self):
        for bad in ("../ffmpeg", "C:\\Windows\\notepad.exe", "ffmpeg;calc", ""):
            res = binaries.resolve(bad)
            self.assertFalse(res.found, bad)
            self.assertIn("refused", res.detail)

    def test_probe_is_cached_until_the_override_changes_or_cache_is_cleared(self):
        first = binaries.resolve("ffmpeg")
        again = binaries.resolve("ffmpeg")
        self.assertEqual(first.path, again.path)
        os.environ["RUKE_FFMPEG"] = str(self.outside)
        self.assertEqual(Path(binaries.resolve("ffmpeg").path), self.outside,
                         "an override change must be re-probed, not served from cache")
        os.environ.pop("RUKE_FFMPEG", None)
        binaries.clear_cache()
        self.assertEqual(binaries.resolve("ffmpeg").source, "project-local")


class ProvenancePayload(_Fixture):
    def test_repo_local_binary_is_shown_relative_to_the_repo(self):
        d = binaries.resolve("ffmpeg").as_dict()
        self.assertTrue(d["found"])
        self.assertTrue(d["inside_repo"])
        self.assertEqual(d["path"], "node_modules/ffmpeg-static/" + self.inside.name)
        self.assertNotIn(str(self.repo), str(d))

    def test_binary_outside_the_repo_is_reduced_to_its_file_name(self):
        os.environ["RUKE_FFMPEG"] = str(self.outside)
        d = binaries.resolve("ffmpeg").as_dict()
        self.assertEqual(d["source"], "env")
        self.assertFalse(d["inside_repo"])
        self.assertEqual(d["path"], self.outside.name)
        self.assertNotIn(str(self.tmp), str(d), "the host directory layout must not be published")

    def test_registry_status_carries_the_provenance_that_made_it_available(self):
        st = catalog().status_for("video.timeline")
        self.assertEqual(st["status"], AVAILABLE, st["detail"])
        self.assertEqual(st["binary"]["source"], "project-local")
        self.assertTrue(st["binary"]["found"])
        self.assertIn("project-local", st["detail"])

    def test_registry_reports_not_installed_when_nothing_validates(self):
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp / "empty-repo")
        st = catalog().status_for("video.timeline")
        self.assertEqual(st["status"], NOT_INSTALLED)
        self.assertFalse(st["binary"]["found"])
        self.assertIn("ffmpeg", st["detail"])


class SceneCommand(_Fixture):
    def test_command_names_the_validated_copy_not_a_bare_hope(self):
        cmd = scenes.ffmpeg_scene_command("clip.mp4", 0.3)
        self.assertEqual(Path(cmd[0]), self.inside)

    def test_command_falls_back_to_the_token_when_no_copy_is_valid(self):
        os.environ["RUKE_REPO_ROOT"] = str(self.tmp / "empty-repo")
        self.assertEqual(scenes.ffmpeg_scene_command("clip.mp4", 0.3)[0], "ffmpeg")


class VersionProbeArgs(unittest.TestCase):
    """The probe flag is program-specific, and a failed flag is not a broken program.

    A single hard-coded `-version` made the project-local Tesseract 5.5.3 - which
    rejects that flag with exit 1 and only accepts `--version` - resolve to "", i.e. a
    real, working OCR engine was reported as not installed.
    """

    def setUp(self):
        binaries.clear_cache()

    def tearDown(self):
        binaries.clear_cache()

    def test_primary_flag_follows_the_program(self):
        self.assertEqual(binaries._probe_variants("ffmpeg")[0], ("-version",))
        self.assertEqual(binaries._probe_variants("ffprobe")[0], ("-version",))
        self.assertEqual(binaries._probe_variants("tesseract")[0], ("--version",))
        # every program gets a bounded set of alternatives before it is refused
        for name in ("ffmpeg", "tesseract", "some-other-tool"):
            self.assertEqual(len(binaries._probe_variants(name)), 2, name)

    def test_a_program_that_rejects_dash_version_still_validates(self):
        # CPython exits non-zero for `-version` and only accepts `--version`, which is
        # exactly the shape of the Tesseract failure; the fallback variant must rescue it.
        self.assertEqual(binaries.validate(sys.executable, "python"), "")

    def test_a_spoofed_copy_is_still_refused(self):
        spot = Path(tempfile.mkdtemp(prefix="ruke-ocr-stub-")) / "tesseract.exe"
        spot.write_bytes(b"this is not a PE image")
        try:
            reason = binaries.validate(str(spot), "tesseract")
        finally:
            shutil.rmtree(str(spot.parent), ignore_errors=True)
        self.assertTrue(reason, "a spoofed tesseract.exe must not satisfy the probe")
        self.assertIn("executed", reason)

    def test_the_project_local_ocr_copy_actually_resolves(self):
        if os.environ.get("RUKE_TESSERACT") or shutil.which("tesseract") is None:
            copies = [p for pat in binaries.PROJECT_LOCAL_PATTERNS["tesseract"]
                      for p in binaries.repo_root().glob(pat) if p.is_file()]
            if not copies:
                self.skipTest("no project-local tesseract copy in this checkout")
        res = binaries.resolve("tesseract")
        self.assertTrue(res.found, res.detail)
        self.assertIn("validated", res.detail)
        self.assertEqual(Path(res.path).name.lower(), "tesseract.exe")
        d = res.as_dict()
        self.assertTrue(d["found"])


if __name__ == "__main__":
    unittest.main()
