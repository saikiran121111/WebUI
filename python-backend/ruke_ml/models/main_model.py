"""The MAIN model's lifecycle, through its own provider API - provider-independently.

Amendment 5 (SPEC 17) allows a heavyweight job to ask the resident main model to step out
of RAM/VRAM, run, and then put it back. That is only safe if it happens through the
provider's own supported lifecycle calls, with the ORIGINAL state recorded first, and with
an honest "this provider cannot do that" answer when it cannot.

What is verified here (read from the running Strata install's own source, 2026-11-17):
  * `POST /unload` (also `/v1/unload`) answers `{"status": "unloaded"|"not loaded"|"busy"|
    "unsupported"}`; 409 while a turn is running, 503 if the engine gets stuck; it accepts
    `?wait=1` or `?wait=<seconds>` and waits up to its own bound (300 s) for the turn.
  * `POST /load` (also `/v1/load`) answers `{"status": "loaded"}`; 503 + `Retry-After` when
    the GPU is busy.
  * The control guard requires `Content-Type: application/json` and rejects a FOREIGN
    `Origin`; a client that sends no Origin at all is allowed. So these calls deliberately
    send JSON with no Origin header - and never a browser-style one.
  * BOTH `/load` and every generation request start the engine if it is unloaded. That is
    why unloading is only correct while the exclusive lease is held: any stray inference
    request - from Ruke's title generation or from a coding CLI - would silently bring the
    model back and make the fit calculation a lie.

Nothing in this module loads or unloads anything by itself, and nothing here pretends an
unsupported provider can be unloaded.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import provider_config

# Resolution order for the endpoint. The project's own .env.local already carries the
# Strata control URLs, so configuration stays inside the project rather than requiring a
# global environment change.
ENV_ENDPOINT = "RUKE_LLM_ENDPOINT"
ENV_UNLOAD_URL = "LLM_UNLOAD_URL"
ENV_API_URL = "LLM_API_URL"
DEFAULT_ENDPOINT = "http://127.0.0.1:8080"

DEFAULT_UNLOAD_WAIT_S = 60.0
DEFAULT_READY_TIMEOUT_S = 300.0
HTTP_TIMEOUT_S = 10.0


def endpoint() -> str:
    """The control endpoint origin, without ever contacting it.

    This is no longer an independent resolver: it is the control origin of the ONE provider
    configuration (settings.json > environment > .env.local > fallback), derived from the
    SAME URL the chat path uses. An earlier version resolved the lifecycle endpoint on its
    own from the environment first, which let a handoff unload one server while chat kept
    using another. `RUKE_LLM_ENDPOINT` remains an explicit operator override of the origin.
    """
    return provider_config.load().control_origin


def provider_config_snapshot() -> dict[str, Any]:
    """The resolved provider configuration, with each value's source and no secret leak."""
    return provider_config.load().as_dict()


@dataclass(slots=True)
class MainModelState:
    provider: str
    endpoint: str
    loaded: bool | None
    model: str = ""
    busy: bool | None = None
    queued: bool | None = None
    auto_load: bool | None = None
    detail: str = ""
    reachable: bool = False
    checked_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return {"provider": self.provider, "endpoint": self.endpoint, "loaded": self.loaded,
                "model": self.model or None, "busy": self.busy, "queued": self.queued,
                "auto_load": self.auto_load, "detail": self.detail, "reachable": self.reachable,
                "checked_at": self.checked_at}

    def resident(self) -> bool:
        """True only when the model was positively observed loaded."""
        return self.loaded is True


def _result(ok: bool, status: str, detail: str, http_status: int = 0,
            retry_after_s: int | None = None) -> dict[str, Any]:
    return {"ok": ok, "status": status, "detail": detail, "http_status": http_status,
            "retry_after_s": retry_after_s}


class MainModelProvider:
    """Provider-independent lifecycle surface. Subclasses map it onto a real server."""

    name = "unknown"

    def __init__(self, base_url: str = "", timeout_s: float = HTTP_TIMEOUT_S) -> None:
        self.base_url = (base_url or endpoint()).rstrip("/")
        self.timeout_s = timeout_s

    # ---- transport -------------------------------------------------------------
    def _request(self, method: str, path: str, *, body: Any = None,
                 timeout_s: float | None = None) -> tuple[int, dict[str, Any], str]:
        """Return (http_status, decoded_json_or_empty, raw_error).

        No Origin header is ever sent: Strata's control guard treats a browser Origin as a
        cross-site request and rejects it, while an Origin-less service client is allowed.
        A JSON body with an explicit content type is required by that same guard.
        """
        url = self.base_url + path
        data = None
        headers = {"Accept": "application/json"}
        if body is not None or method.upper() == "POST":
            data = json.dumps(body if body is not None else {}).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=timeout_s or self.timeout_s) as resp:
                raw = resp.read(65536).decode("utf-8", "replace")
                return resp.status, _jsonish(raw), ""
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read(65536).decode("utf-8", "replace")
            except Exception:                                    # noqa: BLE001
                pass
            retry = exc.headers.get("Retry-After") if exc.headers else None
            err = f"HTTP {exc.code}"
            if retry:
                err += f" Retry-After={retry}"
            return exc.code, _jsonish(raw), err
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return 0, {}, f"{type(exc).__name__}: {exc}"

    # ---- surface ---------------------------------------------------------------
    def supports_lifecycle(self) -> tuple[bool, str]:
        return False, f"{self.name}: no validated unload/load lifecycle is implemented"

    def inspect(self) -> MainModelState:
        raise NotImplementedError

    def unload(self, wait_s: float = DEFAULT_UNLOAD_WAIT_S) -> dict[str, Any]:
        ok, detail = self.supports_lifecycle()
        return _result(False, "provider_unsupported" if not ok else "failed", detail)

    def load(self) -> dict[str, Any]:
        ok, detail = self.supports_lifecycle()
        return _result(False, "provider_unsupported" if not ok else "failed", detail)

    def wait_ready(self, timeout_s: float = DEFAULT_READY_TIMEOUT_S) -> dict[str, Any]:
        ok, detail = self.supports_lifecycle()
        return _result(False, "provider_unsupported" if not ok else "failed", detail)


class StrataProvider(MainModelProvider):
    """Validated against the running Strata serve source on this host (2026-11-17)."""

    name = "strata"

    def inspect(self) -> MainModelState:
        status, payload, err = self._request("GET", "/health")
        if status == 0:
            # A control endpoint that does not answer /health is still not proof of
            # absence - Strata serves it; anything else is a different provider.
            status2, payload2, err2 = self._request("GET", "/v1/models")
            if status2 == 0:
                return MainModelState(self.name, self.base_url, None, reachable=False,
                                      detail=f"endpoint unreachable: {err or err2}")
            loaded = _loaded_from_models(payload2)
            return MainModelState(self.name, self.base_url, loaded, reachable=True,
                                  detail=f"/health absent ({err}); /v1/models status used")
        loaded = payload.get("loaded")
        return MainModelState(
            self.name, self.base_url,
            loaded if isinstance(loaded, bool) else None,
            model=str(payload.get("model") or ""),
            busy=payload.get("busy") if isinstance(payload.get("busy"), bool) else None,
            queued=payload.get("queued") if isinstance(payload.get("queued"), bool) else None,
            auto_load=payload.get("auto_load") if isinstance(payload.get("auto_load"), bool) else None,
            detail=str(payload.get("status") or ""), reachable=True)

    def supports_lifecycle(self) -> tuple[bool, str]:
        # The endpoints exist and are validated by inspect()/unload(); a server that answers
        # 404 for them reports "unsupported" through the typed status instead.
        return True, "Strata serves POST /unload and POST /load (verified in serve/server.py)"

    def unload(self, wait_s: float = DEFAULT_UNLOAD_WAIT_S) -> dict[str, Any]:
        """Ask the engine to drop its weights. Never force it past a running turn."""
        path = "/unload"
        if wait_s and wait_s > 0:
            path += f"?wait={int(wait_s)}"
        status, payload, err = self._request("POST", path, body={}, timeout_s=max(
            self.timeout_s, float(wait_s) + 15.0))
        if status in (404, 405):
            return _result(False, "unsupported", f"this server has no unload endpoint ({status})", status)
        if status == 409:
            return _result(False, "busy",
                           "a turn is running; unload refuses rather than evict mid-generation"
                           + (f" ({_msg(payload)})" if _msg(payload) else ""), status)
        if status == 503:
            return _result(False, "engine_stuck", _msg(payload) or err or "engine stuck", status)
        if status >= 400:
            return _result(False, "failed", _msg(payload) or err or f"HTTP {status}", status)
        reported = str(payload.get("status") or "").strip().lower()
        if reported in ("unloaded", "not loaded"):
            return _result(True, reported or "unloaded",
                           f"engine reported {reported!r}", status)
        if reported == "busy":
            return _result(False, "busy", "engine refused while busy", status)
        if reported == "unsupported":
            return _result(False, "unsupported", "engine says unloading is unsupported", status)
        return _result(True, reported or "unloaded",
                       f"engine answered {payload!r}" if payload else "engine answered ok", status)

    def load(self) -> dict[str, Any]:
        status, payload, err = self._request("POST", "/load", body={},
                                             timeout_s=max(self.timeout_s, 20.0))
        if status in (404, 405):
            return _result(False, "unsupported", f"this server has no load endpoint ({status})", status)
        if status == 503:
            retry = payload.get("retry_after")
            return _result(False, "gpu_busy", _msg(payload) or err or "GPU busy", status,
                           int(retry) if isinstance(retry, (int, float)) else None)
        if status >= 400:
            return _result(False, "failed", _msg(payload) or err or f"HTTP {status}", status)
        reported = str(payload.get("status") or "").strip().lower()
        return _result(True, reported or "loaded", f"engine answered {reported or 'ok'}", status)

    def wait_ready(self, timeout_s: float = DEFAULT_READY_TIMEOUT_S) -> dict[str, Any]:
        """Poll the provider's own readiness answer until the model is loaded again."""
        deadline = time.time() + max(1.0, float(timeout_s))
        last = ""
        while time.time() < deadline:
            state = self.inspect()
            if state.reachable and state.loaded is True:
                return _result(True, "loaded", f"{state.model or 'model'} loaded and ready",
                               200)
            last = state.detail or "not loaded yet"
            time.sleep(1.0)
        return _result(False, "timeout", f"main model was not ready within {int(timeout_s)} s ({last})")


class OllamaProvider(MainModelProvider):
    """Detected, honestly not implemented: its unload semantics differ per deployment."""

    name = "ollama"

    def inspect(self) -> MainModelState:
        status, payload, err = self._request("GET", "/api/tags")
        if status >= 400 or status == 0:
            return MainModelState(self.name, self.base_url, None, reachable=status != 0,
                                  detail=f"/api/tags: {err or 'HTTP ' + str(status)}")
        models = payload.get("models") if isinstance(payload.get("models"), list) else []
        loaded = bool(models)
        return MainModelState(self.name, self.base_url, loaded,
                              model=", ".join(str(m.get("name", "")) for m in models[:3]),
                              detail=f"{len(models)} model(s) listed; residency is not reported "
                                     "by /api/tags", reachable=True)

    def supports_lifecycle(self) -> tuple[bool, str]:
        return False, ("ollama was detected but no unload/load adapter has been validated on "
                       "this host; its keep-alive semantics depend on the deployment mode, so "
                       "this run reports the limitation instead of pretending unloading worked")


class LlamaCppServerProvider(MainModelProvider):
    """Detected, honestly not implemented - its /props shape is a different contract."""

    name = "llama.cpp-server"

    def inspect(self) -> MainModelState:
        status, payload, err = self._request("GET", "/props")
        if status >= 400 or status == 0:
            return MainModelState(self.name, self.base_url, None, reachable=status != 0,
                                  detail=f"/props: {err or 'HTTP ' + str(status)}")
        return MainModelState(self.name, self.base_url, None,
                              model=str(payload.get("model_alias") or payload.get("model_role") or ""),
                              detail="llama.cpp server answered /props; loaded/busy is not a "
                                     "field this adapter has validated", reachable=True)

    def supports_lifecycle(self) -> tuple[bool, str]:
        return False, ("a llama.cpp-style server was detected but no unload/load adapter has "
                       "been validated on this host; reporting the limitation rather than "
                       "issuing unvalidated control calls")


class UnreachableProvider(MainModelProvider):
    name = "unreachable"

    def inspect(self) -> MainModelState:
        return MainModelState(self.name, self.base_url, None, reachable=False,
                              detail="no main-model control endpoint answered")


def provider_for(base_url: str = "", *, probe: bool = True) -> MainModelProvider:
    """Pick the adapter by the server's own answers, not by a config string.

    Strata answers `/health` with a `loaded` field; Ollama answers `/api/tags`; a
    llama.cpp-style server answers `/props`. Anything else stays "unreachable" so a caller
    cannot accidentally believe it arranged a handoff against nothing.

    An explicit `RUKE_LLM_PROVIDER` pins the adapter, but only for the configuration-derived
    endpoint: a caller that passes its own base URL (a test server, a second deployment) still
    gets a probed answer rather than an inherited label.
    """
    cfg = provider_config.load()
    base = (base_url or cfg.control_origin).rstrip("/")
    if not probe:
        return StrataProvider(base)
    if not base_url:
        adapter = _PROVIDER_HINTS.get((cfg.provider_hint or "").strip().lower())
        if adapter is not None:
            return adapter(base)
    probe_client = MainModelProvider(base)
    status, payload, _err = probe_client._request("GET", "/health")  # noqa: SLF001 - shared transport
    if status == 200 and "loaded" in payload:
        return StrataProvider(base)
    status2, payload2, _ = probe_client._request("GET", "/api/tags")  # noqa: SLF001
    if status2 == 200 and "models" in payload2:
        return OllamaProvider(base)
    status3, payload3, _ = probe_client._request("GET", "/props")     # noqa: SLF001
    if status3 == 200 and payload3:
        # Strata also serves /props; prefer it only when the health shape did not match.
        return (StrataProvider(base) if "unload" in str(payload3).lower()
                else LlamaCppServerProvider(base))
    if status != 0:
        return StrataProvider(base)
    return UnreachableProvider(base)


_PROVIDER_HINTS = {
    "strata": StrataProvider,
    "ollama": OllamaProvider,
    "llama.cpp-server": LlamaCppServerProvider,
    "llama.cpp": LlamaCppServerProvider,
    "llamacpp": LlamaCppServerProvider,
}


def _jsonish(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {"value": value}


def _loaded_from_models(payload: dict[str, Any]) -> bool | None:
    status = payload.get("status")
    if isinstance(status, dict):
        value = str(status.get("value", "")).lower()
        if value:
            return value == "loaded"
    if isinstance(status, str) and status:
        return status.lower() == "loaded"
    return None


def _msg(payload: dict[str, Any]) -> str:
    for key in ("error", "detail", "message", "status"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            inner = value.get("message") or value.get("detail")
            if isinstance(inner, str) and inner:
                return inner
    return ""


def snapshot(base_url: str = "") -> dict[str, Any]:
    """The ORIGINAL state a handoff must be able to restore to. Recorded BEFORE any unload.

    `loaded` is the decisive field: a model that was never loaded must never be loaded by
    the recovery path, and a model that WAS loaded must be back before the lease is released.
    """
    prov = provider_for(base_url)
    state = prov.inspect()
    can, why = prov.supports_lifecycle()
    return {"provider": prov.name, "endpoint": prov.base_url, **state.as_dict(),
            "lifecycle_supported": can, "lifecycle_detail": why}
