"""Candidate model registry: identity, revision, claims, and what this host can actually run.

Published support is a CLAIM, not measured quality. Every language listed as
verified here needs an actual audio sample plus a transcription check on this machine;
the default state for unmeasured languages is verified=False.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from typing import Any

from . import binaries

# status values
NOT_INSTALLED = "not_installed"
EVALUATION_REQUIRED = "evaluation_required"
LICENSE_REQUIRED = "license_acceptance_required"
NOT_CONFIGURED = "not_configured"
AVAILABLE = "available"
NOT_SUPPORTED_BY_HOST = "not_supported_by_host"
# A capability that is deliberately served by another engine in this repository. It is
# neither "not installed" (implying a missing pip package) nor "unpinned candidate"
# (implying a pending quality decision) - so it gets its own honest value.
NOT_MIGRATED = "not-migrated"


@dataclass(slots=True)
class ModelSpec:
    id: str
    revision: str                       # pinned commit/tag once selected; "unpinned" until then
    capability: str
    provider: str
    package: str                        # python distribution that provides it
    claims: dict[str, Any] = field(default_factory=dict)
    verified: dict[str, bool] = field(default_factory=dict)   # measured on THIS host
    needs_token: bool = False
    heavy: bool = True
    est_peak_mib: int = 0               # measured load-time peak, 0 = not yet measured
    notes: str = ""
    # builtin=True means the capability is implemented BY THIS PACKAGE rather than by a
    # third-party distribution. Without it, code that really runs (the lexical retriever,
    # the timeline planner) is reported "not_installed", and code that does not run
    # (a Python artifact writer) is reported the same way - i.e. the capability report
    # says nothing either way.
    builtin: bool = False
    # A builtin feature that shells out to an external program is only installed when a
    # validated copy of that program actually exists on this host. The resolution is
    # provenance-aware (explicit override, PATH, then project-local copies owned by this
    # repository), because PATH alone is wrong in both directions: it reports a binary
    # this repo already ships as missing, and it accepts any same-named stub on PATH.
    requires_binary: str = ""

    def installed(self) -> bool:
        if self.builtin:
            if self.requires_binary:
                return binaries.resolve(self.requires_binary).found
            return True
        if not self.package:
            return False
        try:
            # find_spec raises ModuleNotFoundError when the PARENT package is missing
            # ("pyannote.audio" without "pyannote"), which must not crash capability reporting.
            return importlib.util.find_spec(self.package) is not None
        except (ImportError, ValueError):
            return False


class Catalog:
    def __init__(self, specs: list[ModelSpec]) -> None:
        self._specs = {s.id: s for s in specs}
        self._resident: set[str] = set()
        self._running_worker_cap: str | None = None

    def get(self, model_id: str) -> ModelSpec | None:
        return self._specs.get(model_id)

    def for_capability(self, capability: str) -> list[ModelSpec]:
        return [s for s in self._specs.values() if s.capability == capability]

    def status_for(self, capability: str) -> dict[str, Any]:
        specs = self.for_capability(capability)
        if not specs:
            return {"status": NOT_CONFIGURED, "models": [], "detail": "no adapter is registered for this capability"}
        entries = []
        for s in specs:
            binary = binaries.resolve(s.requires_binary) if s.requires_binary else None
            if s.needs_token and not s.installed():
                st = LICENSE_REQUIRED
                detail = "provider requires an access token and licence acceptance; startup must not fail"
            elif s.builtin and not s.installed():
                st = NOT_INSTALLED
                detail = (f"implemented here but needs the external program {s.requires_binary!r}; "
                          + (binary.detail if binary else "no candidate was probed"))
            elif not s.installed():
                if s.revision == NOT_MIGRATED:
                    st = NOT_CONFIGURED
                    detail = (s.notes or "no adapter is configured here; another verified "
                              "engine in this repository serves this capability")
                elif s.revision == "unpinned":
                    st = EVALUATION_REQUIRED
                    detail = "candidate not installed; the quality gate selects it before pinning"
                else:
                    st = NOT_INSTALLED
                    detail = "not installed in this environment"
            else:
                st = AVAILABLE
                if s.builtin and binary is not None:
                    detail = ("built into this package; the external program it needs was "
                              f"validated via {binary.source}: {binary.detail}")
                elif s.builtin:
                    detail = ("built into this package; it runs here and must state its own quality mode")
                else:
                    detail = "importable; heavy weights load only inside an owned worker"
            entries.append({"id": s.id, "revision": s.revision, "status": st, "detail": detail,
                            "claims": s.claims, "verified": s.verified, "heavy": s.heavy,
                            "est_peak_mib": s.est_peak_mib, "builtin": s.builtin,
                            "requires_binary": s.requires_binary,
                            # Provenance, not a guess: which copy was found, where it came
                            # from, and why a rejected candidate was rejected.
                            "binary": binary.as_dict() if binary is not None else None})
        best = next((e for e in entries if e["status"] == AVAILABLE), None)
        chosen = best or entries[0]
        return {"status": best["status"] if best else entries[0]["status"], "models": entries,
                "detail": best["detail"] if best else entries[0]["detail"],
                # The provenance of the entry whose status is being reported, never of an
                # arbitrary sibling spec in the same capability family.
                "binary": chosen["binary"]}

    # --- residency accounting (updated by the lifecycle manager, never guessed) ---
    def mark_worker_started(self, capability: str) -> None:
        self._running_worker_cap = capability

    def mark_worker_stopped(self) -> None:
        self._running_worker_cap = None

    def mark_resident(self, model_id: str) -> None:
        self._resident.add(model_id)

    def mark_released(self, model_id: str) -> None:
        self._resident.discard(model_id)

    def heavy_worker_running(self) -> str | None:
        return self._running_worker_cap

    def resident_heavy_models(self) -> list[str]:
        return sorted(self._resident)


_DEFAULTS: list[ModelSpec] = [
    ModelSpec(id="ruke-lexical-bm25", revision="builtin-v1", capability="rerank", provider="builtin",
              package="", heavy=False, builtin=True, claims={"coverage": "lexical only"},
              notes="always-available baseline; must report its own quality mode"),
    # The embeddings path that actually runs in this checkout is the hashed-lexical view
    # used for fusion. It is a real, executable implementation, so it must be registered;
    # otherwise "embeddings" looks uniformly uninstalled even though a caller can get
    # vectors out of it today, and the eval harness has no adapter to name.
    ModelSpec(id="ruke-lexical-hash", revision="builtin-v1", capability="embeddings",
              provider="builtin", package="", heavy=False, builtin=True,
              claims={"coverage": "hashed lexical term weights, not model-quality",
                      "dim": 512, "normalization": "l2"},
              verified={"model_quality_parity": False},
              notes="quality mode is reported per call; never claim parity with a neural "
                    "embedder, and a lexical vector must never be tagged as a proven-relevant passage"),
    ModelSpec(id="Qwen/Qwen3-Embedding-0.6B", revision="unpinned", capability="embeddings",
              provider="huggingface", package="sentence_transformers",
              claims={"languages": "documented multilingual", "dim": 1024, "pooling": "documented last-token + normalize"},
              verified={"multilingual_quality_on_this_host": False},
              notes="do not reuse MiniLM pooling; verify pooling/instruction and dimension before indexing"),
    ModelSpec(id="BAAI/bge-m3", revision="unpinned", capability="embeddings", provider="huggingface",
              package="FlagEmbedding", claims={"languages": "documented multilingual"},
              verified={"multilingual_quality_on_this_host": False}),
    ModelSpec(id="Qwen/Qwen3-Reranker-0.6B", revision="unpinned", capability="rerank",
              provider="huggingface", package="sentence_transformers",
              claims={"protocol": "documented generative/instruct scoring"},
              verified={"quality_on_this_host": False}),
    ModelSpec(id="Xenova/whisper-base.en", revision="unpinned", capability="speech.asr",
              provider="huggingface", package="transformers", heavy=True,
              claims={"languages": ["en"]}, verified={"en": True},
              notes="English ONLY - it must never be the universal default"),
    ModelSpec(id="openai/whisper-large-v3", revision="unpinned", capability="speech.asr",
              provider="huggingface", package="transformers",
              claims={"languages": "registry multilingual, includes te and hi"},
              verified={"te": False, "hi": False, "en": False},
              notes="candidate for Telugu/Hindi; published registry support is not quality evidence"),
    ModelSpec(id="Qwen/Qwen3-ASR-1.7B", revision="unpinned", capability="speech.asr",
              provider="huggingface", package="qwen_asr",
              claims={"languages": "as published"}, verified={"te": False, "hi": False},
              notes="published table omits Telugu; forced aligner excludes Telugu/Hindi - do not route those through it"),
    ModelSpec(id="pyannote/speaker-diarization-community-1", revision="unpinned",
              capability="speech.diarize", provider="huggingface", package="pyannote.audio",
              needs_token=True, claims={"speakers": "anonymous labels only"},
              notes="licence acceptance required; report the blocker, never fail startup"),
    # speech.align must be registered, otherwise speech.alignment.alignment_supported()
    # can only ever answer "no aligner is registered", even on a host where one IS
    # installed. A capability with no spec is reported not_configured, which is a
    # different (and here a false) claim than "installed but not yet verified".
    ModelSpec(id="Qwen/Qwen3-ForcedAligner-0.6B", revision="unpinned", capability="speech.align",
              provider="huggingface", package="qwen_asr",
              claims={"languages": "as published", "output": "word/character timing"},
              verified={"te": False, "hi": False, "en": False},
              notes="published aligner table omits Telugu and Hindi; those languages must "
                    "fall back to segment-level timing rather than invented word times"),
    ModelSpec(id="whisperx/whisper-alignment", revision="unpinned", capability="speech.align",
              provider="pypi", package="whisperx",
              claims={"languages": "follows the Whisper language registry",
                      "output": "word timing cross-checked against the ASR hypothesis"},
              verified={"te": False, "hi": False, "en": False},
              notes="alignment must never silently stretch a clock error; only load when "
                    "precise word timing or subtitles are actually requested"),
    ModelSpec(id="docling", revision="unpinned", capability="documents.parse", provider="pypi",
              package="docling", claims={"formats": "pdf/docx/pptx/xlsx and more"},
              verified={"tables": False, "formula": False, "indic_ocr": False},
              notes="layout/OCR extras selected per document class after measurement"),
    ModelSpec(id="PaddleOCR-VL", revision="unpinned", capability="documents.ocr", provider="paddle",
              package="paddleocr", claims={"ocr": "documented"}, verified={"te": False, "hi": False},
              notes="Indic coverage unverified - the small/medium PP-OCR tables did not establish it"),
    # --- temporal video: the planning/timestamping logic is implemented here; the pixels
    #     come from ffmpeg, so the honest status on a host without ffmpeg is not_installed.
    ModelSpec(id="ruke-video-timeline", revision="builtin-v1", capability="video.timeline",
              provider="builtin", package="", heavy=False, builtin=True, requires_binary="ffmpeg",
              claims={"timing": "source timestamps from the container, never frame_index/nominal_fps",
                      "evidence": "atomic timeline record with per-stage coverage"},
              notes="frame decoding and seeking need ffmpeg on PATH; scene/timeline correctness "
                    "still has to be measured on a human-labelled recording before quality is claimed"),
    ModelSpec(id="ruke-video-scenes", revision="builtin-v1", capability="video.scenes",
              provider="builtin", package="", heavy=False, builtin=True,
              claims={"coverage": "bounded sampling plan, head/middle/tail + query windows"},
              notes="produces a sampling plan only; a bounded plan can never prove an event is absent, "
                    "and extracting the planned frames needs ffmpeg (see video.timeline status)"),
    ModelSpec(id="ruke-video-observations", revision="builtin-v1", capability="video.observations",
              provider="builtin", package="", heavy=False, builtin=True,
              claims={"storage": "timestamped observation records with provenance"},
              notes="stores/validates observations; producing them from frames needs ffmpeg plus a "
                    "vision/OCR stage that is itself gated, so no visual quality is claimed"),
    ModelSpec(id="ruke-video-search-hints", revision="builtin-v1", capability="video.search_hints",
              provider="builtin", package="", heavy=False, builtin=True,
              claims={"output": "MediaSearchHints with provenance + source intervals"},
              notes="derives hints only from evidence already in the timeline record; with no "
                    "evidence staged it returns nothing rather than inventing clues"),
    # --- artifacts: the verified engines are TypeScript. Registering that fact keeps the
    #     capability report honest instead of implying a Python writer exists.
    ModelSpec(id="typescript-exceljs", revision="not-migrated", capability="artifacts.xlsx",
              provider="repository", package="", heavy=False,
              claims={"engine": "TypeScript ExcelJS remains the verified writer"},
              notes="not migrated to Python: no measured quality deficit justifies it; a Python "
                    "writer would additionally have to recalculate dependent formulas, which "
                    "openpyxl does not do on its own"),
    ModelSpec(id="typescript-docx", revision="not-migrated", capability="artifacts.docx",
              provider="repository", package="", heavy=False,
              claims={"engine": "TypeScript DOCX writer remains the verified writer"},
              notes="not migrated to Python: no measured quality deficit justifies it"),
    ModelSpec(id="typescript-pptx", revision="not-migrated", capability="artifacts.pptx",
              provider="repository", package="", heavy=False,
              claims={"engine": "TypeScript PPTX writer remains the verified writer"},
              notes="not migrated to Python: no measured quality deficit justifies it"),
]


_CATALOG = Catalog(_DEFAULTS)


def catalog() -> Catalog:
    return _CATALOG
