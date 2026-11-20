"""Resolve an external program by provenance, never by PATH alone.

PATH-only detection is wrong in both directions on this host. ffmpeg IS present here,
but it is installed project-locally (npm `ffmpeg-static`, and the copy Playwright
downloads), not on PATH - so a PATH probe reported a running capability as
`not_installed`. At the other end, a PATH hit is not trusted either: a stub, a
non-executable file or an unrelated program of the same name must never make a
capability claim `available`.

Order (first VALIDATED hit wins):
  1. explicit absolute-path override, e.g. RUKE_FFMPEG
  2. PATH
  3. project-local copies this repository or its installed dev dependencies already own

Every candidate is validated by actually running the program's version probe with a
bounded timeout, and the outcome (including which source supplied it) is cached per
process so capability reporting costs at most one probe per binary. The probe flag is
program-specific: `-version` is the ffmpeg/ffprobe convention, while the Windows
Tesseract build rejects it (exit 1) and only accepts `--version`, so a single hard-coded
flag would report a real, working copy as not installed. Nothing is downloaded here.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import processes
from ..config import repo_root

PROBE_TIMEOUT_S = 5.0
MAX_PROBE_OUTPUT_BYTES = 1 << 16

# Version-probe arguments per program. The first entry is the documented convention for
# that program; a bounded set of alternatives is tried before the candidate is refused,
# so an unfamiliar-but-genuine build is not misreported as broken.
VERSION_ARGS: dict[str, tuple[str, ...]] = {
    "ffmpeg": ("-version",),
    "ffprobe": ("-version",),
    "tesseract": ("--version",),
}


def _probe_variants(name: str) -> tuple[tuple[str, ...], ...]:
    primary = VERSION_ARGS.get(name, ("-version",))
    variants = [primary]
    for args in (("-version",), ("--version",)):
        if args not in variants:
            variants.append(args)
    return tuple(variants)


# Only the names the application actually shells out to. Adding a name here is a
# contract change, not a convenience: it decides what "installed" may claim.
PROJECT_LOCAL_PATTERNS: dict[str, tuple[str, ...]] = {
    "ffmpeg": (
        "node_modules/ffmpeg-static/ffmpeg.exe",
        "node_modules/ffmpeg-static/ffmpeg",
        "node_modules/ffmpeg-static/bin/*/ffmpeg.exe",
        ".data/ms-playwright/ffmpeg-*/ffmpeg-win64.exe",
        ".data/ms-playwright/ffmpeg-*/ffmpeg-mac",
        ".data/ms-playwright/ffmpeg-*/ffmpeg-linux",
        "bin/ffmpeg.exe",
        "bin/ffmpeg",
    ),
    "ffprobe": (
        "node_modules/@ffprobe-installer/ffprobe/ffprobe.exe",
        # The platform sub-package is where this installer actually lays the binary; the
        # umbrella package only holds a JS shim, so a probe of the umbrella path would
        # report a real, working ffprobe as missing.
        "node_modules/@ffprobe-installer/win32-x64/ffprobe.exe",
        "node_modules/@ffprobe-installer/*/ffprobe.exe",
        "node_modules/@ffprobe-installer/*/ffprobe",
        "bin/ffprobe.exe",
        "bin/ffprobe",
    ),
    # OCR shells out to an external engine, so "installed" must mean a validated copy,
    # not a pip wrapper that would fail at spawn time.
    "tesseract": (
        # The amendment-4 location: a project-local install of the verified UB Mannheim /
        # upstream Windows x64 build. A system-wide install is deliberately not used.
        ".data/tools/tesseract/tesseract.exe",
        ".data/tools/tesseract/bin/tesseract.exe",
        "bin/tesseract/tesseract.exe",
        "bin/tesseract.exe",
        "bin/tesseract/tesseract",
        "bin/tesseract",
    ),
}

# Playwright lays its browsers out directly under the browsers root, so the same program
# lives at a different relative path there than under a repository's .data mirror.
BROWSERS_ROOT_PATTERNS: dict[str, tuple[str, ...]] = {
    "ffmpeg": (
        "ffmpeg-*/ffmpeg-win64.exe",
        "ffmpeg-*/ffmpeg-mac",
        "ffmpeg-*/ffmpeg-linux",
    ),
}

_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


@dataclass(slots=True)
class Resolution:
    name: str
    path: str
    source: str          # "env" | "PATH" | "project-local" | "" when absent
    detail: str

    @property
    def found(self) -> bool:
        return bool(self.path)

    def as_dict(self) -> dict[str, Any]:
        """Public capability payload: provenance without leaking the whole host layout.

        An absolute path outside the repository is deliberately reduced to its file
        name, so the browser-visible status endpoint cannot be used to enumerate the
        user's profile or drive layout.
        """
        shown, inside = "", False
        if self.path:
            inside = _inside_repo(self.path)
            shown = _display_path(self.path) if inside else Path(self.path).name
        return {
            "name": self.name,
            "found": self.found,
            "source": self.source or None,
            "path": shown or None,
            "inside_repo": inside,
            "detail": self.detail,
        }


MISSING = Resolution(name="", path="", source="", detail="")

_CACHE: dict[tuple[str, str], Resolution] = {}
_LOCK = threading.Lock()


def env_var(name: str) -> str:
    return "RUKE_" + re.sub(r"[^A-Z0-9]", "_", name.upper())


def _inside_repo(path: str) -> bool:
    try:
        Path(path).resolve().relative_to(repo_root().resolve())
        return True
    except (OSError, ValueError):
        return False


def _display_path(path: str) -> str:
    try:
        return Path(path).resolve().relative_to(repo_root().resolve()).as_posix()
    except (OSError, ValueError):
        return path


def validate(path: str, name: str = "") -> str:
    """Return "" when `path` really is a runnable copy of `name`, else the reason."""
    if not path:
        return "no candidate path"
    if not _SAFE_NAME.match(name or ""):
        return "refused: not a bare program name"
    p = Path(path)
    try:
        if not p.is_file():
            return "not a regular file"
    except OSError as exc:
        return f"path rejected ({exc.__class__.__name__})"
    if os.name == "nt":
        # Refuse to hand an arbitrary document to CreateProcess, and refuse to let an
        # extension-less file resolve to something else through PATHEXT.
        if p.suffix.lower() not in (".exe", ".cmd", ".bat"):
            return "not an executable file extension on Windows"
    elif not os.access(str(p), os.X_OK):
        return "not marked executable"
    try:
        first_failure = ""
        for args in _probe_variants(name):
            try:
                done = processes.run_captured([str(p), *args], timeout=PROBE_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                first_failure = first_failure or f"version probe `{args[0]}` timed out"
                continue
            except (OSError, subprocess.SubprocessError) as exc:
                # A file that cannot be spawned at all will not get better with a
                # different flag, so stop rather than mask the real cause.
                return f"could not be executed ({exc.__class__.__name__})"
            blob = ((done.stdout or b"") + (done.stderr or b""))[:MAX_PROBE_OUTPUT_BYTES]
            if done.returncode != 0:
                first_failure = first_failure or (
                    f"version probe `{name} {' '.join(args)}` exited {done.returncode}"
                )
                continue
            if name.encode("ascii", "ignore").split(b"-")[0] not in blob.lower():
                first_failure = first_failure or (
                    f"version probe for `{name} {' '.join(args)}` did not identify this program"
                )
                continue
            return ""
        return first_failure or "no version probe args were available"
    except OSError as exc:
        return f"could not be executed ({exc.__class__.__name__})"


def _candidates(name: str) -> list[tuple[str, str]]:
    """(path, source) pairs in resolution order. Paths are absolute; no cwd guessing."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(path: str, source: str) -> None:
        if not path:
            return
        key = os.path.normcase(os.path.abspath(path))
        if key in seen:
            return
        seen.add(key)
        out.append((os.path.abspath(path), source))

    override = os.environ.get(env_var(name), "").strip()
    if override:
        add(override, "env")

    on_path = shutil.which(name)
    if on_path:
        add(on_path, "PATH")

    pw = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    scopes: list[tuple[Path, tuple[str, ...]]] = [(repo_root(), PROJECT_LOCAL_PATTERNS.get(name, ()))]
    if pw:
        scopes.append((Path(pw).expanduser(),
                       BROWSERS_ROOT_PATTERNS.get(name, ()) + PROJECT_LOCAL_PATTERNS.get(name, ())))
    for root, patterns in scopes:
        for pattern in patterns:
            try:
                for hit in sorted(root.glob(pattern))[:8]:
                    add(str(hit), "project-local")
            except OSError:
                continue
    return out


def resolve(name: str) -> Resolution:
    """Resolve `name` to a validated executable, or an absent Resolution."""
    if not _SAFE_NAME.match(name or ""):
        return Resolution(name=name or "", path="", source="",
                          detail="refused: not a bare program name")
    key = (name, os.environ.get(env_var(name), "").strip())
    with _LOCK:
        cached = _CACHE.get(key)
    if cached is not None:
        return cached

    notes: list[str] = []
    bad_override = os.environ.get(env_var(name), "").strip()
    result = Resolution(name=name, path="", source="", detail="")
    for path, source in _candidates(name):
        reason = validate(path, name)
        if not reason:
            result = Resolution(name=name, path=path, source=source,
                                detail=(f"validated by `{name} "
                                        f"{' '.join(_probe_variants(name)[0])}; found via {source}"))
            break
        notes.append(f"{source} candidate {path!r}: {reason}")
    if not result.found:
        if bad_override:
            notes.insert(0, f"explicit {env_var(name)} override was not usable")
        notes.append("checked the override, PATH and the project-local locations listed "
                     "in ruke_ml.models.binaries")
        result = Resolution(name=name, path="", source="", detail="; ".join(notes))
    with _LOCK:
        _CACHE[key] = result
    return result


def path_for(name: str) -> str:
    """Convenience for callers that just want the executable ("" when absent)."""
    return resolve(name).path


def clear_cache() -> None:
    """Test seam: drop cached probes so a changed environment is re-checked."""
    with _LOCK:
        _CACHE.clear()
