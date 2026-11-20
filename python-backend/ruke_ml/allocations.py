"""One shared classifier for "the host refused to give this process memory".

Leaf module on purpose: it imports nothing from this package, so every layer
(adapters, workers, the pool that owns the ceilings) can agree on the same
vocabulary without an import cycle.

WHY THIS EXISTS AT ALL, with the measurement that produced it:
  * 2026-11-16, E03 probe, the pinned Systran/faster-whisper-base snapshot loaded on
    CPU/int8 through the real worker tree: RESIDENT peak working set 388 MiB, but
    COMMIT peak 1,276 MiB (docs/overnight/logs/e03-speech-20261116T16564630343.json).
    Resident RAM and commit charge are different quantities.
  * 2026-11-17, this session: the enforceable per-worker job-object ceiling was being
    derived from the resident number (2 x 388 = 776 MiB of commit). The same ASR job
    then died inside Intel oneMKL in 1.66 s with "mkl_malloc: failed to allocate
    memory" and was reported to the caller as reason=model_unavailable, whose human
    step says "prepare the pinned asset" - i.e. the report told the user to re-download
    weights that were already on disk. With the ceiling raised to 3,072 MiB the SAME
    job transcribed for real (device cpu, compute int8):
    "The Kestral Depot Inventory lists 11 crates of copper cable worth 2400 euros."
    (docs/overnight/logs/f54-g26-asr-default-1.log vs f54-g26-asr-raised-1.log).

The law this module enforces: an allocation refusal is a RESOURCE condition. It is
never an asset problem, never a corrupt-input problem, and never "internal". The
 remedy ("free RAM/commit or take the coordinated unload/load handoff") is the
opposite of the asset remedy ("re-prepare the model"), so getting this wrong sends
a user to destroy the very thing that already works.
"""
from __future__ import annotations

# Substrings matched against the LOWER-CASED failure text. Each one says "an
# allocation was refused"; none of them says "a file is missing", which is the
# confusion this classifier exists to prevent. Deliberately absent: generic words
# like "memory" alone, "resource exhausted", or "cache" - those appear in ordinary
# missing-asset and dependency messages and would invert the error.
ALLOCATED_REFUSED_MARKERS: tuple[str, ...] = (
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


def is_allocation_failure(text: object) -> bool:
    """True when failure text says an allocation was REFUSED, not that an asset is absent.

    Accepts any object (the adapters pass exception messages, sometimes the exception
    itself); the text is stringified and lower-cased. Empty/None is False.

    An exception with NO message still names its class, and that name is the only
    evidence available: `str(MemoryError())` is empty, so stringifying the exception
    alone used to read a bare MemoryError as "not an allocation" and let the generic
    asset/internal reason win. Naming the class when there is no message fixes that at
    the shared classifier instead of at each adapter.
    """
    if text is None:
        return False
    if isinstance(text, BaseException):
        named = str(text).strip() or f"{type(text).__name__}"
    else:
        named = str(text)
    low = named.lower()
    if not low.strip():
        return False
    return any(marker in low for marker in ALLOCATED_REFUSED_MARKERS)


def describe() -> dict[str, object]:
    """What this classifier counts as an allocation refusal - for reports, not prompts."""
    return {
        "markers": list(ALLOCATED_REFUSED_MARKERS),
        "law": ("an allocation refusal is a resource condition (memory_pressure, retryable), "
                "never model_unavailable/corrupt_input/internal"),
        "evidence": ("docs/overnight/logs/e03-speech-20261116T16564630343.json (resident 388 MiB "
                     "vs commit 1,276 MiB) and docs/overnight/logs/f54-g26-asr-{default,raised}-1.log"),
    }
