"""Versioned wire contracts shared with the TS and Rust sides.

SCHEMA_VERSION bumps on any incompatible change. Callers must reject, not coerce,
an envelope they do not understand: silent coercion is how value semantics get lost.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any

SCHEMA_VERSION = 1

CAPABILITIES = (
    "embeddings", "rerank", "documents.parse", "documents.ocr", "speech.asr",
    "speech.align", "speech.diarize", "video.scenes", "video.observations",
    "video.timeline", "video.search_hints", "video.frame_ocr",
    "artifacts.xlsx", "artifacts.docx", "artifacts.pptx",
)
PROGRESS_STATES = ("queued", "preparing", "download_required", "extracting", "ocr", "transcribing",
                   "indexing", "retrieving", "analysing", "writing", "ready", "failed", "cancelled")
ERROR_REASONS = (
    "not_configured", "license_acceptance_required", "model_unavailable", "download_failed",
    "cancelled", "deadline_exceeded", "memory_pressure", "input_rejected", "unsupported_input",
    "corrupt_input", "evaluation_required", "internal", "crash", "capability_mismatch",
    "contract_mismatch", "resource_busy",
)


class ContractError(ValueError):
    pass


def _req(d: dict[str, Any], key: str, typ: type, where: str) -> Any:
    if key not in d:
        raise ContractError(f"{where}: missing required field {key!r}")
    v = d[key]
    if typ is float and isinstance(v, int) and not isinstance(v, bool):
        return float(v)
    if not isinstance(v, typ):
        raise ContractError(f"{where}: field {key!r} must be {typ.__name__}, got {type(v).__name__}")
    return v


@dataclass(slots=True)
class ModelIdentity:
    id: str
    revision: str
    provider: str = ""
    quantization: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ModelIdentity":
        return cls(
            id=_req(d, "id", str, "model"),
            revision=_req(d, "revision", str, "model"),
            provider=d.get("provider", "") or "",
            quantization=d.get("quantization", "") or "",
        )


@dataclass(slots=True)
class Coverage:
    """What was ACTUALLY examined. A bounded sample never claims completeness."""
    examined: list[tuple[float, float]] = field(default_factory=list)
    skipped: list[tuple[float, float]] = field(default_factory=list)
    units: str = "seconds"
    total_source: float | None = None
    complete: bool = False
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"examined": [list(x) for x in self.examined], "skipped": [list(x) for x in self.skipped],
                "units": self.units, "total_source": self.total_source, "complete": self.complete, "note": self.note}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Coverage":
        def spans(k: str) -> list[tuple[float, float]]:
            out = []
            for s in d.get(k, []) or []:
                if not isinstance(s, (list, tuple)) or len(s) != 2:
                    raise ContractError(f"coverage.{k}: each span needs [start, end]")
                out.append((float(s[0]), float(s[1])))
            return out
        total = d.get("total_source")
        return cls(examined=spans("examined"), skipped=spans("skipped"), units=d.get("units", "seconds"),
                   total_source=None if total is None else float(total),
                   complete=bool(d.get("complete", False)), note=d.get("note", "") or "")


@dataclass(slots=True)
class StructuredError:
    reason: str
    message: str
    retryable: bool = False
    capability: str = ""
    human_step: str = ""

    def __post_init__(self) -> None:
        if self.reason not in ERROR_REASONS:
            raise ContractError(f"unknown error reason {self.reason!r}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "StructuredError":
        return cls(reason=_req(d, "reason", str, "error"), message=_req(d, "message", str, "error"),
                   retryable=bool(d.get("retryable", False)), capability=d.get("capability", "") or "",
                   human_step=d.get("human_step", "") or "")


@dataclass(slots=True)
class JobRequest:
    request_id: str
    run_id: str
    job_id: str
    capability: str
    payload: dict[str, Any] = field(default_factory=dict)
    deadline_s: float | None = None
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise ContractError(f"schema_version {self.schema_version} not supported (this build is {SCHEMA_VERSION})")
        if self.capability not in CAPABILITIES:
            raise ContractError(f"unknown capability {self.capability!r}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "JobRequest":
        return cls(request_id=_req(d, "request_id", str, "request"), run_id=_req(d, "run_id", str, "request"),
                   job_id=_req(d, "job_id", str, "request"), capability=_req(d, "capability", str, "request"),
                   payload=d.get("payload", {}) or {}, deadline_s=d.get("deadline_s"),
                   schema_version=int(d.get("schema_version", SCHEMA_VERSION)))


@dataclass(slots=True)
class JobResult:
    job_id: str
    capability: str
    state: str                      # one of PROGRESS_STATES minus queued
    payload: dict[str, Any] = field(default_factory=dict)
    coverage: Coverage | None = None
    model: ModelIdentity | None = None
    error: StructuredError | None = None
    progress: float | None = None   # only when the provider genuinely reports it
    schema_version: int = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        out = {"job_id": self.job_id, "capability": self.capability, "state": self.state,
               "payload": self.payload, "schema_version": self.schema_version}
        if self.coverage is not None:
            out["coverage"] = self.coverage.to_dict()
        if self.model is not None:
            out["model"] = self.model.to_dict()
        if self.error is not None:
            out["error"] = self.error.to_dict()
        if self.progress is not None:
            out["progress"] = self.progress
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "JobResult":
        state = _req(d, "state", str, "result")
        if state not in PROGRESS_STATES:
            raise ContractError(f"result.state {state!r} is not a known progress state")
        if int(d.get("schema_version", SCHEMA_VERSION)) != SCHEMA_VERSION:
            raise ContractError("result schema_version mismatch")
        return cls(job_id=_req(d, "job_id", str, "result"), capability=_req(d, "capability", str, "result"),
                   state=state, payload=d.get("payload", {}) or {},
                   coverage=Coverage.from_dict(d["coverage"]) if d.get("coverage") else None,
                   model=ModelIdentity.from_dict(d["model"]) if d.get("model") else None,
                   error=StructuredError.from_dict(d["error"]) if d.get("error") else None,
                   progress=d.get("progress"))


@dataclass(slots=True)
class EmbeddingMeta:
    """Vectors carry the identity of what produced them. Incompatible vectors are rejected."""
    model: ModelIdentity
    dim: int
    normalization: str              # "l2" | "none"
    pooling: str = ""
    query_instruction: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"model": self.model.to_dict(), "dim": self.dim, "normalization": self.normalization,
                "pooling": self.pooling, "query_instruction": self.query_instruction}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EmbeddingMeta":
        return cls(model=ModelIdentity.from_dict(_req(d, "model", dict, "embedding_meta")),
                   dim=int(_req(d, "dim", int, "embedding_meta")),
                   normalization=_req(d, "normalization", str, "embedding_meta"),
                   pooling=d.get("pooling", "") or "", query_instruction=d.get("query_instruction", "") or "")

    def compatible_with(self, other: "EmbeddingMeta") -> tuple[bool, str]:
        if self.model.id != other.model.id or self.model.revision != other.model.revision:
            return False, f"embedding model changed: {self.model.id}@{self.model.revision} != {other.model.id}@{other.model.revision}"
        if self.dim != other.dim:
            return False, f"embedding dimension changed: {self.dim} != {other.dim}"
        if self.normalization != other.normalization:
            return False, f"normalization changed: {self.normalization} != {other.normalization}"
        if self.query_instruction != other.query_instruction:
            return False, "query instruction/pooling recipe changed"
        return True, ""


def sha256_hex(data: bytes | str) -> str:
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8", "surrogatepass")).hexdigest()


def canon_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
