"""THE OCR CHILD PROCESS. Runs under python-backend/.venv-ocr, NOT the backend venv.

Deliberate constraints, because this file is the memory boundary:
  * it imports ONLY the standard library plus paddleocr - never ruke_ml. Importing the
    package would drag the supervisor's own dependency set (onnxruntime, faster-whisper,
    numpy builds) into the process that is already loading 2 GB of OCR weights.
  * it is one process per JOB, not per page: a second copy of the runtime would double the
    peak the budget is measured against.
  * it never downloads: the two model directories come from the header, and the child's
    cache variables are pinned project-local by the parent.
  * it echoes the device it ACTUALLY resolved. A plan that said cpu and an echo of gpu is a
    contradiction the parent refuses rather than reports as success.

Protocol (one JSON object per line, stdout only - diagnostics go to stderr):
  -> {"header":{"vl_rec_model_dir":...,"layout_model_dir":...,"device":"cpu","cpu_threads":4}}
  <- {"event":"ready","device":"cpu","cuda_compiled":false,"paddle_version":...,"dropped":[]}
  <- {"event":"error","stage":"load","detail":...,"allocation_refusal":<token>}  (only when the
     engine itself said the allocator refused - the parent then reports a resource limit, not a
     load failure, and keeps the ceiling arithmetic alongside it)
  -> {"page":3,"image":"D:\\...\\page-0003.png"}
  <- {"page":3,"state":"recognised","text":...,"regions":[...],"raw_json_path":...,"markdown_path":...}
  -> {"event":"shutdown"}

The result surface is the pinned paddleocr 3.6.0 / paddlex 3.6.1 contract, read off the
installed source rather than assumed: `res.json` is `{"res": {...}}` and that payload carries
`parsing_res_list` entries with `block_label`, `block_content` and `block_bbox`; markdown
comes from `res.markdown["markdown_texts"]`. If a future build changes that shape, the worker
says what keys it actually saw and marks the page unresolved - it never invents text.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# Set by the parent when RUKE_OCR_FAULT=crash. The point is to reproduce a worker death WITHOUT
# loading 1.9 GB of weights: the handshake, the page write, the death, the kill/release and the
# caller's per-unit fallback all still happen for real. Nothing here ever reports a text result.
FAULT_ENV = "RUKE_OCR_WORKER_FAULT"


def fault_mode() -> str:
    return (os.environ.get(FAULT_ENV) or "").strip().lower()


# Whether a failure names a REFUSED allocation. The authoritative marker list lives in the parent
# package (ruke_ml/allocations.py::ALLOCATED_REFUSED_MARKERS) and is handed to this child in the
# header, because this file must not import ruke_ml (see the module docstring); the tuple below is
# only the fallback for a header that did not carry one. Why the child marks this at all: "the
# allocator said no" is a resource condition, never an engine defect, and the parent must not have
# to infer it from a job-object peak ratio - one large request can be refused while the kernel peak
# stays far below the ceiling, which is how the 2026-11-18 cold load died.
# Kept byte-for-byte equal to ruke_ml/allocations.py::ALLOCATED_REFUSED_MARKERS, which is the
# single authority; tests/test_ocr_resource_window.py pins the two sets equal so a one-sided edit
# fails a test instead of silently making a child deaf to an MKL/CUDA refusal.
DEFAULT_MEMORY_REFUSAL_MARKERS = (
    "mkl_malloc",
    "failed to allocate",
    "could not allocate",
    "cannot allocate",
    "can't allocate",
    "unable to allocate",
    "allocation failed",
    "not enough memory",
    "insufficient memory",
    "out of memory",
    "memoryerror",
    "bad_alloc",
    "paging file is too small",
    "the paging file",
    "0x8007000e",
    "0x800705af",
    "cuda out of memory",
    "cudnn out of memory",
    "std::alloc",
    "std::bad_alloc",
)
MEMORY_REFUSAL_MARKERS: tuple[str, ...] = DEFAULT_MEMORY_REFUSAL_MARKERS


def set_memory_markers(markers) -> str:
    """Take the marker list from the header. Returns what was actually installed, for the echo."""
    global MEMORY_REFUSAL_MARKERS
    cleaned = tuple(str(marker).strip().lower() for marker in (markers or ())
                    if str(marker).strip())
    MEMORY_REFUSAL_MARKERS = cleaned or DEFAULT_MEMORY_REFUSAL_MARKERS
    return ("header" if cleaned else "builtin fallback")


def memory_refusal_signal(*parts) -> str:
    """The marker that marks this failure as a refused allocation, or "" if nothing says so."""
    text = " ".join(str(part or "") for part in parts).lower()
    for marker in MEMORY_REFUSAL_MARKERS:
        if marker in text:
            return marker
    return ""


def read_line():
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return {}
    try:
        return json.loads(line)
    except ValueError as exc:
        log(f"bad request line: {exc}")
        return {}


def device_echo() -> dict:
    """What paddle ACTUALLY resolved, as a claim the parent can check."""
    out: dict = {}
    try:
        import paddle                                   # noqa: PLC0415

        out["device"] = str(paddle.device.get_device())
        out["cuda_compiled"] = bool(paddle.device.is_compiled_with_cuda())
        out["paddle_version"] = str(getattr(paddle, "__version__", ""))
    except Exception as exc:                            # noqa: BLE001
        out["device_error"] = f"{type(exc).__name__}: {exc}"
    return out


def dtype_policy(header: dict) -> dict:
    """Say what numeric format this pinned build will ACTUALLY use, in the build's own terms.

    Why this exists: the header sends `precision: "fp32"`, and it is tempting to read that as "the
    run is fp32, so it costs X bytes" - or, worse, as a knob that could be turned to fit a memory
    ceiling. In the pinned paddleocr 3.6 that kwarg maps to `pptrt_precision`, the precision of the
    TensorRT subgraph engine (paddleocr/_common_args.py, _constants.py SUPPORTED_PRECISION_LIST =
    ["fp32","fp16"]), which a CPU run does not use at all. The doc-VLM predictor chooses bfloat16
    only when `is_bfloat16_available(device)` is true, and that helper returns true only for
    gpu/npu/xpu/mlu/metax/iluvatar (paddlex/inference/models/doc_vlm/predictor.py,
    paddlex/inference/utils/misc.py). On CPU that means float32 weights, which is a fact about the
    pinned pair, not a configuration choice - measured 2026-11-18, when the load was killed by a
    3,814 MiB commit ceiling while mapping model.safetensors.
    """
    out: dict = {
        "available": True,
        "requested_precision": str(header.get("precision") or ""),
        "requested_device": str(header.get("device") or "cpu"),
        "precision_kwarg_scope": (
            "paddleocr 3.6 maps 'precision' to pptrt_precision, the TensorRT subgraph engine "
            "precision; on a CPU inference engine it selects no weight dtype at all"),
    }
    try:
        import paddle                                   # noqa: PLC0415

        out["device"] = str(paddle.device.get_device())
        out["cuda_compiled"] = bool(paddle.device.is_compiled_with_cuda())
    except Exception as exc:                            # noqa: BLE001
        out["device_error"] = f"{type(exc).__name__}: {exc}"
        return out
    try:
        from paddlex.inference.utils.misc import is_bfloat16_available   # noqa: PLC0415

        out["bfloat16_available_for_device"] = bool(is_bfloat16_available(str(out["device"])))
        out["bfloat16_basis"] = (
            "paddlex doc_vlm predictor selects bfloat16 only when is_bfloat16_available(device) "
            "is true; on this device the weights load as float32"
            if not out["bfloat16_available_for_device"] else
            "this device can select bfloat16; the dtype actually used still has to be read from "
            "the predictor's own configuration")
    except Exception as exc:                            # noqa: BLE001
        # Unknown, never False: an unreadable helper does not prove the run is float32.
        out["bfloat16_available_for_device"] = None
        out["bfloat16_basis"] = (f"the pinned bf16-availability helper was not readable "
                                 f"({type(exc).__name__}: {exc}), so the selected dtype is UNKNOWN")
    return out


def build_pipeline(header: dict) -> tuple[object, list[str]]:
    """Instantiate the FULL PaddleOCR-VL pipeline (layout analysis + recognition + assembly).

    Unknown keyword arguments are dropped ONE at a time and reported, because a pinned build
    that no longer accepts a knob must not be silently reinterpreted: whatever was dropped is
    part of the evidence, and a dropped layout knob changes what the run can claim.
    """
    from paddleocr import PaddleOCRVL                     # noqa: PLC0415

    kwargs: dict = {
        "pipeline_version": header.get("pipeline_version") or "v1.6",
        "device": header.get("device") or "cpu",
        # Queues spawn extra producer/consumer processes and their own buffers; with a 5 GB
        # aggregate ceiling the single-process form is the one that can be accounted for.
        "use_queues": False,
        "cpu_threads": int(header.get("cpu_threads") or 4),
        # Layout analysis is the point of the pipeline, so it stays on. The doc-preprocessor
        # models (orientation classify / unwarping) are two EXTRA models: orientation is
        # handled deterministically at rasterization instead, and both flags are reported.
        "use_layout_detection": True,
        "use_doc_orientation_classify": bool(header.get("use_doc_orientation_classify", False)),
        "use_doc_unwarping": bool(header.get("use_doc_unwarping", False)),
    }
    if header.get("vl_rec_model_dir"):
        kwargs["vl_rec_model_dir"] = str(header["vl_rec_model_dir"])
    if header.get("layout_model_dir"):
        kwargs["layout_detection_model_dir"] = str(header["layout_model_dir"])
    if header.get("precision"):
        kwargs["precision"] = str(header["precision"])
    if "enable_mkldnn" in header:
        kwargs["enable_mkldnn"] = bool(header["enable_mkldnn"])

    dropped: list[str] = []
    while True:
        try:
            return PaddleOCRVL(**kwargs), dropped
        except TypeError as exc:
            text = str(exc)
            token = None
            for name in list(kwargs):
                if f"'{name}'" in text or f'"{name}"' in text or f" {name}" in text:
                    token = name
                    break
            if token is None or len(dropped) >= 6:
                raise
            log(f"pinned pipeline does not accept {token!r}; dropping it and recording that")
            kwargs.pop(token)
            dropped.append(token)


def extract(res: object, scratch_dir: str, page: int) -> dict:
    """Turn one pipeline result into text + regions + on-disk raw evidence."""
    out: dict = {"state": "ocr_failed", "text": "", "regions": [], "confidence": None}
    json_path = ""
    md_path = ""
    try:
        payload_all = res.json                      # type: ignore[attr-defined]
    except Exception as exc:                        # noqa: BLE001
        out["detail"] = f"result.json unavailable: {type(exc).__name__}: {exc}"
        return out
    body = payload_all.get("res") if isinstance(payload_all, dict) else None
    if not isinstance(body, dict):
        out["detail"] = f"result.json had no 'res' payload; keys seen: {sorted(payload_all)[:20] if isinstance(payload_all, dict) else type(payload_all).__name__}"
        return out

    try:
        import os                                    # noqa: PLC0415

        json_path = os.path.join(scratch_dir, f"page-{page:04d}-paddle.json")
        with open(json_path, "w", encoding="utf-8") as handle:
            json.dump(payload_all, handle, ensure_ascii=False, default=str)
    except OSError as exc:
        log(f"raw json not saved for page {page}: {exc}")

    try:
        markdown = res.markdown                     # type: ignore[attr-defined]
        md_text = markdown.get("markdown_texts", "") if isinstance(markdown, dict) else str(markdown)
    except Exception as exc:                        # noqa: BLE001
        md_text = ""
        out["markdown_error"] = f"{type(exc).__name__}: {exc}"
    if md_text:
        try:
            import os                                # noqa: PLC0415

            md_path = os.path.join(scratch_dir, f"page-{page:04d}-paddle.md")
            with open(md_path, "w", encoding="utf-8") as handle:
                handle.write(md_text)
        except OSError:
            pass

    blocks = body.get("parsing_res_list")
    regions: list[dict] = []
    texts: list[str] = []
    if isinstance(blocks, list) and blocks:
        for index, block in enumerate(blocks):
            label = getattr(block, "label", None)
            bbox = getattr(block, "bbox", None)
            content = getattr(block, "content", None)
            if label is None and isinstance(block, dict):
                label = block.get("block_label")
                bbox = block.get("block_bbox")
                content = block.get("block_content")
            text = "" if content is None else str(content).strip()
            box = None
            try:
                if bbox is not None:
                    box = [int(float(v)) for v in list(bbox)[:4]]
            except (TypeError, ValueError):
                box = None
            regions.append({"order": index, "label": str(label or ""), "bbox": box, "text": text})
            if text:
                texts.append(text)
        out["regions"] = regions
        out["text"] = "\n\n".join(texts)
        out["state"] = "recognised" if texts else "empty"
        if not texts:
            out["detail"] = (f"the pipeline returned {len(blocks)} block(s) with no text content "
                             f"(labels: {sorted({r['label'] for r in regions})[:12]})")
        return out

    # Second documented surface: the plain-text OCR result of the layout stage.
    plain = body.get("overall_ocr_res") or body.get("ocr_res")
    if isinstance(plain, dict):
        lines = plain.get("rec_texts") or plain.get("text") or []
        if isinstance(lines, list) and any(str(x).strip() for x in lines):
            out["regions"] = [{"order": i, "label": "text", "bbox": None, "text": str(t)}
                              for i, t in enumerate(lines) if str(t).strip()]
            out["text"] = "\n".join(r["text"] for r in out["regions"])
            scores = plain.get("rec_scores")
            if isinstance(scores, list) and scores:
                try:
                    out["confidence"] = round(sum(float(s) for s in scores) / len(scores), 4)
                except (TypeError, ValueError):
                    out["confidence"] = None
            out["state"] = "recognised"
            return out

    if md_text.strip():
        out["text"] = md_text.strip()
        out["state"] = "recognised"
        out["detail"] = "no block list; markdown text used"
        out["regions"] = [{"order": 0, "label": "markdown", "bbox": None, "text": out["text"]}]
        return out

    out["detail"] = ("no recognised block surface in the result; payload keys seen: "
                     + ", ".join(sorted(body)[:25]))
    out["raw_json_path"] = json_path
    return out


def main() -> int:
    header = read_line()
    if not isinstance(header, dict) or "header" not in header:
        emit({"event": "error", "stage": "header", "detail": "first line must be the header"})
        return 2
    header = header["header"] or {}
    scratch_dir = str(header.get("scratch_dir") or ".")
    # Which marker list this child will use to call something an allocation refusal. Recorded in
    # the ready echo so the evidence says whether the parent's authoritative list arrived.
    marker_source = set_memory_markers(header.get("memory_refusal_markers"))

    fault = fault_mode()
    if fault == "crash":
        log(f"{FAULT_ENV}=crash: the pipeline was NOT loaded; no inference will run")
        emit({"event": "ready", "stage": "load", "seconds": 0.0,
              "device": str(header.get("device") or "cpu"), "cuda_compiled": False,
              "paddle_version": "not-loaded(fault-injected)", "dropped_kwargs": [],
              "fault": "crash",
              "detail": "fault-injected ready handshake; no weights were loaded"})
        request = read_line()
        if isinstance(request, dict) and request.get("event") == "shutdown":
            log("shutdown received before the injected death")
            return 0
        log("fault-injected worker death at the first page request")
        return 9

    started = time.time()
    try:
        pipeline, dropped = build_pipeline(header)
    except Exception as exc:                            # noqa: BLE001
        log(traceback.format_exc())
        payload = {"event": "error", "stage": "load",
                   "detail": f"{type(exc).__name__}: {exc}",
                   "seconds": round(time.time() - started, 2)}
        refusal = memory_refusal_signal(type(exc).__name__, str(exc))
        if refusal:
            # The engine named the refusal. Say so on the wire instead of letting the parent guess
            # from an exit code: this child can be killed mid-mmap before any Python exception
            # exists, and can also raise one whose kernel peak never reaches the ceiling.
            payload["allocation_refusal"] = refusal
        emit(payload)
        return 3

    echo = device_echo()
    echo["dtype_policy"] = dtype_policy(header)
    echo.update({"event": "ready", "stage": "load",
                 "seconds": round(time.time() - started, 2),
                 "dropped_kwargs": dropped,
                 "memory_marker_source": marker_source,
                 "requested_device": header.get("device") or "cpu"})
    emit(echo)

    while True:
        request = read_line()
        if request is None:
            break
        if not request:
            continue
        if request.get("event") == "shutdown":
            break
        page = int(request.get("page") or 0)
        image = str(request.get("image") or "")
        if not image:
            emit({"page": page, "state": "ocr_failed", "detail": "no image path in the request"})
            continue
        page_started = time.time()
        try:
            results = list(pipeline.predict(image))         # noqa: PLC0415
            if not results:
                emit({"page": page, "state": "ocr_failed",
                      "detail": "the pipeline returned no result object for this image",
                      "seconds": round(time.time() - page_started, 2)})
                continue
            merged = extract(results[0], scratch_dir, page)
            if len(results) > 1:
                merged["extra_result_objects"] = len(results) - 1
        except Exception as exc:                            # noqa: BLE001
            log(traceback.format_exc())
            payload = {"page": page, "state": "ocr_failed",
                       "detail": f"{type(exc).__name__}: {exc}",
                       "seconds": round(time.time() - page_started, 2)}
            refusal = memory_refusal_signal(type(exc).__name__, str(exc))
            if refusal:
                payload["allocation_refusal"] = refusal
            emit(payload)
            continue
        merged["page"] = page
        merged["seconds"] = round(time.time() - page_started, 2)
        emit(merged)

    try:
        closer = getattr(pipeline, "close", None)
        if callable(closer):
            closer()
    except Exception:                                       # noqa: BLE001
        pass
    emit({"event": "closed"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
