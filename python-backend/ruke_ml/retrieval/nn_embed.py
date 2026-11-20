"""The neural embedding backend that actually executes on this host.

Backend: sentence-transformers ``all-MiniLM-L6-v2`` weights, ONNX Export, run by
``onnxruntime`` on the CPU provider. Nothing here downloads at inference time and
nothing here asks for a GPU: ``CPUExecutionProvider`` is the only provider the
session is created with.

Why the weights are hash-pinned instead of "revision-pinned": this asset came from a
model hub snapshot and is read from the project tree, so the only identity that can
actually be verified offline is the bytes. The digest below was MEASURED on this host
(``sha256`` of ``onnx/model.onnx``), and a mismatch is a hard failure rather than a
shrug - a silently swapped .onnx is exactly how a "verified" embedding stops being
the embedding the index was built with.

Pooling matches the published protocol for this checkpoint (mean over the attention
mask, then L2 normalize, 256-token truncation, dim 384). A stored vector whose
model/dim/pooling does not match is rejected upstream by ``EmbeddingMeta``, so an
incorrect pooling choice cannot quietly poison ranking; it fails loudly.
"""
from __future__ import annotations

import hashlib
import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from ..config import model_dir
from .. import allocations
from ..contracts import EmbeddingMeta, ModelIdentity

MODEL_ID = "Xenova/all-MiniLM-L6-v2"
# sha256 of .data/models/Xenova/all-MiniLM-L6-v2/onnx/model.onnx, measured 2026-11-17.
PINNED_ONNX_SHA256 = "759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e"
PINNED_REVISION = f"sha256:{PINNED_ONNX_SHA256}"
PROVIDER = "onnxruntime-cpu"
DIM = 384
MAX_TOKENS = 256
POOLING = "mean"
NORMALIZATION = "l2"

ENV_EMBED_DIR = "RUKE_EMBED_DIR"


class NeuralEmbeddingError(ValueError):
    """Typed, non-silent failure of the neural backend.

    ``reason`` is one of the wire ERROR_REASONS values so the worker can pass it
    straight through instead of flattening everything into "internal".
    """

    def __init__(self, message: str, reason: str = "model_unavailable") -> None:
        super().__init__(message)
        self.reason = reason


def model_onnx_path(root: Path | None = None) -> Path:
    base = Path(os.environ.get(ENV_EMBED_DIR, "")).expanduser() if os.environ.get(
        ENV_EMBED_DIR, "") else (model_dir() if root is None else root)
    return base / MODEL_ID / "onnx" / "model.onnx"


def model_dir_for(root: Path | None = None) -> Path:
    return model_onnx_path(root).parents[1]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass(slots=True)
class AssetState:
    ok: bool
    reason: str
    detail: str
    path: Path
    digest: str = ""


def check_assets(expected_sha256: str = PINNED_ONNX_SHA256, root: Path | None = None) -> AssetState:
    """Readiness WITHOUT loading the model: file present, digest matches, tokenizer present."""
    onnx = model_onnx_path(root)
    tok = onnx.parents[1] / "tokenizer.json"
    if not onnx.exists():
        return AssetState(False, "model_unavailable",
                          f"no ONNX weights at {onnx}; run the retrieval asset preparation step",
                          onnx)
    if not tok.exists():
        return AssetState(False, "model_unavailable",
                          f"weights are present but {tok} is missing - the tokenizer is not optional",
                          onnx)
    digest = _sha256(onnx)
    if expected_sha256 and digest != expected_sha256:
        return AssetState(False, "model_unavailable",
                          f"{onnx} has sha256 {digest}, expected {expected_sha256}; "
                          "refusing to embed with an unverified checkpoint", onnx, digest)
    return AssetState(True, "", f"{onnx} verified against sha256:{digest}", onnx, digest)


class _Backend:
    """Lazy, process-local, CPU-only. One session; the worker host is already serialized."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._session = None
        self._tokenizer = None
        self._input_names: list[str] = []
        self._loaded_from: Path | None = None
        self._digest = ""
        self._load_error: str = ""

    def reset(self) -> None:
        with self._lock:
            self._session = None
            self._tokenizer = None
            self._loaded_from = None
            self._digest = ""
            self._load_error = ""

    def ensure(self, root: Path | None = None) -> None:
        if self._session is not None:
            return
        with self._lock:
            if self._session is not None:
                return
            state = check_assets(root=root)
            if not state.ok:
                self._load_error = state.detail
                raise NeuralEmbeddingError(state.detail, state.reason)
            try:
                import onnxruntime as ort
                from tokenizers import Tokenizer
            except ImportError as exc:  # dependency, not an asset problem
                self._load_error = f"neural embedding needs onnxruntime+tokenizers: {exc}"
                raise NeuralEmbeddingError(self._load_error, "not_configured") from exc
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
            # CPU explicitly. No CUDA/DirectML provider is requested, and none is
            # available in this build either way - asserting the list keeps that intent
            # from depending on a build accident.
            try:
                session = ort.InferenceSession(str(state.path), sess_options=opts,
                                               providers=["CPUExecutionProvider"])
            except Exception as exc:
                self._load_error = f"onnxruntime could not load {state.path} on CPU: {exc}"
                # "could not load" is what onnxruntime says when the host REFUSES an
                # allocation too. The asset is present and digest-verified at this point, so
                # telling the caller to prepare it again would destroy the working snapshot.
                reason = ("memory_pressure" if allocations.is_allocation_failure(self._load_error)
                          else "model_unavailable")
                raise NeuralEmbeddingError(self._load_error, reason) from exc
            tokenizer = Tokenizer.from_file(str(state.path.parents[1] / "tokenizer.json"))
            tokenizer.enable_truncation(max_length=MAX_TOKENS)
            tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
            self._session = session
            self._tokenizer = tokenizer
            self._input_names = [i.name for i in session.get_inputs()]
            self._loaded_from = state.path
            self._digest = state.digest
            self._load_error = ""

    @property
    def loaded(self) -> bool:
        return self._session is not None

    @property
    def info(self) -> dict[str, object]:
        return {"path": str(self._loaded_from or model_onnx_path()), "digest": self._digest,
                "load_error": self._load_error, "loaded": self.loaded,
                "providers": list(getattr(self._session, "get_providers", lambda: [])())
                if self._session else []}

    def encode(self, texts: Sequence[str]) -> tuple[list[list[float]], int]:
        """Returns unit-norm vectors plus how many inputs were truncated at MAX_TOKENS."""
        self.ensure()
        assert self._session is not None and self._tokenizer is not None
        import numpy as np  # onnxruntime's own dependency; local so a read never needs it
        vectors: list[list[float]] = []
        truncated = 0
        batch = 16
        for start in range(0, len(texts), batch):
            group = texts[start:start + batch]
            encodings = self._tokenizer.encode_batch(list(group))
            ids = [e.ids for e in encodings]
            mask = [e.attention_mask for e in encodings]
            feed: dict[str, object] = {}
            feed["input_ids"] = np.asarray(ids, dtype="int64")
            feed["attention_mask"] = np.asarray(mask, dtype="int64")
            if "token_type_ids" in self._input_names:
                feed["token_type_ids"] = np.asarray([e.type_ids for e in encodings], dtype="int64")
            if any(len(e.ids) >= MAX_TOKENS for e in encodings):
                truncated += sum(1 for e in encodings if len(e.ids) >= MAX_TOKENS)
            out = self._session.run(["last_hidden_state"], feed)[0]
            arr = np.asarray(out, dtype="float64")
            m = np.asarray(mask, dtype="float64")
            summed = np.einsum("bsd,bs->bd", arr, m)
            counts = np.clip(m.sum(axis=1), 1.0, None)
            pooled = summed / counts[:, None]
            norms = np.linalg.norm(pooled, axis=1)
            norms = np.where(norms == 0.0, 1.0, norms)
            pooled = pooled / norms[:, None]
            vectors.extend([[float(x) for x in row] for row in pooled])
        return vectors, truncated


_BACKEND = _Backend()


def reset_backend() -> None:
    """Test seam: drop the session so an asset/drift change is observed, not cached."""
    _BACKEND.reset()


def backend_info() -> dict[str, object]:
    return _BACKEND.info


def neural_available() -> tuple[bool, str]:
    """Cheap readiness answer for the capability surface (no model load)."""
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except ImportError as exc:
        return False, f"missing dependency for the neural backend: {exc}"
    state = check_assets()
    return state.ok, state.detail or "assets verified"


def neural_meta() -> EmbeddingMeta:
    return EmbeddingMeta(model=ModelIdentity(id=MODEL_ID, revision=PINNED_REVISION,
                                             provider=PROVIDER),
                         dim=DIM, normalization=NORMALIZATION, pooling=POOLING,
                         query_instruction="")


def neural_embed_texts(texts: Sequence[str]) -> tuple[list[list[float]], EmbeddingMeta, dict[str, object]]:
    """Embed with the real checkpoint. Never falls back to hashing on failure."""
    if not texts:
        return [], neural_meta(), {"truncated": 0, "backend": backend_info()}
    vectors, truncated = _BACKEND.encode(list(texts))
    for v in vectors:
        if len(v) != DIM:
            raise NeuralEmbeddingError(f"backend produced a {len(v)}-d vector, expected {DIM}")
        norm = math.sqrt(sum(x * x for x in v))
        if not (0.99 <= norm <= 1.01):
            raise NeuralEmbeddingError(f"vectors must come back L2-normalized (got norm {norm:.4f})")
    return vectors, neural_meta(), {"truncated": truncated, "max_tokens": MAX_TOKENS,
                                    "backend": backend_info()}
