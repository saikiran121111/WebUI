"""Shared job plumbing so a capability job module can fail in the SAME typed way.

Every capability handler answers with a JobResult whose error carries one of the
contract's legal wire reasons. This module is where the mapping from an adapter's own
typed exception (OCR engine missing, ASR asset missing, decoder failure...) to that wire
reason lives, so no individual handler invents its own status vocabulary and no adapter
failure gets flattened into "internal".
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..contracts import JobRequest, JobResult, StructuredError
from .. import allocations


@dataclass(slots=True)
class JobContext:
    """A request plus the two things a long-running job needs: cancel and progress."""
    req: JobRequest
    cancel: threading.Event
    progress: Callable[[str, str], None]
    # When THIS job started, so a relative deadline_s becomes an absolute instant the OCR
    # cascade can honour page by page. Without it, `deadline_s` is only enforced by the RPC
    # kill from the outside, and a page-level budget has nothing to be measured against.
    started_at: float = field(default_factory=time.time)

    def deadline_at(self) -> float:
        ds = getattr(self.req, "deadline_s", None)
        try:
            seconds = float(ds) if ds else 0.0
        except (TypeError, ValueError):
            seconds = 0.0
        return (self.started_at + seconds) if seconds > 0 else 0.0

    def failed(self, reason: str, message: str, *, retryable: bool = False,
               human_step: str = "") -> JobResult:
        return JobResult(job_id=self.req.job_id, capability=self.req.capability, state="failed",
                         error=StructuredError(reason, message, retryable=retryable,
                                               capability=self.req.capability,
                                               human_step=human_step))

    def cancelled(self) -> JobResult:
        return JobResult(job_id=self.req.job_id, capability=self.req.capability, state="cancelled",
                         error=StructuredError("cancelled", "cancelled before a result was produced",
                                               retryable=True, capability=self.req.capability,
                                               human_step="re-run the request; no partial result "
                                                         "was published"))

    def ready(self, payload: dict[str, Any], coverage: Any = None, model: Any = None,
              progress: float | None = None) -> JobResult:
        return JobResult(job_id=self.req.job_id, capability=self.req.capability, state="ready",
                         payload=payload, coverage=coverage, model=model, progress=progress)


# An adapter exception kind -> (wire reason, retryable, extra human step). The adapter
# names WHAT went wrong; the wire names WHAT THE CALLER CAN DO ABOUT IT. Flattening every
# kind into "internal" is how a missing asset and a corrupt file become the same bug.
KIND_TO_REASON: dict[str, tuple[str, bool, str]] = {
    "engine_missing": ("not_configured", False, "install or point RUKE_TESSERACT at a validated OCR engine"),
    "rasterizer_missing": ("not_configured", False, "install the documents extra (pypdfium2) in the backend venv"),
    "engine_spawn_failed": ("internal", True, "retry; if it repeats, report this log line"),
    "engine_failed": ("internal", True, "retry; if it repeats, check the engine's language data"),
    "ocr_timeout": ("deadline_exceeded", True, "lower the DPI or OCR fewer pages per job"),
    "raster_failed": ("corrupt_input", False, "this page could not be rasterized; repair or split the document"),
    "encrypted_input": ("input_rejected", False, "supply the password, then retry"),
    "corrupt_input": ("corrupt_input", False, "the file could not be parsed; re-export it from the source application"),
    "unsupported_language": ("unsupported_input", False, "install the language data/model for this language, or ask in a supported language"),
    "dependency_missing": ("not_configured", False, "install the pinned dependency from python-backend/pyproject.toml"),
    # The PUBLISHED device is absent (e.g. a CUDA-first ASR row on a CUDA-less host).
    # Distinct from dependency_missing: the package imports fine; the hardware/runtime
    # the model card names is what is not there, and the fix is the CUDA build of the
    # pinned runtime or selecting a model whose published runtime fits this host.
    # Silent CPU fallback is NOT the fix - the published quality numbers then do not
    # describe the run (B5 device law).
    "device_unavailable": ("not_configured", False,
                           "install the CUDA build of the pinned runtime, or select a model "
                           "whose published runtime fits this host in Settings→Models"),
    "asset_missing": ("model_unavailable", False, "prepare the pinned asset explicitly: python -m ruke_ml.models.prepare --model <id>"),
    "load_failed": ("model_unavailable", True, "retry; if it repeats, re-prepare the asset"),
    # An allocation refusal is a RESOURCE condition, never an asset condition. The two human
    # steps are opposites - "free memory and retry" versus "re-prepare the model" - and the
    # second one tells the user to destroy weights that are already valid on disk. See
    # ruke_ml/allocations.py for the measured ASR failure this row exists to stop reporting.
    "allocation_failed": ("memory_pressure", True,
                          "the model is already on disk; free RAM/commit or let the resource "
                          "coordinator take the unload/load handoff, then retry. Do NOT "
                          "re-download the asset"),
    # A capability that DECLARED more peak than the resource window can offer, and was refused
    # before the child existed (or died inside a ceiling the OS had attached). Distinct from
    # allocation_failed, which is the allocator actually saying no: this one is arithmetic decided
    # in advance, and the human action is the same family - widen the window the supported way.
    "resource_limit": ("memory_pressure", True,
                       "the declared peak does not fit the resource window; let the resource "
                       "coordinator take the unload/load handoff and retry inside it, or run the "
                       "recovery engine. Do NOT raise the hard maximum, skip pages, or "
                       "re-prepare assets that are already valid"),
    "decode_failed": ("corrupt_input", False, "the media could not be decoded; check the container and the selected track"),
    "transcription_failed": ("internal", True, "retry; if it repeats, lower the decode window size"),
    "input_rejected": ("input_rejected", False, "check the request arguments"),
    "spawn_failed": ("internal", True, "retry; the external program could not be started"),
    "ffmpeg_not_installed": ("not_configured", False, "install or point RUKE_FFMPEG at a validated copy"),
    "timeout": ("deadline_exceeded", True, "narrow the requested range or raise the job deadline"),
    # Amendment 5: the primary pipeline reports its own conditions, and each has a different
    # human action. Collapsing them into "internal" hides the difference between "prepare the
    # runtime", "this host is out of RAM", and "we refused to place weights on a device the
    # pinned runtime cannot use".
    "runtime_missing": ("not_configured", False,
                        "run scripts/prepare-ocr-runtime.ps1 to build the isolated pinned runtime"),
    "gpu_placement_refused": ("internal", True,
                              "re-plan onto the device the pinned runtime actually supports"),
    "handoff_held": ("resource_busy", True,
                     "another exclusive processing window owns the shared engine; retry after it "
                     "releases"),
    "worker_crashed": ("crash", True, "retry; the processing worker died and was released"),
}


def typed_from_kind(kind: str, message: str, *, human_step: str = "",
                    capability: str = "") -> StructuredError:
    """Map an adapter failure kind onto a legal wire reason, keeping the adapter's own step."""
    reason, retryable, default_step = KIND_TO_REASON.get(
        kind, ("internal", True, "retry; if it repeats, report this log line"))
    # THE CLASS-LEVEL GUARD, not the example-level one (amendment 11: fix the class of
    # failure across every path). Any adapter that flattens an allocation refusal into
    # load_failed / asset_missing / engine_failed / decode_failed produced a reason whose
    # human step tells the user to re-prepare or re-export the very thing that is already
    # valid on disk. The adapter's own step is therefore DROPPED here, and the adapter kind
    # stays in the message so provenance is not lost.
    if kind != "allocation_failed" and reason in ("model_unavailable", "internal",
                                                  "corrupt_input", "not_configured"):
        if allocations.is_allocation_failure(message):
            reason, retryable, default_step = KIND_TO_REASON["allocation_failed"]
            human_step = ""
    return StructuredError(reason, f"{kind}: {message}", retryable=retryable, capability=capability,
                           human_step=human_step or default_step)


# Which wire reason each unsatisfied readiness blocker means for the caller.
# ORDER IS THE MECHANISM: a family can be blocked on several conditions at once, and the
# one the caller must act on first is the licence (nothing you install can bypass it), then
# the weight, then configuration/dependency, and only then the development work of writing
# an adapter. Reversed, diarization would report "not_configured: no adapter" while the
# real blocker is an unaccepted community licence.
READINESS_BLOCKER_REASON: list[tuple[str, str, str]] = [
    ("provider access/licence", "license_acceptance_required",
     "accept the provider licence and provide the access token; this run will not accept "
     "terms on a human's behalf"),
    ("pinned model asset", "model_unavailable",
     "prepare the pinned asset explicitly: python -m ruke_ml.models.prepare --model <id>"),
    ("required configuration", "not_configured", "set the configuration this adapter declares"),
    ("pinned dependency", "not_configured",
     "install the pinned dependency declared in python-backend/pyproject.toml, or point the "
     "declared RUKE_<PROGRAM> override at a validated copy of the external program"),
    ("no adapter", "not_configured", "implement and register the adapter for this capability"),
]


def readiness_error(capability: str, blockers: list[str], *, candidates: list[str],
                    detail: str = "") -> StructuredError:
    """Turn the catalog's own blocker list for a capability into an actionable typed failure."""
    reason, step = "not_configured", "resolve the readiness blockers listed in the message"
    for needle, mapped_reason, mapped_step in READINESS_BLOCKER_REASON:
        if any(needle in b for b in blockers):
            reason, step = mapped_reason, mapped_step
            break
    message = (f"{capability} is not executable on this host: "
               + ("; ".join(blockers) if blockers else "no registered row is executable")
               + (f" | candidates: {', '.join(candidates)}" if candidates else ""))
    if detail:
        message += f" | {detail}"
    return StructuredError(reason, message, retryable=reason in ("model_unavailable", "internal"),
                           capability=capability, human_step=step)


def readiness_gate(capability: str) -> StructuredError | None:
    """The dispatch-side answer to "can this capability actually run here?".

    None means at least one registered row is executable, so the handler should really
    execute. A StructuredError means the handler must NOT run: the reason comes from the
    same readiness conjunction the /capabilities report uses, so a capability can never
    again be advertised `available` and then answered with a fixed failure. Nothing here
    loads a model or touches the network.
    """
    from ..models.registry import catalog
    cat = catalog()
    if cat.executable_for(capability):
        return None
    specs = cat.for_capability(capability)
    if not specs:
        return StructuredError("not_configured",
                               f"no adapter is registered for {capability}", capability=capability,
                               human_step="register and implement the adapter for this capability")
    # Prefer the most-advanced row: an implemented adapter beats an unimplemented one, so
    # the human step says "prepare the asset", not "implement the adapter", when the code
    # is already there.
    best = max(specs, key=lambda s: bool(s.adapter))
    model_id, blockers = cat.blockers_for(capability)
    family = cat.status_for(capability)
    detail = str(family.get("detail", "") or "")
    if model_id:
        detail = f"{model_id}: {detail}" if detail else model_id
    return readiness_error(capability, blockers, candidates=[s.id for s in specs], detail=detail)
