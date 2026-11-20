"""G3 live-route evidence: the PINNED cross-encoder through the supervisor /job route.

This is the route probe, not the quality probe. Quality lives in
probes/g05_cross_encoder_probe.py with the frozen n=10 answer key; what this file
establishes is that a real capability WORKER, running the pinned ONNX cross-encoder,
answers the same contract the production caller (lib/server/attachindex/rerank.ts)
sends, and it measures the memory the worker actually holds while doing it.

Recorded facts, all measured, none inferred:
  * the worker reports mode_actually_used, engine identity (id + pinned revision) and
    provider - so "neural" can never be a relabelled lexical run at this layer;
  * scores are finite probabilities, one per candidate, ranked 1..n;
  * an identical second call reproduces the same order (warm worker, deterministic);
  * asking for the lexical baseline still gets lexical, and it is REPORTED as lexical;
  * an unknown mode is a typed failure, never a silent substitution;
  * peak working set / commit of the supervisor + worker tree during the job, sampled
    from the OS (K32GetProcessMemoryInfo), plus the released value afterwards.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]  # docs/overnight/probes/<this file> -> repo root
sys.path.insert(0, str(REPO / "python-backend"))

from ruke_ml.models import resources                       # noqa: E402
from ruke_ml.retrieval.nn_rerank import (                  # noqa: E402
    MODEL_ID, MODE_NAME, PINNED_REVISION, PROVIDER,
)

DISCOVERY = REPO / ".data" / "python" / "supervisor.json"

# Four passages, three of them plausible; the expected one is the passage that answers
# the question by content. Authored before this run, same discipline as g05.
QUERY = "How many crates arrived at the depot on Tuesday?"
CANDIDATES = [
    ("c0", "On Tuesday, 61 crates arrived at the depot."),
    ("c1", "On Tuesday, 99 crates arrived at the depot."),
    ("c2", "The depot closed early on Friday because of a power outage."),
    ("c3", "Crate deliveries are scheduled weekly by the regional planner."),
]
EXPECTED = "c1"


def post_job(base: str, token: str, payload: dict, deadline_s: float = 90.0) -> tuple[int, dict]:
    body = json.dumps({
        "schema_version": 1,
        "request_id": f"probe_{int(time.time()*1000)}",
        "run_id": "run_g06",
        "job_id": f"g06_{payload.get('tag', 'job')}",
        "capability": "rerank",
        "deadline_s": deadline_s,
        "payload": {k: v for k, v in payload.items() if k != "tag"},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/job", data=body, method="POST",
        headers={"content-type": "application/json", "X-Ruke-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=deadline_s + 20) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"state": "failed", "raw": raw[:400]}


class Sampler(threading.Thread):
    """Peak OS-level memory of the supervisor tree, sampled while the job runs."""

    def __init__(self, root_pid: int, interval_s: float = 0.1) -> None:
        super().__init__(daemon=True)
        self.root_pid, self.interval_s = root_pid, interval_s
        self.stop = threading.Event()
        self.peak_ws = 0.0
        self.peak_commit = 0.0
        self.peak_pids: list[int] = []
        self.samples = 0
        self.baseline_ws = 0.0

    def run(self) -> None:
        first = True
        while not self.stop.is_set():
            snap = resources.process_tree_memory(self.root_pid)
            if snap.get("available"):
                ws = float(snap.get("working_set_mib", 0))
                cm = float(snap.get("commit_mib", 0))
                if first:
                    self.baseline_ws = ws
                    first = False
                if ws > self.peak_ws:
                    self.peak_ws, self.peak_pids = ws, list(snap.get("pids", []))
                self.peak_commit = max(self.peak_commit, cm)
                self.samples += 1
            time.sleep(self.interval_s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    ap.add_argument("--idle-wait", type=float, default=130.0,
                    help="seconds to wait for the idle-TTL worker release (0 skips)")
    args = ap.parse_args()

    disc = json.loads(DISCOVERY.read_text(encoding="utf-8"))
    base = f"http://{disc['host']}:{disc['port']}"
    token = Path(disc["secret_file"]).read_text(encoding="utf-8").strip()
    sup_pid = int(disc["pid"])

    checks: list[dict] = []
    def check(name: str, ok: bool, detail: object = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)

    print(f"supervisor {base} pid={sup_pid} (owned by the running dev tree)")
    sampler = Sampler(sup_pid)
    sampler.start()
    t0 = time.time()

    status, cold = post_job(base, token, {
        "tag": "cold", "query": QUERY, "mode": MODE_NAME, "top_k": len(CANDIDATES),
        "chunks": [{"chunk_id": cid, "text": txt} for cid, txt in CANDIDATES],
    })
    cold_ms = round((time.time() - t0) * 1000)

    payload = cold.get("payload") or {}
    scores = payload.get("scores") or []
    check("cold call reaches a real worker (HTTP 200 + ready)",
          status == 200 and cold.get("state") == "ready",
          f"status={status} state={cold.get('state')} err={(cold.get('error') or {}).get('reason')}")
    check("the engine says it ran the PINNED cross-encoder, not lexical",
          payload.get("mode_actually_used") == MODE_NAME,
          payload.get("mode_actually_used"))
    eng = payload.get("engine") or {}
    check("engine identity matches the pinned model/revision",
          eng.get("id") == MODEL_ID and eng.get("revision") == PINNED_REVISION,
          f"{eng.get('id')} @ {str(eng.get('revision'))[:24]} provider={eng.get('provider')}")
    check("provider is CPU ONNX (no GPU compute for processing jobs)",
          eng.get("provider") == PROVIDER, eng.get("provider"))
    check("one finite probability per candidate, ranked 1..n",
          len(scores) == len(CANDIDATES)
          and all(0.0 <= float(s.get("score", -1)) <= 1.0 for s in scores)
          and [s.get("rank") for s in scores] == list(range(1, len(CANDIDATES) + 1)),
          [round(float(s.get("score", 0)), 4) for s in scores])
    check("coverage says the whole candidate field was examined",
          bool((cold.get("coverage") or {}).get("complete")),
          (cold.get("coverage") or {}).get("note", "")[:70])

    t1 = time.time()
    status2, warm = post_job(base, token, {
        "tag": "warm", "query": QUERY, "mode": MODE_NAME, "top_k": len(CANDIDATES),
        "chunks": [{"chunk_id": cid, "text": txt} for cid, txt in CANDIDATES],
    })
    warm_ms = round((time.time() - t1) * 1000)
    p2 = warm.get("payload") or {}
    order_cold = [s.get("chunk_id") for s in scores]
    order_warm = [s.get("chunk_id") for s in (p2.get("scores") or [])]
    check("a warm repeat call reproduces the order",
          status2 == 200 and order_cold == order_warm, f"{order_cold} -> {order_warm} in {warm_ms} ms")
    check("the expected passage ranks first on this item",
          (order_warm or [""])[0] == EXPECTED, f"expected {EXPECTED}, got {(order_warm or [''])[0]}")

    # Honest fallback: asking for lexical gets lexical, reported as lexical.
    status3, lex = post_job(base, token, {
        "tag": "lexical", "query": QUERY, "mode": "lexical", "top_k": len(CANDIDATES),
        "chunks": [{"chunk_id": cid, "text": txt} for cid, txt in CANDIDATES],
    })
    lp = lex.get("payload") or {}
    check("a lexical request is served AND reported as lexical",
          status3 == 200 and lp.get("mode_actually_used") == "lexical",
          f"state={lex.get('state')} mode={lp.get('mode_actually_used')}")

    # An unknown mode must be refused with a typed error, not silently served by a neighbour.
    status4, bad = post_job(base, token, {
        "tag": "badmode", "query": QUERY, "mode": "neural_gpt4_all_pro", "top_k": 4,
        "chunks": [{"chunk_id": cid, "text": txt} for cid, txt in CANDIDATES],
    })
    check("an unknown mode is a typed failure, not a substitution",
          status4 != 200 and (bad.get("error") or {}).get("reason"),
          f"status={status4} reason={(bad.get('error') or {}).get('reason')}")

    after_ws = resources.process_tree_memory(sup_pid)
    sampler.stop.set()
    sampler.join(timeout=2)

    workers = []
    try:
        req = urllib.request.Request(f"{base}/health", headers={"X-Ruke-Token": token})
        with urllib.request.urlopen(req, timeout=5) as res:
            # urllib has no .json(); the snapshot is the supervisor's own status payload, which
            # carries the worker report including each worker's startup prelude.
            workers = json.loads(res.read().decode("utf-8", "replace"))
    except Exception as exc:                                     # reporting only
        workers = {"error": str(exc)}

    released_ws = None
    if args.idle_wait > 0:
        print(f"waiting {args.idle_wait:.0f} s for the idle-TTL worker release...", flush=True)
        time.sleep(args.idle_wait)
        released_ws = resources.process_tree_memory(sup_pid)

    peak_bytes = int(round(sampler.peak_ws * (1 << 20)))
    commit_bytes = int(round(sampler.peak_commit * (1 << 20)))
    out = {
        "capability": "rerank",
        "endpoint": base,
        "supervisor_pid": sup_pid,
        "mode_requested": MODE_NAME,
        "model": {"id": MODEL_ID, "revision": PINNED_REVISION, "provider": PROVIDER},
        "cold_call_ms": cold_ms, "warm_call_ms": warm_ms,
        "order_cold": order_cold, "order_warm": order_warm, "expected": EXPECTED,
        "scores_cold": scores,
        "lexical_reported": lp.get("mode_actually_used"),
        "bad_mode": {"status": status4, "error": bad.get("error")},
        "memory": {
            "samples": sampler.samples,
            "baseline_tree_working_set_mib": round(sampler.baseline_ws, 1),
            "peak_tree_working_set_mib": round(sampler.peak_ws, 1),
            "peak_tree_commit_mib": round(sampler.peak_commit, 1),
            "peak_bytes": peak_bytes,
            "commit_bytes": commit_bytes,
            "pids_at_peak": sampler.peak_pids,
            "after_job_working_set_mib": round(float(after_ws.get("working_set_mib", 0)), 1),
            "after_idle_release_working_set_mib": (
                None if released_ws is None
                else round(float(released_ws.get("working_set_mib", 0)), 1)),
            "definition": "K32GetProcessMemoryInfo summed over the supervisor pid and its "
                          "owned worker children; working set = resident RAM, commit = "
                          "pagefile charge; the 5,000,000,000 B ceiling is a COMMIT ceiling",
        },
        "limits": {"mem_ceiling_bytes": 5_000_000_000, "target_bytes": 4_000_000_000},
        "health": workers,
        "checks": checks,
    }
    text = json.dumps(out, indent=2, ensure_ascii=False)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    failed = [c["name"] for c in checks if not c["ok"]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed; "
          f"peak tree working set {sampler.peak_ws:.1f} MiB / commit {sampler.peak_commit:.1f} MiB")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
