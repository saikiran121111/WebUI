"""ONE authoritative provider configuration, shared by chat and lifecycle calls.

Amendment 8 section B: the chat URL used to come from settings.json first (TypeScript and
Rust), while the Python lifecycle resolver read the environment and .env.local first. Two
resolvers over the same settings can therefore point at two different servers, and a handoff
would then unload one server while chat kept talking to another. This module is the single
Python resolver; the derived lifecycle URLs are anchored to the SAME origin as the chat URL
so they cannot drift apart.

Precedence, per key, highest first:
  1. settings.json          - what the user chose in the UI (llm_api_url / llm_api_key)
  2. the process environment - what the supervisor or an operator exported
  3. .env.local             - the project's own gitignored local overrides
  4. the built-in fallback   - the documented default, never a personal absolute path

RUKE_LLM_ENDPOINT stays a deliberate operator override of the CONTROL origin only, and
RUKE_OCR_ALLOW_UNLOAD stays an explicit per-run override of the handoff policy.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from ..config import repo_root

CHAT_URL_FALLBACK = "http://127.0.0.1:8080/v1/chat/completions"
API_KEY_FALLBACK = "no-key"

SETTINGS_CHAT_KEY = "llm_api_url"
SETTINGS_KEY_KEY = "llm_api_key"

ENV_CHAT_URL = "LLM_API_URL"
ENV_API_KEY = "LLM_API_KEY"
ENV_UNLOAD_URL = "LLM_UNLOAD_URL"
ENV_RELOAD_URL = "LLM_RELOAD_URL"
# Amendment 11 section 21.1: one base whose PATH PREFIX is preserved. The default stays
# anchored to the control origin, because that is what is proven live on this deployment
# (Strata serves POST /unload and POST /load at the root). But an origin-only derivation is
# the only option the old code offered, and it silently drops a prefix for a gateway that
# mounts the lifecycle endpoints under the same prefix as chat. This name pins the base
# verbatim: <base>/unload and <base>/load. An explicit LLM_UNLOAD_URL/LLM_RELOAD_URL still
# wins, verbatim, and is never rewritten.
ENV_LIFECYCLE_BASE = "RUKE_LIFECYCLE_BASE"
ENV_CONTROL_ORIGIN = "RUKE_LLM_ENDPOINT"
ENV_PROVIDER = "RUKE_LLM_PROVIDER"
ENV_MODEL = "RUKE_LLM_MODEL"
ENV_AUTOMATIC_HANDOFF = "RUKE_LLM_AUTOMATIC_HANDOFF"
ENV_LEGACY_ALLOW_UNLOAD = "RUKE_OCR_ALLOW_UNLOAD"

DEFAULT_CONTROL_ORIGIN = "http://127.0.0.1:8080"

_LOCK = threading.Lock()
_SETTINGS_CACHE: dict[str, Any] = {"mtime": None, "data": {}}
_DOTENV_CACHE: dict[str, Any] = {"mtime": None, "data": {}}


def _read_keyed_file(path: Path, cache: dict[str, Any],
                     parse: Callable[[str], dict[str, str]]) -> dict[str, str]:
    """mtime-gated read that keeps the last good parse when a file turns corrupt."""
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        cache["mtime"], cache["data"] = None, {}
        return {}
    if cache["mtime"] != mtime:
        try:
            cache["data"] = parse(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, ValueError):
            # Corrupt or unreadable: keep the previous parse, do NOT accept the mtime,
            # so the next call retries. Never invent an empty config for a real file.
            return dict(cache["data"])
        cache["mtime"] = mtime
    return dict(cache["data"])


def _parse_settings(text: str) -> dict[str, str]:
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("settings.json is not an object")
    out: dict[str, str] = {}
    for key in (SETTINGS_CHAT_KEY, SETTINGS_KEY_KEY):
        got = value.get(key)
        if isinstance(got, str) and got.strip():
            out[key] = got.strip()
    return out


def _parse_dotenv(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.lower().startswith("export "):
            line = line[len("export "):].strip()
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1].strip()
        if key and value:
            out[key] = value
    return out


def settings_file(root: Path | None = None) -> Path:
    return (root or repo_root()) / "settings.json"


def dotenv_file(root: Path | None = None) -> Path:
    return (root or repo_root()) / ".env.local"


def _settings_values(root: Path | None = None) -> dict[str, str]:
    return _read_keyed_file(settings_file(root), _SETTINGS_CACHE, _parse_settings)


def _dotenv_values(root: Path | None = None) -> dict[str, str]:
    return _read_keyed_file(dotenv_file(root), _DOTENV_CACHE, _parse_dotenv)


def resolve(*, env_names: tuple[str, ...], settings_key: str = "",
            root: Path | None = None,
            environ: Mapping[str, str] | None = None) -> tuple[str, str]:
    """Return (value, source_label) for one logical setting, honouring the precedence."""
    env = environ if environ is not None else os.environ
    if settings_key:
        got = _settings_values(root).get(settings_key, "")
        if got:
            return got, f"settings.json({settings_key})"
    for name in env_names:
        got = (env.get(name) or "").strip()
        if got:
            return got, f"env({name})"
    for name in env_names:
        got = _dotenv_values(root).get(name, "")
        if got:
            return got, f"dotenv({name})"
    return "", "unset"


def origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit((url or "").strip())
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return ""


def _bool(value: str, default: bool) -> bool:
    raw = (value or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


@dataclass(frozen=True)
class ProviderConfig:
    chat_url: str
    api_key: str
    control_origin: str
    unload_url: str
    load_url: str
    provider_hint: str
    model_id: str
    automatic_handoff: bool
    lifecycle_explicit: bool = False
    lifecycle_base: str = ""
    sources: dict[str, str] = field(default_factory=dict)

    @property
    def api_prefix(self) -> str:
        path = urllib.parse.urlsplit(self.chat_url).path or ""
        for suffix in ("/chat/completions", "/completions", "/responses"):
            if path.endswith(suffix):
                return path[: -len(suffix)].rstrip("/")
        return path.rstrip("/")

    def as_dict(self, *, redact_key: bool = True) -> dict[str, Any]:
        return {
            "chat_url": self.chat_url,
            "api_key_set": bool(self.api_key),
            "api_key": "<redacted>" if (redact_key and self.api_key) else self.api_key,
            "control_origin": self.control_origin,
            "api_prefix": self.api_prefix,
            "unload_url": self.unload_url,
            "load_url": self.load_url,
            "lifecycle_explicit": self.lifecycle_explicit,
            "lifecycle_base": self.lifecycle_base or None,
            "provider_hint": self.provider_hint or None,
            "model": self.model_id or None,
            "automatic_handoff": self.automatic_handoff,
            "config_source": dict(self.sources),
        }


def load(root: Path | None = None,
         environ: Mapping[str, str] | None = None) -> ProviderConfig:
    """Resolve the provider configuration. Never contacts the endpoint."""
    env = environ if environ is not None else os.environ
    sources: dict[str, str] = {}

    chat_url, chat_src = resolve(env_names=(ENV_CHAT_URL,),
                                 settings_key=SETTINGS_CHAT_KEY, root=root, environ=env)
    if not chat_url:
        chat_url, chat_src = CHAT_URL_FALLBACK, "default(LLM_API_URL fallback)"
    sources["chat_url"] = chat_src

    api_key, key_src = resolve(env_names=(ENV_API_KEY,),
                               settings_key=SETTINGS_KEY_KEY, root=root, environ=env)
    if not api_key:
        api_key, key_src = API_KEY_FALLBACK, "default(LLM_API_KEY fallback)"
    sources["api_key"] = key_src

    # The control origin follows the chat URL unless an operator pinned it deliberately.
    direct, direct_src = resolve(env_names=(ENV_CONTROL_ORIGIN,), root=root, environ=env)
    derived = origin_of(chat_url)
    if direct:
        control_origin, control_src = direct.rstrip("/"), direct_src
    elif derived:
        control_origin, control_src = derived, f"derived-from-chat-url({chat_src})"
    else:
        control_origin = origin_of(CHAT_URL_FALLBACK) or DEFAULT_CONTROL_ORIGIN
        control_src = "default(chat url had no absolute origin)"
    sources["control_origin"] = control_src

    # What the lifecycle paths are appended to. One resolution, used by both URLs, so the
    # pair can never be built from two different bases.
    lifecycle_base, lifecycle_base_src = resolve(env_names=(ENV_LIFECYCLE_BASE,),
                                                 root=root, environ=env)
    if lifecycle_base:
        lifecycle_base = lifecycle_base.rstrip("/")
        anchor, anchor_src = (lifecycle_base or control_origin), f"{lifecycle_base_src}"
    else:
        anchor, anchor_src = control_origin, control_src
    sources["lifecycle_base"] = (lifecycle_base_src if lifecycle_base
                                 else "unset(append to the control origin, which preserves the "
                                      "root-mounted lifecycle endpoints this deployment serves)")

    unload_url, unload_src = resolve(env_names=(ENV_UNLOAD_URL,), root=root, environ=env)
    lifecycle_explicit = bool(unload_url)
    if unload_url:
        sources["unload_url"] = unload_src
    else:
        unload_url, sources["unload_url"] = anchor + "/unload", f"derived({anchor_src})"

    load_url, load_src = resolve(env_names=(ENV_RELOAD_URL,), root=root, environ=env)
    lifecycle_explicit = lifecycle_explicit or bool(load_url)
    if load_url:
        sources["load_url"] = load_src
    else:
        load_url, sources["load_url"] = anchor + "/load", f"derived({anchor_src})"

    provider_hint, provider_src = resolve(env_names=(ENV_PROVIDER,), root=root, environ=env)
    if provider_hint:
        sources["provider"] = provider_src
    model_id, model_src = resolve(env_names=(ENV_MODEL,), root=root, environ=env)
    if model_id:
        sources["model_id"] = model_src

    handoff_raw, handoff_src = resolve(env_names=(ENV_AUTOMATIC_HANDOFF, ENV_LEGACY_ALLOW_UNLOAD),
                                       root=root, environ=env)
    automatic = _bool(handoff_raw, True) if handoff_raw else True
    sources["automatic_handoff"] = (handoff_src if handoff_raw
                                    else "default(true: unloading is allowed only when the job "
                                         "does not fit and the provider supports lifecycle calls)")

    return ProviderConfig(chat_url=chat_url, api_key=api_key, control_origin=control_origin,
                          unload_url=unload_url, load_url=load_url,
                          provider_hint=provider_hint, model_id=model_id,
                          automatic_handoff=automatic, lifecycle_explicit=lifecycle_explicit,
                          lifecycle_base=lifecycle_base,
                          sources=sources)
