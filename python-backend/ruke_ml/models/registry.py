"""Candidate model registry: identity, revision, claims, and what this host can actually run.

Published support is a CLAIM, not measured quality. Every language listed as
verified here needs an actual audio sample plus a transcription check on this machine;
the default state for unmeasured languages is verified=False.
"""
from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass, field
from typing import Any

from ..language_tables import validate_language_claims
from . import assets
from . import binaries
from . import ocr_runtime
from ..language_tables import whisper_ct2_languages
from ..retrieval.nn_embed import MAX_TOKENS as MINILM_MAX_TOKENS
from ..retrieval.nn_embed import MODEL_ID as MINILM_ID
from ..retrieval.nn_embed import PINNED_ONNX_SHA256 as MINILM_SHA256
from ..retrieval.nn_rerank import MAX_TOKENS as CROSS_ENCODER_MAX_TOKENS
from ..retrieval.nn_rerank import MODEL_ID as CROSS_ENCODER_ID
from ..retrieval.nn_rerank import PINNED_ONNX_SHA256 as CROSS_ENCODER_SHA256
from ..retrieval.nn_rerank import PINNED_REVISION_COMMIT as CROSS_ENCODER_COMMIT

# Explicit tag list captured from the pinned CT2 Whisper backend (see
# ruke_ml/data/whisper_language_tags.json for the package versions behind it).
# Published coverage, NOT measured quality: every tag here still needs a per-language
# evaluation on this host before it can be marked verified.
WHISPER_TAGS = whisper_ct2_languages()

# The snapshot actually prepared INSIDE this project (.data/ml-cache/huggingface/hub/
# models--Systran--faster-whisper-base/snapshots/<this>) by the explicit preparer.
# Pinning it is what makes "the asset is present" a checkable statement rather than a
# pointer at whatever main branch happens to resolve that day; assets.assert_revision()
# refuses a snapshot that is not this one.
SPEECH_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"

# The pinned OCR pipeline assets, resolved from the sources the amendment names rather than
# invented: the model cards plus the Hugging Face tree API for these exact commits.
#   PaddlePaddle/PaddleOCR-VL-1.6 @ 132c45f5...  recognition model, 17 files, 1,930,469,491 B,
#                                             model.safetensors = 1,917,255,968 B
#   PaddlePaddle/PP-DocLayoutV3   @ 241f8bdf...  layout model, inference trio, pdiparams =
#                                             130,806,572 B
# These are the REPOSITORY ids. The display id used by the CLI and the UI is "PaddleOCR-VL",
# and conflating the two is exactly how `prepare` ended up fetching a repo id that does not
# exist while the runtime looked for a different one.
PADDLE_VL_REPO = "PaddlePaddle/PaddleOCR-VL-1.6"
PADDLE_VL_REVISION = "132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd"
PADDLE_LAYOUT_REPO = "PaddlePaddle/PP-DocLayoutV3"
PADDLE_LAYOUT_REVISION = "241f8bdfc77a7c7bee915a5057aaee58c235a8d3"

# Files each pinned snapshot must contain, with the byte floor that distinguishes the real
# weight blob from an LFS pointer or a truncated download. Sizes are taken from the pinned
# trees above; the floors sit just under them so a legitimately unchanged file passes.
PADDLE_VL_FILES: tuple[tuple[str, int], ...] = (
    ("model.safetensors", 1_900_000_000),
    ("config.json", 1_000),
    ("generation_config.json", 20),
    ("preprocessor_config.json", 50),
    ("processor_config.json", 50),
    ("configuration_paddleocr_vl.py", 1_000),
    ("modeling_paddleocr_vl.py", 10_000),
    ("processing_paddleocr_vl.py", 5_000),
    ("image_processing_paddleocr_vl.py", 10_000),
    ("tokenizer_config.json", 10_000),
    ("tokenizer.json", 1_000_000),
    ("tokenizer.model", 100_000),
    ("added_tokens.json", 1_000),
    ("special_tokens_map.json", 100),
    ("chat_template.jinja", 100),
)
PADDLE_LAYOUT_FILES: tuple[tuple[str, int], ...] = (
    ("inference.json", 100_000),
    ("inference.pdiparams", 130_000_000),
    ("inference.yml", 100),
)

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


@dataclass(frozen=True, slots=True)
class AdapterReadiness:
    """The one readiness answer shared by the catalog AND by job dispatch.

    Why this exists: `installed()` only proved that a python package can be imported,
    so the audit could mock installed=True, watch a capability report "available", and
    still hit a hardcoded execution failure in the worker. Readiness separates the five
    independent conditions, and `executable` is the conjunction the dispatcher uses.

    Executable still does NOT mean measured accuracy, and it does not promise that a
    later job cannot fail (OOM, corrupt input, host limits). Quality evaluation stays in
    the eval harness, and job outcomes stay in the job result.
    """
    implemented: bool
    dependencies_present: bool
    assets_validated: bool
    configuration_valid: bool
    access_satisfied: bool

    @property
    def executable(self) -> bool:
        return all((
            self.implemented,
            self.dependencies_present,
            self.assets_validated,
            self.configuration_valid,
            self.access_satisfied,
        ))

    def blockers(self) -> list[str]:
        out = []
        if not self.implemented:
            out.append("no adapter code is registered for this model id")
        if not self.dependencies_present:
            out.append("the pinned dependency (package or external program) is not present")
        if not self.assets_validated:
            out.append("the pinned model asset is not in the local cache "
                       "(prepare it explicitly: python -m ruke_ml.models.prepare)")
        if not self.configuration_valid:
            out.append("required configuration is missing")
        if not self.access_satisfied:
            out.append("provider access/licence acceptance is missing")
        return out

    def as_dict(self) -> dict[str, Any]:
        return {"implemented": self.implemented,
                "dependencies_present": self.dependencies_present,
                "assets_validated": self.assets_validated,
                "configuration_valid": self.configuration_valid,
                "access_satisfied": self.access_satisfied,
                "executable": self.executable,
                "blockers": self.blockers()}


READINESS_UNKNOWN = AdapterReadiness(False, False, False, False, False)


@dataclass(frozen=True, slots=True)
class AssetRef:
    """One weight repository an adapter loads, with its pinned revision and required files.

    A pipeline adapter legitimately needs more than one asset: PaddleOCR-VL runs PP-DocLayoutV3
    for layout AND the VL recognition model. Modelling that as a single `asset` string forced a
    choice between "the readiness check lies about half the pipeline" and "register a fake
    capability row for a component", and both produce a capability report that cannot be trusted.
    """
    repo_id: str
    revision: str = ""
    required_files: tuple[tuple[str, int], ...] = ()


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
    # A second, ANDed external program. `requires_binary` alone cannot express a capability
    # that needs a DECODER and a RECOGNISER (video frame OCR needs ffmpeg for the pixels and
    # tesseract for the glyphs), and a readiness report that only checks one of them says
    # "installed" while the job still cannot run. Presence of both is the honest condition.
    also_requires_binaries: tuple[str, ...] = ()

    # The module that actually implements this capability for this model id. A spec with
    # no adapter can never be executable: registering an id nobody can run is how a
    # capability report becomes decoration.
    adapter: str = ""
    # Repo id of the weight asset this adapter loads. Empty means "this adapter needs no
    # external asset", which is an EXPLICIT statement rather than an assumed default.
    asset: str = ""
    # Additional asset repositories the SAME adapter loads (layout model, sidecar heads).
    # Readiness validates every one of them, so "the pipeline is ready" cannot mean "one of
    # its two models happens to be on disk".
    extra_assets: tuple[AssetRef, ...] = ()
    # Files the primary `asset` snapshot must contain, with byte floors (see assets.verify_files).
    required_files: tuple[tuple[str, int], ...] = ()
    # A named isolated interpreter/environment this capability shells out to, validated by
    # models/ocr_runtime.py WITHOUT importing the framework. Empty means "no such dependency".
    requires_runtime: str = ""
    # Where est_peak_mib came from: "measured" only when an actual cold-load peak was recorded.
    est_peak_basis: str = ""
    # Commit charge is a DIFFERENT quantity from resident RAM, and the enforceable ceiling
    # the pool puts on a worker (a Windows job object) is expressed in COMMIT. Deriving that
    # ceiling from a resident peak under-sizes it: measured 2026-11-16 on the pinned whisper
    # snapshot, 388 MiB resident but 1,276 MiB commit. A ceiling between the two numbers
    # kills the load inside oneMKL, and the failure then reads like a missing asset.
    # 0 means "commit has never been measured for this row", which the pool says out loud
    # instead of inventing a number.
    est_peak_commit_mib: int = 0
    est_peak_commit_basis: str = ""
    # VRAM is a SEPARATE quantity from system RAM: a GPU-resident job can fit in RAM and still
    # not fit on the device (and vice versa). 0 means "no VRAM requirement declared", which the
    # device planner treats as "GPU is not selectable for this capability".
    est_peak_vram_mib: int = 0
    # Provenance of est_peak_vram_mib; "measured" only after a real GPU run recorded it.
    est_vram_basis: str = ""
    # Environment variables the adapter needs to be configured (empty = no configuration).
    config_env: tuple[str, ...] = ()
    # Token env var when needs_token is set; the value itself is never read or logged.
    token_env: str = "HF_TOKEN"

    def installed(self) -> bool:
        if self.requires_runtime:
            # The dependency is an isolated project-local interpreter plus its pinned
            # distributions, not a module importable from THIS process. Importing it to answer
            # the question would allocate the very weights the answer is about.
            return ocr_runtime.installed(self.requires_runtime)
        if self.builtin:
            # Every declared external program must have a validated copy: a capability that
            # needs a decoder AND a recogniser is not "installed" when only one of them is
            # present, and reporting it as installed is what makes the job fail later.
            if self.requires_binary or self.also_requires_binaries:
                return not self.missing_binaries()
            return True
        if not self.package:
            return False
        try:
            # find_spec raises ModuleNotFoundError when the PARENT package is missing
            # ("pyannote.audio" without "pyannote"), which must not crash capability reporting.
            return importlib.util.find_spec(self.package) is not None
        except (ImportError, ValueError):
            return False

    def missing_binaries(self) -> list[str]:
        """External programs this row needs that have no validated copy on this host."""
        names = ([self.requires_binary] if self.requires_binary else []) + list(
            self.also_requires_binaries)
        return [name for name in names if not binaries.resolve(name).found]


class Catalog:
    def __init__(self, specs: list[ModelSpec]) -> None:
        # Keyed by (capability, id), NOT by id. The same checkpoint can legitimately be
        # registered for two different capabilities (the CT2 whisper row is both the ASR
        # backend and the word-timing aligner), and an id-keyed dict silently keeps only
        # the LAST row: the audit-visible symptom was speech.asr losing the one ASR row
        # that can actually execute, while every routing/status answer kept quoting it.
        self._ordered: list[ModelSpec] = list(specs)
        self._specs: dict[tuple[str, str], ModelSpec] = {(s.capability, s.id): s for s in specs}
        self._resident: set[str] = set()
        self._running_worker_cap: str | None = None
        # Malformed OPTIONAL metadata is reported, never fatal: one bad manifest row
        # must not take the supervisor down, and must not be read as if it said something.
        self._claim_problems = [
            problem for problem in (validate_language_claims(s.claims, model_id=s.id)
                                    for s in specs) if problem
        ]

    def all_specs(self) -> list[ModelSpec]:
        """Every registered row, in registration order, duplicates across capabilities kept."""
        return list(self._ordered)

    def get(self, model_id: str, capability: str = "") -> ModelSpec | None:
        """The row for a model id.

        With a capability, the exact (capability, id) row. Without one, the FIRST row
        registered under that id, which is the deterministic answer a caller like the
        asset preparer wants; a caller that cares which capability it means must say so.
        """
        if capability:
            return self._specs.get((capability, model_id))
        return next((s for s in self._ordered if s.id == model_id), None)

    def for_capability(self, capability: str) -> list[ModelSpec]:
        return [s for s in self._ordered if s.capability == capability]

    def claim_problems(self) -> list[str]:
        return list(self._claim_problems)

    def readiness(self, model_id: str, capability: str = "") -> AdapterReadiness:
        """Real readiness for one registered model id, computed, never stored as a string."""
        spec = self.get(model_id, capability)
        if spec is None:
            return READINESS_UNKNOWN
        return self._readiness(spec)

    def _readiness(self, spec: ModelSpec) -> AdapterReadiness:
        implemented = bool(spec.adapter)
        if implemented:
            try:
                implemented = importlib.util.find_spec(spec.adapter) is not None
            except (ImportError, ValueError):
                implemented = False
        dependencies_present = spec.installed()
        if spec.asset:
            refs = [AssetRef(spec.asset, self._pinned_revision(spec), spec.required_files)]
            refs += [AssetRef(ref.repo_id, ref.revision or self._pinned_revision(spec),
                              ref.required_files) for ref in spec.extra_assets]
            assets_validated = all(
                assets.asset_state(ref.repo_id, expected_revision=ref.revision,
                                   required=ref.required_files).present
                for ref in refs)
        else:
            # An adapter that declares no asset says so explicitly; that is a satisfied
            # condition, not an unmeasured one.
            assets_validated = True
        configuration_valid = all(os.environ.get(name, "").strip() for name in spec.config_env)
        if spec.needs_token:
            access_satisfied = bool(os.environ.get(spec.token_env, "").strip())
        else:
            access_satisfied = True
        return AdapterReadiness(implemented, dependencies_present, assets_validated,
                                configuration_valid, access_satisfied)

    @staticmethod
    def _pinned_revision(spec: ModelSpec) -> str:
        """The revision a row demands of its asset, or "" when it deliberately pins none.

        A row that is still an unpinned candidate must not be failed for having the
        wrong snapshot - there is no right one yet. A row that DOES name a revision gets
        that revision checked, so "the asset is present" cannot be satisfied by whatever
        download happened to land in the cache directory.
        """
        rev = (spec.revision or "").strip()
        if rev in ("", "unpinned", NOT_MIGRATED, "builtin"):
            return ""
        return rev

    def executable_for(self, capability: str) -> list[ModelSpec]:
        """Specs that can genuinely run here. Never loads a heavy model to answer."""
        return [s for s in self.for_capability(capability) if self._readiness(s).executable]

    def blockers_for(self, capability: str) -> tuple[str, list[str]]:
        """(model_id, blockers) for the MOST-ADVANCED row of a capability family.

        The most-advanced row is the one dispatch should be told about: if the adapter is
        already implemented and only the asset is missing, the actionable step is to
        prepare the asset, not to write the adapter. Reporting the first registered row
        instead would send the reader to the wrong work item.
        """
        specs = self.for_capability(capability)
        if not specs:
            return "", []
        best = max(specs, key=lambda s: bool(s.adapter))
        return best.id, self._readiness(best).blockers()

    def asset_problems(self, spec: ModelSpec) -> list[str]:
        """Why an asset condition failed, per asset. Never inferred from a directory's mood.

        Cheap: a local cache scan and a stat per required file. It is what turns "the OCR
        engine is not executable" into an actionable sentence naming the missing weight file.
        """
        if not spec.asset:
            return []
        refs = [AssetRef(spec.asset, self._pinned_revision(spec), spec.required_files)]
        refs += [AssetRef(ref.repo_id, ref.revision or self._pinned_revision(spec),
                          ref.required_files) for ref in spec.extra_assets]
        out: list[str] = []
        for ref in refs:
            state = assets.asset_state(ref.repo_id, expected_revision=ref.revision,
                                       required=ref.required_files)
            if not state.present:
                out.append(f"{ref.repo_id}: {state.detail}")
        return out

    def pipeline_rows(self, name: str) -> list[ModelSpec]:
        """The registry rows a named pipeline needs, so one command prepares every asset.

        The name is the DISPLAY id (what the UI and the CLI say), not a Hugging Face repo id.
        Unknown names return [] so the preparer can list the valid ones instead of silently
        fetching nothing.
        """
        wanted = (name or "").strip().lower()
        rows = [s for s in self._ordered
                if s.id.strip().lower() == wanted and bool(s.adapter)]
        if not rows:
            rows = [s for s in self._ordered
                    if wanted and (wanted in s.id.strip().lower() or s.id.strip().lower() in wanted)
                    and bool(s.adapter)]
        # One row per (capability, id); a pipeline name must not prepare the same asset twice.
        unique: list[ModelSpec] = []
        seen: set[tuple[str, str]] = set()
        for row in rows:
            key = (row.capability, row.id)
            if key not in seen:
                seen.add(key)
                unique.append(row)
        return unique

    def pipeline_names(self) -> list[str]:
        return sorted({s.id for s in self._ordered if bool(s.adapter) and (s.asset or s.extra_assets)})

    def status_for(self, capability: str) -> dict[str, Any]:
        specs = self.for_capability(capability)
        if not specs:
            return {"status": NOT_CONFIGURED, "models": [], "detail": "no adapter is registered for this capability"}
        entries = []
        for s in specs:
            ready = self._readiness(s)
            binary = binaries.resolve(s.requires_binary) if s.requires_binary else None
            if s.needs_token and not s.installed():
                st = LICENSE_REQUIRED
                detail = "provider requires an access token and licence acceptance; startup must not fail"
            elif not ready.implemented:
                st = NOT_CONFIGURED
                detail = (f"registry row {s.id} names no importable adapter module, so this "
                          "capability cannot execute here regardless of what is installed")
            elif s.needs_token and not ready.access_satisfied:
                st = LICENSE_REQUIRED
                detail = (f"the adapter is implemented and its dependency is present, but "
                          f"{s.token_env} is not set and the licence has not been accepted")
            elif ready.implemented and not ready.assets_validated:
                st = NOT_INSTALLED
                problems = self.asset_problems(s)
                detail = (f"adapter implemented; its pinned asset(s) are not satisfied "
                          f"(prepare them with python -m ruke_ml.models.prepare --pipeline {s.id}): "
                          + ("; ".join(problems) if problems else f"{s.asset!r} is not in the local cache"))
            elif s.requires_runtime and not s.installed():
                st = NOT_INSTALLED
                detail = (f"adapter implemented and its assets are in place, but the isolated "
                          f"runtime {s.requires_runtime!r} is not validated: "
                          + ocr_runtime.status(s.requires_runtime).detail)
            elif s.builtin and not s.installed():
                st = NOT_INSTALLED
                missing = s.missing_binaries()
                probe = binaries.resolve(missing[0]) if missing else binary
                named = ", ".join(repr(name) for name in missing) or repr(s.requires_binary)
                detail = (f"implemented here but needs the external program(s) {named}; "
                          + (probe.detail if probe else "no candidate was probed"))
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
                # AVAILABLE is only reported when the whole readiness conjunction holds.
                st = AVAILABLE if ready.executable else NOT_CONFIGURED
                if ready.executable:
                    detail = _executable_detail(s, binary)
                else:
                    detail = "not executable: " + "; ".join(ready.blockers())
            entries.append({"id": s.id, "revision": s.revision, "status": st, "detail": detail,
                            "claims": s.claims, "verified": s.verified, "heavy": s.heavy,
                            "est_peak_mib": s.est_peak_mib, "builtin": s.builtin,
                            "requires_binary": s.requires_binary,
                            "also_requires_binaries": list(s.also_requires_binaries),
                            "adapter": s.adapter, "asset": s.asset,
                            "extra_assets": [{"repo_id": a.repo_id, "revision": a.revision,
                                              "required_files": [list(f) for f in a.required_files]}
                                             for a in s.extra_assets],
                            "requires_runtime": s.requires_runtime or None,
                            "runtime": (ocr_runtime.status(s.requires_runtime).as_dict()
                                        if s.requires_runtime else None),
                            "asset_problems": self.asset_problems(s),
                            "est_peak_basis": s.est_peak_basis,
                            "readiness": ready.as_dict(),
                            "executable": ready.executable,
                            # Provenance, not a guess: which copy was found, where it came
                            # from, and why a rejected candidate was rejected.
                            "binary": binary.as_dict() if binary is not None else None})
        best = next((e for e in entries if e["status"] == AVAILABLE), None)
        chosen = best or entries[0]
        return {"status": best["status"] if best else entries[0]["status"], "models": entries,
                "detail": best["detail"] if best else entries[0]["detail"],
                # The provenance of the entry whose status is being reported, never of an
                # arbitrary sibling spec in the same capability family.
                "binary": chosen["binary"],
                # Malformed optional manifest metadata for ANY row in this family. The
                # supervisor stays up; the report stops pretending the metadata meant something.
                "metadata_problems": self.claim_problems()}


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


def _executable_detail(spec: ModelSpec, binary: Any) -> str:
    if spec.builtin and binary is not None:
        return ("built into this package; the external program it needs was "
                f"validated via {binary.source}: {binary.detail}")
    if spec.builtin:
        return "built into this package; it runs here and must state its own quality mode"
    if spec.requires_runtime:
        runtime = ocr_runtime.status(spec.requires_runtime)
        return (f"adapter {spec.adapter} is implemented and runs in the isolated interpreter "
                f"{runtime.interpreter}; {runtime.detail}; heavy weights load only inside an "
                "owned worker")
    asset_note = (f"asset {spec.asset} is in the local cache" if spec.asset
                  else "no external asset is needed")
    return (f"adapter {spec.adapter} is implemented, {spec.package} is importable, {asset_note}; "
            "heavy weights load only inside an owned worker")


_DEFAULTS: list[ModelSpec] = [
    ModelSpec(id="ruke-lexical-bm25", revision="builtin-v1", capability="rerank", provider="builtin",
              package="", heavy=False, builtin=True, claims={"coverage": "lexical only"},
              adapter="ruke_ml.retrieval.reranker",
              notes="always-available baseline; must report its own quality mode"),
    # The embeddings path that actually runs in this checkout is the hashed-lexical view
    # used for fusion. It is a real, executable implementation, so it must be registered;
    # otherwise "embeddings" looks uniformly uninstalled even though a caller can get
    # vectors out of it today, and the eval harness has no adapter to name.
    ModelSpec(id="ruke-lexical-hash", revision="builtin-v1", capability="embeddings",
              provider="builtin", package="", heavy=False, builtin=True,
              claims={"coverage": "hashed lexical term weights, not model-quality",
                      "dim": 512, "normalization": "l2"},
              adapter="ruke_ml.retrieval.embeddings",
              verified={"model_quality_parity": False},
              notes="quality mode is reported per call; never claim parity with a neural "
                    "embedder, and a lexical vector must never be tagged as a proven-relevant passage"),
    ModelSpec(id="Qwen/Qwen3-Embedding-0.6B", revision="unpinned", capability="embeddings",
              provider="huggingface", package="sentence_transformers",
              claims={"languages": [], "dim": 1024,
                      "pooling": "documented last-token + normalize"},
              asset="Qwen/Qwen3-Embedding-0.6B",
              verified={"multilingual_quality_on_this_host": False},
              notes="no adapter module is implemented for it here, so it is not executable; "
                    "its published language table was never captured offline, so claims.languages "
                    "stays empty rather than prose. Do not reuse MiniLM pooling; verify "
                    "pooling/instruction and dimension before indexing"),
    # --- the neural embedding backend that EXECUTES here: MiniLM-L6-v2 ONNX on CPU.
    # The row names the same package, the same asset and the same adapter module the worker
    # loads, and the asset identity is a sha256 the adapter re-verifies at load time.
    # "available" here therefore means a job can actually run, not that a wheel imports.
    ModelSpec(id=MINILM_ID, revision="builtin", capability="embeddings",
              provider="onnxruntime-cpu", package="onnxruntime", heavy=True,
              adapter="ruke_ml.retrieval.nn_embed", asset=MINILM_ID,
              required_files=(("onnx/model.onnx", 90_000_000), ("tokenizer.json", 500_000),
                              ("config.json", 100), ("tokenizer_config.json", 100)),
              claims={"dim": 384, "max_tokens": MINILM_MAX_TOKENS,
                      "pooling": "mean over the attention mask, then L2 normalize "
                                 "(the published protocol for this checkpoint)",
                      "providers": ["CPUExecutionProvider"],
                      "asset_identity": f"sha256 of onnx/model.onnx re-verified at load: {MINILM_SHA256}",
                      "dependencies": "onnxruntime + tokenizers in the project venv",
                      # Published card coverage, not measured quality. all-MiniLM-L6-v2 is a
                      # mostly-English sentence-embedding checkpoint; claiming broad
                      # multilingual quality here would be exactly the overclaim the registry
                      # comment at the top of this file forbids.
                      "languages": [], "language_note": "no measured non-English quality on this host"},
              verified={"asset_digest_verified_on_this_host": True,
                        "cpu_provider_only": True,
                        "dense_vectors_load_and_embed_on_this_host": True,
                        "multilingual_quality_on_this_host": False,
                        "model_quality_parity": False},
              est_peak_mib=288, est_peak_basis="measured: cold-load peak working set of one "
                                                "CPU onnxruntime session, 48 texts, 2026-11-17; "
                                                "commit/private was ~1012 MiB, so the budget "
                                                "report must quote BOTH or it understates pressure",
              notes="runs in the worker host, not the supervisor; lexical hashing stays available "
                    "as the clearly-labelled fallback and is never presented as this model"),
    # The neural reranker is a DENSE BI-ENCODER over the checkpoint above. It is genuinely
    # neural, and it is genuinely NOT a cross-encoder: no cross-encoder asset is pinned on
    # this host, and the mode string the worker returns says so.
    ModelSpec(id="ruke-neural-biencoder-minilm", revision="builtin", capability="rerank",
              provider="onnxruntime-cpu", package="onnxruntime", heavy=True,
              adapter="ruke_ml.retrieval.reranker", asset=MINILM_ID,
              required_files=(("onnx/model.onnx", 90_000_000), ("tokenizer.json", 500_000)),
              claims={"protocol": "cosine of L2-normalized mean-pooled vectors; query and "
                                  "candidate are encoded independently",
                      "not_a": "cross-encoder — no joint query/passage scoring happens",
                      "scoring": "cosine in [-1,1], descending rank"},
              verified={"asset_digest_verified_on_this_host": True, "cpu_provider_only": True,
                        "cross_encoder_parity": False},
              est_peak_mib=288, est_peak_basis="measured with the embedding row above",
              notes="candidate recall is measured BEFORE reranking: a reranker cannot recover "
                    "evidence that candidate selection already dropped"),
    # --- the neural CROSS-ENCODER that now EXECUTES here (F27). Separate asset, separate
    # adapter, separate protocol from the bi-encoder above: one forward pass over the
    # (query, passage) PAIR, so the two channels attend to each other. Downloaded from the
    # pinned Hugging Face revision below into the project model dir, digest recorded, and the
    # adapter re-verifies that digest at every load. "available" means a rerank job in this
    # mode actually runs here, which the g05 probe demonstrated; a production caller now uses
    # it (D-058; the chain is executed end-to-end by the F66 live-route test), and it still
    # does not mean parity.
    ModelSpec(id=CROSS_ENCODER_ID, revision=CROSS_ENCODER_COMMIT, capability="rerank",
              provider="onnxruntime-cpu", package="onnxruntime", heavy=True,
              adapter="ruke_ml.retrieval.nn_rerank", asset=CROSS_ENCODER_ID,
              required_files=(("onnx/model.onnx", 90_000_000), ("tokenizer.json", 500_000),
                              ("config.json", 100), ("tokenizer_config.json", 100)),
              claims={"protocol": "joint (query, passage) tokenization [CLS] q [SEP] p [SEP], "
                                  "one logit per pair, sigmoid into (0,1); this is the published "
                                  "scoring head of the upstream cross-encoder checkpoint",
                      "not_a": "bi-encoder - query and candidate are never embedded separately "
                               "here; and not a recall fix - it only reorders given candidates",
                      "max_tokens": CROSS_ENCODER_MAX_TOKENS,
                      "truncation": "tail beyond max_tokens is dropped by the tokenizer and "
                                    "REPORTED per job in the payload, never hidden",
                      "providers": ["CPUExecutionProvider"],
                      "asset_identity": f"sha256 of onnx/model.onnx re-verified at load: "
                                        f"{CROSS_ENCODER_SHA256}",
                      "upstream_source": "cross-encoder/ms-marco-MiniLM-L-6-v2, ONNX export",
                      "dependencies": "onnxruntime + tokenizers in the project venv",
                      "preparation": f"python -m ruke_ml.models.prepare --model {CROSS_ENCODER_ID} "
                                     "--local  (project-local checkout + asset-manifest.json; "
                                     "ordinary startup never downloads it)",
                      # Published coverage of an English MS MARCO checkpoint. Empty list, plus an
                      # explicit note: no non-English quality has been measured on this host, so
                      # nothing here may be read as multilingual reranking.
                      "languages": [],
                      "language_note": "English MS MARCO training distribution; no measured "
                                       "non-English quality on this host"},
              verified={"asset_digest_verified_on_this_host": True,
                        "asset_pinned_revision_recorded": True,
                        "cpu_provider_only": True,
                        "joint_pair_scoring_executed_on_this_host": True,
                        "scores_reproducible_on_this_host": True,
                        # Measured on the g05 probe (n=10 hand-authored queries, 6 domains,
                        # expected answer fixed before any engine ran): top-1 9/10, top-3 10/10,
                        # MRR 0.950. Same numbers as the dense bi-encoder, i.e. it TIES on this
                        # set and did not beat it, so parity is not claimed.
                        "ranking_top1_9_of_10_on_g05_set": True,
                        "beats_dense_biencoder_on_g05_set": False,
                        # The failure that motivated a cross-encoder is STILL a failure for it:
                        # the two-candidate numeric-fact case ranked the wrong number first with
                        # every engine (g05 line "g04_numeric_case: cross_encoder_rank=2").
                        "numeric_fact_case_fixed": False,
                        "multilingual_quality_on_this_host": False,
                        "model_quality_parity": False,
                        # Wired as of D-058: TS attachindex owns retrieval, and its rerank stage
                        # (lib/server/attachindex/rerank.ts, wired in turn.ts) invokes this
                        # engine through the Rust ml-job route (POST /api/ruke/ml/job), which
                        # accepts `rerank`. F66 executed that chain end-to-end on the live tree
                        # and recorded the supervisor tree's peak RSS
                        # (logs/f66-rerank-live-route-1.log, 2026-11-20). Wiring and execution
                        # are proven; QUALITY is not claimed - the negative results above stand
                        # and are pinned as characterizations by the live test
                        # __tests__/server/attach-rerank-live-route.test.ts.
                        "production_caller_wired": True},
              est_peak_mib=268,
              est_peak_basis="measured: 267.7 MiB peak working set of the g05 probe process, "
                             "which held BOTH the bi-encoder and the cross-encoder ONNX "
                             "sessions plus numpy/onnxruntime/tokenizers import time "
                             "(logs/f27-g05-rerank-2.log, 2026-11-17). Not an isolated single-"
                             "engine figure; a worker that loads only this engine is smaller "
                             "(91 MB fp32 weights), but commit charge is not measured here.",
              notes="candidate recall is still measured BEFORE reranking; the engine adds a "
                    "joint-scoring second opinion on the same candidates, it cannot retrieve "
                    "what candidate selection dropped. Retains the clearly-labelled lexical "
                    "(BM25) fallback and never substitutes it silently for a neural mode."),
    ModelSpec(id="BAAI/bge-m3", revision="unpinned", capability="embeddings", provider="huggingface",
              package="FlagEmbedding", claims={"languages": []}, asset="BAAI/bge-m3",
              verified={"multilingual_quality_on_this_host": False}),
    ModelSpec(id="Qwen/Qwen3-Reranker-0.6B", revision="unpinned", capability="rerank",
              provider="huggingface", package="sentence_transformers",
              claims={"protocol": "documented generative/instruct scoring", "languages": []},
              asset="Qwen/Qwen3-Reranker-0.6B",
              verified={"quality_on_this_host": False}),
    # --- the ASR backend that actually runs here: faster-whisper on CTranslate2.
    # The registry row names the SAME package, model id and adapter module the worker
    # loads, so "available" cannot mean "a different library is importable".
    ModelSpec(id="Systran/faster-whisper-base", revision=SPEECH_REVISION, capability="speech.asr",
              provider="huggingface", package="faster_whisper",
              adapter="ruke_ml.speech.whisper_ct2", asset="Systran/faster-whisper-base",
              claims={"languages": WHISPER_TAGS, "task": "transcribe+translate",
                      "language_table": "faster_whisper.tokenizer._LANGUAGE_CODES",
                      "language_detection": True,
                      "timestamps": "source-time segments; word timing only with word_timestamps",
                      "device_policy": "cpu/int8 - a GPU on this host belongs to the main LLM",
                      # Measured, not inferred: the E03 probe ran this exact pinned snapshot
                      # on CPU/int8 through the real worker pipe. Sample size is stated with
                      # the number because one short TTS clip measures the mechanics and this
                      # language on this host, NOT general multilingual quality.
                      "measured_on_this_host": {
                          "en": {"word_error_rate": 0.0769, "truth_words": 13, "clips": 1,
                                 "device": "cpu", "compute_type": "int8",
                                 "evidence": "docs/overnight/logs/e03-speech-20261116T16564630343.json",
                                 "note": "en-US synthetic TTS; a second clip inside an MP4 "
                                         "container scored 0.0"}},
                      "not_measured": "multilingual quality (the published table is a claim), "
                                      "music/speech content classification, speaker separation"},
              verified={},
              est_peak_mib=388,
              # Machine-readable provenance, not prose: with this empty, `admission` charges
              # the row as provisional (1.5x plus a 1 GiB margin) even though the number below
              # was actually measured on this host, and a report cannot tell measured from guess.
              est_peak_basis="measured: E03 2026-11-16 cold-load peak working set summed across "
                             "the owned worker tree that ran this pinned snapshot on cpu/int8 "
                             "(docs/overnight/logs/e03-speech-20261116T16564630343.json)",
              # Resident 388 MiB, commit 1,276 MiB. The enforceable ceiling is in COMMIT, so the
              # ceiling has to be cleared by this second number, not the first. See
              # ruke_ml/allocations.py for the failure this exact pair produced.
              est_peak_commit_mib=1_276,
              est_peak_commit_basis="measured: same E03 run, peak_commit of the owned worker tree "
                                    "= 1276.0 MiB (pagefile charge, not resident RAM)",
              notes="published multilingual table, captured from the pinned package. Every "
                    "per-language verified flag must come from a measured run on this host; "
                    "none is assumed. The revision is the snapshot actually prepared inside "
                    "the project (.data/ml-cache), not a floating main branch. est_peak_mib is "
                    "measured (E03, 2026-11-16): sum of per-process peak working sets across "
                    "the worker tree = 388 MiB, largest simultaneous sample = 318 MiB, peak "
                    "commit = 1276 MiB. It counts the worker tree, because the venv "
                    "python.exe this supervisor spawns is a redirector and its child "
                    "interpreter is what holds the weights"),
    ModelSpec(id="Systran/faster-whisper-base", revision=SPEECH_REVISION, capability="speech.align",
              provider="huggingface", package="faster_whisper",
              adapter="ruke_ml.speech.whisper_ct2", asset="Systran/faster-whisper-base",
              claims={"languages": WHISPER_TAGS, "output": "word timing from the model's own "
                                                          "cross-attention, validated on receipt"},
              verified={},
              est_peak_mib=388,
              est_peak_basis="measured: same checkpoint and same load path as the speech.asr "
                             "row above (E03, 2026-11-16)",
              est_peak_commit_mib=1_276,
              est_peak_commit_basis="measured: same E03 run as the speech.asr row (same "
                                    "checkpoint, same load path)",
              notes="alignment support is the ALIGNER's table, not the ASR's: it is only used "
                    "when the same checkpoint can produce word times, and a segment span is "
                    "never passed off as word timing. est_peak_mib is the same measured "
                    "checkpoint as the speech.asr row; word times were observed from the "
                    "provider (E03 C10 verdict counts), not interpolated"),
    ModelSpec(id="Xenova/whisper-base.en", revision="unpinned", capability="speech.asr",
              provider="huggingface", package="transformers", heavy=True,
              claims={"languages": ["en"]}, asset="Xenova/whisper-base.en",
              verified={},
              notes="English ONLY - it must never be the universal default"),
    ModelSpec(id="openai/whisper-large-v3", revision="unpinned", capability="speech.asr",
              provider="huggingface", package="transformers",
              claims={"languages": WHISPER_TAGS}, asset="openai/whisper-large-v3",
              verified={"te": False, "hi": False, "en": False},
              notes="candidate for Telugu/Hindi; the tag list is the published Whisper "
                    "multilingual table, and published support is not quality evidence. No "
                    "adapter module is implemented for the transformers path here"),
    ModelSpec(id="Qwen/Qwen3-ASR-1.7B", revision="unpinned", capability="speech.asr",
              provider="huggingface", package="qwen_asr",
              claims={"languages": []}, asset="Qwen/Qwen3-ASR-1.7B",
              verified={"te": False, "hi": False},
              notes="its published language table was never captured offline, so no language is "
                    "claimed and nothing routes through it; the earlier prose value ("
                    "\"as published\") was unreadable by any router and is deliberately gone"),
    ModelSpec(id="pyannote/speaker-diarization-community-1", revision="unpinned",
              capability="speech.diarize", provider="huggingface", package="pyannote.audio",
              needs_token=True, claims={"speakers": "anonymous labels only", "languages": []},
              asset="pyannote/speaker-diarization-community-1", token_env="HF_TOKEN",
              notes="licence acceptance required; report the blocker, never fail startup"),
    # speech.align must be registered, otherwise speech.alignment.alignment_supported()
    # can only ever answer "no aligner is registered", even on a host where one IS
    # installed. A capability with no spec is reported not_configured, which is a
    # different (and here a false) claim than "installed but not yet verified".
    ModelSpec(id="Qwen/Qwen3-ForcedAligner-0.6B", revision="unpinned", capability="speech.align",
              provider="huggingface", package="qwen_asr",
              claims={"languages": [], "output": "word/character timing"},
              asset="Qwen/Qwen3-ForcedAligner-0.6B",
              verified={"te": False, "hi": False, "en": False},
              notes="published aligner table omits Telugu and Hindi; those languages must "
                    "fall back to segment-level timing rather than invented word times"),
    ModelSpec(id="whisperx/whisper-alignment", revision="unpinned", capability="speech.align",
              provider="pypi", package="whisperx",
              claims={"languages": [],
                      "output": "word timing cross-checked against the ASR hypothesis"},
              asset="",
              verified={"te": False, "hi": False, "en": False},
              notes="alignment must never silently stretch a clock error; only load when "
                    "precise word timing or subtitles are actually requested"),
    # --- document reading that actually runs here. The OOXML/text readers are built in;
    #     the PDF reader is the pinned pure-python backend named by this row.
    ModelSpec(id="ruke-ooxml-reader", revision="builtin-v1", capability="documents.parse",
              provider="builtin", package="", heavy=False, builtin=True,
              adapter="ruke_ml.documents.parser",
              claims={"formats": ["xlsx", "docx", "pptx", "txt", "md", "log", "csv", "json"],
                      "languages": []},
              notes="stdlib OOXML/text reader: formulas with cached values, merged ranges, "
                    "table identity and speaker notes survive; visual content is not described"),
    ModelSpec(id="pypdf", revision="unpinned", capability="documents.parse", provider="pypi",
              package="pypdf", adapter="ruke_ml.documents.pdf", asset="",
              claims={"formats": ["pdf"], "languages": [],
                      "extraction": "native text layer per page, rotation and per-page honesty; "
                                    "scanned pages are routed to OCR, never invented"},
              verified={"tables": False, "formula": False, "indic_ocr": False},
              notes="the PDF text-layer backend that actually executes here. It is NOT an OCR "
                    "engine and claims no OCR quality; layout/indic coverage stays unmeasured "
                    "until the document quality gate runs"),
    ModelSpec(id="docling", revision="unpinned", capability="documents.parse", provider="pypi",
              package="docling", claims={"formats": [], "languages": []},
              asset="",
              verified={"tables": False, "formula": False, "indic_ocr": False},
              notes="candidate only: no adapter module is implemented for it, so it is not "
                    "executable; layout/OCR extras are selected per document class after measurement"),
    ModelSpec(id="tesseract", revision="unpinned", capability="documents.ocr", provider="binary",
              package="", builtin=True, requires_binary="tesseract",
              adapter="ruke_ml.documents.ocr_tesseract", asset="",
              claims={"languages": [],
                      "coverage": "whatever the installed tesseract + installed language packs "
                                  "actually cover, probed per run"},
              verified={"te": False, "hi": False},
              notes="real OCR adapter for the external tesseract program; its language coverage "
                    "is probed from the program itself, never copied from a model card"),
    # The primary OCR pipeline the amendment pins: PP-DocLayoutV3 layout analysis plus the
    # PaddleOCR-VL 1.6 recognition model, assembled as a document pipeline rather than the VLM
    # alone. Every condition is separately checkable:
    #   implemented   -> ruke_ml.documents.ocr_paddle (a real adapter that spawns a worker)
    #   dependencies  -> the isolated CPU venv validated from its pinned dist-info, not an import
    #   assets        -> BOTH repositories at the pinned revisions, file-by-file
    # It deliberately does NOT claim "available" here: readiness is computed, so on a host whose
    # free RAM cannot admit the pipeline the job answer is a typed refusal, not a green string.
    ModelSpec(id="PaddleOCR-VL-1.6", revision=PADDLE_VL_REVISION, capability="documents.ocr",
              provider="paddle", package="", requires_runtime=ocr_runtime.RUNTIME_ID,
              adapter="ruke_ml.documents.ocr_paddle",
              asset=PADDLE_VL_REPO, required_files=PADDLE_VL_FILES,
              extra_assets=(AssetRef(PADDLE_LAYOUT_REPO, PADDLE_LAYOUT_REVISION,
                                     PADDLE_LAYOUT_FILES),),
              claims={"ocr": "document pipeline: layout analysis + element recognition + "
                             "structured assembly (PP-DocLayoutV3 + PaddleOCR-VL 1.6)",
                      "device": "cpu only - the pinned paddlepaddle wheel is the x64 CPU build",
                      "languages": ["en", "fr", "de", "ja", "ko", "zh", "es", "pt", "it", "ru",
                                    "ar", "hi", "bn", "te", "ta", "mr", "sa", "fa", "ur"]},
              verified={"te": False, "hi": False, "en": False, "complex_layout": False,
                        "formula": False, "table": False},
              # 2,061,276,063 B of pinned weights (1,930,469,491 + 130,806,572) plus the paddle
              # runtime and activations. This is a PROVISIONAL bound, not a measurement: it is
              # replaced by the recorded cold-load peak the first time the pipeline actually
              # runs under tree accounting. Until then it errs high, because under-estimating a
              # 2 GB model is how a host gets OOM-killed instead of getting a typed refusal.
              est_peak_mib=3_300,
              est_peak_basis="provisional: pinned weight bytes 1966 MiB + paddle runtime and "
                             "activation allowance; NOT yet a measured cold-load peak",
              # VRAM is reported separately from system RAM: fitting in RAM says nothing about the
              # device, and on this host the shared 12 GiB GPU is mostly occupied by the main model.
              # The bound errs high on purpose - a GPU estimate that is too low turns a schedulable
              # job into a CUDA allocation failure inside a child we then have to clean up.
              est_peak_vram_mib=6_000,
              est_vram_basis="provisional: device-resident weights 1966 MiB + layout model + fp32 "
                             "activations/page render buffers; NOT yet a measured GPU peak (no GPU "
                             "run has been executed on this host yet)",
              notes="primary OCR engine. Its published language list is a PUBLISHED claim, not "
                    "measured quality: nothing here is verified until the document quality gate "
                    "runs it on real pages on THIS host. Indic coverage stays unverified."),
    # --- temporal video: the planning/timestamping logic is implemented here; the pixels
    #     come from ffmpeg, so the honest status on a host without ffmpeg is not_installed.
    ModelSpec(id="ruke-video-timeline", revision="builtin-v1", capability="video.timeline",
              provider="builtin", package="", heavy=False, builtin=True, requires_binary="ffmpeg",
              adapter="ruke_ml.video.timeline",
              claims={"timing": "source timestamps from the container, never frame_index/nominal_fps",
                      "evidence": "atomic timeline record with per-stage coverage"},
              notes="frame decoding and seeking need ffmpeg on PATH; scene/timeline correctness "
                    "still has to be measured on a human-labelled recording before quality is claimed"),
    ModelSpec(id="ruke-video-scenes", revision="builtin-v1", capability="video.scenes",
              provider="builtin", package="", heavy=False, builtin=True,
              adapter="ruke_ml.video.scenes",
              claims={"coverage": "bounded sampling plan, head/middle/tail + query windows"},
              notes="produces a sampling plan only; a bounded plan can never prove an event is absent, "
                    "and extracting the planned frames needs ffmpeg (see video.timeline status)"),
    ModelSpec(id="ruke-video-observations", revision="builtin-v1", capability="video.observations",
              provider="builtin", package="", heavy=False, builtin=True,
              adapter="ruke_ml.video.observations",
              claims={"storage": "timestamped observation records with provenance"},
              notes="stores/validates observations; producing them from frames needs ffmpeg plus a "
                    "vision/OCR stage that is itself gated, so no visual quality is claimed"),
    ModelSpec(id="ruke-video-search-hints", revision="builtin-v1", capability="video.search_hints",
              provider="builtin", package="", heavy=False, builtin=True,
              adapter="ruke_ml.video.search_hints",
              claims={"output": "MediaSearchHints with provenance + source intervals"},
              notes="derives hints only from evidence already in the timeline record; with no "
                    "evidence staged it returns nothing rather than inventing clues"),
    # The stage that makes "visual evidence" mean something: it decodes a frame and READS the
    # glyphs in it. Before this row existed the pipeline could plan frames and store
    # "visual" observations, but nothing anywhere turned pixels into text, so on-screen text
    # (slides, burned-in captions, terminal output, signage) was unreachable at any sample rate.
    # Two external programs are required, so readiness ANDs both: ffmpeg for the pixels, the
    # validated tesseract copy for the glyphs. It deliberately claims no language list - the
    # engine's coverage is probed from the installed binary, exactly like documents.ocr.
    ModelSpec(id="ruke-video-frame-ocr", revision="builtin-v1", capability="video.frame_ocr",
              provider="builtin", package="", heavy=False, builtin=True,
              requires_binary="ffmpeg", also_requires_binaries=("tesseract",),
              adapter="ruke_ml.video.frame_ocr",
              claims={"languages": [],
                      "coverage": "only the sampled instants that were decoded AND recognised; "
                                  "a bounded sample of instants can never establish visual "
                                  "coverage of a recording",
                      "output": "per-instant text with source-relative presentation times and "
                                "the engine that produced it"},
              verified={},
              notes="reads visible TEXT in frames with the same project-local engine as "
                    "documents.ocr; it does not interpret diagrams, recover table structure or "
                    "claim layout fidelity, and no frame OCR quality is measured on this host "
                    "until the media quality gate runs it"),
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
