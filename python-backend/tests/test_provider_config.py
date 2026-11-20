"""One provider configuration: chat and lifecycle resolve through the SAME chain.

Amendment 8 section B. The defect this locks down is not a missing default - it is two
resolvers over one setting: chat used settings.json first while the Python lifecycle
resolver read the environment and .env.local first, so a deployment whose settings.json
named server A could have its handoff unload server B. These tests pin the order, the
derivation of the lifecycle URLs from the chat origin, and the honest source attribution.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ruke_ml.models import main_model, provider_config
from ruke_ml.documents import ocr_cascade


CHAT = "http://127.0.0.1:9099/v1/chat/completions"


class Precedence(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        provider_config._SETTINGS_CACHE.update({"mtime": None, "data": {}})
        provider_config._DOTENV_CACHE.update({"mtime": None, "data": {}})
        self.tmp.cleanup()

    def _settings(self, value: dict) -> None:
        (self.root / "settings.json").write_text(json.dumps(value), encoding="utf-8")

    def _dotenv(self, text: str) -> None:
        (self.root / ".env.local").write_text(text, encoding="utf-8")

    def load(self, environ: dict[str, str] | None = None):
        return provider_config.load(root=self.root, environ=environ or {})

    def test_settings_json_beats_environment_and_dotenv(self) -> None:
        self._settings({"llm_api_url": CHAT, "llm_api_key": "from-settings"})
        self._dotenv("LLM_API_URL=http://dotenv-host:1/v1/chat/completions\n")
        cfg = self.load({"LLM_API_URL": "http://env-host:1/v1/chat/completions"})
        self.assertEqual(cfg.chat_url, CHAT)
        self.assertEqual(cfg.api_key, "from-settings")
        self.assertEqual(cfg.sources["chat_url"], "settings.json(llm_api_url)")
        # The lifecycle is anchored to THAT origin, not to the env/dotenv origin.
        self.assertEqual(cfg.control_origin, "http://127.0.0.1:9099")
        self.assertEqual(cfg.unload_url, "http://127.0.0.1:9099/unload")
        self.assertEqual(cfg.load_url, "http://127.0.0.1:9099/load")

    def test_environment_beats_dotenv_and_both_point_lifecycle_at_the_same_origin(self) -> None:
        self._dotenv("LLM_API_URL=http://dotenv-host:7/v1/chat/completions\n")
        cfg = self.load({"LLM_API_URL": CHAT})
        self.assertEqual(cfg.chat_url, CHAT)
        self.assertEqual(cfg.sources["chat_url"], "env(LLM_API_URL)")
        self.assertEqual(cfg.control_origin, "http://127.0.0.1:9099")
        self.assertEqual(cfg.unload_url, "http://127.0.0.1:9099/unload")

    def test_dotenv_is_a_real_layer_and_not_only_an_env_substitute(self) -> None:
        self._dotenv("# comment\nexport LLM_API_URL=\"http://localhost:8080/v1/chat/completions\"\n"
                     "LLM_API_KEY='secret-from-file'\n")
        cfg = self.load({})
        self.assertEqual(cfg.chat_url, "http://localhost:8080/v1/chat/completions")
        self.assertEqual(cfg.api_key, "secret-from-file")
        self.assertEqual(cfg.sources["chat_url"], "dotenv(LLM_API_URL)")
        self.assertEqual(cfg.sources["api_key"], "dotenv(LLM_API_KEY)")
        self.assertEqual(cfg.control_origin, "http://localhost:8080")

    def test_nothing_configured_falls_back_without_a_personal_absolute_path(self) -> None:
        cfg = self.load({})
        self.assertEqual(cfg.chat_url, provider_config.CHAT_URL_FALLBACK)
        self.assertEqual(cfg.api_key, provider_config.API_KEY_FALLBACK)
        self.assertEqual(cfg.control_origin, "http://127.0.0.1:8080")
        self.assertTrue(cfg.sources["chat_url"].startswith("default"))

    def test_a_corrupt_settings_file_does_not_become_an_empty_config(self) -> None:
        self._settings({"llm_api_url": CHAT})
        self.assertEqual(self.load({}).chat_url, CHAT)
        (self.root / "settings.json").write_text("{ not json", encoding="utf-8")
        provider_config._SETTINGS_CACHE["mtime"] = None  # force a re-stat like a new process
        cfg = self.load({})
        self.assertEqual(cfg.chat_url, CHAT, "a corrupt rewrite must keep the last good parse")


class LifecycleDerivation(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        provider_config._SETTINGS_CACHE.update({"mtime": None, "data": {}})
        provider_config._DOTENV_CACHE.update({"mtime": None, "data": {}})
        self.tmp.cleanup()

    def test_an_explicit_url_prefix_survives(self) -> None:
        (self.root / "settings.json").write_text(
            json.dumps({"llm_api_url": "https://gw.example.com/tenant/v1/chat/completions"}),
            encoding="utf-8")
        cfg = provider_config.load(root=self.root, environ={})
        self.assertEqual(cfg.api_prefix, "/tenant/v1")
        self.assertEqual(cfg.chat_url, "https://gw.example.com/tenant/v1/chat/completions")
        self.assertEqual(cfg.unload_url, "https://gw.example.com/unload")
        self.assertEqual(cfg.control_origin, "https://gw.example.com")

    def test_an_operator_may_pin_the_control_origin_but_not_the_chat_origin(self) -> None:
        (self.root / "settings.json").write_text(json.dumps({"llm_api_url": CHAT}), encoding="utf-8")
        cfg = provider_config.load(root=self.root, environ={"RUKE_LLM_ENDPOINT": "http://127.0.0.1:8080/"})
        self.assertEqual(cfg.control_origin, "http://127.0.0.1:8080")
        self.assertEqual(cfg.chat_url, CHAT)
        self.assertEqual(cfg.sources["control_origin"], "env(RUKE_LLM_ENDPOINT)")
        self.assertFalse(cfg.lifecycle_explicit)

    def test_explicit_lifecycle_urls_win_and_are_reported_as_explicit(self) -> None:
        cfg = provider_config.load(root=self.root, environ={
            "LLM_API_URL": CHAT,
            "LLM_UNLOAD_URL": "http://127.0.0.1:8080/v1/unload",
            "LLM_RELOAD_URL": "http://127.0.0.1:8080/v1/load",
        })
        self.assertEqual(cfg.unload_url, "http://127.0.0.1:8080/v1/unload")
        self.assertEqual(cfg.load_url, "http://127.0.0.1:8080/v1/load")
        self.assertTrue(cfg.lifecycle_explicit)

    def test_the_api_key_is_never_serialised_into_a_report(self) -> None:
        cfg = provider_config.load(root=self.root, environ={"LLM_API_URL": CHAT,
                                                            "LLM_API_KEY": "super-secret"})
        blob = json.dumps(cfg.as_dict())
        self.assertNotIn("super-secret", blob)
        self.assertEqual(cfg.as_dict()["api_key"], "<redacted>")
        self.assertTrue(cfg.as_dict()["api_key_set"])


class LifecycleBasePreservesItsPrefix(unittest.TestCase):
    """Amendment 11 section 21.1: RUKE_LIFECYCLE_BASE names one base, prefix intact.

    The default must NOT change: this deployment serves POST /unload and POST /load at the
    root, measured live (F32 freed 51,079 MiB RAM and 9,483 MiB VRAM at 127.0.0.1:8080), so
    blindly appending the chat API prefix would break the working server. What the old code
    lacked was a way to name a prefixed base at all - a gateway that mounts lifecycle under
    /tenant/v1 had no option except two hand-written absolute URLs.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        provider_config._SETTINGS_CACHE.update({"mtime": None, "data": {}})
        provider_config._DOTENV_CACHE.update({"mtime": None, "data": {}})
        self.tmp.cleanup()

    def test_a_prefixed_base_keeps_its_prefix_for_both_paths(self) -> None:
        cfg = provider_config.load(root=self.root, environ={
            "LLM_API_URL": "https://gw.example.com/tenant/v1/chat/completions",
            "RUKE_LIFECYCLE_BASE": "https://gw.example.com/tenant/v1/",
        })
        self.assertEqual(cfg.lifecycle_base, "https://gw.example.com/tenant/v1")
        self.assertEqual(cfg.unload_url, "https://gw.example.com/tenant/v1/unload")
        self.assertEqual(cfg.load_url, "https://gw.example.com/tenant/v1/load")
        self.assertFalse(cfg.lifecycle_explicit, "a base is still a derivation, not an explicit URL")

    def test_the_default_stays_root_anchored_and_says_why(self) -> None:
        cfg = provider_config.load(root=self.root, environ={
            "LLM_API_URL": "https://gw.example.com/tenant/v1/chat/completions"})
        self.assertEqual(cfg.lifecycle_base, "")
        self.assertEqual(cfg.unload_url, "https://gw.example.com/unload")
        self.assertIn("root-mounted", cfg.sources["lifecycle_base"])

    def test_an_explicit_url_still_wins_verbatim_over_the_base(self) -> None:
        cfg = provider_config.load(root=self.root, environ={
            "LLM_API_URL": CHAT,
            "RUKE_LIFECYCLE_BASE": "http://127.0.0.1:8080/v1",
            "LLM_UNLOAD_URL": "http://127.0.0.1:8080/admin/unload",
        })
        self.assertEqual(cfg.unload_url, "http://127.0.0.1:8080/admin/unload")
        self.assertEqual(cfg.load_url, "http://127.0.0.1:8080/v1/load")
        self.assertTrue(cfg.lifecycle_explicit)

    def test_both_urls_report_the_same_base_so_the_pair_cannot_drift(self) -> None:
        cfg = provider_config.load(root=self.root, environ={
            "LLM_API_URL": CHAT, "RUKE_LIFECYCLE_BASE": "http://127.0.0.1:8080/v1"})
        self.assertEqual(cfg.sources["unload_url"], "derived(env(RUKE_LIFECYCLE_BASE))")
        self.assertEqual(cfg.sources["load_url"], "derived(env(RUKE_LIFECYCLE_BASE))")
        self.assertEqual(cfg.sources["lifecycle_base"], "env(RUKE_LIFECYCLE_BASE)")
        blob = json.dumps(cfg.as_dict())
        self.assertEqual(blob.count("http://127.0.0.1:8080/v1/unload"), 1)
        self.assertEqual(blob.count("http://127.0.0.1:8080/v1/load"), 1)


class HandoffPolicyIsConfiguredNotFlagged(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        provider_config._SETTINGS_CACHE.update({"mtime": None, "data": {}})
        provider_config._DOTENV_CACHE.update({"mtime": None, "data": {}})
        self.tmp.cleanup()

    def test_it_defaults_to_on_for_a_configured_deployment(self) -> None:
        (self.root / ".env.local").write_text(f"LLM_API_URL={CHAT}\n", encoding="utf-8")
        self.assertTrue(provider_config.load(root=self.root, environ={}).automatic_handoff)

    def test_an_explicit_off_is_respected(self) -> None:
        for value in ("0", "false", "off", "no"):
            cfg = provider_config.load(root=self.root, environ={
                "LLM_API_URL": CHAT, "RUKE_LLM_AUTOMATIC_HANDOFF": value})
            self.assertFalse(cfg.automatic_handoff, value)

    def test_the_legacy_per_run_override_still_wins_over_the_default(self) -> None:
        off = provider_config.load(root=self.root, environ={"LLM_API_URL": CHAT,
                                                            "RUKE_OCR_ALLOW_UNLOAD": "0"})
        self.assertFalse(off.automatic_handoff)
        on = provider_config.load(root=self.root, environ={"LLM_API_URL": CHAT,
                                                           "RUKE_OCR_ALLOW_UNLOAD": "1"})
        self.assertTrue(on.automatic_handoff)

    def test_the_cascade_policy_reports_the_configured_source(self) -> None:
        import os
        saved = {k: os.environ.get(k) for k in
                 ("LLM_API_URL", "RUKE_OCR_ALLOW_UNLOAD", "RUKE_LLM_AUTOMATIC_HANDOFF",
                  "RUKE_LLM_ENDPOINT")}
        try:
            for key in saved:
                os.environ.pop(key, None)
            os.environ["RUKE_LLM_AUTOMATIC_HANDOFF"] = "0"
            pol = ocr_cascade.policy()
            self.assertFalse(pol["allow_unload"])
            self.assertIn("RUKE_LLM_AUTOMATIC_HANDOFF", pol["allow_unload_source"])
            self.assertIn("chat_url", pol["provider"])
            self.assertNotIn("api_key_value", json.dumps(pol))
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class MainModelFollowsTheOneResolver(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        provider_config._SETTINGS_CACHE.update({"mtime": None, "data": {}})
        provider_config._DOTENV_CACHE.update({"mtime": None, "data": {}})
        self.tmp.cleanup()

    def test_endpoint_is_the_chat_origin_not_a_second_guess(self) -> None:
        (self.root / "settings.json").write_text(json.dumps({"llm_api_url": CHAT}), encoding="utf-8")
        real_load = provider_config.load

        def patched(root=None, environ=None):
            return real_load(root=self.root, environ=environ if environ is not None else {})

        original = provider_config.load
        provider_config.load = patched
        try:
            self.assertEqual(main_model.endpoint(), "http://127.0.0.1:9099")
            provider = main_model.provider_for("", probe=False)
            self.assertEqual(provider.base_url, "http://127.0.0.1:9099")
        finally:
            provider_config.load = original

    def test_an_explicit_provider_hint_pins_the_adapter_only_for_the_configured_endpoint(self) -> None:
        original = provider_config.load

        def patched(root=None, environ=None):
            cfg = original(root=root, environ=environ)
            from dataclasses import replace
            return replace(cfg, provider_hint="ollama")

        provider_config.load = patched
        try:
            self.assertIsInstance(main_model.provider_for("", probe=True),
                                  main_model.OllamaProvider)
            # A caller with its OWN base url keeps a probed answer, never an inherited label.
            self.assertIsInstance(main_model.provider_for("http://127.0.0.1:1", probe=True),
                                  main_model.UnreachableProvider)
        finally:
            provider_config.load = original


class ResolverDoesNotContactTheEndpoint(unittest.TestCase):
    def test_resolution_never_opens_a_socket(self) -> None:
        import socket
        real = socket.socket

        class Exploding(real):
            def __init__(self, *a, **k):
                raise AssertionError("provider resolution must not contact the endpoint")

        socket.socket = Exploding
        try:
            provider_config.load(environ={"LLM_API_URL": "http://203.0.113.9:9/v1/chat/completions"})
        finally:
            socket.socket = real
