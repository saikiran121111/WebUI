"""Every grandchild Ruke starts must be isolated from the pipes Ruke itself owns.

A capability worker answers its owner over a stdin/stdout JSON protocol. If a decoder
or OCR engine inherits that stdin handle, the tool's interactive-input path reads the
owner's request pipe: the tool never exits, the job burns its whole deadline, and bytes
meant for the worker's control channel can be consumed by the tool. Both directions are
wrong, so the isolation is structural rather than a per-callsite reminder:

  * stdin is DEVNULL, never the inherited handle;
  * on Windows CREATE_NO_WINDOW, so a console tool cannot grab the console input buffer
    or open a window behind the supervisor;
  * ffmpeg command builders also carry -nostdin, the documented switch for exactly this
    class of hang (measured here: a loudness pass inside a worker never exited while the
    worker's control pipe stayed open, and the job reported `deadline_exceeded`).
"""
from __future__ import annotations

import os
import subprocess
from typing import Any, Sequence

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def spawn_kwargs(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """The invariant keyword arguments for any grandchild we start."""
    kwargs: dict[str, Any] = {"stdin": subprocess.DEVNULL}
    if NO_WINDOW:
        kwargs["creationflags"] = NO_WINDOW
    if extra:
        kwargs.update(extra)
    return kwargs


def run_captured(cmd: Sequence[str], *, timeout: float, text: bool = False,
                 extra: dict[str, Any] | None = None) -> subprocess.CompletedProcess:
    """Run one bounded tool call with its pipes captured and its stdin closed off."""
    return subprocess.run(list(cmd), capture_output=True, timeout=timeout, text=text,
                          **spawn_kwargs(extra))
