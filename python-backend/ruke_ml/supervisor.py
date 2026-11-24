"""Persistent Python supervisor: loopback-only, stdlib-only, zero heavy imports at startup.

Startup contract (tested): no torch/paddle/transformers/docling/pyannote import, no model
download, no outbound network. Health and capability answers come from the registry, not
from probing a model. Heavy work runs in short-lived owned workers that the pool may kill.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import handoff               # light (urllib/ctypes only): keeps the startup contract
from .config import (ENV_MEM_CEILING, ENV_RPC_TOKEN, ENV_SECRET_FILE, LIMITS, ensure_dirs,
                     fingerprint, runtime_dir)
from .contracts import CAPABILITIES, JobRequest, JobResult, StructuredError, canon_json
from .health import Health
from .models import job_limits          # stdlib ctypes only: this stays a light startup
from .models import resources           # stdlib ctypes + psutil-free host numbers, no model import
from .models.lifecycle import WorkerPool
from .models.registry import catalog
from .security import is_loopback, token_ok

HEAVY_MODULES = ("torch", "paddle", "paddleocr", "transformers", "sentence_transformers", "docling",
                 "pyannote", "FlagEmbedding", "faster_whisper", "qwen_asr", "onnxruntime", "cv2",
                 "tensorflow", "ultralytics")
# Captured while this module is being imported, because that is the contract: importing
# the supervisor must not drag a heavy framework into the process that will serve /job.
# It is deliberately a snapshot rather than a live probe. The live set is ALSO reported
# (heavy_imports_now) so nothing is hidden: a heavy module can be seen there while the
# startup set stays empty, which is exactly the state of a worker host that has run a
# real engine. main() below still refuses to serve if a heavy module is live at startup,
# and StartupContract re-imports in a fresh interpreter to prove the import contract.
HEAVY_AT_IMPORT = tuple(sorted(m for m in HEAVY_MODULES if m in sys.modules))
DISCOVERY_FILE = "supervisor.json"
# Loopback clients that go away (cancelled probes, teardown, idle keep-alive) are ordinary
# traffic; they must cost one log line and no thread, never a traceback or a parked thread.
CONNECTION_IDLE_TIMEOUT_S = 15.0


def heavy_imports_present() -> list[str]:
    return sorted(m for m in HEAVY_MODULES if m in sys.modules)


def write_secret(path: Path) -> str:
    secret = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(secret, encoding="utf-8")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass            # Windows ACLs come from the parent directory; the file stays inside the data root
    return secret


def build_discovery(port: int, secret_file: Path, started_at: float) -> dict[str, Any]:
    return {"schema_version": 1, "host": "127.0.0.1", "port": port, "pid": os.getpid(),
            "secret_file": str(secret_file), "fingerprint": fingerprint(),
            "started_at": started_at, "capabilities": list(CAPABILITIES),
            "token_env": ENV_RPC_TOKEN}


class QuietServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that stays quiet about client-side connection losses."""

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            sys.stderr.write(f"connection closed by client: {exc.__class__.__name__}\n")
            return
        super().handle_error(request, client_address)


def make_handler(health: Health, pool: WorkerPool, secret: str, audit: list[str]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "ruke-ml/1"
        # Idle keep-alive connections must not park a handler thread forever (health probes
        # are short-lived clients that often keep the socket open).
        timeout = CONNECTION_IDLE_TIMEOUT_S

        def log_message(self, fmt: str, *args: Any) -> None:      # never to stdout: stdout is the worker pipe
            line = f"{time.strftime('%H:%M:%S')} {self.address_string()} {fmt % args}"
            audit.append(line)
            del audit[:-200]
            sys.stderr.write(line + "\n")

        def handle_one_request(self) -> None:
            """A client that hangs up is normal traffic, not a supervisor fault.

            Without this, socketserver prints a full ConnectionResetError traceback to
            stderr for every aborted probe, which buries the real diagnostics this process
            is supposed to produce.
            """
            try:
                super().handle_one_request()
            except (ConnectionError, TimeoutError) as exc:
                self.close_connection = True
                sys.stderr.write(f"connection closed by client: {exc.__class__.__name__}\n")

        # -- plumbing
        def _send(self, code: int, obj: dict[str, Any]) -> None:
            body = canon_json(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            presented = self.headers.get("X-Ruke-Token") or ""
            if not presented:
                auth = self.headers.get("Authorization", "")
                if auth.lower().startswith("bearer "):
                    presented = auth[7:].strip()
            return token_ok(presented, secret)

        def do_GET(self) -> None:                                  # noqa: N802
            if self.path.startswith("/health"):
                snap = health.snapshot()
                snap["workers"] = pool.report()
                # Both sets, with different meanings. The startup set is the import
                # contract; the live set shows a model that has since been loaded in the
                # same process. Reporting only one of them makes "no heavy model loaded"
                # either a lie or a tautology depending on which one you pick.
                snap["heavy_imports_at_startup"] = list(HEAVY_AT_IMPORT)
                snap["heavy_imports_now"] = heavy_imports_present()
                # Which ceiling is actually enforced, and what the OS recorded as the peak
                # commit for each worker it reaped. The budget claim is meaningless without it.
                snap["memory_ceiling"] = job_limits.status()
                snap["ceiling_evidence"] = pool.ceiling_evidence()
                # The host numbers the ceiling and the admission gate are actually acting on,
                # so a caller can tell "under the ceiling" from "the host has no RAM left".
                snap["host_memory"] = resources.memory_report()
                snap["pressure_releases"] = pool.pressure_releases()
                self._send(200, snap)
                return
            if self.path.startswith("/capabilities"):
                from .documents.ocr import ocr_status
                from .speech.alignment import alignment_status
                from .speech.asr import speech_status
                from .speech.diarization import diarization_status
                self._send(200, {"capabilities": {c: catalog().status_for(c) for c in CAPABILITIES},
                                 "speech": speech_status(), "alignment": alignment_status(),
                                 "diarization": diarization_status(), "ocr": ocr_status()})
                return
            if self.path.startswith("/audit"):
                self._send(200, {"audit": list(audit[-50:])})
                return
            self._send(404, {"error": StructuredError("input_rejected", "unknown endpoint").to_dict()})

        def do_POST(self) -> None:                                 # noqa: N802
            if self.path.startswith("/shutdown"):
                if not self._authorized():
                    self._send(401, {"error": StructuredError("not_configured", "missing or wrong token").to_dict()})
                    return
                self._send(200, {"state": "draining"})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            # The /models model-manager control plane (hub search/inspect/
            # download/delete) is REMOVED (final-decision addendum 2026-11-22): OCR/ASR
            # selection is fixed defaults, provisioning of the pinned assets is
            # automatic through models/prepare (the pinned-revision law in assets.py),
            # and a user-facing hub surface with a token field has no place left.
            if not self.path.startswith("/job"):
                self._send(404, {"error": "not found"})
                return
            if not self._authorized():
                health.last_error = "unauthenticated /job request refused"
                self._send(401, {"error": StructuredError(
                    "not_configured", "missing or wrong per-run token",
                    human_step="read the token from the supervisor discovery file").to_dict()})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > LIMITS.max_request_bytes:
                self._send(413, {"error": StructuredError(
                    "input_rejected", f"request body must be between 1 and {LIMITS.max_request_bytes} bytes",
                    human_step="pass a reference to a staged file instead of a payload").to_dict()})
                return
            raw = self.rfile.read(length)
            try:
                req = JobRequest.from_dict(json.loads(raw.decode("utf-8")))
            except Exception as exc:
                self._send(400, JobResult(job_id="unknown", capability="", state="failed",
                                          error=StructuredError("contract_mismatch", str(exc))).to_dict())
                return
            health.active_jobs += 1
            try:
                res = pool.run(req)
            finally:
                health.active_jobs -= 1
            self._send(200 if res.state != "failed" else 552, res.to_dict())

        def do_DELETE(self) -> None:                               # noqa: N802
            self._send(405, {"error": StructuredError(
                "input_rejected", "no deletable resources; generations are replaced").to_dict()})

    return Handler


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ruke ML supervisor (lightweight, loopback-only)")
    ap.add_argument("--port", type=int, default=0, help="0 picks a free loopback port")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--discovery", default="", help="where to write the discovery JSON")
    ap.add_argument("--idle-ttl", type=float, default=LIMITS.idle_ttl_s)
    ap.add_argument("--mem-ceiling-bytes", type=int, default=0,
                    help="hard commit ceiling for this process and every worker it spawns; "
                         f"0 (default) MEASURES the host budget at startup (B8 law), and a "
                         f"{ENV_MEM_CEILING} environment value is honoured as the operator cap")
    args = ap.parse_args(argv)

    # Bind safety first. It is a pure function of the arguments and must produce the
    # same exit code no matter what else happens to be loaded in the process; the
    # heavy-import guard below is a property of this process's import graph.
    if not is_loopback(args.host):
        sys.stderr.write("FATAL: the supervisor may bind only to loopback\n")
        return 4
    heavy = heavy_imports_present()
    if heavy:
        sys.stderr.write(f"FATAL: supervisor imported heavy modules before serving: {heavy}\n")
        return 3

    LIMITS.idle_ttl_s = args.idle_ttl
    # Put the whole runtime tree under an OS-enforced commit ceiling BEFORE any worker can be
    # spawned. Children created by a job member join the job at create time, so a lazily
    # loaded heavy model cannot walk past the cap on its way in. If the OS refuses, that is
    # logged as an acceptance failure rather than folded into a normal startup line.
    # 0 = measure the host budget at startup (B8 law); an explicit CLI value wins, and an
    # explicit RUKE_ML_MEM_CEILING_BYTES environment value is honoured as the operator cap.
    ceiling_bytes = int(args.mem_ceiling_bytes)
    if ceiling_bytes <= 0 and os.environ.get(ENV_MEM_CEILING):
        ceiling_bytes = int(LIMITS.mem_ceiling_bytes)
    ceiling = job_limits.install_process_job(ceiling_bytes)
    if ceiling.get("enforced"):
        sys.stderr.write(f"ruke-ml commit ceiling enforced: {ceiling.get('limit_bytes')} bytes "
                         f"via {ceiling.get('mechanism')} ({ceiling.get('name')}) "
                         f"source: {ceiling.get('limit_source')}\n")
    else:
        sys.stderr.write(f"ruke-ml memory ceiling NOT enforced: {ceiling.get('mechanism')} "
                         f"reason={ceiling.get('reason')} win32={ceiling.get('win32_error')}\n")
    ensure_dirs()
    started = time.time()
    rdir = runtime_dir()
    secret_file = rdir / "supervisor.secret"
    secret = write_secret(secret_file)
    health = Health(started)
    health.state = "starting"
    pool = WorkerPool()
    audit: list[str] = []

    httpd = QuietServer(("127.0.0.1", args.port), make_handler(health, pool, secret, audit))
    port = httpd.server_address[1]
    discovery_path = Path(args.discovery) if args.discovery else rdir / DISCOVERY_FILE
    discovery_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = discovery_path.with_name(discovery_path.name + f".tmp{os.getpid()}")
    tmp.write_text(canon_json(build_discovery(port, secret_file, started)), encoding="utf-8")
    os.replace(tmp, discovery_path)

    health.state = "ready"
    sys.stderr.write(f"ruke-ml supervisor ready on 127.0.0.1:{port} pid={os.getpid()}\n")
    # B10: one reload owner on restart. The journal is the evidence of whether a previous
    # window unloaded the main model; if the window was interrupted, finishing the
    # restoration is THIS process's job — dispatched here, in the background (a real model
    # load takes minutes and must not block serving /job), yielding to a live lease.
    # No UI poll ever drives the reload.
    def _startup_recovery() -> None:
        try:
            report = handoff.recover_at_startup()
        except Exception as exc:                               # noqa: BLE001
            report = {"detail": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(f"ruke-ml startup handoff recovery: {canon_json(report)}\n")

    threading.Thread(target=_startup_recovery, name="handoff-startup-recovery",
                     daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        health.state = "draining"
        pool.stop_all()                     # only our own children, bounded escalation
        httpd.server_close()
        try:
            discovery_path.unlink(missing_ok=True)
        except OSError:
            pass
        health.state = "stopped"
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
