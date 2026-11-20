"""The worker pipe is a BYTE protocol: one bad codec assumption loses a good answer.

Reproduced defect (measured, not theorised): a PDF parse that had genuinely succeeded died
as `worker closed its output stream mid-job`. The worker wrote its result with
`ensure_ascii=False` through a text stdout whose encoding was the Windows ANSI codepage,
so a document's own U+2019 went out as byte 0x92 into a stream the supervisor decodes as
UTF-8; the reader thread raised UnicodeDecodeError, which is a ValueError, and the pump
turned that into its end-of-stream sentinel. A correct answer was destroyed by its own
encoding, and the reported cause was a worker crash.

The fix has three parts and each one is locked here: the worker writes UTF-8 BYTES, the
child environment pins UTF-8 codecs, and the supervisor's pipes decode with
errors="replace" so a stray byte can never masquerade as a clean end of stream again.
"""
from __future__ import annotations

import io
import json
import contextlib
import os
import sys
import tempfile
import unittest
import zipfile

from ruke_ml.config import child_env
from ruke_ml.workers import runner

HARD_TEXT = "Quarter\u2019s margin \u2014 \u0939\u093f\u0902\u0926\u0940 \u30c7\u30fc\u30bf \U0001F600"


class ChildEnvironment(unittest.TestCase):
    def test_child_env_pins_utf8_codecs_for_owned_children(self):
        env = child_env("job-utf8")
        self.assertEqual(env["PYTHONUTF8"], "1")
        self.assertEqual(env["PYTHONIOENCODING"].lower().split(":")[0], "utf-8")


class FrameEncoding(unittest.TestCase):
    def _capture(self, action) -> bytes:
        """Run `action` with sys.stdout configured like a Windows console pipe (cp1252)."""
        raw = io.BytesIO()
        text = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", newline="")
        with contextlib.redirect_stdout(text):
            action()
            text.flush()
        return raw.getvalue()

    def test_a_frame_survives_a_locale_text_layer_that_cannot_represent_it(self):
        frame = {"kind": "result", "text": HARD_TEXT}
        fixed = self._capture(lambda: runner._emit(frame))
        decoded = json.loads(fixed.decode("utf-8"))          # must not raise
        self.assertEqual(decoded["text"], HARD_TEXT)
        self.assertIn("Quarter\u2019s".encode("utf-8"), fixed)
        self.assertNotIn(b"\x92", fixed, "the Windows-1252 byte for U+2019 must never "
                                         "reach a stream decoded as UTF-8")

    def test_the_old_text_layer_write_is_what_broke_so_the_regression_stays_exercised(self):
        # Written from the pre-fix code path. If this ever stops raising/producing the
        # invalid byte, the test above is no longer proving anything about the fix.
        frame = {"kind": "result", "text": "Quarter\u2019s margin \u2014 Q1"}
        legacy = self._capture(lambda: sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\n"))
        self.assertIn(b"\x92", legacy, "cp1252 must still encode U+2019 as 0x92 in this test")
        with self.assertRaises(UnicodeDecodeError):
            legacy.decode("utf-8")
        with self.assertRaises(UnicodeEncodeError):
            # a script cp1252 cannot represent at all: the child raised inside its own write
            self._capture(lambda: sys.stdout.write(HARD_TEXT))

    def test_a_lone_surrogate_cannot_kill_the_pipe(self):
        frame = {"kind": "result", "name": "bad\ud800name.pdf"}
        obj = json.loads(self._capture(lambda: runner._emit(frame)).decode("utf-8"))
        self.assertIn("name.pdf", obj["name"])


XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


class OwnedRoundTrip(unittest.TestCase):
    """The same content through a REAL owned child process and the real pump."""

    def setUp(self):
        from ruke_ml.config import LIMITS
        self._limits = (LIMITS.worker_deadline_s, LIMITS.worker_ready_timeout_s)
        LIMITS.worker_deadline_s = 60.0
        LIMITS.worker_ready_timeout_s = 15.0
        self.dir = tempfile.mkdtemp(prefix="ruke-utf8-")
        with zipfile.ZipFile(os.path.join(self.dir, "quote.docx"), "w") as z:
            z.writestr("[Content_Types].xml", XMLDECL + "<Types/>")
            z.writestr("word/document.xml", XMLDECL + (
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f"<w:body><w:p><w:r><w:t>{HARD_TEXT}</w:t></w:r></w:p></w:body></w:document>"))

    def tearDown(self):
        from ruke_ml.config import LIMITS
        (LIMITS.worker_deadline_s, LIMITS.worker_ready_timeout_s) = self._limits
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_a_non_ascii_parse_result_comes_back_instead_of_a_worker_crash(self):
        from ruke_ml.contracts import JobRequest
        from ruke_ml.models.lifecycle import WorkerPool
        pool = WorkerPool()
        try:
            res = pool.run(JobRequest(
                request_id="r", run_id="run", job_id="utf8", capability="documents.parse",
                payload={"path": os.path.join(self.dir, "quote.docx"), "root": self.dir}),
                deadline_s=60)
            self.assertEqual(res.state, "ready",
                             f"{res.error.reason if res.error else ''}: "
                             f"{res.error.message if res.error else ''}")
            texts = [b["text"] for b in res.payload["document"]["blocks"]]
            self.assertIn(HARD_TEXT, texts,
                         "the document's own punctuation and scripts must arrive intact")
        finally:
            pool.stop_all()


class PipeHygiene(unittest.TestCase):
    """Reader-thread teardown must release its pipe ends.

    The supervisor legitimately reaps idle workers all day. Every spawn creates three
    pipe descriptors, and until the reader threads closed them on end-of-stream each
    reap cycle leaked them (`ResourceWarning: unclosed file`) until a spawn could no
    longer create a pipe. Deterministic: no child process, just the two readers.
    """

    class _Proc:
        def __init__(self) -> None:
            self.stdout = io.StringIO("payload\n")
            self.stderr = io.StringIO("noise\n")
            self.stdin = io.StringIO()
            # None means "still running", exactly like Popen.poll().
            self.returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

    def test_the_readers_close_their_pipes_and_tolerate_a_race(self):
        from ruke_ml.models.lifecycle import Owned, WorkerPool, _close_stream

        proc = self._Proc()
        proc.returncode = 1                    # output ended because this child is gone
        owned = Owned(capability="documents.parse", proc=proc, created=0,
                      last_used=0.0, heavy=False, resident=[])
        WorkerPool._pump(owned)
        self.assertTrue(proc.stdout.closed, "the stdout reader must release its read end")
        self.assertTrue(proc.stdin.closed, "a dead worker's request pipe is finished with")
        WorkerPool._drain_stderr(owned)
        self.assertTrue(proc.stderr.closed)
        self.assertTrue(owned.drained.is_set())
        # Closing twice, or closing something that is not a stream, is never an error.
        _close_stream(proc.stdout)
        _close_stream(None)
        _close_stream(object())

    def test_a_still_running_worker_keeps_its_request_pipe(self):
        """End of stdout alone never justifies closing the pool's write end.

        Closing stdin from the stdout reader thread made the pool report "worker pipe
        failed" instead of the worker's own typed diagnosis, so the operator lost the
        real cause. `_terminate` is the only place the request pipe may be closed.
        """
        from ruke_ml.models.lifecycle import Owned, WorkerPool

        proc = self._Proc()                    # alive: poll() reports None
        owned = Owned(capability="rerank", proc=proc, created=0,
                      last_used=0.0, heavy=False, resident=[])
        WorkerPool._pump(owned)
        self.assertTrue(proc.stdout.closed)
        self.assertFalse(proc.stdin.closed, "a live worker may still be handed a job")

    def test_reaping_a_worker_releases_its_request_pipe(self):
        """The reaper is the routine path, and it must not leak the write end."""
        from ruke_ml.config import LIMITS
        from ruke_ml.models.lifecycle import Owned, WorkerPool

        proc = self._Proc()
        proc.poll = lambda: 0                  # already exited: no escalation needed
        owned = Owned(capability="rerank", proc=proc, created=0,
                      last_used=0.0, heavy=False, resident=[])
        pool = WorkerPool()
        real_grace = LIMITS.terminate_grace_s
        LIMITS.terminate_grace_s = 0.1
        try:
            pool._terminate(owned, "idle_ttl")
        finally:
            LIMITS.terminate_grace_s = real_grace
        self.assertTrue(proc.stdin.closed, "a retired worker keeps no pipe open")


if __name__ == "__main__":
    unittest.main()
