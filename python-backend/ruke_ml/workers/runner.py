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
from .. import allocations
from . import jobs as jobs_mod

_CANCEL = threading.Event()


def _retrieval_failure(reason: str, message: str) -> tuple[str, str]:
    """One place that decides what a retrieval-model failure asks of the caller.

    Both retrieval handlers used to hard-code "prepare the pinned asset" for any
    model_unavailable. That is the wrong request when the asset is on disk and the host
    refused the allocation instead (see ruke_ml/allocations.py), and it is also the wrong
    request for a missing dependency. The adapter's own reason wins unless the text proves
    an allocation refusal.
    """
    if reason == "memory_pressure" or allocations.is_allocation_failure(message):
        return "memory_pressure", ("an allocation was refused while loading the pinned model; "
                                   "the asset is already on disk - free RAM/commit or let the "
                                   "resource coordinator run the unload/load handoff, then retry")
    if reason == "model_unavailable":
        return reason, "prepare the pinned embedding asset (see the setup step), then retry"
    if reason == "not_configured":
        return reason, ("install the pinned dependency declared in python-backend/pyproject.toml "
                        "(onnxruntime + tokenizers for the neural retrieval path)")
    return reason, "run the retrieval quality gate, then pin the selected model"

# Which native dependency graph each capability worker must own, in load order (the base
# numeric extension first, so its thread pool is built alone). Deliberately per-capability:
# a document parse that never touches BLAS must not pay for a numpy import it does not use.
_PRELUDE: dict[str, tuple[str, ...]] = {
    "speech.asr": ("numpy", "faster_whisper"),
    "speech.align": ("numpy",),
    # The two neural retrieval capabilities were the last ones to import a native extension
    # lazily, inside a running worker, and it failed the same measured way the ASR path used
    # to: a rerank hung in numpy's C init for 155 s at 0.14 s of CPU while the model file was
    # never even opened (faulthandler showed the identical create_module frame at 30 s, 60 s
    # and 150 s), so every neural rerank ended at its deadline and the candidate order was
    # never produced. Same interpreter, same venv, same wheels: 0.06 s in a fresh child. The
    # graph therefore belongs in the single-threaded handshake, not in the job.
    "rerank": ("numpy", "onnxruntime", "tokenizers"),
    "embeddings": ("numpy", "onnxruntime", "tokenizers"),
}


def _emit(obj: dict[str, Any]) -> None:
    """Write one protocol frame as UTF-8 BYTES, never through the locale text codec.

    The result of a document parse carries the document's own punctuation (curly quotes,
    currency, CJK, Devanagari). If the child's stdout used the Windows ANSI codepage, those
    characters went out as cp1252 bytes into a stream the supervisor reads as UTF-8: the
    reader thread died on the decode and the job was reported as a worker crash, i.e. the
    successful answer was destroyed by its own encoding. `backslashreplace` keeps even a
    lone surrogate (which json can emit for a corrupt filename) inside valid UTF-8.
    """
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    raw = getattr(sys.stdout, "buffer", None)
    if raw is None:                       # stdout was replaced (tests, embedders): text mode
        sys.stdout.write(line)
        sys.stdout.flush()
        return
    try:
        sys.stdout.flush()                # drain the text layer first: no interleaved frames
    except (OSError, ValueError):
        pass
    raw.write(line.encode("utf-8", "backslashreplace"))
    raw.flush()


def _progress(job_id: str, capability: str, state: str, note: str = "") -> None:
    _emit({"kind": "progress", "job_id": job_id, "capability": capability, "state": state, "note": note})


def _failed(req: JobRequest, err: StructuredError) -> JobResult:
    return JobResult(job_id=req.job_id, capability=req.capability, state="failed", error=err)


def _cancelled(req: JobRequest) -> JobResult:
    return JobResult(job_id=req.job_id, capability=req.capability, state="cancelled",
                     error=StructuredError("cancelled", "cancelled before a result was produced",
                                           retryable=True, capability=req.capability,
                                           human_step="re-run the request; no partial result was published"))


def _ctx(req: JobRequest) -> "jobs_mod.JobContext":
    """Bind this worker's cancel event and progress channel into a job context."""
    return jobs_mod.JobContext(req=req, cancel=_CANCEL,
                               progress=lambda state, note: _progress(req.job_id, req.capability,
                                                                      state, note=note))


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
        reason, step = _retrieval_failure(getattr(exc, "reason", "evaluation_required"), str(exc))
        return _failed(req, StructuredError(reason, str(exc), capability="embeddings",
                                            human_step=step))
    return JobResult(job_id=req.job_id, capability="embeddings", state="ready",
                     payload={"vectors": vectors, "embedding": meta.to_dict(), "quality_mode": mode,
                              "quality_note": (
                                  "lexical hashing is a baseline; it is not model-quality parity"
                                  if meta.model.id == "ruke-lexical-hash" else
                                  f"model embeddings from {meta.model.id} ({meta.model.provider}, "
                                  f"dim {meta.dim}); quality is measured, not assumed")},
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
        reason, step = _retrieval_failure(getattr(exc, "reason", "evaluation_required"), str(exc))
        return _failed(req, StructuredError(reason, str(exc), capability="rerank",
                                            human_step=step))
    limited = scored[: int(req.payload.get("top_k", len(scored)))]
    identity: dict[str, object] = {}
    if used != "lexical":
        # Which engine actually scored this matters to the reader: the UI must not be able to
        # show "reranked" while hiding whether a bi-encoder or a cross-encoder ran.
        try:
            if used == "neural_cross_encoder_minilm":
                from ..retrieval.nn_rerank import cross_encoder_identity
                identity = cross_encoder_identity().to_dict()
            else:
                from ..retrieval.nn_embed import neural_meta
                identity = neural_meta().model.to_dict()
        except Exception:                                   # reporting only, never fatal
            identity = {}
    return JobResult(job_id=req.job_id, capability="rerank", state="ready",
                     payload={"scores": [{"chunk_id": s.chunk.chunk_id, "score": s.score, "rank": i + 1}
                                         for i, s in enumerate(limited)],
                              "mode_actually_used": used, "candidate_count": len(chunks),
                              "returned": len(limited),
                              "engine": identity,
                              "quality_note": (
                                  "lexical BM25 baseline reordering only"
                                  if used == "lexical" else
                                  "dense bi-encoder cosine (MiniLM, CPU ONNX); a bi-encoder scores "
                                  "each text separately and is NOT a cross-encoder"
                                  if used == "neural_biencoder_minilm" else
                                  "pinned cross-encoder on CPU ONNX: query and passage are scored "
                                  "jointly in one forward pass; English MS MARCO coverage, and it "
                                  "can only reorder candidates it was given"),
                              "truncation_note": (
                                  "candidates longer than the model window were truncated at the "
                                  "tail; scoring is per pair" if used == "neural_cross_encoder_minilm"
                                  else ""),
                              },
                     coverage=Coverage(units="chunks", total_source=float(len(chunks)),
                                       examined=[(0.0, float(len(chunks)))],
                                       complete=len(limited) >= len(chunks),
                                       note="reranking only reorders candidates it was given; it cannot recover "
                                            "evidence discarded before candidate selection"))


def _do_documents_parse(req: JobRequest) -> JobResult:
    """Extraction with per-unit honesty (kernel B).

    Two false-success paths were removed here. An unsupported extension used to answer
    `ready` with zero blocks, which a caller read as "the document is empty"; and coverage
    used to be the contiguous prefix `[(0, units_extracted)]`, which is a FALSE statement
    whenever the units that worked are not a prefix (pages 1 and 3 succeeding while page 2
    failed used to be reported as two examined pages). Coverage is now derived from the
    recorded unit ids, and the OCR escalation runs the real adapter when the readiness
    gate says it is executable, or says out loud that it did not run.
    """
    from .document_jobs import parse_job
    return parse_job(_ctx(req))


def _do_documents_ocr(req: JobRequest) -> JobResult:
    """Real rasterize+recognise cascade through the external engine (kernel E wiring)."""
    from .document_jobs import ocr_job
    return ocr_job(_ctx(req))


def _do_speech_asr(req: JobRequest) -> JobResult:
    """Transcription through the adapter the registry names, in bounded windows."""
    from .speech_jobs import asr_job
    return asr_job(_ctx(req))


def _do_speech_align(req: JobRequest) -> JobResult:
    """Word timing only when a provider really supplies it; segment spans stay spans."""
    from .speech_jobs import align_job
    return align_job(_ctx(req))


def _do_speech_diarize(req: JobRequest) -> JobResult:
    from ..speech.asr import license_required_error
    return _failed(req, license_required_error("speech.diarize"))


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
            horizon = (f"{scan.scanned_seconds:.1f}s decoded" if scan.prefix_measured
                       else "an unmeasured amount")
            note = (f"{note}; cut scan stopped after {horizon} of {duration:.1f}s, "
                    "so later cuts are unknown")
    stage_anchors = [{"start": a.start, "end": a.end, "kind": a.kind, "reason": a.reason}
                     for a in scenes.anchors(duration, cuts)]
    # anchors() already labels each cut anchor as a POINT whose window is only a
    # sampling suggestion; the worker must not rewrite that provenance here.
    return JobResult(job_id=req.job_id, capability="video.scenes", state="ready",
                     payload={"anchors": stage_anchors,
                              "windows": [{"start": w.start, "end": w.end, "kind": w.kind, "reason": w.reason}
                                          for w in plan.windows],
                              "deduped": plan.deduped,
                              "detected_cuts": cuts,
                              "cut_scan": (None if scan is None else {
                                  "cuts": scan.cuts, "ok": scan.ok, "error": scan.error,
                                  "detail": scan.detail, "truncated": scan.truncated,
                                  "scanned_seconds": scan.scanned_seconds,
                                  "prefix_measured": scan.prefix_measured,
                                  "progress_updates": scan.progress_updates,
                                  "log_chars": scan.log_chars, "log_capped": scan.log_capped,
                                  "threshold": scan.threshold, "elapsed_ms": scan.elapsed_ms}),
                              # The measured stage, kept separate from the plan on purpose:
                              # a decode prefix is evidence about the DECODER, and a plan is
                              # evidence about nothing yet.
                              "stages": {"sampling_plan": {
                                             "windows": len(plan.windows),
                                             "planned_seconds": plan.planned_seconds,
                                             "claims_inspected_coverage": False},
                                         "decode_scan": (None if scan is None else {
                                             "measured_prefix_s": scan.scanned_seconds,
                                             "prefix_measured": scan.prefix_measured,
                                             "truncated": scan.truncated,
                                             "detected_cuts": len(scan.cuts)})},
                              "ffmpeg_scene_command": scenes.ffmpeg_scene_command(
                                  source or "media"),
                              "note": note},
                     # Coverage for THIS job is a plan, so it examined nothing. Real evidence
                     # arrives through the stages that actually decode frames, recorded via
                     # video.timeline's add_observations, never by borrowing the plan's numbers.
                     coverage=Coverage(
                         units="seconds",
                         total_source=duration,
                         examined=[],
                         skipped=[(0.0, duration)] if duration > 0 else [],
                         complete=False,
                         note="Sampling plan only; visual observations are recorded separately."))


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


def _do_video_frame_ocr(req: JobRequest) -> JobResult:
    """Decode frames and READ their visible text: the stage that makes visual evidence real."""
    from .video_jobs import frame_ocr_job
    return frame_ocr_job(_ctx(req))


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
    "documents.ocr": _do_documents_ocr,
    "speech.asr": _do_speech_asr,
    "speech.align": _do_speech_align,
    "speech.diarize": _do_speech_diarize,
    "video.timeline": _do_video_timeline,
    "video.observations": _do_video_timeline,
    "video.scenes": _do_video_scenes,
    "video.search_hints": _do_video_hints,
    "video.frame_ocr": _do_video_frame_ocr,
    "artifacts.xlsx": _do_artifacts,
    "artifacts.docx": _do_artifacts,
    "artifacts.pptx": _do_artifacts,
}

# Capabilities whose handler consults the registry readiness gate before doing any work.
# These are exactly the ones that used to answer with a FIXED failure regardless of what
# was installed, so the gate is what makes "the report says available" and "the job runs"
# the same statement. video.* keeps its own typed probes (it already distinguishes a
# missing decoder from a corrupt file), but video.frame_ocr is the exception: it needs a
# validated DECODER and a validated RECOGNISER at once, and the gate is what stops a host
# that has one of them from reporting a capability that cannot actually run.
# documents.parse is served by built-in readers and needs no gate.
GATED = ("documents.ocr", "speech.asr", "speech.align", "speech.diarize", "video.frame_ocr")


def dispatch(req: JobRequest) -> JobResult:
    handler = HANDLERS.get(req.capability)
    if handler is not None:
        if req.capability in GATED:
            err = jobs_mod.readiness_gate(req.capability)
            if err is not None:
                return _failed(req, err)
        return handler(req)
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


def _prelude(capability: str) -> dict[str, Any]:
    """Build this capability's heavy dependency graph while the process is single-threaded.

    Measured reason, not superstition: with the ASR path importing numpy lazily inside a
    job, the extension module was mapped into the worker but its C init never returned -
    faulthandler reported the identical frame at 12s, 24s, 48s and 108s while the worker
    had used 0.14s of CPU, and every non-silent transcription ended at its deadline. The
    same interpreter imports the identical graph in 0.27s in a fresh child, so the import
    does not belong in the middle of a running worker: doing it here makes the cost
    deterministic, moves it inside the startup handshake where it can be measured, and
    keeps the BLAS thread pool from being built alongside the control threads.

    An absent optional dependency is reported on the handshake, not turned into a crash:
    the job path still answers with its typed readiness error.
    """
    mods = _PRELUDE.get(capability, ())
    if not mods:
        return {}
    started = time.perf_counter()
    imported: list[str] = []
    failures: list[str] = []
    for name in mods:
        try:
            __import__(name)
            imported.append(name)
        except (ImportError, OSError, ValueError) as exc:
            failures.append(f"{name}: {type(exc).__name__}: {str(exc)[:160]}")
    return {"imports": imported, "import_failures": failures,
            "prelude_ms": int((time.perf_counter() - started) * 1000)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ruke capability worker")
    ap.add_argument("capability", nargs="?", default="")
    args = ap.parse_args(argv)
    if sys.stdin is None or sys.stdout is None:
        return 2
    prelude = _prelude(args.capability)
    q: queue.Queue = queue.Queue()
    threading.Thread(target=_stdin_reader, args=(q,), daemon=True).start()
    threading.Thread(target=_parent_watchdog, daemon=True).start()
    # Handshake first. The owner must be able to tell "started but idle" apart from
    # "started but can never answer"; without this, a broken worker consumes a whole
    # job deadline before anyone notices.
    _emit({"kind": "ready", "capability": args.capability, "pid": os.getpid(),
           "schema_version": SCHEMA_VERSION, "prelude": prelude})
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
            # A crash without any stderr is undiagnosable: the owner reports the worker's
            # own last words, so the injected fault has to leave some.
            print("selftest_crash: injected helper fault (test control)", file=sys.stderr, flush=True)
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
