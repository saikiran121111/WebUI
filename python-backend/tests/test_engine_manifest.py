"""engine/manifest.json is tracked bootstrap+version metadata and must never drift.

The B5 final decision (2026-11-22) keeps the engines in Ruke's lifecycle with
"tracked bootstrap+version metadata under engine/". A hand-maintained copy of
version pins rots silently, so the manifest is pinned EQUAL to the machine truth
it mirrors: ocr_runtime.PINNED, the registry's PARAKEET row and Paddle asset
revisions, and the installer URL the prepare-*.ps1 scripts actually fetch. Editing a
pin in code without editing the manifest (or vice versa) fails these tests.

Nothing here touches the network: the update-check wiring is verified by reading
scripts/dev-supervisor.mjs, and model revisions are pinned independently of library
versions, so a newer upstream release never satisfies a manifest revision check.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from ruke_ml.models import ocr_runtime, registry

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "engine" / "manifest.json"


def _manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


class ManifestTracksTheOcrPins(unittest.TestCase):
    def setUp(self):
        self.m = _manifest()
        self.paddle = self.m["engines"]["ocr_paddle"]

    def test_paddle_runtime_pins_equal_the_python_truth(self):
        self.assertEqual(self.paddle["runtime"]["pinned"], dict(ocr_runtime.PINNED),
                         "the manifest's OCR runtime pins must equal ocr_runtime.PINNED exactly")

    def test_the_paddle_index_is_the_gpu_cu126_index_with_the_cpu_index_as_fallback(self):
        # B9 (2026-11-22): GPU-first per the B5 final decision. The manifest must name the
        # index the preparer ACTUALLY fetches from: the CUDA 12.6 index first, the x64 CPU
        # index as the documented fallback for hosts that cannot take the CUDA wheel.
        self.assertEqual(self.paddle["runtime"]["index"],
                         "https://www.paddlepaddle.org.cn/packages/stable/cu126/")
        self.assertEqual(self.paddle["runtime"]["index_fallback"],
                         "https://www.paddlepaddle.org.cn/packages/stable/cpu/")
        self.assertEqual(self.paddle["runtime"]["manifest"], ocr_runtime.MANIFEST_REL)
        by_name = {c["package"]: c for c in self.paddle["update_channels"]}
        self.assertEqual(by_name["paddlepaddle-gpu"]["pinned"],
                         ocr_runtime.PINNED[ocr_runtime.PADDLE_PIN])
        self.assertEqual(by_name["paddlepaddle-gpu"]["index"], self.paddle["runtime"]["index"])

    def test_paddle_asset_revisions_equal_the_registry_constants(self):
        assets = {a["repo"]: a["revision"] for a in self.paddle["assets"]}
        self.assertEqual(assets, {registry.PADDLE_VL_REPO: registry.PADDLE_VL_REVISION,
                                  registry.PADDLE_LAYOUT_REPO: registry.PADDLE_LAYOUT_REVISION},
                         "model revisions are pinned independently; the manifest must name "
                         "exactly the revisions the registry demands")

    def test_tesseract_installer_pin_matches_the_bootstrap_script(self):
        tess = self.m["engines"]["ocr_tesseract"]["bootstrap"]
        script = (REPO_ROOT / "scripts" / "prepare-tesseract-runtime.ps1").read_text(encoding="utf-8")
        self.assertIn(tess["installer"]["url"], script,
                      "the manifest must name the installer the bootstrap actually downloads")
        self.assertIn(tess["installer"]["name"], script)
        self.assertIn(tess["language_data"]["url"], script)


class ManifestTracksTheAsrEngine(unittest.TestCase):
    def setUp(self):
        self.asr = _manifest()["engines"]["speech_asr"]
        self.row = next(r for r in registry.catalog().all_specs()
                        if r.capability == "speech.asr" and r.id == registry.PARAKEET_ID)

    def test_the_sole_engine_is_the_pinned_parakeet_checkpoint(self):
        self.assertEqual(self.asr["checkpoint"],
                         {"repo": registry.PARAKEET_ID, "revision": self.row.revision},
                         "the manifest checkpoint must equal the registry's frozen speech.asr row")
        self.assertEqual(self.asr["integration"], "python-backend/ruke_ml/speech/transformers_asr.py")
        self.assertEqual(self.asr["integration"].replace("python-backend/", "").replace("/", ".").removesuffix(".py"),
                         self.row.adapter,
                         "the manifest integration and the registry adapter are the same file")

    def test_measured_stack_matches_the_registry_runtime_claim(self):
        runtime_claim = self.row.claims["runtime"]
        stack = {k: v for k, v in self.asr["measured_stack"].items() if k != "basis"}
        self.assertEqual(set(stack), {"transformers", "torch"})
        for pkg, ver in stack.items():
            if pkg == "torch":
                ver = ver.split("+")[0]  # the claim names the base version beside the local tag
            self.assertIn(f"{pkg} {ver}", runtime_claim,
                          f"the manifest's measured {pkg} pin must be the version the registry "
                          "records as measured on this host")

    def test_the_stable_channels_name_the_pinned_versions(self):
        by_name = {c["package"]: c for c in self.asr["update_channels"]}
        self.assertEqual(by_name["transformers"]["pinned"], self.asr["measured_stack"]["transformers"])
        self.assertEqual(by_name["torch"]["pinned"],
                         self.asr["measured_stack"]["torch"].split("+")[0])


class ManifestWiringIsReal(unittest.TestCase):
    """Every path the manifest names exists, and the dev lifecycle actually spawns the check."""

    def test_every_named_bootstrap_path_exists(self):
        m = _manifest()
        named = [
            m["engines"]["speech_asr"]["integration"],
            m["engines"]["ocr_paddle"]["bootstrap"]["script"],
            m["engines"]["ocr_tesseract"]["bootstrap"]["script"],
            m["update_check"]["script"],
        ]
        for rel in named:
            self.assertTrue((REPO_ROOT / rel).is_file(), f"manifest names a missing file: {rel}")

    def test_the_dev_supervisor_spawns_the_report_only_check(self):
        m = _manifest()
        supervisor = (REPO_ROOT / "scripts" / "dev-supervisor.mjs").read_text(encoding="utf-8")
        self.assertIn(Path(m["update_check"]["script"]).name, supervisor,
                      "`npm run dev` must run the stable-channel check the manifest declares")
        self.assertIn("RUKE_ENGINE_UPDATES", supervisor,
                      "the check must be opt-outable without editing the supervisor")
        self.assertTrue(m["update_check"]["report"].startswith(".data/"),
                        "the report lives project-locally, never in the tracked tree")

    def test_vendor_slots_are_declared_optional_checkout_addresses(self):
        for slot in _manifest()["vendor"]["slots"]:
            self.assertTrue(slot["path"].startswith("engine/vendor/"),
                            "source checkouts live under engine/vendor/ only")
            self.assertTrue(slot["remote"].startswith("https://"))


if __name__ == "__main__":
    unittest.main()
