"""Supervisor startup contract, RPC auth/limits, and owned-worker lifecycle.

The startup contract is the memory law: the persistent supervisor must stay stdlib-only.
Worker tests use real child processes, because process exit is the memory-reclaim mechanism.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from ruke_ml import supervisor
from ruke_ml.config import LIMITS
from ruke_ml.contracts import JobRequest
from ruke_ml.health import Health
from ruke_ml.models.lifecycle import WorkerPool

SECRET = "test-per-run-secret"


class StartupContract(unittest.TestCase):
    def test_supervisor_imports_nothing_heavy(self):
        code = ("import sys, json, ruke_ml.supervisor as s; "
                "print(json.dumps({'heavy': s.heavy_imports_present(), 'torch': 'torch' in sys.modules}))")
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120,
                             cwd=str(Path(supervisor.__file__).parents[1]),
                             env={**os.environ, "PYTHONPATH": str(Path(supervisor.__file__).parents[1])})
        self.assertEqual(out.returncode, 0, out.stderr)
        data = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(data["heavy"], [], "supervisor pulled in a heavy framework: %s" % data)
        self.assertEqual(data["torch"], False)

    def test_supervisor_refuses_a_non_loopback_bind(self):
        self.assertEqual(supervisor.main(["--host", "10.0.0.1", "--port", "0"]), 4)

    def test_discovery_record_shape(self):
        d = supervisor.build_discovery(45123, Path("C:/x/supervisor.secret"), 1000.0)
        self.assertEqual(d["port"], 45123)
        self.assertEqual(d["host"], "127.0.0.1")
        self.assertTrue(d["secret_file"].endswith("supervisor.secret"))
        self.assertIn("RUKE_ML_TOKEN", d["token_env"])
        self.assertTrue(len(d["fingerprint"]) >= 8)
        self.assertTrue(d["capabilities"])

    def test_secret_is_written_atomically_and_readable(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "nested" / "supervisor.secret"
            secret = supervisor.write_secret(path)
            self.assertGreaterEqual(len(secret), 32)
            self.assertEqual(path.read_text(encoding="utf-8"), secret)
            self.assertEqual([p.name for p in path.parent.iterdir()], ["supervisor.secret"])


def _request(port, method, path, body=None, token=None, raw_length=None):
    """Raw loopback request: exact framing, and Connection: close so the answer is complete."""
    payload = b"" if body is None else json.dumps(body).encode("utf-8")
    declared = len(payload) if raw_length is None else raw_length
    lines = [f"{method} {path} HTTP/1.1", f"Host: 127.0.0.1:{port}", "Connection: close",
             "Content-Type: application/json"]
    if token:
        lines.append("X-Ruke-Token: " + token)
    lines.append("Content-Length: " + str(declared))
    sock = socket.create_connection(("127.0.0.1", port), timeout=60)
    try:
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
        if payload and raw_length is None:
            sock.sendall(payload)
        chunks = []
        while True:
            part = sock.recv(65536)
            if not part:
                break
            chunks.append(part)
    finally:
        sock.close()
    data = b"".join(chunks)
    head, _, rest = data.partition(b"\r\n\r\n")
    if not head:
        raise AssertionError("the supervisor closed the connection without a response")
    status = int(head.split(b" ", 2)[1])
    body_text = rest.decode("utf-8", "replace")
    return status, (json.loads(body_text) if body_text.strip() else {})


class RpcRoundTrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # A bounded ceiling: a broken helper must fail the suite quickly, never hold it
        # for the production 15-minute heavy deadline.
        cls._limits = (LIMITS.worker_deadline_s, LIMITS.worker_ready_timeout_s,
                       LIMITS.idle_ttl_s, LIMITS.terminate_grace_s)
        LIMITS.worker_deadline_s = 30.0
        LIMITS.worker_ready_timeout_s = 10.0
        LIMITS.idle_ttl_s = 120.0
        LIMITS.terminate_grace_s = 2.0
        cls.pool = WorkerPool()
        cls.health = Health()
        cls.health.state = "ready"
        cls.httpd = supervisor.QuietServer(("127.0.0.1", 0),
                                           supervisor.make_handler(cls.health, cls.pool, SECRET, []))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.pool.stop_all()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=10)
        (LIMITS.worker_deadline_s, LIMITS.worker_ready_timeout_s,
         LIMITS.idle_ttl_s, LIMITS.terminate_grace_s) = cls._limits

    def test_a_health_reports_real_state_without_touching_a_model(self):
        code, body = _request(self.port, "GET", "/health")
        self.assertEqual(code, 200)
        self.assertEqual(body["state"], "ready")
        self.assertEqual(body["heavy_imports_at_startup"], [])
        self.assertEqual(body["limits"]["heavy_concurrency"], 1)
        self.assertIn("speech.asr", body["capabilities"])
        self.assertIn("workers", body)

    def test_x_the_startup_heavy_set_is_a_snapshot_not_a_live_probe(self):
        """The contract is what importing the supervisor pulled in, not what something
        else sharing the process happened to load. Both facts are reported separately;
        conflating them made the startup law depend on unrelated test order, and made a
        worker host that has legitimately run an engine look like a broken startup."""
        fake = "qwen_asr"  # a HEAVY_MODULES name that no code here imports
        self.assertNotIn(fake, sys.modules)
        sys.modules[fake] = None
        try:
            code, body = _request(self.port, "GET", "/health")
            self.assertEqual(code, 200)
            self.assertIn(fake, body["heavy_imports_now"],
                          "the live set must report what is actually in the process")
            self.assertEqual(body["heavy_imports_at_startup"], [],
                             "a module loaded after supervisor import is not a supervisor import")
        finally:
            sys.modules.pop(fake, None)

    def test_b_job_without_a_token_is_refused(self):
        code, body = _request(self.port, "POST", "/job", {"capability": "embeddings"})
        self.assertEqual(code, 401)
        self.assertEqual(body["error"]["reason"], "not_configured")

    def test_c_embeddings_run_lexically_and_report_their_own_mode(self):
        req = JobRequest(request_id="r1", run_id="run1", job_id="j1", capability="embeddings",
                         payload={"texts": ["C++ memory model", "C# generics"]}).to_dict()
        code, body = _request(self.port, "POST", "/job", req, token=SECRET)
        self.assertEqual(code, 200, body)
        self.assertEqual(body["state"], "ready")
        self.assertEqual(body["payload"]["quality_mode"], "lexical")
        self.assertIn("not model-quality parity", body["payload"]["quality_note"])
        self.assertEqual(body["model"]["id"], "ruke-lexical-hash")
        self.assertEqual(len(body["payload"]["vectors"]), 2)
        self.assertEqual(body["payload"]["embedding"]["dim"], len(body["payload"]["vectors"][0]))

    def test_d_uninstalled_backend_is_a_typed_failure_not_a_zero_vector(self):
        req = JobRequest(request_id="r2", run_id="run1", job_id="j2", capability="embeddings",
                         payload={"texts": ["x"], "quality_mode": "qwen3"}).to_dict()
        code, body = _request(self.port, "POST", "/job", req, token=SECRET)
        self.assertEqual(code, 552, "a failed result must not look like a success")
        self.assertEqual(body["state"], "failed")
        self.assertEqual(body["error"]["reason"], "evaluation_required")
        self.assertTrue(body["error"]["human_step"])
        self.assertNotIn("vectors", body.get("payload") or {})

    def test_e_oversized_request_is_refused_before_it_is_read(self):
        code, body = _request(self.port, "POST", "/job", None, token=SECRET,
                              raw_length=LIMITS.max_request_bytes + 1)
        self.assertEqual(code, 413)
        self.assertIn("staged file", body["error"]["human_step"])

    def test_f_contract_mismatch_is_typed(self):
        code, body = _request(self.port, "POST", "/job", {"capability": "embeddings"}, token=SECRET)
        self.assertEqual(code, 400)
        self.assertEqual(body["error"]["reason"], "contract_mismatch")

    def test_g_capabilities_report_licence_blockers_without_failing(self):
        code, body = _request(self.port, "GET", "/capabilities")
        self.assertEqual(code, 200)
        self.assertTrue(body["capabilities"])
        self.assertTrue(body["diarization"]["license_acceptance_required"])
        self.assertEqual(body["speech"]["pcm_contract"]["rate_hz"], 16000)

    def test_h_client_churn_is_quiet_and_bounded(self):
        # A probe that hangs up mid-request must cost one log line, not a traceback: this
        # process's stderr is the operator's only diagnostic channel during startup.
        import io
        buf, old = io.StringIO(), sys.stderr
        sys.stderr = buf
        try:
            import struct
            for payload in (b"GET /health HTTP/1.1\r\nHost: x\r\n",           # headers never end
                            b"POST /job HTTP/1.1\r\nHost: x\r\nContent-Length: 8\r\n\r\n"):
                s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                # SO_LINGER with a zero timeout forces RST instead of FIN, so the server is
                # guaranteed to observe an abort rather than a graceful half-close.
                s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("iii", 1, 0, 0))
                s.sendall(payload)
                s.close()                                                    # abrupt hang-up
            deadline = time.time() + 5.0
            while time.time() < deadline and "connection closed by client" not in buf.getvalue():
                time.sleep(0.05)
        finally:
            sys.stderr = old
        text = buf.getvalue()
        self.assertIn("connection closed by client", text)
        self.assertNotIn("Traceback", text, "a client abort was reported as a supervisor fault")

    def test_i_keep_alive_connections_expire(self):
        # HTTP/1.1 keep-alive hands a thread to every connection; without an idle timeout a
        # client that keeps sockets open parks threads in the supervisor forever.
        self.assertEqual(self.httpd.RequestHandlerClass.timeout,
                         supervisor.CONNECTION_IDLE_TIMEOUT_S)
        self.assertGreater(supervisor.CONNECTION_IDLE_TIMEOUT_S, 0.0)
        self.assertLess(supervisor.CONNECTION_IDLE_TIMEOUT_S, LIMITS.worker_deadline_s)

    def test_z_shutdown_needs_a_token_and_drains(self):
        code, _ = _request(self.port, "POST", "/shutdown")
        self.assertEqual(code, 401)
        code, body = _request(self.port, "POST", "/shutdown", {}, token=SECRET)
        self.assertEqual(code, 200)
        self.assertEqual(body["state"], "draining")
        self.thread.join(timeout=15)
        self.assertFalse(self.thread.is_alive(), "the supervisor did not drain and stop")


class ConnectionOwnership(unittest.TestCase):
    """The quiet path must be specific: a genuine server fault still gets a traceback."""

    def test_quiet_server_filters_aborts_only(self):
        import io
        handler = supervisor.make_handler(Health(), WorkerPool(), "s", [])
        self.assertEqual(handler.timeout, supervisor.CONNECTION_IDLE_TIMEOUT_S)
        srv = supervisor.QuietServer(("127.0.0.1", 0), handler)
        buf, old = io.StringIO(), sys.stderr
        sys.stderr = buf
        try:
            try:
                raise ConnectionAbortedError("aborted")
            except ConnectionAbortedError:
                srv.handle_error(None, ("127.0.0.1", 1))
            try:
                raise socket.timeout("idle keep-alive expired")
            except socket.timeout:
                srv.handle_error(None, ("127.0.0.1", 2))
            try:
                raise ZeroDivisionError("genuine fault")
            except ZeroDivisionError:
                srv.handle_error(None, ("127.0.0.1", 3))
        finally:
            sys.stderr = old
            srv.server_close()
        text = buf.getvalue()
        self.assertIn("connection closed by client: ConnectionAbortedError", text)
        # socket.timeout is TimeoutError from 3.10 on; either spelling must reach the quiet path.
        self.assertTrue("connection closed by client: TimeoutError" in text
                        or "connection closed by client: timeout" in text, text)
        self.assertEqual(text.count("Traceback"), 1, "aborts must not print tracebacks: " + text)
        self.assertIn("ZeroDivisionError", text, "a real fault must still be reported")


class OwnedWorkers(unittest.TestCase):
    def setUp(self):
        self._limits = (LIMITS.worker_deadline_s, LIMITS.worker_ready_timeout_s,
                        LIMITS.idle_ttl_s, LIMITS.terminate_grace_s)
        LIMITS.worker_deadline_s = 30.0
        LIMITS.worker_ready_timeout_s = 10.0
        LIMITS.idle_ttl_s = 120.0
        LIMITS.terminate_grace_s = 2.0
        self.pool = WorkerPool()

    def tearDown(self):
        self.pool.stop_all()
        (LIMITS.worker_deadline_s, LIMITS.worker_ready_timeout_s,
         LIMITS.idle_ttl_s, LIMITS.terminate_grace_s) = self._limits

    def test_real_worker_round_trip_and_report(self):
        req = JobRequest(request_id="r", run_id="run", job_id="j", capability="rerank",
                         payload={"query": "C++ move semantics", "chunks": [
                             {"chunk_id": "a", "text": "C++ move semantics and rvalue references",
                              "source_id": "s", "source_hash": "h"},
                             {"chunk_id": "b", "text": "banana bread recipe", "source_id": "s", "source_hash": "h"}]})
        res = self.pool.run(req, deadline_s=60)
        self.assertEqual(res.state, "ready", res.to_dict())
        self.assertEqual(res.payload["scores"][0]["chunk_id"], "a")
        self.assertEqual(res.payload["mode_actually_used"], "lexical")
        self.assertIn("cannot recover evidence", res.coverage.note)
        rep = self.pool.report()
        self.assertIn("rerank", rep)
        self.assertGreater(rep["rerank"]["pid"], 0)
        self.assertGreater(rep["rerank"]["created"], 0, "identity proof against PID reuse is required")
        self.assertEqual(self.pool.owned_pids(), [rep["rerank"]["pid"]])

    def test_job_stages_are_captured_not_discarded(self):
        """The worker really emits {"kind":"progress"} frames. The pool used to read them
        and `continue`, so no UI could ever show a genuine stage. The frames must be kept
        (counted, with the newest one visible) and the terminal state recorded."""
        req = JobRequest(request_id="r", run_id="run", job_id="job-stages", capability="rerank",
                         payload={"query": "C++ move semantics", "chunks": [
                             {"chunk_id": "a", "text": "C++ move semantics", "source_id": "s",
                              "source_hash": "h"}]})
        res = self.pool.run(req, deadline_s=60)
        self.assertEqual(res.state, "ready", res.to_dict())
        rep = self.pool.report()["rerank"]
        for key in ("current_stage", "current_note", "last_state", "last_detail", "progress_seq"):
            self.assertIn(key, rep, f"report() must expose {key} or the UI has nothing honest to show")
        self.assertGreaterEqual(rep["progress_seq"], 2,
                                "the helper emits preparing and analysing; both must be counted")
        self.assertEqual(rep["last_state"], "ready")
        self.assertEqual(rep["current_stage"], "", "a finished job has no stage in flight")
        self.assertEqual(rep["last_detail"], "", "a successful job invents no failure detail")

    def test_a_failed_job_records_its_state_on_a_worker_that_survived(self):
        req = JobRequest(request_id="r", run_id="run", job_id="job-bad", capability="rerank",
                         payload={"query": "", "chunks": []})
        res = self.pool.run(req, deadline_s=60)
        self.assertEqual(res.state, "failed")
        rep = self.pool.report().get("rerank")
        self.assertIsNotNone(rep, "the helper stays owned and must show why the job failed")
        self.assertEqual(rep["last_state"], "failed")
        self.assertIn("query", rep["last_detail"])

    def test_worker_crash_becomes_a_retryable_typed_failure(self):
        first = JobRequest(request_id="r", run_id="run", job_id="j1", capability="rerank",
                           payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]})
        self.assertEqual(self.pool.run(first, deadline_s=60).state, "ready")
        owned = self.pool._workers["rerank"]
        owned.proc.stdin.write(json.dumps({"kind": "selftest_crash"}) + "\n")
        owned.proc.stdin.flush()
        res = self.pool.run(JobRequest(request_id="r", run_id="run", job_id="j2", capability="rerank",
                                       payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]}),
                            deadline_s=60)
        self.assertEqual(res.state, "failed")
        self.assertEqual(res.error.reason, "crash")
        # A bare "worker exited rc=3" is un diagnosable. The owner must hand over the
        # worker's own bounded stderr tail, or every crash becomes a guessing game.
        self.assertIn("injected helper fault", res.error.message,
                      f"the crash message must carry the worker's stderr tail, got: {res.error.message!r}")
        self.assertTrue(res.error.retryable, "a crashed helper must be restartable, not fatal")
        res2 = self.pool.run(JobRequest(request_id="r", run_id="run", job_id="j3", capability="rerank",
                                        payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]}),
                             deadline_s=60)
        self.assertEqual(res2.state, "ready", "the helper must come back for the next job")

    def test_deadline_terminates_only_the_owned_worker(self):
        pid_holder = {}
        first = JobRequest(request_id="r", run_id="run", job_id="j1", capability="rerank",
                           payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]})
        self.pool.run(first, deadline_s=60)
        owned = self.pool._workers["rerank"]
        pid_holder["pid"] = owned.proc.pid
        owned.proc.stdin.write(json.dumps({"kind": "selftest_slow", "seconds": 8}) + "\n")
        owned.proc.stdin.flush()
        res = self.pool.run(JobRequest(request_id="r", run_id="run", job_id="j2", capability="rerank",
                                       payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]}),
                            deadline_s=1.0)
        self.assertEqual(res.error.reason, "deadline_exceeded")
        self.assertTrue(res.error.retryable)
        self.assertEqual(self.pool.owned_pids(), [], "the timed-out child must not stay behind")
        self.assertTrue(self._process_gone(pid_holder["pid"]))

    @staticmethod
    def _process_gone(pid: int) -> bool:
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return True
        code = ctypes.c_ulong()
        ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(ok) and code.value != STILL_ACTIVE

    def test_gated_capability_reports_licence_blocker_as_a_typed_failure(self):
        res = self.pool.run(JobRequest(request_id="r", run_id="run", job_id="j", capability="speech.diarize",
                                       payload={"path": "x.wav"}), deadline_s=90)
        self.assertEqual(res.state, "failed")
        self.assertEqual(res.error.reason, "license_acceptance_required")
        self.assertFalse(res.error.retryable)
        self.assertIn("licence", res.error.human_step.lower())

    def test_a_heavy_worker_declares_what_it_loaded_before_it_answers(self):
        """Cold-load evidence: the handshake carries the native graph the worker imported
        and how long it took, so a heavy dependency's cost is measured per capability
        instead of assumed. It also proves the ASR worker's graph loaded single-threaded,
        which is what made a real transcription possible at all."""
        # This test owns the HANDSHAKE, not the admission gate. The gate answers from the
        # host's live free RAM, and `speech.asr` is model-backed, so on a host where the
        # main LLM is resident the pool refuses the load typed (`memory_pressure`) and the
        # worker is never spawned - which makes this assertion depend on how much RAM other
        # processes happen to be holding rather than on the worker. The gate's own contract
        # is asserted in tests.test_memory_policy; here it is stubbed to "fits" so the
        # handshake is checked on every host, and the stub is the narrowest possible one:
        # the refusal hook only, not the sampler, the ceiling or the unload rules.
        with mock.patch.object(self.pool, "_admission_refusal", return_value=None):
            res = self.pool.run(JobRequest(request_id="r", run_id="run", job_id="prelude",
                                           capability="speech.asr",
                                           payload={"path": "missing.wav", "root": "."}),
                                deadline_s=60)
        self.assertIn(res.state, ("ready", "failed"), res.to_dict())
        rep = self.pool.report().get("speech.asr")
        self.assertIsNotNone(rep, "the helper is owned and must report its startup")
        prelude = rep.get("prelude") or {}
        for name in ("numpy", "faster_whisper"):
            self.assertIn(name, prelude.get("imports", []),
                          f"{name} must be imported during the startup prelude, got {prelude!r}")
        self.assertEqual(prelude.get("import_failures"), [], "an installed backend must not report a failure")
        self.assertGreaterEqual(prelude.get("prelude_ms", -1), 0)

    def test_the_neural_retrieval_workers_also_prelude_import_their_native_graph(self):
        """Regression measured before it was fixed (F29): a neural rerank sent through the
        supervisor died at its ~95 s deadline after 0.14 s of CPU, with the 90 MB model file
        never opened. `faulthandler` showed the identical stuck frame at 30 s, 60 s and 150 s:
        `import onnxruntime` -> numpy `multiarray` -> `importlib create_module`. The same
        import costs 0.05-0.06 s in a fresh child under the same env, venv and wheels, so the
        failure was a native-extension init once the runner's control threads exist - exactly
        what `_prelude` exists to prevent. `rerank` and `embeddings` had never been given a
        prelude entry, so neural retrieval was silently a deadline error in production. Their
        absence must fail a test, not only a live probe.
        """
        cases = (
            ("rerank", {"query": "alpha", "chunks": [{"chunk_id": "a", "text": "alpha text"}]}),
            ("embeddings", {"texts": ["alpha beta gamma"]}),
        )
        for cap, payload in cases:
            with self.subTest(capability=cap):
                res = self.pool.run(JobRequest(request_id="r", run_id="run",
                                               job_id=f"prelude-{cap}", capability=cap,
                                               payload=payload), deadline_s=90)
                self.assertEqual(res.state, "ready", res.to_dict())
                rep = self.pool.report().get(cap)
                self.assertIsNotNone(rep, f"the {cap} helper is owned and must report its startup")
                prelude = rep.get("prelude") or {}
                for name in ("numpy", "onnxruntime", "tokenizers"):
                    self.assertIn(name, prelude.get("imports", []),
                                  f"{name} must load in the {cap} startup prelude, got {prelude!r}")
                self.assertEqual(prelude.get("import_failures"), [],
                                 f"installed {cap} backends must not report an import failure")
                self.assertGreaterEqual(prelude.get("prelude_ms", -1), 0)

    def test_the_reaper_never_unloads_a_worker_that_has_a_job_in_flight(self):
        """Regression, measured before it was fixed.

        `last_used` was stamped when a job was handed over and never refreshed while the
        job ran, so with `idle_ttl_s = 120` the reaper terminated a worker that was still
        working: the owner got "worker closed its output stream mid-job" / 
        `deadline_exceeded` at about 125s for a job that was simply still running. An
        in-flight job is not idleness, and memory pressure is no excuse either - killing
        the worker mid-job destroys the work it was asked to do.
        """
        LIMITS.idle_ttl_s = 0.5          # far shorter than the job below, on purpose
        first = JobRequest(request_id="r", run_id="run", job_id="warm", capability="rerank",
                           payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]})
        self.assertEqual(self.pool.run(first, deadline_s=60).state, "ready")
        owned = self.pool._workers["rerank"]
        owned.proc.stdin.write(json.dumps({"kind": "selftest_slow", "seconds": 5}) + "\n")
        owned.proc.stdin.flush()
        got: list = []
        threading.Thread(target=lambda: got.append(self.pool.run(
            JobRequest(request_id="r", run_id="run", job_id="in-flight", capability="rerank",
                       payload={"query": "q2", "chunks": [{"chunk_id": "b", "text": "q2 text"}]}),
            deadline_s=30)), daemon=True).start()
        time.sleep(2.5)                  # several reaper passes, each of which used to kill it
        self.assertEqual(self.pool.owned_pids(), [owned.proc.pid],
                         "a worker with a job in flight must not be unloaded for being idle")
        self.assertFalse(self._process_gone(owned.proc.pid), "the reaper must not terminate it")
        deadline = time.time() + 25
        while not got and time.time() < deadline:
            time.sleep(0.2)
        self.assertTrue(got, "the queued job must eventually be answered")
        self.assertEqual(got[0].state, "ready", got[0].to_dict())

    def test_heavy_stages_are_serialised_through_one_slot(self):
        first = JobRequest(request_id="r", run_id="run", job_id="slow", capability="embeddings",
                           payload={"texts": ["alpha beta gamma"]})
        self.assertEqual(self.pool.run(first, deadline_s=60).state, "ready")
        owned = self.pool._workers["embeddings"]
        owned.proc.stdin.write(json.dumps({"kind": "selftest_slow", "seconds": 6}) + "\n")
        owned.proc.stdin.flush()
        results: list = []
        thread = threading.Thread(target=lambda: results.append(
            self.pool.run(JobRequest(request_id="r", run_id="run", job_id="held", capability="embeddings",
                                     payload={"texts": ["delayed text"]}), deadline_s=40)), daemon=True)
        thread.start()
        time.sleep(0.4)
        blocked = self.pool.run(JobRequest(request_id="r2", run_id="run", job_id="contender",
                                           capability="rerank",
                                           payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]}),
                                deadline_s=1.0)
        self.assertEqual(blocked.error.reason, "resource_busy",
                         "two heavy capabilities must never share the machine at once")
        self.assertTrue(blocked.error.retryable)
        thread.join(timeout=60)
        self.assertEqual(results and results[0].state, "ready")


if __name__ == "__main__":
    unittest.main()
