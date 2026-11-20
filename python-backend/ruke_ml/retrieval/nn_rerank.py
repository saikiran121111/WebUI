"""The neural CROSS-ENCODER that actually executes on this host.

A cross-encoder scores the query and the candidate TOGETHER in one forward pass, which is
exactly what the dense bi-encoder cannot do (it embeds them separately and compares
vectors). That joint attention is why it is the right second opinion for the failure mode
measured in `g04`: the dense channel put the wrong-number candidate first.

Backend: `cross-encoder/ms-marco-MiniLM-L-6-v2`, ONNX export (`Xenova/...`), run by
`onnxruntime` with `CPUExecutionProvider` only. Nothing downloads at inference time. The
identity is a measured sha256 of the weight file, re-verified before every load, for the
same reason as the embedder: an unverified .onnx is how a "verified" reranker stops being
the one whose scores were measured.

Scoring protocol matches the published checkpoint: single logit per pair, squashed with a
sigmoid into (0,1). Pre-tokenization is `[CLS] query [SEP] passage [SEP]`, which is what
`tokenizers` produces for a text pair, with `token_type_ids` fed because this graph
declares it. Truncation is at MAX_TOKENS and is REPORTED, never hidden.

Scope statement, because this is an English MS MARCO checkpoint: its published coverage is
English relevance ranking. It is not a multilingual reranker, no non-English quality has
been measured here, and it is not a claim that any reranker fixes recall - a reranker can
only reorder candidates it was given.
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
from ..contracts import ModelIdentity

MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2"
SOURCE_UPSTREAM = "cross-encoder/ms-marco-MiniLM-L-6-v2"
# Pinned Hugging Face revision this snapshot was fetched from (see
# docs/overnight/logs/f27-rerank-download-1.log, 2026-11-17).
PINNED_REVISION_COMMIT = "a09144355adeed5f58c8ed011d209bf8ee5a1fec"
# sha256 of .data/models/Xenova/ms-marco-MiniLM-L-6-v2/onnx/model.onnx, measured on this
# host after the pinned-revision download. The adapter re-verifies it at load time, so the
# runtime identity is the bytes, not a tag that could resolve differently tomorrow.
PINNED_ONNX_SHA256 = "c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870"
PINNED_ONNX_MIN_BYTES = 90_000_000
PINNED_REVISION = f"sha256:{PINNED_ONNX_SHA256}"
PROVIDER = "onnxruntime-cpu"
MODE_NAME = "neural_cross_encoder_minilm"
MAX_TOKENS = 256
BATCH = 16
SCORING = "sigmoid of the single classification logit for the (query, passage) pair"

ENV_RERANK_DIR = "RUKE_RERANK_DIR"


class CrossEncoderError(ValueError):
    """Typed failure of the cross-encoder backend (never a silent downgrade).

    ``reason`` is a wire reason code so the worker can pass it through: a missing asset is
    ``model_unavailable``, a missing dependency is ``not_configured``. Neither is ever
    answered by running the bi-encoder or BM25 instead and calling it neural.
    """

    def __init__(self, message: str, reason: str = "model_unavailable") -> None:
        super().__init__(message)
        self.reason = reason


def model_onnx_path(root: Path | None = None) -> Path:
    env = os.environ.get(ENV_RERANK_DIR, "").strip()
    if env:
        base = Path(env).expanduser()
    elif root is not None:
        base = root
    else:
        base = model_dir()
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


def check_assets(expected_sha256: str = PINNED_ONNX_SHA256,
                 root: Path | None = None) -> AssetState:
    """Readiness without loading: weights present, digest matches, tokenizer present."""
    onnx = model_onnx_path(root)
    tok = onnx.parents[1] / "tokenizer.json"
    if not onnx.exists():
        return AssetState(False, "model_unavailable",
                          f"no cross-encoder ONNX weights at {onnx}; run the pinned rerank "
                          f"asset preparation step ({MODEL_ID} @ {PINNED_REVISION_COMMIT})", onnx)
    if onnx.stat().st_size < PINNED_ONNX_MIN_BYTES:
        return AssetState(False, "model_unavailable",
                          f"{onnx} is {onnx.stat().st_size} B, below the pinned minimum "
                          f"{PINNED_ONNX_MIN_BYTES} B - an incomplete download is not a model",
                          onnx)
    if not tok.exists():
        return AssetState(False, "model_unavailable",
                          f"weights are present but {tok} is missing - the tokenizer is not "
                          "optional", onnx)
    digest = _sha256(onnx)
    if expected_sha256 and digest != expected_sha256:
        return AssetState(False, "model_unavailable",
                          f"{onnx} has sha256 {digest}, expected {expected_sha256}; refusing to "
                          "score with an unverified checkpoint", onnx, digest)
    return AssetState(True, "", f"{onnx} verified against sha256:{digest}", onnx, digest)


class _Backend:
    """Lazy, process-local, CPU-only. One session, bounded batch."""

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
                raise CrossEncoderError(state.detail, state.reason)
            try:
                import onnxruntime as ort
                from tokenizers import Tokenizer
            except ImportError as exc:
                self._load_error = f"the cross-encoder needs onnxruntime+tokenizers: {exc}"
                raise CrossEncoderError(self._load_error, "not_configured") from exc
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
            try:
                session = ort.InferenceSession(str(state.path), sess_options=opts,
                                               providers=["CPUExecutionProvider"])
            except Exception as exc:
                self._load_error = f"onnxruntime could not load {state.path} on CPU: {exc}"
                # Same class of misreport as the bi-encoder: an allocation refusal is a
                # resource condition, and the asset passed digest verification above.
                reason = ("memory_pressure" if allocations.is_allocation_failure(self._load_error)
                          else "model_unavailable")
                raise CrossEncoderError(self._load_error, reason) from exc
            providers = list(getattr(session, "get_providers", lambda: [])())
            if providers and providers[0] != "CPUExecutionProvider":
                raise CrossEncoderError(
                    f"the session picked {providers[0]}, not CPUExecutionProvider - this host "
                    "does not authorize GPU compute for processing jobs", "not_configured")
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
                "inputs": list(self._input_names),
                "providers": list(getattr(self._session, "get_providers", lambda: [])())
                if self._session else []}

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> tuple[list[float], int]:
        """Joint scores in (0,1) plus how many pairs were truncated at MAX_TOKENS."""
        self.ensure()
        assert self._session is not None and self._tokenizer is not None
        import numpy as np  # onnxruntime's own dependency; imported locally
        scores: list[float] = []
        truncated = 0
        for start in range(0, len(pairs), BATCH):
            group = pairs[start:start + BATCH]
            enc = self._tokenizer.encode_batch([(q, p) for q, p in group])
            ids = [e.ids for e in enc]
            mask = [e.attention_mask for e in enc]
            feed: dict[str, object] = {
                "input_ids": np.asarray(ids, dtype="int64"),
                "attention_mask": np.asarray(mask, dtype="int64"),
            }
            if "token_type_ids" in self._input_names:
                feed["token_type_ids"] = np.asarray([e.type_ids for e in enc], dtype="int64")
            truncated += sum(1 for e in enc if len(e.ids) >= MAX_TOKENS)
            out = self._session.run(["logits"], feed)[0]
            arr = np.asarray(out, dtype="float64").reshape(len(group), -1)
            if arr.shape[1] < 1:
                raise CrossEncoderError("the cross-encoder returned no logit per pair",
                                        "output_invalid")
            for row in arr[:, 0]:
                scores.append(1.0 / (1.0 + math.exp(-float(row))))
        return scores, truncated


_BACKEND = _Backend()


def reset_backend() -> None:
    _BACKEND.reset()


def backend_info() -> dict[str, object]:
    return _BACKEND.info


def cross_encoder_available(root: Path | None = None) -> tuple[bool, str]:
    state = check_assets(root=root)
    return state.ok, state.detail or "assets verified"


def cross_encoder_identity() -> ModelIdentity:
    return ModelIdentity(id=MODEL_ID, revision=PINNED_REVISION, provider=PROVIDER,
                         quantization="fp32 onnx")


def cross_encoder_scores(query: str, passages: Sequence[str],
                         root: Path | None = None) -> tuple[list[float], dict[str, object]]:
    """Score every passage against the query jointly. Never falls back to another ranker.

    Raises ``CrossEncoderError`` (a ``ValueError``) when the pinned asset or its tokenizer
    is absent, when the digest does not match, or when the session cannot run on CPU. A
    caller that wants BM25 must ask for BM25 explicitly.
    """
    if not query:
        raise CrossEncoderError("cross-encoder scoring needs a non-empty query", "input_rejected")
    if not passages:
        return [], {"truncated": 0, "max_tokens": MAX_TOKENS, "model": MODEL_ID,
                    "revision": PINNED_REVISION, "provider": PROVIDER,
                    "scoring": SCORING, "batch": BATCH, "backend": backend_info()}
    scores, truncated = _BACKEND.score_pairs([(query, p) for p in passages])
    if len(scores) != len(passages):
        raise CrossEncoderError(f"scored {len(scores)} of {len(passages)} candidates",
                                "output_invalid")
    for s in scores:
        if not (0.0 <= s <= 1.0) or s != s:
            raise CrossEncoderError("cross-encoder scores must be finite probabilities in [0,1]",
                                    "output_invalid")
    return scores, {"truncated": truncated, "max_tokens": MAX_TOKENS, "model": MODEL_ID,
                    "upstream": SOURCE_UPSTREAM, "revision": PINNED_REVISION,
                    "commit": PINNED_REVISION_COMMIT, "provider": PROVIDER, "scoring": SCORING,
                    "batch": BATCH, "language_scope": "English (published MS MARCO coverage); "
                                                      "no measured non-English quality",
                    "backend": backend_info()}
