"""One capability per owned worker process, with lazy per-job imports.

Protocol (line-delimited JSON):
  stdin  : one JobRequest per line, or a control line {"kind": "cancel"|"selftest_*"}
  stdout : one JobResult per request, plus optional {"kind": "progress", ...} lines

Cancellation, stated honestly: a third-party library call that cannot be interrupted
is not interrupted by a flag. The owner stops it by ending the worker process, which is
also how heavy allocator memory is reclaimed. Cooperative cancel events stop OUR OWN
loops (chunking, embedding, windowing) before publication, so a cancelled job never
publishes a partial generation.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
from typing import Any

from ..config import ENV_PARENT_PID
from ..contracts import SCHEMA_VERSION, Coverage, JobRequest, JobResult, StructuredError

_CANCEL = threading.Event()


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _progress(job_id: str, capability: str, state: str, note: str = "") -> None:
    _emit({"kind": "progress", "job_id": job_id, "capability": capability, "state": state, "note": note})


def _failed(req: JobRequest, err: StructuredError) -> JobResult:
    return JobResult(job_id=req.job_id, capability=req.capability, state="failed", error=err)


def _cancelled(req: JobRequest) -> JobResult:
    return JobResult(job_id=req.job_id, capability=req.capability, state="cancelled",
                     error=StructuredError("cancelled", "cancelled before a result was produced",
                                           retryable=True, capability=req.capability,
                                           human_step="re-run the request; no partial result was published"))


# ------------------------------------------------------------------ capability work
def _do_embeddings(req: JobRequest) -> JobResult:
    from ..retrieval.embeddings import embed_texts
    texts = req.payload.get("texts") or []
    if not isinstance(texts, list) or not texts:
        return _failed(req, StructuredError("input_rejected", "embeddings needs a non-empty texts list",
                                            capability="embeddings"))
    mode = str(req.payload.get("quality_mode", "lexical"))
    if _CANCEL.is_set():
        return _cancelled(req)
    _progress(req.job_id, "embeddings", "analysing",
              note=f"{len(texts)} texts, quality_mode={mode}")
    try:
        vectors, meta = embed_texts(texts, quality_mode=mode)
    except ValueError as exc:
        return _failed(req, StructuredError("evaluation_required", str(exc), capability="embeddings",
                                            human_step="run the retrieval quality gate, then pin the selected model"))
    return JobResult(job_id=req.job_id, capability="embeddings", state="ready",
                     payload={"vectors": vectors, "embedding": meta.to_dict(), "quality_mode": mode,
                              "quality_note": "lexical hashing is a baseline; it is not model-quality parity"},
                     model=meta.model)


def _do_rerank(req: JobRequest) -> JobResult:
    from ..retrieval.chunking import Chunk
    from ..retrieval.reranker import rerank
    query = str(req.payload.get("query", ""))
    raw = req.payload.get("chunks") or []
    if not query or not isinstance(raw, list) or not raw:
        return _failed(req, StructuredError("input_rejected", "rerank needs a query and chunks",
                                            capability="rerank"))
    chunks = []
    for c in raw:
        if not isinstance(c, dict) or "chunk_id" not in c or "text" not in c:
            return _failed(req, StructuredError("input_rejected", "each chunk needs chunk_id and text",
                                                capability="rerank"))
        chunks.append(Chunk(chunk_id=str(c["chunk_id"]), text=str(c["text"]),
                            source_id=str(c.get("source_id", "")), source_hash=str(c.get("source_hash", "")),
                            loc=c.get("loc", {}) or {}, block_ids=list(c.get("block_ids", []) or [])))
    mode = str(req.payload.get("mode", "lexical"))
    if _CANCEL.is_set():
        return _cancelled(req)
    _progress(req.job_id, "rerank", "analysing",
              note=f"{len(chunks)} candidates, mode={mode}")
    try:
        scored, used = rerank(query, chunks, mode=mode)
    except ValueError as exc:
        return _failed(req, StructuredError("evaluation_required", str(exc), capability="rerank",
                                            human_step="run the retrieval quality gate, then pin the reranker"))
    limited = scored[: int(req.payload.get("top_k", len(scored)))]
    return JobResult(job_id=req.job_id, capability="rerank", state="ready",
                     payload={"scores": [{"chunk_id": s.chunk.chunk_id, "score": s.score, "rank": i + 1}
                                         for i, s in enumerate(limited)],
                              "mode_actually_used": used, "candidate_count": len(chunks),
                              "returned": len(limited)},
                     coverage=Coverage(units="chunks", total_source=float(len(chunks)),
                                       examined=[(0.0, float(len(chunks)))],
                                       complete=len(limited) >= len(chunks),
                                       note="reranking only reorders candidates it was given; it cannot recover "
                                            "evidence discarded before candidate selection"))


def _do_documents_parse(req: JobRequest) -> JobResult:
    from ..documents import ocr, parser
    from ..security import resolve_within
    path = str(req.payload.get("path", ""))
    root = str(req.payload.get("root", ""))
    if not path or not root:
        return _failed(req, StructuredError("input_rejected", "documents.parse needs path and root",
                                            capability="documents.parse"))
    try:
        target = resolve_within(path, root)
    except Exception as exc:
        return _failed(req, StructuredError("input_rejected", f"path refused: {exc}",
                                            capability="documents.parse",
                                            human_step="place the file inside the allowed upload root"))
    if not target.exists():
        return _failed(req, StructuredError("input_rejected", "file not found inside the allowed root",
                                            capability="documents.parse"))
    if _CANCEL.is_set():
        return _cancelled(req)
    _progress(req.job_id, "documents.parse", "extracting", note=target.name)
    try:
        doc = parser.load_document(target)
    except parser.ExtractionRejected as exc:
        return _failed(req, StructuredError("corrupt_input", str(exc), capability="documents.parse",
                                            human_step="the archive exceeded its bounds or was malformed"))
    except Exception as exc:
        return _failed(req, StructuredError("unsupported_input", f"extraction failed: {exc}",
                                            capability="documents.parse"))
    a = ocr.assess(doc)
    units = doc.coverage.units_total or len(doc.blocks)
    return JobResult(job_id=req.job_id, capability="documents.parse", state="ready",
                     payload={"document": doc.to_dict(), "ocr_route": a.route,
                              "ocr_reasons": a.reasons, "ocr_units": a.units,
                              "coverage_complete": doc.coverage.complete},
                     coverage=Coverage(units="pages" if doc.kind == "pdf" else "units",
                                       total_source=float(units),
                                       examined=[(0.0, float(doc.coverage.units_extracted))],
                                       skipped=[(float(i - 1), float(i)) for i in
                                                sorted(set(doc.coverage.units_failed
                                                          + doc.coverage.units_needing_ocr))],
                                       complete=doc.coverage.complete, note=doc.coverage.note or
                                       "non-empty text is not proof that every unit was understood"))


def _do_video_timeline(req: JobRequest) -> JobResult:
    from ..video.observations import Observation
    from ..video.timeline import MediaMeta, TimelineStore, coverage_reply
    root = str(req.payload.get("root", ""))
    if not root:
        return _failed(req, StructuredError("input_rejected", "video.timeline needs root",
                                            capability="video.timeline"))
    store = TimelineStore(root)
    op = str(req.payload.get("op", "load"))
    if req.capability == "video.observations":
        # The capability name IS the operation for this entry point, so a client cannot
        # ask the observations worker to silently rewrite a baseline instead.
        op = "observe"
    if op == "init":
        _progress(req.job_id, "video.timeline", "indexing", note="upload baseline")
        payload = req.payload.get("meta") or {}
        try:
            meta = MediaMeta(source_id=str(payload["source_id"]), source_hash=str(payload["source_hash"]),
                             duration=float(payload["duration"]), streams=list(payload.get("streams", [])),
                             rotation_deg=int(payload.get("rotation_deg", 0)),
                             has_audio_track=bool(payload.get("has_audio_track", False)),
                             subtitle_tracks=list(payload.get("subtitle_tracks", [])),
                             stream_start_offsets=dict(payload.get("stream_start_offsets", {})))
        except (KeyError, TypeError, ValueError) as exc:
            return _failed(req, StructuredError("input_rejected", f"bad media metadata: {exc}",
                                                capability="video.timeline"))
        rec = store.init_baseline(meta)
        return JobResult(job_id=req.job_id, capability="video.timeline", state="ready",
                         payload={"record": rec, "reply": coverage_reply(rec),
                                  "note": "upload baseline only; no heavy modality was run"})
    if op == "observe":
        h = str(req.payload.get("source_hash", ""))
        stage = str(req.payload.get("stage", ""))
        _progress(req.job_id, "video.timeline", "indexing", note=f"stage={stage}")
        obs: list[Observation] = []
        try:
            for o in req.payload.get("observations", []) or []:
                obs.append(Observation(start=float(o["start"]), end=float(o.get("end", o["start"])),
                                       kind=str(o["kind"]), text=str(o.get("text", "")),
                                       frame_ref=str(o.get("frame_ref", "")),
                                       bbox=o.get("bbox"), audio_state=str(o.get("audio_state", "unknown")),
                                       provider=str(o.get("provider", "")), confidence=o.get("confidence")))
            cov = Coverage.from_dict(req.payload.get("coverage", {}))
        except (KeyError, TypeError, ValueError) as exc:
            return _failed(req, StructuredError("input_rejected", f"bad evidence: {exc}",
                                                capability="video.timeline"))
        try:
            rec = store.add_observations(h, obs, cov, stage)
        except FileNotFoundError:
            return _failed(req, StructuredError("input_rejected", "no baseline record for that source_hash",
                                                capability="video.timeline",
                                                human_step="run op=init at upload time first"))
        return JobResult(job_id=req.job_id, capability="video.timeline", state="ready",
                         payload={"record": rec, "reply": coverage_reply(rec)})
    _progress(req.job_id, "video.timeline", "retrieving", note="timeline record")
    rec = store.load(str(req.payload.get("source_hash", "")))
    if rec is None:
        return _failed(req, StructuredError("input_rejected", "no timeline record for that source",
                                            capability="video.timeline"))
    return JobResult(job_id=req.job_id, capability="video.timeline", state="ready",
                     payload={"record": rec, "reply": coverage_reply(rec)})


def _do_video_scenes(req: JobRequest) -> JobResult:
    from ..video import scenes
    duration = float(req.payload.get("duration", 0.0) or 0.0)
    if duration <= 0:
        return _failed(req, StructuredError("input_rejected", "video.scenes needs a positive duration",
                                            capability="video.scenes"))
    cuts = [float(x) for x in (req.payload.get("cuts") or [])]
    qw = [tuple(float(y) for y in x) for x in (req.payload.get("query_windows") or [])]
    budget = int(req.payload.get("max_windows", 12))
    source = str(req.payload.get("source", "") or "")
    scan = None
    if req.payload.get("detect_cuts") and source:
        # The read side: decode once and take the real timestamps out of the decode.
        # A caller that only passes `cuts` is trusting an upstream claim; a caller that
        # asks us to look gets measured numbers, including how far the scan actually got.
        _progress(req.job_id, "video.scenes", "extracting", note="scene-cut decode scan")
        scan = scenes.scan_scene_cuts(
            source, duration=duration,
            threshold=float(req.payload.get("cut_threshold", 0.35)),
            timeout_s=float(req.payload.get("scan_timeout_s", 120.0)),
            stream_start_offset=float(req.payload.get("stream_start_offset", 0.0)))
        if scan.ok:
            cuts = scan.cuts
    _progress(req.job_id, "video.scenes", "analysing", note=f"duration={duration}s")
    plan = scenes.sample_windows(duration, query_windows=qw or None, cuts=cuts or None, budget=budget,
                                 separate_ranges=bool(req.payload.get("separate_ranges", False)))
    note = plan.honest_note
    if scan is not None:
        if not scan.ok:
            note = (f"{note}; cut detection {scan.error} ({scan.detail}); "
                    "anchors below are head/middle/tail + interval coverage only")
        elif scan.truncated:
            note = (f"{note}; cut scan stopped after {scan.scanned_seconds:.1f}s of "
                    f"{duration:.1f}s, so later cuts are unknown")
    return JobResult(job_id=req.job_id, capability="video.scenes", state="ready",
                     payload={"anchors": [{"start": a.start, "end": a.end, "kind": a.kind, "reason": a.reason}
                                          for a in scenes.anchors(duration, cuts)],
                              "windows": [{"start": w.start, "end": w.end, "kind": w.kind, "reason": w.reason}
                                          for w in plan.windows],
                              "deduped": plan.deduped,
                              "detected_cuts": cuts,
                              "cut_scan": (None if scan is None else {
                                  "cuts": scan.cuts, "ok": scan.ok, "error": scan.error,
                                  "detail": scan.detail, "truncated": scan.truncated,
                                  "scanned_seconds": scan.scanned_seconds,
                                  "threshold": scan.threshold, "elapsed_ms": scan.elapsed_ms}),
                              "ffmpeg_scene_command": scenes.ffmpeg_scene_command(
                                  source or "media"),
                              "note": note},
                     coverage=Coverage(units="seconds", total_source=duration,
                                       examined=[(w.start, w.end) for w in plan.windows],
                                       complete=False, note=note))


def _do_video_hints(req: JobRequest) -> JobResult:
    from ..video.search_hints import build_hints
    from ..video.timeline import TimelineStore
    root = str(req.payload.get("root", ""))
    _progress(req.job_id, "video.search_hints", "retrieving", note="timeline record")
    rec = TimelineStore(root).load(str(req.payload.get("source_hash", ""))) if root else None
    if rec is None:
        return _failed(req, StructuredError("input_rejected", "no timeline record to derive hints from",
                                            capability="video.search_hints",
                                            human_step="index the media first (op=init, then evidence stages)"))
    hints = build_hints(rec)
    return JobResult(job_id=req.job_id, capability="video.search_hints", state="ready",
                     payload={"hints": hints.to_dict(),
                              "queries": hints.to_queries(int(req.payload.get("max_queries", 8)))})


def _do_artifacts(req: JobRequest) -> JobResult:
    # The working artifact engines in this repository are TypeScript (ExcelJS/DOCX/PPTX/PDF).
    # Claiming a Python engine here would be a fiction, so the honest answer is a typed refusal.
    return _failed(req, StructuredError("not_configured",
                                        "no Python artifact engine is installed or evaluated; artifact "
                                        "generation stays with the verified TypeScript engines",
                                        retryable=False, capability=req.capability,
                                        human_step="only migrate after the artifact quality gate selects "
                                                  "a Python writer"))


HANDLERS = {
    "embeddings": _do_embeddings,
    "rerank": _do_rerank,
    "documents.parse": _do_documents_parse,
    "video.timeline": _do_video_timeline,
    "video.observations": _do_video_timeline,
    "video.scenes": _do_video_scenes,
    "video.search_hints": _do_video_hints,
    "artifacts.xlsx": _do_artifacts,
    "artifacts.docx": _do_artifacts,
    "artifacts.pptx": _do_artifacts,
}


def dispatch(req: JobRequest) -> JobResult:
    handler = HANDLERS.get(req.capability)
    if handler is not None:
        return handler(req)
    if req.capability == "documents.ocr":
        from ..documents.ocr import ocr_status
        st = ocr_status()
        return _failed(req, StructuredError("evaluation_required", str(st["detail"]),
                                            capability="documents.ocr", human_step=str(st["human_step"])))
    if req.capability == "speech.asr":
        from ..speech.asr import language_route
        route = language_route(str(req.payload.get("language", "")))
        if route["decision"] in ("not_configured", "unsupported"):
            return _failed(req, StructuredError("not_configured",
                                                f"no ASR route for {route['language']}: {route['note']}",
                                                capability="speech.asr",
                                                human_step=str(route.get("human_step", ""))))
        return _failed(req, StructuredError("evaluation_required",
                                            f"candidate for {route['language']} is not installed/pinned: "
                                            f"{route['note']}", capability="speech.asr",
                                            human_step=str(route.get("human_step")
                                                          or "install and evaluate the candidate model")))
    if req.capability == "speech.align":
        from ..speech.alignment import alignment_supported
        ok, why = alignment_supported(str(req.payload.get("model", "")), str(req.payload.get("language", "")))
        if ok:
            return _failed(req, StructuredError("evaluation_required",
                                                why + "; alignment quality must be measured before use",
                                                capability="speech.align"))
        reason = "unsupported_input" if "does not list" in why else "not_configured"
        return _failed(req, StructuredError(reason, why, capability="speech.align",
                                            human_step="install/verify the aligner, or accept segment-level timing"))
    if req.capability == "speech.diarize":
        from ..speech.asr import license_required_error
        return _failed(req, license_required_error("speech.diarize"))
    return _failed(req, StructuredError("capability_mismatch", f"this worker does not serve {req.capability}",
                                        capability=req.capability))


# ------------------------------------------------------------------ control loop
def _stdin_reader(q: queue.Queue) -> None:
    """Feed the request/control queue from stdin.

    This thread is the worker's only control channel: if it dies, the owner can keep
    writing requests and never get an answer. The loop is therefore wrapped and an
    abnormal exit is announced on stdout as a typed protocol fault, so the owner fails
    the job immediately instead of waiting out a long deadline. (An earlier version
    started this thread without its queue argument, which killed the channel silently
    and made every worker hang until its deadline expired.)
    """
    try:
        for line in sys.stdin:
            q.put(line)
    except BaseException as exc:                     # noqa: BLE001 - must never die silently
        try:
            _emit({"kind": "control_channel_failed", "detail": f"{type(exc).__name__}: {exc}",
                   "schema_version": SCHEMA_VERSION})
        except (OSError, ValueError):
            pass
    q.put(None)


def _parent_watchdog() -> None:
    """A worker must not outlive its owner. Two confirmations avoid a transient API failure."""
    ppid = int(os.environ.get(ENV_PARENT_PID, "0") or 0)
    if ppid <= 0:
        return
    from ..models import resources
    seen_dead = 0
    while not _CANCEL.wait(1.0):
        if resources.process_creation_time(ppid) == 0:
            seen_dead += 1
            if seen_dead >= 2:
                _progress("", "", "failed", note=f"parent {ppid} is gone; worker exiting")
                os._exit(0)
        else:
            seen_dead = 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ruke capability worker")
    ap.add_argument("capability", nargs="?", default="")
    args = ap.parse_args(argv)
    if sys.stdin is None or sys.stdout is None:
        return 2
    q: queue.Queue = queue.Queue()
    threading.Thread(target=_stdin_reader, args=(q,), daemon=True).start()
    threading.Thread(target=_parent_watchdog, daemon=True).start()
    # Handshake first. The owner must be able to tell "started but idle" apart from
    # "started but can never answer"; without this, a broken worker consumes a whole
    # job deadline before anyone notices.
    _emit({"kind": "ready", "capability": args.capability, "pid": os.getpid(),
           "schema_version": SCHEMA_VERSION})
    while True:
        line = q.get()
        if line is None:
            return 0
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            _emit(JobResult(job_id="unknown", capability=args.capability, state="failed",
                            error=StructuredError("contract_mismatch", "control line was not valid JSON")
                            ).to_dict())
            continue
        if not isinstance(obj, dict):
            _emit(JobResult(job_id="unknown", capability=args.capability, state="failed",
                            error=StructuredError("contract_mismatch", "expected a JSON object")
                            ).to_dict())
            continue
        kind = str(obj.get("kind", ""))
        if kind == "cancel":
            _CANCEL.set()
            continue
        if kind == "shutdown":                      # clean exit for idle TTL / owner shutdown
            return 0
        if kind == "selftest_crash":            # test control, never a capability
            os._exit(3)
        if kind == "selftest_slow":
            time.sleep(float(obj.get("seconds", 5.0)))
            continue
        try:
            req = JobRequest.from_dict(obj)
        except Exception as exc:
            _emit(JobResult(job_id=str(obj.get("job_id", "unknown")),
                            capability=str(obj.get("capability", "") or args.capability), state="failed",
                            error=StructuredError("contract_mismatch", str(exc))).to_dict())
            continue
        if req.capability != args.capability:
            _emit(_failed(req, StructuredError("capability_mismatch",
                                               f"worker serves {args.capability!r}, was asked for "
                                               f"{req.capability!r}", capability=req.capability)).to_dict())
            continue
        _progress(req.job_id, req.capability, "preparing")
        try:
            res = dispatch(req)
        except Exception as exc:                 # a library fault is a typed failure, not a lost job
            res = _failed(req, StructuredError("internal", f"{type(exc).__name__}: {exc}", retryable=True,
                                               capability=req.capability,
                                               human_step="retry; if it repeats, report this log line"))
        _emit(res.to_dict())


if __name__ == "__main__":
    raise SystemExit(main())
