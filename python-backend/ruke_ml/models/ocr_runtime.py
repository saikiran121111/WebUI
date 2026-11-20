"""The isolated CPU OCR runtime, validated WITHOUT importing the framework.

PaddleOCR-VL's dependency set (paddlepaddle + paddlex + opencv-contrib) conflicts with the
backend venv that carries onnxruntime and faster-whisper, so the amendment authorizes a
SEPARATE interpreter inside `python-backend`, wired into the OCR worker launcher. That
interpreter is a dependency of the capability, so "installed" must mean a validated copy
of it, not a hope that an import would work.

The validation deliberately never spawns the interpreter and never imports paddle:
the capability/status endpoint is served by the supervisor, and loading a multi-gigabyte
framework to answer "is this engine here" would consume the exact RAM the answer is about.
So:
  * the interpreter is resolved from an explicit override or the project-local venv,
  * the pinned dependency set is read from the `*.dist-info` directories that the
    installer itself lays down, which is the same evidence `uv pip freeze` reads,
  * the CPU-only claim is read from the preparation manifest, which recorded a real
    `paddle.device` probe at install time. A missing manifest is a reported gap, never an
    assumed GPU.

Nothing here downloads anything.
"""
from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..config import repo_root

RUNTIME_ID = "paddle-ocr-cpu"

# Where the authorized preparer creates the isolated environment, in preference order.
VENV_DIRS = (".venv-ocr", ".venv-paddle")

# Explicit operator override, same convention as binaries.env_var().
ENV_INTERPRETER = "RUKE_OCR_PYTHON"

# The manifest written by scripts/prepare-ocr-runtime.ps1. Kept inside the project.
MANIFEST_REL = ".data/models/ocr/ocr-runtime.json"

# The exact dependency set prepare-ocr-runtime.ps1 installs from the documented CPU wheel
# index (https://www.paddlepaddle.org.cn/packages/stable/cpu/). Exact pins, not ranges:
# "the pinned release" is only a checkable statement if the version is part of the check.
PINNED: dict[str, str] = {
    "paddlepaddle": "3.2.1",
    "paddleocr": "3.6.0",
    "paddlex": "3.6.1",
    "opencv-contrib-python": "4.10.0.84",
    # protobuf is part of the pin because the venv's OWN generated stubs declare the runtime
    # they were built against, and 6.33.4 was measurably too old for this pipeline. Measured
    # 2026-11-17 15:44:37 inside a real coordinated OCR window: the worker died while
    # CONSTRUCTING the PaddleOCR-VL pipeline with
    #   load_failed: VersionError: Detected incompatible Protobuf Gencode/Runtime versions
    #   when loading sentencepiece_model.proto: gencode 7.36.1 runtime 6.33.4
    # The demanding file is sentencepiece 0.2.3's sentencepiece/sentencepiece_model_pb2.py
    # (imported by paddlex/inference/models/common/tokenizer/llama_tokenizer.py:100 while the
    # VLM tokenizer is built). paddlepaddle 3.2.1 declares protobuf>=3.20.2 with no upper
    # bound, so 7.36.2 - the version the main backend venv already runs on this host - is the
    # pin, and the ABI itself is now checked before any exclusive window is entered (see
    # gencode_floor below).
    "protobuf": "7.36.2",
}

_NAME_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# A protobuf stub calls a runtime-version validator at import time, passing the gencode version
# it was generated against. If the installed runtime is OLDER than that, importing the stub
# raises - it does not degrade. For OCR that raise happens while the pipeline is being
# constructed, i.e. minutes into an exclusive resource window that cost an LLM unload to open.
# So the requirement is read off the files instead: a readiness answer that can only fail after
# the weights are loaded is not a readiness answer.
_PB_GENCODE = re.compile(
    r"ValidateProtobufRuntimeVersion\(\s*(?:_runtime_version\.)?Domain\.PUBLIC,\s*"
    r"(\d+),\s*(\d+),\s*(\d+)", re.S)


def _version_tuple(raw: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in str(raw or "").split(".")[:3]:
        digits = chunk.strip()
        head = ""
        for ch in digits:
            if not ch.isdigit():
                break
            head += ch
        parts.append(int(head) if head else 0)
    while parts and parts[-1] == 0:
        parts.pop()
    return tuple(parts) or (0,)


def gencode_floor(site_packages: Sequence[Path]) -> tuple[tuple[int, ...], str]:
    """The highest protobuf runtime any shipped *_pb2 stub demands, plus where it came from.

    Only *_pb2*.py files are read (measured: ~0.14 s over this venv, against ~30 s for a full
    scan), and nothing is imported, so answering this costs no RAM.
    """
    best: tuple[int, ...] = (0,)
    origin = ""
    for site in site_packages:
        try:
            candidates = list(site.rglob("*_pb2*.py"))
        except OSError:
            continue
        for path in candidates:
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            match = _PB_GENCODE.search(text)
            if not match:
                continue
            wanted = tuple(int(g) for g in match.groups())
            if wanted > best:
                best = wanted
                try:
                    origin = str(path.relative_to(site))
                except ValueError:
                    origin = path.name
    return best, origin


@dataclass(slots=True)
class RuntimeStatus:
    runtime: str
    interpreter: str
    found: bool
    detail: str
    pinned: dict[str, str]
    missing: list[str]
    mismatched: list[str]
    manifest: dict[str, Any]
    inside_project: bool
    # Stubs in the venv that demand a protobuf runtime NEWER than the installed one. These are
    # not version-pin disagreements: importing them raises, so the pipeline cannot be built at
    # all even when every pinned distribution is present.
    abi_issues: list[str] = field(default_factory=list)

    @property
    def cpu_only_verified(self) -> bool:
        """True only when a preparation-time device probe actually recorded CPU."""
        probe = self.manifest.get("device_probe")
        return isinstance(probe, dict) and str(probe.get("device", "")).lower() == "cpu"

    def as_dict(self) -> dict[str, Any]:
        return {
            "runtime": self.runtime,
            "interpreter": self.interpreter or None,
            "found": self.found,
            "inside_project": self.inside_project,
            "pinned": self.pinned,
            "missing": self.missing,
            "mismatched": self.mismatched,
            "abi_issues": list(self.abi_issues),
            "cpu_only_verified": self.cpu_only_verified,
            "detail": self.detail,
        }


MISSING = RuntimeStatus(RUNTIME_ID, "", False, "no OCR runtime candidate", {}, [], [], {}, False)

_CACHE: dict[str, RuntimeStatus] = {}
_LOCK = threading.Lock()


def _normalize(name: str) -> str:
    # PEP 503 style: the installer writes underscores, humans type hyphens.
    return re.sub(r"[-_.]+", "-", name or "").strip().lower()


def interpreter_path() -> tuple[str, str]:
    """(path, source) for the isolated interpreter. Never creates or downloads it."""
    override = os.environ.get(ENV_INTERPRETER, "").strip()
    if override:
        return override, "env"
    root = repo_root()
    for rel in VENV_DIRS:
        for exe in ("Scripts/python.exe", "bin/python"):
            candidate = root / "python-backend" / rel / exe
            try:
                if candidate.is_file():
                    return str(candidate), "project-local"
            except OSError:
                continue
    return "", ""


def _site_packages(interpreter: str) -> list[Path]:
    """The venv's site-packages, derived from the interpreter's own location.

    Deriving it from the interpreter is what makes this immune to the running
    interpreter's sys.path: the whole point is that a DIFFERENT environment is being
    inspected.
    """
    scripts = Path(interpreter).parent            # <venv>/Scripts or <venv>/bin
    venv = scripts.parent
    out: list[Path] = []
    for pattern in ("Lib/site-packages", "lib/python*/site-packages"):
        try:
            out += [p for p in venv.glob(pattern) if p.is_dir()]
        except OSError:
            continue
    return out


def _installed_dists(interpreter: str) -> dict[str, str]:
    """{normalized distribution: version} from the venv's ``*.dist-info`` directories."""
    return _dists_from_sites(_site_packages(interpreter))


def _dists_from_sites(sites: Sequence[Path]) -> dict[str, str]:
    found: dict[str, str] = {}
    for site in sites:
        try:
            entries = [p.name for p in site.iterdir() if p.name.endswith(".dist-info")]
        except OSError:
            continue
        for name in entries:
            stem = name[: -len(".dist-info")]
            dist, sep, version = stem.rpartition("-")
            if not sep or not _NAME_SAFE.match(dist) or not version:
                continue
            found[_normalize(dist)] = version
    return found


def read_manifest() -> dict[str, Any]:
    """The preparation record, when it exists. Absence is reported, not assumed."""
    path = repo_root() / MANIFEST_REL
    try:
        if not path.is_file():
            return {}
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def status(runtime: str = RUNTIME_ID) -> RuntimeStatus:
    if runtime and runtime != RUNTIME_ID:
        # A registry row naming a runtime this module does not implement must fail
        # readiness loudly rather than borrow the Paddle answer.
        return RuntimeStatus(runtime, "", False,
                             f"no runtime resolver is implemented for {runtime!r}",
                             {}, [], [], {}, False)
    key = f"{runtime}|{os.environ.get(ENV_INTERPRETER, '').strip()}"
    with _LOCK:
        cached = _CACHE.get(key)
    if cached is not None:
        return cached

    exe, source = interpreter_path()
    manifest = read_manifest()
    if not exe:
        result = RuntimeStatus(
            RUNTIME_ID, "", False,
            f"no isolated OCR interpreter: none of python-backend/{'/'.join(VENV_DIRS)} exists "
            f"and {ENV_INTERPRETER} is unset; run scripts/prepare-ocr-runtime.ps1",
            dict(PINNED), sorted(PINNED), [], manifest, False)
    else:
        inside = _inside_project(exe)
        sites = _site_packages(exe)
        dists = _dists_from_sites(sites)
        missing = [d for d in PINNED if _normalize(d) not in dists]
        mismatched = [f"{d}=={dists[_normalize(d)]} (pinned {PINNED[d]})"
                      for d in PINNED
                      if _normalize(d) in dists and dists[_normalize(d)] != PINNED[d]]
        # The ABI check is deliberately separate from the pin check. An environment can hold the
        # pinned protobuf and still be unable to build the pipeline (a wheel that ships a newer
        # gencode than its own dependency resolution allows), and vice versa: the pin reports the
        # disagreement, the ABI check reports the consequence.
        floor, origin = gencode_floor(sites)
        abi_issues: list[str] = []
        if floor > (0,):
            have = dists.get("protobuf", "")
            if _version_tuple(have) < floor:
                abi_issues.append(
                    f"{origin} demands protobuf >={'.'.join(str(p) for p in floor)} (gencode), but "
                    f"the OCR venv has protobuf {have or 'not installed'}: importing that stub "
                    f"raises VersionError while the pipeline is being built")
        found = bool(missing == [] and mismatched == [] and abi_issues == [])
        notes = [f"interpreter resolved via {source}: {_display(exe)}"]
        if missing:
            notes.append("missing pinned distributions: " + ", ".join(missing))
        if mismatched:
            notes.append("version disagrees with the pin: " + ", ".join(mismatched))
        if abi_issues:
            notes.append("; ".join(abi_issues))
        if found and not manifest:
            notes.append(f"no preparation manifest at {MANIFEST_REL}; the pinned distributions "
                         "are installed but no recorded device probe proves CPU placement")
        result = RuntimeStatus(RUNTIME_ID, exe, found, "; ".join(notes),
                               {d: dists.get(_normalize(d), "") for d in PINNED},
                               missing, mismatched, manifest, inside, abi_issues)
    with _LOCK:
        _CACHE[key] = result
    return result


def installed(runtime: str = RUNTIME_ID) -> bool:
    return status(runtime).found


def _inside_project(path: str) -> bool:
    try:
        Path(path).resolve().relative_to(repo_root().resolve())
        return True
    except (OSError, ValueError):
        return False


def _display(path: str) -> str:
    try:
        return Path(path).resolve().relative_to(repo_root().resolve()).as_posix()
    except (OSError, ValueError):
        return Path(path).name


def clear_cache() -> None:
    """Test seam: re-read the environment after a preparation step."""
    with _LOCK:
        _CACHE.clear()
