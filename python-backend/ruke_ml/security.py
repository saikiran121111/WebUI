"""Path, archive and RPC-surface safety. Hard rules, not heuristics."""
from __future__ import annotations

import hmac
import os
import re
import stat
from pathlib import Path

from .config import LIMITS

# Windows device paths, UNC shares and drive-relative paths are rejected: they can
# reach beyond the root even when the string looks contained.
_UNC = re.compile(r"^\\\\[^\\]+")
_DEVICE = re.compile(r"^\\\\[?.]\\")
_DRIVE_RELATIVE = re.compile(r"^[A-Za-z]:[^\\/]")
_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.[^\\]*)?$", re.I)
# An archive member may never carry a drive prefix or a colon: on Windows that becomes
# either a stray directory tree or an alternate data stream on the extracted file.
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")


class PathRejected(Exception):
    pass


def normalize_root(root: str | os.PathLike[str]) -> Path:
    return Path(root).expanduser().resolve()


def resolve_within(candidate: str | os.PathLike[str], root: str | os.PathLike[str]) -> Path:
    """Resolve a reference INSIDE an explicit root, following reparse points only after
    the final target is re-checked against the root (time-of-check/use mitigation)."""
    s = str(candidate)
    if not s:
        raise PathRejected("empty path")
    if _DEVICE.match(s) or _UNC.match(s):
        raise PathRejected("device or UNC path is outside the allowed roots")
    if _DRIVE_RELATIVE.match(s):
        raise PathRejected("drive-relative path is ambiguous")
    name = Path(s).name
    if name and _RESERVED.match(name):
        raise PathRejected(f"reserved device name: {name}")
    rootp = normalize_root(root)
    p = Path(s)
    if not p.is_absolute():
        p = rootp / p
    # resolve() follows junctions/symlinks/reparse points; then re-verify the FINAL target.
    try:
        rp = p.resolve()
    except OSError as exc:  # broken link, loop, invalid name
        raise PathRejected(f"unresolvable path: {exc}") from exc
    try:
        rp.relative_to(rootp)
    except ValueError:
        raise PathRejected(f"path escapes the root: {rp} not under {rootp}") from None
    if rp.exists():
        st = rp.stat()
        if stat.S_ISLNK(st.st_mode) or (getattr(st, "st_reparse_tag", 0) not in (0, None)):
            # A reparse point is allowed only when its resolved target is also inside.
            target = Path(os.path.realpath(rp))
            try:
                target.relative_to(rootp)
            except ValueError:
                raise PathRejected("reparse point targets outside the root") from None
    return rp


def safe_member_name(name: str) -> str:
    """Archive member names must never contain traversal, absolute paths or device names."""
    if not name or name.startswith(("/", "\\")) or _DRIVE_RELATIVE.match(name) or _UNC.match(name):
        raise PathRejected(f"unsafe archive member: {name!r}")
    if _DRIVE_PREFIX.match(name):
        raise PathRejected(f"drive-qualified archive member: {name!r}")
    if ":" in name:
        raise PathRejected(f"colon in archive member (drive form or NTFS stream): {name!r}")
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".")]
    if ".." in parts:
        raise PathRejected(f"traversal in archive member: {name!r}")
    if any(_RESERVED.match(p) for p in parts):
        raise PathRejected(f"reserved name in archive member: {name!r}")
    return "/".join(parts)


def audit_zip_members(zf, ratio_limit: float | None = None) -> None:
    """Zip-bomb / traversal guard, run BEFORE any extraction."""
    entries = zf.infolist()
    if len(entries) > LIMITS.max_archive_entries:
        raise PathRejected(f"archive has too many members: {len(entries)}")
    total = sum(max(0, i.file_size) for i in entries)
    if total > LIMITS.max_archive_uncompressed_bytes:
        raise PathRejected(f"archive expands beyond the byte budget: {total}")
    comp = sum(max(1, i.compress_size) for i in entries)
    ratio = total / max(1, comp)
    if ratio > (ratio_limit or LIMITS.max_archive_ratio):
        raise PathRejected(f"suspicious expansion ratio {ratio:.0f}x")
    for i in entries:
        safe_member_name(i.filename)


# The ONLY destinations exempt from the worker egress blackhole (see
# egress_blocked_for_workers): loopback literals, matching is_loopback below.
LOOPBACK_NO_PROXY = ("127.0.0.0/8", "127.0.0.1", "localhost", "::1")


def is_loopback(host: str) -> bool:
    h = host.strip().lower()
    if h in ("localhost", "127.0.0.1", "::1"):
        return True
    return h.startswith("127.") and h.count(".") == 3


def token_ok(presented: str | None, expected: str) -> bool:
    """Constant-time comparison; never log the token."""
    if not presented or not expected:
        return False
    return hmac.compare_digest(presented, expected)


def egress_blocked_for_workers(env: dict[str, str]) -> dict[str, str]:
    """Parse/render workers get no network path and no macro/external-link follow.

    F91 (2026-11-23): the block is a blackhole PROXY, so `no_proxy` is part of the law,
    not an escape hatch. Blackholing loopback too made the placement gate's main-model
    probe connection-refused (WinError 10061 on /health, /api/tags AND /props), which the
    planner recorded as "the main model is not loaded, so there is nothing to reclaim" -
    the GPU handoff window died in every OCR/ASR admission (accept-4: F91.1, fr-U1,
    fr-F123). The exempt set is loopback ONLY: the machine's own model server and control
    endpoint. Any non-loopback destination still routes to the dead sink.
    """
    env = dict(env)
    env["http_proxy"] = env["https_proxy"] = env["HTTP_PROXY"] = env["HTTPS_PROXY"] = "http://127.0.0.1:9"
    env["no_proxy"] = env["NO_PROXY"] = ",".join(LOOPBACK_NO_PROXY)
    env["RUKE_EGRESS"] = "blocked"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["HF_HUB_OFFLINE"] = "1"
    return env
