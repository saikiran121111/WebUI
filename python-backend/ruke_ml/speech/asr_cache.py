"""Durable ASR result records (F152, 2026-11-24).

The law is the OCR record law (documents/ocr_cascade.py), mirrored for the audio
channel: a transcription is an answer about SOURCE CONTENT and a REQUEST, so the
record is keyed by both, and staleness is judged on CONTENT (sha256), never on
mtime - touching a file does not change what the engine heard, and rejecting a
reusable record over a timestamp would re-run minutes of inference for nothing.

The root lives under runtime_dir(), overridable with RUKE_ASR_RESULT_DIR for the
same store-isolation reason the e2e launcher sets RUKE_OCR_RESULT_DIR: an
acceptance run's evidence must land in the store it owns.

Question-driven intervals ride the same key: the SPAN is part of the request, so
a record for 12.0-45.0s is findable by the next 12.0-45.0s request on identical
bytes. A span is NEVER served from a different span's record - the interval
answer comes from an engine that decoded exactly the interval under the bounded
window law (honest partial coverage, edge-cut fragments at the span edges), not
from a slice of a whole-file pass, whose window boundaries cut sentences at
different places and whose coverage claims are about the whole track.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from ..config import runtime_dir

RESULT_SCHEMA = "ruke.asr-result.v1"
RESULT_DIR_ENV = "RUKE_ASR_RESULT_DIR"
# Same cap as the OCR law: above this the hash covers head+tail and SAYS so, so
# persistence never puts an unbounded read on the critical path.
RESULT_HASH_CAP_BYTES = 512 << 20


def result_dir() -> Path:
    raw = os.environ.get(RESULT_DIR_ENV, "").strip()
    return Path(raw) if raw else runtime_dir() / "asr-results"


def identity_core(identity: dict[str, Any]) -> dict[str, Any]:
    """The part of a source identity staleness is judged on (mtime excluded, the
    OCR law: a touch is not a content change)."""
    return {k: identity.get(k) for k in ("sha256", "size_bytes", "hash_basis")}


def source_identity(path: str) -> dict[str, Any]:
    """Content identity for a media file. A path name is not identity (OCR law)."""
    out: dict[str, Any] = {"ok": False, "identity": {}, "detail": ""}
    try:
        size = int(os.path.getsize(path))
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            if size <= RESULT_HASH_CAP_BYTES:
                for block in iter(lambda: fh.read(1 << 20), b""):
                    h.update(block)
                basis = f"sha256 over all {size} bytes"
            else:
                head = fh.read(8 << 20)
                fh.seek(max(0, size - (8 << 20)))
                tail = fh.read(8 << 20)
                h.update(head)
                h.update(tail)
                basis = (f"sha256 over the first and last 8 MiB of a {size} byte file "
                         f"(over the {RESULT_HASH_CAP_BYTES} byte cap), so a change "
                         "confined to the middle of the file is NOT detected by this identity")
        out["identity"] = {"sha256": h.hexdigest(), "size_bytes": size, "hash_basis": basis}
        out["ok"] = True
    except OSError as exc:
        out["detail"] = (f"the source could not be read to establish its identity: "
                         f"{type(exc).__name__}: {exc}")
    return out


def request_key(path: str, *, start_s: float, end_s: float, duration: float,
                language: str, model_id: str, word_timestamps: bool,
                vad_filter: bool, window_s: Any) -> dict[str, Any]:
    """Key the record by what it is an answer ABOUT, not by where the file sits.

    The engine identity is the registry row's model id (the F122 OCR-selection law:
    a record must stay attributable to the engine that produced it across setting
    changes), and so are the request knobs that change the answer: language, word
    timings, gating, explicit window bound, and the span.
    """
    ident = source_identity(path)
    if not ident["ok"]:
        return {"ok": False, "detail": ident["detail"]}
    lo = round(max(0.0, float(start_s or 0.0)), 3)
    hi = round(float(end_s), 3) if float(end_s or 0.0) > 0 else round(float(duration), 3)
    request = {
        "schema": RESULT_SCHEMA,
        "model": model_id,
        "source": ident["identity"],
        "span": [lo, hi],
        "language": (language or "").strip().lower(),
        "word_timestamps": bool(word_timestamps),
        "vad_filter": bool(vad_filter),
        "window_s": (round(float(window_s), 3) if window_s else ""),
    }
    blob = json.dumps(request, sort_keys=True).encode("utf-8")
    return {"ok": True, "key": hashlib.sha256(blob).hexdigest(), "request": request,
            "identity": ident["identity"]}


def lookup(cache_key: dict[str, Any]) -> dict[str, Any] | None:
    """Find a durable record for this exact request. A corrupt record is a miss.

    Freshness is CONTENT: the stored request's source identity core must equal the
    identity core in the key's request (the file's current bytes). Same bytes +
    same span + same engine identity -> the engine heard exactly this before.
    """
    if not cache_key.get("ok"):
        return None
    path = result_dir() / f"{cache_key['key']}.json"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("schema") != RESULT_SCHEMA:
        return None
    stored = (record.get("request") or {}).get("source")
    if not isinstance(stored, dict):
        return None
    want = identity_core(cache_key["request"]["source"])
    if identity_core(stored) != want:
        return None
    if (record.get("request") or {}).get("span") != cache_key["request"]["span"]:
        return None
    return record


def store(cache_key: dict[str, Any], *, payload: dict[str, Any],
          coverage: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    """Write the record atomically (tmp + os.replace): a reader either sees the
    whole record or nothing, never a half-written transcript."""
    if not cache_key.get("ok"):
        return {"ok": False, "detail": cache_key.get("detail", "no key")}
    try:
        root = result_dir()
        root.mkdir(parents=True, exist_ok=True)
        record = {"schema": RESULT_SCHEMA,
                  "stored_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "request": cache_key["request"], "payload": payload,
                  "coverage": coverage, "model": model}
        final = root / f"{cache_key['key']}.json"
        tmp = root / f"{cache_key['key']}.json.tmp-{os.getpid()}"
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, final)
        return {"ok": True, "path": str(final)}
    except OSError as exc:
        return {"ok": False, "detail": f"the record could not be written: "
                                       f"{type(exc).__name__}: {exc}"}
