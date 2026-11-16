"""Wire contracts must reject, never coerce. Paths must resolve inside an owned root."""
from __future__ import annotations

import io
import os
import tempfile
import unittest
import zipfile

from ruke_ml import security
from ruke_ml.contracts import (CAPABILITIES, Coverage, EmbeddingMeta, JobRequest, JobResult,
                               ERROR_REASONS, ModelIdentity, StructuredError, canon_json)


def meta(model="ruke-lexical-hash", rev="builtin-v1", dim=512, norm="l2", instr=""):
    return EmbeddingMeta(model=ModelIdentity(model, rev, "builtin"), dim=dim, normalization=norm,
                         query_instruction=instr)


class Contracts(unittest.TestCase):
    def test_round_trip(self):
        req = JobRequest("r1", "run1", "j1", "documents.parse", {"path": "a.xlsx"})
        self.assertEqual(JobRequest.from_dict(req.to_dict()), req)
        res = JobResult("j1", "documents.parse", "ready", {"ok": True},
                        coverage=Coverage([(0.0, 5.0)], [(5.0, 10.0)], "seconds", 10.0, False, "partial"),
                        model=ModelIdentity("docling", "rev1"), progress=0.5)
        back = JobResult.from_dict(res.to_dict())
        self.assertEqual(back.coverage.examined, [(0.0, 5.0)])
        self.assertEqual(back.coverage.skipped, [(5.0, 10.0)])
        self.assertEqual(back.model.revision, "rev1")
        self.assertEqual(back.progress, 0.5)

    def test_rejects(self):
        with self.assertRaises(Exception):
            JobRequest("r", "run", "j", "not-a-capability").to_dict()
        d = JobRequest("r", "run", "j", "rerank").to_dict()
        d["schema_version"] = 99
        with self.assertRaises(Exception):
            JobRequest.from_dict(d)
        with self.assertRaises(Exception):
            JobResult.from_dict({"job_id": "j", "capability": "rerank", "state": "mangled", "schema_version": 1})
        with self.assertRaises(Exception):
            Coverage.from_dict({"examined": [[0, 1, 2]]})
        with self.assertRaises(Exception):
            StructuredError("made_up_reason", "x")

    def test_embedding_compatibility(self):
        ok, _ = meta().compatible_with(meta())
        self.assertTrue(ok)
        for other in (meta(dim=1024), meta(rev="v2"), meta(norm="none"), meta(instr="q: ")):
            ok, why = meta().compatible_with(other)
            self.assertFalse(ok, other)
            self.assertTrue(why)

    def test_canon_json_stable(self):
        self.assertEqual(canon_json({"b": 1, "a": 2}), canon_json({"a": 2, "b": 1}))
        self.assertIn("capabilities", canon_json({"capabilities": list(CAPABILITIES)}))


class Paths(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ruke-root-")

    def test_traversal_rejected(self):
        for bad in ("..", "../evil.txt", "a/../../b", "C:\\Windows\\notepad.exe",
                    "\\\\server\\share\\x", "\\\\?\\UNC\\server\\share", "C:Windows\\x"):
            with self.assertRaises(security.PathRejected, msg=bad):
                security.resolve_within(bad, self.root)

    def test_reserved_device_names(self):
        for bad in ("CON", "nul.txt", "COM1", "LPT2.log"):
            with self.assertRaises(security.PathRejected, msg=bad):
                security.resolve_within(bad, self.root)

    def test_good_paths_stay_inside(self):
        sub = os.path.join(self.root, "sub")
        os.makedirs(sub, exist_ok=True)
        target = os.path.join(sub, "f.txt")
        open(target, "w").close()
        got = security.resolve_within(target, self.root)
        self.assertTrue(str(got).lower().startswith(self.root.lower()))
        rel = security.resolve_within(os.path.join("sub", "f.txt"), self.root)
        self.assertTrue(str(rel).lower().endswith("f.txt"))

    def test_zip_bomb_and_names(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("ok.txt", "x" * 100)
            z.writestr("../escape.txt", "boom")
        buf.seek(0)
        with zipfile.ZipFile(buf) as z:
            with self.assertRaises(Exception):
                security.audit_zip_members(z)
        buf2 = io.BytesIO()
        with zipfile.ZipFile(buf2, "w") as z:
            z.writestr("a/../b.txt", "x" * 100)
        buf2.seek(0)
        with self.assertRaises(security.PathRejected):
            security.safe_member_name("a/../b.txt")
        with self.assertRaises(security.PathRejected):
            security.safe_member_name("C:\\x")
        with self.assertRaises(security.PathRejected):
            security.safe_member_name("evil.txt:secret_stream")
        with self.assertRaises(security.PathRejected):
            security.safe_member_name("C:/x")
        with self.assertRaises(security.PathRejected):
            security.safe_member_name("a\\b\\..\\c.txt")

    def test_ratio_explosion(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("big.txt", "A" * (4 << 20))
        buf.seek(0)
        with zipfile.ZipFile(buf) as z:
            with self.assertRaises(security.PathRejected):
                security.audit_zip_members(z, ratio_limit=2.0)

    def test_loopback_and_token(self):
        for h in ("127.0.0.1", "localhost", "::1"):
            self.assertTrue(security.is_loopback(h), h)
        for h in ("0.0.0.0", "10.0.0.5", "evil.example.com", ""):
            self.assertFalse(security.is_loopback(h), h)
        self.assertTrue(security.token_ok("abc", "abc"))
        for bad in (None, "", "ab", "abcd", "abd"):
            self.assertFalse(security.token_ok(bad, "abc"), bad)


class Egress(unittest.TestCase):
    def test_worker_env_blocks_egress(self):
        # A dead loopback sink is stronger than deleting the variable: an unset proxy
        # would still route directly. Offline flags cover the model hubs explicitly.
        env = security.egress_blocked_for_workers({"HTTP_PROXY": "http://corp-proxy:8080",
                                                   "PIP_INDEX_URL": "https://pypi.org/simple"})
        for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
            self.assertTrue(env[k].startswith("http://127.0.0.1:"), k)
        self.assertEqual(env["RUKE_EGRESS"], "blocked")
        self.assertEqual(env["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(env["HF_HUB_OFFLINE"], "1")
        self.assertEqual(env["no_proxy"], "")


class WireReasons(unittest.TestCase):
    def test_every_reason_the_package_raises_is_a_legal_wire_reason(self):
        # A reason literal the contract itself rejects turns an honest typed failure into
        # "internal", hiding the real blocker. Scanning the package catches the class of
        # bug, not one instance: evaluation_required was raised in eight places while the
        # contract tuple did not contain it.
        import re
        from pathlib import Path
        pkg = Path(__file__).resolve().parents[1] / "ruke_ml"
        used: set[str] = set()
        for path in pkg.rglob("*.py"):
            used |= set(re.findall(r'StructuredError\(\s*"([a-z_]+)"', path.read_text(encoding="utf-8")))
        self.assertGreaterEqual(len(used), 8, f"scan found only {sorted(used)} - not meaningful coverage")
        illegal = sorted(used - set(ERROR_REASONS))
        self.assertEqual(illegal, [], f"these error reasons are rejected by their own contract: {illegal}")

    def test_reason_names_are_unique(self):
        self.assertEqual(len(set(ERROR_REASONS)), len(ERROR_REASONS))
        for r in ERROR_REASONS:
            self.assertTrue(r and r == r.strip(), r)

    def test_every_declared_capability_reaches_a_worker_handler(self):
        # A capability the wire advertises but no worker serves is a promise the system
        # cannot keep; video.observations used to be exactly that.
        from ruke_ml.workers import runner
        served = set(runner.HANDLERS) | {"documents.ocr", "speech.asr", "speech.align", "speech.diarize"}
        self.assertEqual(set(CAPABILITIES) - served, set())
        self.assertEqual(served - set(CAPABILITIES), set(), "a handler for an undeclared capability")


class WorkerOwnership(unittest.TestCase):
    def test_a_spawned_child_gets_no_egress_path_and_the_right_pythonpath(self):
        # Declaring an egress helper and never applying it to a child is the same failure
        # mode as an unread backup field. The child env is the enforcement point.
        from ruke_ml.models import lifecycle
        captured: dict = {}

        class FakeProc:
            pid = 4242
            returncode = 1

            def __init__(self) -> None:
                self.stdin = io.StringIO("")
                self.stdout = io.StringIO("")
                self.stderr = io.StringIO("")

            def poll(self):
                return 1

        def fake_popen(argv, **kw):
            captured["argv"] = list(argv)
            captured["env"] = dict(kw.get("env") or {})
            return FakeProc()

        real = lifecycle._popen
        lifecycle._popen = fake_popen
        pool = lifecycle.WorkerPool()
        try:
            res = pool.run(JobRequest(request_id="r", run_id="run", job_id="j", capability="rerank",
                                      payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]}),
                           deadline_s=5)
        finally:
            lifecycle._popen = real
        env = captured.get("env") or {}
        self.assertTrue(captured.get("argv"), "no child process was attempted at all")
        self.assertEqual(env.get("RUKE_EGRESS"), "blocked")
        self.assertEqual(env.get("HF_HUB_OFFLINE"), "1")
        self.assertTrue(str(env.get("RUKE_SCRATCH_DIR", "")).endswith("tmp"))
        self.assertIn("python-backend", env.get("PYTHONPATH", ""),
                      "python -m ruke_ml.workers.runner must resolve from any cwd")
        # A child that never completes its handshake is a typed, retryable failure, and it
        # is not retained in the ownership table.
        self.assertEqual(res.state, "failed")
        self.assertEqual(res.error.reason, "crash")
        self.assertTrue(res.error.retryable)
        self.assertEqual(pool.owned_pids(), [])

    def test_a_worker_that_announces_a_dead_control_channel_fails_fast(self):
        from ruke_ml.models import lifecycle
        marker = io.StringIO('{"kind": "control_channel_failed", "detail": "TypeError: boom"}\n')

        class DeadChannelProc:
            pid = 4343
            returncode = None

            def __init__(self) -> None:
                self.stdin = io.StringIO("")
                self.stdout = io.StringIO('{"kind": "ready", "capability": "rerank"}\n'
                                          '{"kind": "control_channel_failed", "detail": "TypeError: boom"}\n')
                self.stderr = io.StringIO("")

            def poll(self):
                return None

            def wait(self, timeout=None):
                return 0

            def terminate(self):
                pass

            def kill(self):
                pass

        def fake_popen(argv, **kw):
            return DeadChannelProc()

        real_popen, real_ct = lifecycle._popen, lifecycle.resources.process_creation_time
        real_grace = lifecycle.LIMITS.terminate_grace_s
        lifecycle.LIMITS.terminate_grace_s = 1.0      # the point is fast failure, not slow escalation
        lifecycle._popen = fake_popen
        lifecycle.resources.process_creation_time = lambda pid: 12345
        pool = lifecycle.WorkerPool()
        try:
            t0 = __import__("time").time()
            res = pool.run(JobRequest(request_id="r", run_id="run", job_id="j", capability="rerank",
                                      payload={"query": "q", "chunks": [{"chunk_id": "a", "text": "q text"}]}),
                           deadline_s=20)
            elapsed = __import__("time").time() - t0
        finally:
            lifecycle._popen = real_popen
            lifecycle.resources.process_creation_time = real_ct
            lifecycle.LIMITS.terminate_grace_s = real_grace
            pool.stop_all()
        self.assertEqual(res.error.reason, "crash")
        self.assertIn("control channel", res.error.message)
        self.assertLess(elapsed, 8, "a dead control channel must not consume the job deadline")


if __name__ == "__main__":
    unittest.main()
