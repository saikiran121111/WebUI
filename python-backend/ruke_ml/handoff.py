"""Exclusive resource handoff between the main LLM and a heavyweight processing job.

Why this exists: the pinned OCR pipeline cannot fit in the ~3.6 GiB of RAM that is free on
this host while the main model is resident - the running engine holds ~50 GiB resident and
~9.4 GiB VRAM (measured 2026-11-17). So a real OCR run has to be able to ask the engine to
step out, run, and then put it back. That is only correct if it is EXCLUSIVE: Strata starts
the engine on `/load` AND on every generation request, so one stray inference request from
Ruke's title generation, a background job, or this coding CLI would silently bring the model
back mid-job and invalidate the fit calculation.

Guarantees implemented here:
  * one exclusive lease, acquired atomically (O_EXCL) in the same `.ai-coordination`
    directory and with the same record discipline as the Playwright lock;
  * a foreign lock is never deleted, and a holder is only broken with proof that its
    process ended (pid absent, or the pid's creation time is LATER than the record, which
    is pid reuse);
  * the shared browser lock is checked BEFORE acquiring, so the two exclusive windows can
    never overlap;
  * phases are journalled before they are entered, so a supervisor restart can see an
    interrupted handoff and finish restoring the model instead of leaving it unloaded;
  * the original state is snapshotted before anything is unloaded, and recovery never loads
    a model that was not loaded to begin with;
  * the lease is released only after the main model is verified back, and processing output
    is persisted to disk before restoration so a failed restoration cannot lose the work.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
import uuid
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import repo_root, runtime_dir
from .models import devices, main_model, resources

# Patchable sleep seam (fixtures pin the settle window to zero; production sleeps).
_sleep = time.sleep

COORD_DIR_REL = ".ai-coordination"
# How long one engine IMPORT (torch/Paddle DLL load) takes on this host: the post-release
# commit gate pays for the drain the host showed across the window for THIS long on top of
# the measured peak (accept-8 live evidence, 2026-11-23: the import died ~20 s after a
# gate that cleared statically, in both the Paddle and the Parakeet rows, WinError 1455).
_COMMIT_DRAIN_IMPORT_S = 60.0
# The drain must be measured over a real window (a sub-second sample is noise), and its
# rate is clamped: page-file churn on this host tops out near a restoring 50 GB resident
# (~200 MiB/s); anything faster is a measurement artifact, and an unclamped rate would
# turn the allowance into a blanket refusal - the ban on manufacturing a "cannot".
_COMMIT_DRAIN_MIN_SAMPLE_S = 2.0
_COMMIT_DRAIN_MAX_MIB_PER_S = 200.0
# F135 settle law (2026-11-23, accept-11 durable gate log): a gate sample taken right
# after /unload rides the SYSTEM-MANAGED pagefile's expansion peak. accept-11's three
# gate lines read 84,449 / 84,491 / 84,142 MiB free commit (the 48.5 GB main model had
# just paged out, the pagefile had grown; sampler: total limit 139 GB), all three loads
# were admitted, and within 30 s the manager shrank the pagefile (limit ~139 -> 83 GB,
# free commit ~19-21k, free phys under ~2.7 GB) and every worker died inside its loader
# with WinError 1455. One post-release sample is not the window's stable headroom:
# take the MINIMUM over a settle window that covers the shrink (observed ~30 s),
# floored by the pre-release baseline. The shrink is a host fact, not a demand
# invention - a quiet host whose samples are flat changes nothing.
_COMMIT_SETTLE_SAMPLES = 3
_COMMIT_SETTLE_S = 10.0
# F138 import-fit law (2026-11-24, accept-14): the gate refused documents.ocr at
# import_required 21,068 MiB against 18,166 MiB of post-release headroom, and the
# host curve cleared 21,068 MiB 61 s after the collapse (accept-14 host CSV:
# 25,165 -> 19,171/18,861/18,992 -> 22,864). The F137 law applies verbatim at THIS
# decision point: "settled" must mean FIT, not elapsed time. The ceiling axis is
# fixed by the clamp and cannot be fitted by waiting, so only the import axis gets
# the fit-wait: poll the post-release free commit at 1 s cadence until it clears
# import_required _IMPORT_FIT_STABLE CONSECUTIVE times, capped at _IMPORT_FIT_CAP_S;
# at the cap the refusal stands and records the fact. A fit tail is the window's own
# witnessed stable reading - never a pagefile expansion spike - so the F135
# pre-release baseline bound does not apply to it: the fit IS the window's law.
_IMPORT_FIT_CAP_S = 120.0
_IMPORT_FIT_STABLE = 10
# F140 deadline law (2026-11-24, accept-15): the documents.ocr TS client gives up at
# 90 s (DOCUMENT_PARSE_DEADLINE_MS + the 5 s RPC grace) while an unloaded window can
# legitimately spend unload_wait (60 s) + the F135 settle (30 s) + the F138 fit-wait
# (120 s). accept-15 showed what the overrun costs: the chip showed a generic
# "processing -> error" (no typed refusal), no cascade record was written, and the
# lease + ML slot stayed held into the next rows (fr-U1 refused with
# coordination_held on F91.1's still-live lease, fr-F123 552). The machine must be
# handed back INSIDE the job's own deadline: the settle and fit budgets are clamped
# to (deadline_at - now - _GATE_DEADLINE_RESERVE_S); the reserve covers the gate
# line and the restoration dispatch. deadline_at is the job's wall-clock expiry
# (JobContext.deadline_at); 0 = no deadline knowledge, pre-F140 budgets stand verbatim.
_GATE_DEADLINE_RESERVE_S = 20.0
LEASE_NAME = "llm-handoff.lock"
PLAYWRIGHT_LOCK = "playwright.lock"
RECORD_WIDTH = 512

# Mirrored from ruke-core::admission::DEFAULT_LEASE_STALE and
# lib/server/coordination/llm-lease.ts::LEASE_STALE_MS. All three clients must
# agree on what "abandoned" means, or one client admits inference while another
# still honours the same record.
DEFAULT_LEASE_STALE_S = float(os.environ.get("RUKE_HANDOFF_STALE_MS", "60000")) / 1000.0


class RecordTooLarge(Exception):
    """A coordination record that does not fit its fixed-width slot.

    Raised instead of truncating. Truncating is what made a HELD lease look
    UNLOCKED: the reader got invalid JSON back and treated that as "no holder",
    so inference walked into a window that a heavyweight job had reserved.
    """


JOURNAL_REL = "python/handoff-journal.json"

# The phase names the amendment specifies. A progress reader must be able to show these
# verbatim, so they are constants rather than ad-hoc strings.
PHASES = ("waiting", "unloading_main_model", "processing", "releasing_worker",
          "restoring_main_model", "ready")


class LeaseHeld(Exception):
    def __init__(self, holder: dict[str, Any]) -> None:
        self.holder = holder
        super().__init__(f"handoff lease is held by {holder.get('owner', '?')} "
                         f"(pid {holder.get('pid', '?')}, phase {holder.get('phase', '?')})")


class PlaywrightHeld(Exception):
    def __init__(self, holder: dict[str, Any]) -> None:
        self.holder = holder
        super().__init__("the browser acceptance window holds the shared lock")


@dataclass(slots=True)
class Lease:
    path: Path
    token: str
    owner: str
    phase: str
    started: float
    fd: int = -1
    extra: dict[str, Any] = field(default_factory=dict)

    def record(self) -> dict[str, Any]:
        return {"token": self.token, "owner": self.owner, "pid": os.getpid(),
                "pid_created": resources.process_creation_time(os.getpid()),
                "phase": self.phase, "started": self.started, "heartbeat": time.time(),
                **self.extra}


def coord_dir() -> Path:
    return repo_root() / COORD_DIR_REL


def lease_path() -> Path:
    return coord_dir() / LEASE_NAME


def _write_record(fd: int, payload: dict[str, Any]) -> None:
    """Fixed-width, NEVER truncated. Raises RecordTooLarge rather than emitting
    bytes no reader can parse - an unparseable lease is worse than no lease,
    because every client has to decide what it means (see _classify_record)."""
    data = _pack_record(payload)
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, data)
    os.fsync(fd)


# The identity fields a recovery decision depends on. Optional diagnostic extras
# are dropped BEFORE anything is ever cut, so a record can grow chatty without
# the core proof becoming unreadable.
CORE_RECORD_KEYS = ("token", "owner", "pid", "pid_created", "phase", "started",
                    "heartbeat")
# A coordination record is read by THREE clients (this process, the Rust
# endpoint gate and the Node ASR stage-2 path). Every one of them has to answer
# "is the main model parked?" from these bytes, so the record is written once
# per state change at a fixed width, never truncated, and its absence,
# unreadability and corruption are three distinct answers.


def _pack_record(payload: dict[str, Any], *, keep_core_only: bool = False) -> bytes:
    """Serialize to exactly RECORD_WIDTH bytes, padding with NULs, never cutting."""
    body = payload
    if keep_core_only:
        body = {key: value for key, value in payload.items() if key in CORE_RECORD_KEYS}
    data = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(data) > RECORD_WIDTH:
        if not keep_core_only:
            return _pack_record(payload, keep_core_only=True)
        raise RecordTooLarge(
            f"a coordination record needs {len(data)} bytes but the fixed slot is "
            f"{RECORD_WIDTH}; refusing to write a truncated (unparseable) record")
    return data + b"\x00" * (RECORD_WIDTH - len(data))


def _stale_window_s() -> float:
    return DEFAULT_LEASE_STALE_S


def _record_age_s(path: Path) -> float | None:
    """Age of a coordination record, or None when its age CANNOT be established.

    Returning 0.0 on a failed stat would fabricate a huge age and "age out" an
    unreadable record into being abandoned - the same fail-open this whole module
    exists to remove. Unknown age means unknown: only an operator's bounded
    break-stale may clear it.
    """
    mtime = _record_mtime(path)
    return None if mtime is None else max(0.0, time.time() - mtime)


def _record_mtime(path: Path) -> float | None:
    """Modified time, or None when the metadata itself cannot be read."""
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _classify_record(raw: bytes | None, mtime: float | None, read_error: str = "",
                     missing_state: str = "absent") -> dict[str, Any]:
    """ONE reader rule for three very different situations.

    Returns {"state": ..., "holder": ..., "detail": ...} where state is
      "absent"     - no record at all: nothing is claimed,
      "unreadable" - a record exists but could not be read (sharing violation,
                     permissions, IO error): we know nothing,
      "corrupt"    - bytes arrived but they are not a JSON object: we know nothing,
      "ok"         - a parseable record.
    "unreadable" and "corrupt" are NOT free: see lease_state, which treats a
    record we cannot read as HELD until its own age proves it was abandoned.

    ``missing_state`` is supplied by the caller because "no bytes" has two
    opposite causes: the record genuinely does not exist, versus it exists and
    cannot be read. Only the first is free.
    """
    if raw is None:
        return {"state": missing_state, "holder": {},
                "detail": read_error or "no lease record exists"}
    text = raw.split(b"\x00", 1)[0].decode("utf-8", "replace").strip()
    if not text:
        return {"state": "corrupt", "holder": {},
                "detail": "the lease record is blank: a writer created the file and "
                          "never got a parseable record into it"}
    try:
        value = json.loads(text)
    except ValueError as exc:
        return {"state": "corrupt", "holder": {},
                "detail": f"the lease record is not parseable JSON: {type(exc).__name__}"}
    if not isinstance(value, dict):
        return {"state": "corrupt", "holder": {},
                "detail": f"the lease record is {type(value).__name__}, not an object"}
    if not value.get("token") and not value.get("owner"):
        return {"state": "corrupt", "holder": value,
                "detail": "the lease record carries neither a token nor an owner, so no "
                          "holder can be identified or ruled out"}
    return {"state": "ok", "holder": value, "detail": "record parsed", "mtime": mtime}


def read_lease_record(path: Path | None = None) -> dict[str, Any]:
    """Classified read of a coordination record. Never creates or repairs one."""
    path = path or lease_path()
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return _classify_record(None, 0.0, "no lease record exists")
    except OSError as exc:
        # The file exists but this process cannot read it. Reporting that as
        # "unlocked" is exactly the defect this replaces.
        return _classify_record(
            None, 0.0,
            f"the lease record at {path} could not be read: "
            f"{type(exc).__name__}: {exc}",
            missing_state="unreadable")
    return _classify_record(raw, _record_mtime(path))


def read_lease(path: Path | None = None) -> dict[str, Any]:
    """Back-compat shim: the parseable holder, or {} when there is no usable one.

    Callers that make a DECISION must use lease_state()/read_lease_record(),
    which distinguish absent from unreadable from corrupt.
    """
    record = read_lease_record(path)
    return dict(record.get("holder") or {}) if record.get("state") == "ok" else {}


def _pid_evidence(holder: dict[str, Any]) -> tuple[bool, str]:
    """(alive, why). Fail-safe: anything unprovable counts as alive."""
    pid = int(holder.get("pid") or 0)
    if pid <= 0:
        return True, "the lock carries no pid, so its liveness cannot be disproved"
    created = resources.process_creation_time(pid)
    if created == 0:
        return False, f"pid {pid} no longer exists"
    recorded = int(holder.get("pid_created") or 0)
    if recorded and created != recorded:
        return False, (f"pid {pid} now belongs to a process started LATER than the lock "
                       "recorded, i.e. the pid was reused")
    return True, f"pid {pid} is running with the recorded start time"


def lease_state(path: Path | None = None) -> dict[str, Any]:
    """Is the coordinated endpoint claimed? Three answers, not one.

    absent            -> not held.
    unreadable/corrupt -> HELD-UNCERTAIN while the record is younger than the
                         stale window: we cannot prove nobody owns it, so we do
                         not take the model. Once the record's own age exceeds
                         the window that IS proof it was abandoned, and the
                         window is bounded, so a broken record can never park
                         the product forever.
    ok                -> the old rule: held, and stale only on PID evidence.
    """
    path = path or lease_path()
    record = read_lease_record(path)
    state = record.get("state")
    if state == "absent":
        return {"held": False, "state": "absent", "uncertain": False,
                "proof": record.get("detail", ""), "path": str(path)}
    holder = dict(record.get("holder") or {})
    if state in ("unreadable", "corrupt"):
        age = _record_age_s(path)
        abandoned = age is not None and age >= _stale_window_s()
        return {"held": not abandoned, "state": state, "uncertain": True,
                "abandoned": abandoned,
                "age_s": round(age, 1) if age is not None else None,
                "stale": abandoned,
                "holder": holder, "path": str(path),
                "proof": (f"{record.get('detail')} and the file itself is "
                          f"{round(age)}s old, past the {round(_stale_window_s())}s window, "
                          "so it is abandoned" if abandoned else
                          (f"{record.get('detail')}, and its age cannot be established, "
                           "so no holder can be ruled out and it cannot be aged out"
                           if age is None else
                           f"{record.get('detail')}, so no holder can be ruled out"))}
    alive, why = _pid_evidence(holder)
    return {"held": True, "state": "ok", "uncertain": False, "stale": not alive, "alive": alive,
            "proof": why, "holder": holder, "path": str(path)}


def playwright_state() -> dict[str, Any]:
    """The shared browser lock, read the same way. Never deletes anything.

    F129 (user brief 2026-11-23 sections 2-5): an acceptance batch that starts
    under scripts/run-browser-e2e-exclusive.ps1 is the workspace's ONLY
    inference owner - the submitter has verified the provider, Claude stays
    dormant, and the batch's own uploads are the requests being tested. Such a
    launcher stamps its record with "ml_window":"grant", and THAT record - and
    only a live, parseable one carrying exactly that field - releases the ML
    handoff while the browser window runs. A foreign lock, a forged grant whose
    granting pid has died, an absent record path, and anything unparseable all
    keep the original law: held, and the handoff stays waiting/retryable.
    """
    path = coord_dir() / PLAYWRIGHT_LOCK
    record = read_lease_record(path)
    state = record.get("state")
    if state == "absent":
        return {"held": False, "state": "absent", "uncertain": False,
                "proof": record.get("detail", ""), "path": str(path)}
    holder = dict(record.get("holder") or {})
    if state in ("unreadable", "corrupt"):
        # This file is written by scripts/playwright-lock-heartbeat.ps1 in the
        # SAME fixed-width format. A record we cannot parse does not mean the
        # browser window is free - a browser session holding Strata would be a
        # second inference stream on a capacity-one endpoint.
        age = _record_age_s(path)
        abandoned = age is not None and age >= _stale_window_s()
        return {"held": not abandoned, "state": state, "uncertain": True,
                "abandoned": abandoned, "stale": abandoned,
                "age_s": round(age, 1) if age is not None else None,
                "holder": holder, "path": str(path),
                "proof": f"{record.get('detail')} (record age "
                         f"{'unknown' if age is None else round(age)}s, window "
                         f"{round(_stale_window_s())}s)"}
    alive, why = _pid_evidence(holder)
    if alive and str(holder.get("ml_window") or "").strip().lower() == "grant":
        # The exclusive acceptance batch granted its own window (see docstring).
        # The grant dies with the granting pid: a crashed launcher's leftover
        # record falls through to the normal held/stale path below.
        return {"held": False, "state": "granted", "uncertain": False,
                "alive": True, "granted": True,
                "proof": f"the exclusive acceptance batch {why} granted the ML window; "
                         "its browser window carries no inference stream while a product "
                         "handoff runs",
                "holder": holder, "path": str(path)}
    return {"held": True, "state": "ok", "uncertain": False, "stale": not alive, "alive": alive,
            "proof": why, "holder": holder, "path": str(path)}


def acquire(owner: str = "ruke-python", phase: str = "waiting", *,
            break_stale: bool = False) -> Lease:
    """Atomic exclusive acquire. Raises PlaywrightHeld / LeaseHeld, never steals.

    The ONE playwright-lock release is the launcher's live F129 grant record
    (playwright_state); nothing here deletes or edits a lock it did not write.
    """
    pw = playwright_state()
    # Uncertain counts as held: an unparseable browser lock cannot be cleared by
    # a client that was not the one that wrote it.
    if pw.get("held"):
        raise PlaywrightHeld(pw.get("holder") or {})

    directory = coord_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = lease_path()
    token = uuid.uuid4().hex
    started = time.time()
    for _attempt in range(2):
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        except FileExistsError:
            state = lease_state(path)
            if state.get("uncertain"):
                # Absent / unreadable / corrupt are three different answers, and
                # none of them is "unlocked". A record we cannot read is refused,
                # because taking the model away from a holder we cannot rule out
                # is the exact failure this replaces. Takeover of an UNVERIFIABLE
                # record needs an explicit break_stale plus the record's own age
                # past the window; age alone never proves death when the record
                # IS parseable (that case goes through the pid branch below).
                if not (state.get("abandoned") and break_stale):
                    raise LeaseHeld({"owner": state.get("state", "uncertain"),
                                     "phase": state.get("state", "uncertain"),
                                     "detail": state.get("proof", "")}) from None
                try:
                    os.unlink(str(path))
                    continue
                except OSError:
                    raise LeaseHeld({"owner": state.get("state", "uncertain"),
                                     "phase": "uncertain",
                                     "detail": state.get("proof", "")}) from None
            if state.get("held") and state.get("stale") and break_stale:
                # Breaking is allowed ONLY on the recorded proof, and only when the caller
                # asked for it. "Stale" proves the RECORDED PROCESS IDENTITY is gone: either the
                # pid no longer exists, or that pid now belongs to a process started later than the
                # lock recorded (pid reuse). In neither case is there a live holder process to stop.
                # Under pid reuse the number belongs to an unrelated innocent process, so removing a
                # stale record must never touch a process. An earlier revision terminated that pid and
                # killed an unrelated process; see docs/overnight/DECISIONS.md D-054.
                try:
                    os.unlink(str(path))
                    continue
                except OSError:
                    raise LeaseHeld(state.get("holder") or {}) from None
            raise LeaseHeld(state.get("holder") or {}) from None
        lease = Lease(path, token, owner, phase, started, fd)
        _write_record(fd, lease.record())
        return lease
    raise LeaseHeld(lease_state(path).get("holder") or {})


# This module deliberately has NO process-killing path. A stale lease is only ever unlinked,
# never "cleaned up" by terminating whatever process id happens to appear in the record.


def heartbeat(lease: Lease, phase: str = "", **extra: Any) -> None:
    if lease.fd < 0:
        return
    if phase:
        lease.phase = phase
    if extra:
        lease.extra.update(extra)
    try:
        _write_record(lease.fd, lease.record())
    except RecordTooLarge:
        # Diagnostics must never be the reason a live lease stops being
        # readable. Drop the extras, keep the identity, and keep the lease held.
        lease.extra = {}
        _write_record(lease.fd, lease.record())


HEARTBEAT_INTERVAL_S = 5.0


def start_heartbeat(lease: Lease, interval_s: float = HEARTBEAT_INTERVAL_S) -> threading.Thread:
    """Keep the lease timestamp fresh for the WHOLE window, not just phases.

    This matters because an external reader (the Rust shared-endpoint gate)
    decides "is this holder alive?" from the lease heartbeat/mtime. A single
    OCR page can run for minutes, so heartbeating only on phase changes would
    make a LIVE window look abandoned and let inference slip into it. The
    thread dies with the window; it never touches a lease we do not own.
    """
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(interval_s):
            if lease.fd < 0:
                return
            try:
                heartbeat(lease)
            except OSError:
                # The record is gone (released out from under us): stop, and
                # let the caller's typed outcome describe the window.
                return

    thread = threading.Thread(target=loop, name="handoff-lease-heartbeat", daemon=True)
    thread.start()
    # Exposed so run_exclusive can stop it deterministically before release.
    thread._ruke_stop = stop  # type: ignore[attr-defined]
    return thread


def stop_heartbeat(thread: threading.Thread | None) -> None:
    """Signal and join, so no heartbeat write can land after release()."""
    if thread is None:
        return
    stop = getattr(thread, "_ruke_stop", None)
    if stop is not None:
        stop.set()
    thread.join(timeout=HEARTBEAT_INTERVAL_S + 2.0)


def release(lease: Lease) -> dict[str, Any]:
    """Owner-only release: verify our token inside the file before removing it."""
    if lease.fd >= 0:
        try:
            os.close(lease.fd)
        except OSError:
            pass
        lease.fd = -1
    record = read_lease_record(lease.path)
    if record.get("state") == "absent":
        return {"released": True, "detail": "lease file was already gone"}
    if record.get("state") in ("unreadable", "corrupt"):
        # We cannot prove this record is ours, so we do not remove it either.
        # It ages out through lease_state's bounded window instead.
        return {"released": False,
                "detail": f"the lease record on disk could not be verified as ours "
                          f"({record.get('detail')}); leaving it to age out"}
    if (record.get("holder") or {}).get("token") != lease.token:
        return {"released": False,
                "detail": "the lease on disk is not ours; refusing to remove a foreign lease"}
    try:
        os.unlink(str(lease.path))
        return {"released": True, "detail": "own lease removed"}
    except OSError as exc:
        return {"released": False, "detail": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------- journal

def journal_path() -> Path:
    return runtime_dir() / Path(JOURNAL_REL).name


def journal_write(payload: dict[str, Any]) -> None:
    path = journal_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def journal_read() -> dict[str, Any]:
    try:
        return json.loads(journal_path().read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def journal_clear() -> None:
    try:
        journal_path().unlink()
    except OSError:
        pass


# ---------------------------------------------------------------- gate audit

GATE_LOG_REL = "python/handoff-gate-log.jsonl"


def gate_log_path() -> Path:
    return runtime_dir() / Path(GATE_LOG_REL).name


def gate_log_append(payload: dict[str, Any]) -> None:
    """Append the post-unload commit-gate evaluation to a durable log.

    The journal is ONE file, overwritten per window and CLEARED on success
    (journal_clear), and a successful window is exactly the run whose gate
    numbers the next reconciliation needs (accept-10: the gate OPENED and the
    worker died at the loader import - with the journal cleared, the gate's
    real s1 was unobtainable). One JSON line per gate evaluation, verdict
    included, never cleared, append-only. Audit trail only: a log failure
    must never break or refuse a window, so all OS errors are swallowed.
    """
    try:
        path = gate_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, sort_keys=True) + "\n")
    except OSError:
        pass


def recover(*, timeout_s: float = main_model.DEFAULT_READY_TIMEOUT_S) -> dict[str, Any]:
    """Finish an interrupted handoff after a supervisor restart.

    The journal says what the original loaded state was, so recovery restores exactly that:
    a model that was already unloaded is not loaded, and one that was loaded is verified
    loaded again. Processing output is never touched here - it is already on disk.
    """
    entry = journal_read()
    if not entry:
        return {"needed": False, "detail": "no handoff journal on disk"}
    original = entry.get("original") or {}
    if entry.get("phase") == "ready" or not original.get("loaded"):
        journal_clear()
        return {"needed": True, "restored": True,
                "detail": "journal cleared (nothing to restore: the model was not loaded before)",
                "journal": entry}
    provider = main_model.provider_for(str(original.get("endpoint") or ""))
    outcome = provider.load()
    ready = provider.wait_ready(timeout_s) if outcome.get("ok") else outcome
    done = bool(ready.get("ok"))
    if done:
        journal_clear()
    return {"needed": True, "restored": done, "load": outcome, "ready": ready,
            "detail": ("main model restored after an interrupted handoff" if done
                       else "RESTORATION FAILED - the main model is still unloaded; retry "
                            "recovery, the processing output is already saved"),
            "journal": entry}


def recover_at_startup(*, timeout_s: float = main_model.DEFAULT_READY_TIMEOUT_S,
                       progress: Callable[[str, str], None] | None = None) -> dict[str, Any]:
    """B10: the supervisor's journal-driven restart recovery — the ONLY server-side
    reload owner outside a live window. Nothing in the UI polls for this.

    A live lease means a window is running on this boot: its holder dispatches
    restoration at worker completion (the run_exclusive law), so startup recovery
    YIELDS and leaves the journal for that holder to settle — one reload owner,
    never a race. With no live holder, the journal is the evidence of an interrupted
    window, and restoring exactly the originally-loaded model is this owner's job.
    The answer is always typed; a failed reload keeps the journal for the next attempt.
    """
    entry = journal_read()
    if not entry:
        return {"needed": False, "detail": "no handoff journal on disk"}
    state = lease_state()
    if state.get("held") and not state.get("stale"):
        if progress:
            progress("startup_recovery", "a live handoff lease is held: yielding to its holder")
        return {"needed": True, "yielded": True, "restored": False,
                "detail": "a live handoff lease is held; its holder is the reload owner "
                          "for this window, and startup recovery will not race it",
                "journal": entry}
    report = recover(timeout_s=timeout_s)
    if progress:
        progress("startup_recovery", str(report.get("detail", "")))
    return report


# ---------------------------------------------------------------- state machine

def _measure() -> dict[str, Any]:
    host = resources.memory_report()
    vram = devices.vram_state(force=True)
    return {"free_physical_mib": host.get("free_physical_mib"),
            "commit_available_mib": host.get("commit_available_mib"),
            "free_vram_mib": vram.free_mib if vram.available else None,
            "vram_available": vram.available}


def _freed_amount(before: dict[str, Any] | None, after: dict[str, Any] | None,
                  key: str, label: str) -> tuple[int | None, str]:
    """How much of one measured quantity the unload actually returned, or (None, why UNKNOWN).

    An earlier report subtracted a missing sample as if it were a zero and the ledger then read
    "freed 0 MiB" as evidence the unload accomplished nothing. A difference needs two real
    samples, and the report has to say when it does not have them.
    """
    before_mib = (before or {}).get(key)
    after_mib = (after or {}).get(key)
    if isinstance(before_mib, int) and isinstance(after_mib, int):
        return after_mib - before_mib, ""
    which = ("both the before and the after sample"
             if before_mib is None and after_mib is None
             else ("the before sample" if before_mib is None else "the after sample"))
    return None, (f"{label} could not be read in {which}, so the amount the unload freed is "
                  "UNKNOWN rather than zero")


def _freed_physical_mib(before: dict[str, Any] | None,
                        after: dict[str, Any] | None) -> tuple[int | None, str]:
    return _freed_amount(before, after, "free_physical_mib", "free physical RAM")


def _last_phase_at(phases: list[dict[str, Any]], name: str) -> float | None:
    """The timestamp of the LAST journalled entry for a phase, or None."""
    for entry in reversed(phases):
        if entry.get("phase") == name and isinstance(entry.get("at"), (int, float)):
            return float(entry["at"])
    return None


def _restore_timings(outcome: dict[str, Any], phases: list[dict[str, Any]],
                     *, from_worker_completion: bool) -> None:
    """B10: record the MEASURED restoration timing from the journalled phase stamps.

    restore_dispatch_ms answers "how long between the worker completing and the
    restoration being dispatched" — the checklist's dispatch latency. It only exists
    when a worker actually completed (the resource_limit path never ran one).
    restore_ready_ms is the dispatch-to-verified answer, so a slow reload is visible
    in the same report as the dispatch gap. Both are computed from the timestamps
    phase() already journalled; nothing here invents a number.
    """
    dispatched = _last_phase_at(phases, "restoring_main_model")
    if dispatched is None:
        return
    if from_worker_completion:
        completed = _last_phase_at(phases, "releasing_worker")
        if completed is not None:
            outcome["restore_dispatch_ms"] = max(0, int(round((dispatched - completed) * 1000)))
    outcome["restore_ready_ms"] = max(0, int(round((time.time() - dispatched) * 1000)))


def _freed_vram_mib(before: dict[str, Any] | None,
                    after: dict[str, Any] | None) -> tuple[int | None, str]:
    return _freed_amount(before, after, "free_vram_mib", "free VRAM")


def _gate_budget_s(deadline_at: float) -> "float | None":
    """Seconds the gate's settle/fit loops may still spend (F140): the job's wall-clock
    deadline minus the exit reserve. None = the window has no deadline knowledge and
    the pre-F140 budgets stand verbatim.
    """
    if not deadline_at:
        return None
    return (float(deadline_at) - time.time()) - _GATE_DEADLINE_RESERVE_S


def run_exclusive(capability: str, work: Callable[[dict[str, Any]], dict[str, Any]], *,
                  est_peak_mib: int, est_peak_vram_mib: int = 0, est_peak_commit_mib: int = 0,
                  est_basis: str = "", est_vram_basis: str = "",
                  allow_gpu: bool = True, allow_unload: bool = False,
                  owner: str = "ruke-python", unload_wait_s: float = 60.0,
                  ready_timeout_s: float = main_model.DEFAULT_READY_TIMEOUT_S,
                  deadline_at: float = 0.0,
                  progress: Callable[[str, str], None] | None = None) -> dict[str, Any]:
    """Lease -> (unload if needed) -> work -> release worker -> restore model -> ready.

    `work` receives the plan and must persist its own results before returning; it must not
    keep the loaded weights alive after it returns.
    `deadline_at` (F140) is the calling job's absolute wall-clock expiry
    (JobContext.deadline_at()); it bounds the gate's settle/fit budgets so the machine
    is handed back before the caller walks away mid-window.
    """
    log = progress or (lambda phase, note: None)
    phases: list[dict[str, Any]] = []

    def restore(endpoint: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Load the ORIGINAL model back and wait until it answers /health."""
        provider = main_model.provider_for(endpoint or "")
        loaded = provider.load()
        ready = provider.wait_ready(ready_timeout_s) if loaded.get("ok") else loaded
        return loaded, ready

    def phase(name: str, note: str = "") -> None:
        phases.append({"phase": name, "at": time.time(), "note": note})
        log(name, note)

    try:
        # F142: the pipeline acquires with the SAME self-heal law as the TS admission
        # client (llm-lease.ts acquireLease), which on PID evidence alone breaks a
        # record whose recorded process identity is provably gone - "a crashed
        # supervisor must not lock the product out of the coordinated path forever".
        # The old default (break_stale=False) left a dead owner's record - the
        # accept-15 window that outlived its client - poisoning every GPU job with
        # coordination_held permanently, because no product path ever passed the flag.
        # Breaking is unlink-only and never touches a process (DECISIONS.md D-054);
        # a live pid stays HELD however quiet, and the takeover is bounded by the
        # same PID/age proofs acquire() already enforces.
        lease = acquire(owner=owner, phase="waiting", break_stale=True)
    except (PlaywrightHeld, LeaseHeld) as exc:
        return {"ok": False, "reason": "coordination_held", "detail": str(exc),
                "holder": getattr(exc, "holder", {})}

    outcome: dict[str, Any] = {"ok": False, "capability": capability, "phases": phases}
    unloaded = False
    hb_thread: threading.Thread | None = None
    try:
        original = main_model.snapshot()
        # Keep the lease visibly alive for the whole window: an external
        # reader (the Rust endpoint gate) must never mistake a minutes-long
        # page for an abandoned holder.
        hb_thread = start_heartbeat(lease)
        journal_write({"token": lease.token, "owner": owner, "capability": capability,
                       "phase": "waiting", "original": original, "started_at": lease.started})
        outcome["original_main_model"] = original
        outcome["measure_before"] = _measure()
        t_plan = time.monotonic()

        plan = devices.device_plan(
            capability, est_peak_mib=est_peak_mib, est_peak_vram_mib=est_peak_vram_mib,
            est_basis=est_basis, est_vram_basis=est_vram_basis, allow_gpu=allow_gpu,
            allow_unload=allow_unload, main_model=original)
        outcome["plan"] = plan.as_dict()

        if not plan.fits and plan.needs_handoff and allow_unload and original.get("loaded"):
            phase("unloading_main_model", plan.reason)
            provider = main_model.provider_for(str(original.get("endpoint") or ""))
            can, why = provider.supports_lifecycle()
            if not can:
                outcome.update(reason="provider_unsupported", detail=why)
                phase("restoring_main_model", "nothing was unloaded")
                # Honest: the machine is unchanged, but the capability did NOT run. Reporting
                # ok=True here would let a caller read "unsupported" as a completed window.
                outcome.update(ok=False, final_status="unsupported", state_restored=True)
                return outcome
            step = provider.unload(unload_wait_s)
            outcome["unload"] = step
            if not step.get("ok"):
                outcome.update(reason="unload_refused", detail=step.get("detail", ""))
                phase("restoring_main_model", "unload refused; nothing to restore")
                outcome.update(ok=False, final_status="unload_refused", state_restored=True)
                return outcome
            unloaded = True
            after = _measure()
            outcome["measure_after_unload"] = after
            freed, freed_why = _freed_physical_mib(outcome.get("measure_before"), after)
            outcome["freed_physical_mib"] = freed
            if freed is None:
                outcome["freed_physical_mib_note"] = freed_why
            # The same question on the other axis: a model parked in VRAM is what a GPU
            # placement was waiting for, and "unknown" must not be reported as 0 MiB freed.
            vfreed, vwhy = _freed_vram_mib(outcome.get("measure_before"), after)
            outcome["freed_vram_mib"] = vfreed
            if vfreed is None:
                outcome["freed_vram_mib_note"] = vwhy
            journal_write({"token": lease.token, "owner": owner, "capability": capability,
                           "phase": "unloading_main_model", "original": original,
                           "unloaded_by_us": True, "started_at": lease.started})
            devices.clear_cache()
            plan = devices.device_plan(capability, est_peak_mib=est_peak_mib,
                                       est_peak_vram_mib=est_peak_vram_mib, est_basis=est_basis,
                                       est_vram_basis=est_vram_basis, allow_gpu=allow_gpu,
                                       main_model=provider.inspect().as_dict())
            outcome["plan_after_unload"] = plan.as_dict()

            # The release moves two axes - RAM and VRAM - and both are re-measured above.
            # The third axis is COMMIT, and it has its own failure mode: a CONFIRMED
            # /unload can leave the engine process resident with its full commit charge
            # (measured 2026-11-23: the ASR worker died at torch's DLL import with
            # WinError 1455 - a commit refusal the loader reports as "paging file too
            # small" - while the sampler showed the "released" model holding ~49 GB of
            # working set through the whole window). The window's own law is that the
            # remeasured post-release plan is the real gate; so is the post-release
            # commit headroom. Refuse typed and transient when it does not clear the
            # capability's measured commit demand - work must never run where the
            # engine's loader will die.
            if est_peak_commit_mib > 0:
                from .models import job_limits as job_limits_mod, lifecycle as lifecycle_mod
                cceil, cnote = job_limits_mod.exclusive_ceiling_bytes()
                # F131 churn law (2026-11-23, accept-8): the static gate above cleared,
                # and the engine's DLL import died ~20 s later with the same WinError
                # 1455 in BOTH live rows (F91.1 libpaddle, fr-U1 cufft64_11.dll). The
                # quiet-host demand figures do not cover what a BUSY host consumes
                # between this gate and the import: a restoring 50 GB main model, page
                # file churn and visible browsers drain the system commit at GB/minute,
                # and Windows reports the import's allocation refusal as "paging file
                # too small". Measure the DRAIN the window itself witnessed - the
                # pre-release and gate commit samples are seconds apart - and demand
                # headroom for one more import-length drain on top of the measured
                # peak. A stable host (drain <= 0) adds nothing and behaves exactly as
                # the static gate did; an unknown sample adds nothing (no regression).
                s0 = (outcome.get("measure_before") or {}).get("commit_available_mib")
                s1 = cnote.get("commit_available_mib")
                # F135: the release's own pagefile expansion makes the single post-release
                # sample the window's MAXIMUM, not its headroom (accept-11: gate 84,449
                # MiB, stable base ~19-21k). Sample across the shrink and gate on the
                # smallest reading the window actually witnessed.
                # F140: the settle and fit budgets are measured against the JOB's own
                # deadline, so a 90 s document job is never left holding the lease and
                # the ML slot past the client's exit (see the constant's law).
                budget_s = _gate_budget_s(deadline_at)
                settle_clamped = False
                settle_samples: list[int] = ([s1] if isinstance(s1, int) else [])
                for _ in range(_COMMIT_SETTLE_SAMPLES):
                    if budget_s is not None and budget_s < _COMMIT_SETTLE_S:
                        settle_clamped = True
                        break
                    budget_s = None if budget_s is None else budget_s - _COMMIT_SETTLE_S
                    _sleep(_COMMIT_SETTLE_S)
                    _, snote = job_limits_mod.exclusive_ceiling_bytes()
                    sv = snote.get("commit_available_mib")
                    if isinstance(sv, int):
                        settle_samples.append(sv)
                s_stable = min(settle_samples) if settle_samples else s1
                elapsed = max(0.001, time.monotonic() - t_plan)
                churn_allowance_mib = 0
                if (isinstance(s0, int) and isinstance(s_stable, int) and s_stable < s0
                        and elapsed >= _COMMIT_DRAIN_MIN_SAMPLE_S):
                    rate = min((s0 - s_stable) / elapsed, _COMMIT_DRAIN_MAX_MIB_PER_S)
                    churn_allowance_mib = int(math.ceil(rate * _COMMIT_DRAIN_IMPORT_S))
                # F133 import-transient axis (2026-11-23, accept-9): the churn gate PASSED
                # - attached ceiling 15,258 MiB over a 10,406 MiB measured peak - and
                # libpaddle's import died on SYSTEM commit anyway (worker log: "DLL load
                # failed while importing libpaddle: The paging file is too small"). The
                # job-object ceiling bounds the child's steady kernel charge; a CUDA build's
                # DLL import maps views (cudnn/cublas, Paddle's op-support tables) charged
                # SYSTEM-WIDE, and accept-9 proved that transient exceeds the steady peak on
                # a busy host: the death happened with free commit >= 17,306 MiB at gate
                # time (ceiling 15,258 + the 2 GiB system reserve the ceiling arithmetic
                # always keeps back) = 1.66x the row's measured peak, while the quiet probe
                # imports cleanly under 11,444 MiB when commit headroom is plentiful. Size
                # the gate to the loader, not only to the kernel: system free commit must
                # cover the import transient (= one more copy of the measured demand, the
                # smallest multiple clearing the 1.66x death point with margin) on top of
                # demand + margin + churn. The ceiling is by construction <= free commit -
                # reserve (job_limits.exclusive_ceiling_bytes), so ceiling + reserve is
                # always a valid floor for free commit; when the gate sample knows better,
                # use that. A host whose commit charge cannot be read keeps the old
                # behaviour (no axis, no invented number).
                reserve_mib = int(cnote.get("system_reserve_bytes") or 0) >> 20
                import_transient_mib = int(est_peak_commit_mib)
                import_required_mib = (int(est_peak_commit_mib)
                                       + lifecycle_mod.COMMIT_CEILING_MARGIN_MIB
                                       + churn_allowance_mib + import_transient_mib)
                headroom_floor_mib = (max(int(s_stable), (int(cceil) >> 20) + reserve_mib)
                                      if isinstance(s_stable, int) else None)
                if headroom_floor_mib is not None and isinstance(s0, int):
                    # The pre-release baseline bounds the window too: a post-release
                    # reading above what the host had BEFORE the unload is pagefile
                    # expansion, never new headroom (F135).
                    headroom_floor_mib = min(headroom_floor_mib, s0)
                outcome["commit_gate_after_unload"] = {
                    "ceiling_mib": int(cceil) >> 20,
                    "commit_available_mib": cnote.get("commit_available_mib"),
                    "commit_available_stable_mib": s_stable,
                    "settle_samples_mib": settle_samples,
                    "settle_clamped_by_deadline": settle_clamped,
                    "commit_available_at_release_mib": s0,
                    "bound_by": cnote.get("bound_by", ""),
                    "demand_mib": int(est_peak_commit_mib),
                    "churn_allowance_mib": churn_allowance_mib,
                    "drain_window_s": round(elapsed, 3),
                    "import_transient_mib": import_transient_mib,
                    "system_headroom_floor_mib": headroom_floor_mib,
                    "import_required_mib": import_required_mib,
                }
                ceiling_short = (int(cceil) >> 20) < (int(est_peak_commit_mib)
                                                      + lifecycle_mod.COMMIT_CEILING_MARGIN_MIB
                                                      + churn_allowance_mib)
                loader_short = (headroom_floor_mib is not None
                                and headroom_floor_mib < import_required_mib)
                # F138 (see the constants): settle-until-fit on the import axis. Only
                # the import axis - the ceiling axis is a clamp fact waiting changes
                # nothing. The fit tail's minimum is the window's own witnessed stable
                # headroom; a stable tail >= required for _IMPORT_FIT_STABLE samples
                # is the window's own definition of fit. A mocked/exhausted clock
                # ends the wait at once: the refusal stands, no invented fit.
                import_fit = None
                if loader_short and not ceiling_short:
                    fit_tail: list[int] = []
                    fit_wait_s = 0.0
                    fit_cap_s = _IMPORT_FIT_CAP_S
                    if budget_s is not None:
                        fit_cap_s = min(_IMPORT_FIT_CAP_S, max(0.0, budget_s))
                    fit_deadline_clamped = fit_cap_s < _IMPORT_FIT_CAP_S
                    try:
                        fit_start = time.monotonic()
                        deadline = fit_start + fit_cap_s
                        while time.monotonic() < deadline:
                            _sleep(1.0)
                            _, fnote = job_limits_mod.exclusive_ceiling_bytes()
                            fv = fnote.get("commit_available_mib")
                            if not isinstance(fv, int) or fv <= 0:
                                break
                            if fv >= import_required_mib:
                                fit_tail.append(int(fv))
                                if len(fit_tail) >= _IMPORT_FIT_STABLE:
                                    break
                            else:
                                fit_tail = []
                        fit_wait_s = round(time.monotonic() - fit_start, 1)
                    except StopIteration:
                        pass  # test clock exhausted: the cap stands, no invented fit
                    if len(fit_tail) >= _IMPORT_FIT_STABLE:
                        s_fit = min(fit_tail)
                        loader_short = s_fit < import_required_mib
                        import_fit = {"wait_s": fit_wait_s,
                                      "stable_samples_mib": fit_tail,
                                      "fit_headroom_floor_mib": s_fit,
                                      "cap_s": round(fit_cap_s, 1),
                                      "deadline_clamped": fit_deadline_clamped}
                    else:
                        import_fit = {"wait_s": fit_wait_s, "stable_samples_mib": [],
                                      "cap_s": round(fit_cap_s, 1),
                                      "deadline_clamped": fit_deadline_clamped,
                                      "note": ("free commit never settled above the import "
                                               "demand inside the fit window (cap expiry or "
                                               "unreadable probe): the refusal stands, typed "
                                               "and retryable"
                                               + (f"; the job's own deadline clamped the fit "
                                                  f"window to {round(fit_cap_s, 1)} s - the "
                                                  "gate must hand the machine back inside it"
                                                  if fit_deadline_clamped else ""))}
                    outcome["commit_gate_after_unload"]["import_fit"] = import_fit
                gate_log_append({
                    "capability": capability, "token": lease.token, "ts": time.time(),
                    "verdict": "refused" if (ceiling_short or loader_short) else "opened",
                    "gate": outcome["commit_gate_after_unload"],
                })
                if ceiling_short or loader_short:
                    outcome.update(
                        reason="resource_limit", transient=True, final_status="resource_limit",
                        detail=("the release was confirmed, but "
                                + (f"the commit headroom this host can give right now is "
                                   f"{int(cceil) >> 20} MiB (bound by "
                                   f"{cnote.get('bound_by', 'the host clamp')}) and the "
                                   f"capability measured {int(est_peak_commit_mib)} MiB of "
                                   f"commit demand"
                                   if ceiling_short else
                                   f"the ceiling {int(cceil) >> 20} MiB clears the capability's "
                                   f"{int(est_peak_commit_mib)} MiB steady commit demand, and "
                                   f"the system free commit at gate time is only "
                                   f"{headroom_floor_mib} MiB (gate sample "
                                   f"{s1} MiB, stable settle minimum {s_stable} MiB)"
                                   if loader_short else "")
                                + (f", plus {churn_allowance_mib} MiB for the commit drain this "
                                   f"host showed across the window ({s0} -> {s_stable} MiB over "
                                   f"{round(elapsed, 1)} s) over one engine import"
                                   if churn_allowance_mib else "")
                                + (f"; the engine's loader measures an import transient of "
                                   f"{import_transient_mib} MiB on top of the steady peak "
                                   f"(total {import_required_mib} MiB): a CUDA build's DLL "
                                   f"import is charged system-wide, above the child's ceiling"
                                   if loader_short else "")
                                + (f"; the release window was then polled for "
                                   f"{import_fit['wait_s']} s and free commit never "
                                   f"settled above {import_required_mib} MiB"
                                   if loader_short and import_fit
                                   and not import_fit.get("stable_samples_mib") else "")
                                + "; running here would die inside the engine's loader, not "
                                  "inside the engine"))
                    phase("restoring_main_model",
                          "commit headroom did not clear the measured commit demand")
                    outcome["restore"], outcome["restore_ready"] = restore(
                        str(original.get("endpoint") or ""))
                    _restore_timings(outcome, phases, from_worker_completion=False)
                    unloaded = not bool(outcome["restore_ready"].get("ok"))
                    return outcome

        if not plan.fits:
            # Neither backend fits even after the handoff: that is an acceptance failure to
            # report, not something to paper over by skipping pages.
            outcome.update(reason="resource_limit", detail=plan.reason,
                           final_status="resource_limit")
            if unloaded:
                phase("restoring_main_model", plan.reason)
                outcome["restore"], outcome["restore_ready"] = restore(
                    str(original.get("endpoint") or ""))
                _restore_timings(outcome, phases, from_worker_completion=False)
                unloaded = not bool(outcome["restore_ready"].get("ok"))
            return outcome

        heartbeat(lease, "processing", device=plan.device)
        phase("processing", f"device={plan.device} est_peak_mib={est_peak_mib}")
        journal_write({"token": lease.token, "owner": owner, "capability": capability,
                       "phase": "processing", "original": original,
                       "unloaded_by_us": unloaded, "device": plan.device,
                       "started_at": lease.started})
        # The worker has to know WHICH budget it may claim. An exclusive ceiling is only
        # legitimate when this operation actually released the main model: a lease can be granted
        # without any unload (the job fitted after all, or the provider refused), and a worker that
        # assumed "lease held == widened ceiling" would widen its own limit on a guess. The flag is
        # therefore stated by the holder, from the same `unloaded` bit that drives restoration.
        payload = dict(plan.as_dict())
        payload["main_model_unloaded_by_us"] = bool(unloaded)
        payload["resource_window"] = "exclusive" if unloaded else "normal"
        work_outcome = work(payload)
        outcome["work"] = work_outcome

        phase("releasing_worker", "worker resources released by the adapter")
        heartbeat(lease, "releasing_worker")
        outcome["measure_after_work"] = _measure()
        outcome["work_peak"] = (work_outcome or {}).get("peak") or {}

        if unloaded:
            phase("restoring_main_model", "bringing the original model back")
            outcome["restore"], outcome["restore_ready"] = restore(
                str(original.get("endpoint") or ""))
            # Recorded BEFORE the ok branch: a failed restoration must carry its own
            # measured timing too, so the report says how long the failed reload tried.
            _restore_timings(outcome, phases, from_worker_completion=True)
            ready = outcome["restore_ready"]
            if not ready.get("ok"):
                outcome.update(reason="restore_failed", detail=ready.get("detail", ""),
                               final_status="restore_failed",
                               note=("processing output is already on disk; retry recovery "
                                      "without repeating the processing"))
                return outcome
            unloaded = False

        phase("ready", "lease released")
        outcome["ok"] = True
        outcome["final_status"] = "ok"
        outcome["device_used"] = plan.device
        return outcome
    except Exception as exc:                                       # noqa: BLE001
        # A crash inside the worker or the planner must still leave the machine in a usable
        # state: the journal is written, the model is put back, and the caller gets a typed
        # answer instead of a traceback out of a detached runner.
        if 'outcome' not in locals() or not isinstance(outcome, dict):
            outcome = {"ok": False, "capability": capability, "phases": phases}
        outcome.update(reason="handoff_failed", final_status="handoff_failed",
                       detail=f"{type(exc).__name__}: {exc}",
                       note="see the journal at .data/python/handoff-journal.json")
        return outcome
    finally:
        finished = bool(outcome.get("ok")) or outcome.get("final_status") == "ok"
        if unloaded and not finished:
            # Recovery beats bookkeeping: put the model back BEFORE journalling, so the
            # journal records whether restoration actually succeeded. A restart relies on it.
            try:
                phase("restoring_main_model", "recovery after an interrupted handoff")
                (outcome["restore"], outcome["restore_ready"]
                 ) = restore(str((outcome.get("original_main_model") or {}).get("endpoint") or ""))
                _restore_timings(outcome, phases,
                                 from_worker_completion=_last_phase_at(phases, "releasing_worker")
                                 is not None)
                if outcome["restore_ready"].get("ok"):
                    outcome["interrupted_with_restore_ok"] = True
            except Exception as exc:                               # noqa: BLE001
                outcome["restore_error"] = f"{type(exc).__name__}: {exc}"
            journal_write({"token": lease.token, "owner": owner, "capability": capability,
                           "phase": outcome.get("final_status") or "interrupted",
                           "original": outcome.get("original_main_model") or {},
                           "unloaded_by_us": True,
                           "detail": outcome.get("detail", ""),
                           "started_at": lease.started})
        else:
            journal_clear()
        # The heartbeat covers restoration too (a model reload takes minutes),
        # and must stop BEFORE the lease is removed so no stale write can
        # resurrect a released record or re-fresh a foreign one.
        stop_heartbeat(hb_thread)
        outcome["lease_release"] = release(lease)


# ------------------------------------------------------------------- operator entry point
def _page_spec(spec: str, total: int) -> list[int]:
    """`1-3,7` -> [1,2,3,7]. Validated against the document's real page count by the caller."""
    if not spec.strip():
        return list(range(1, max(1, int(total)) + 1))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            lo, hi = int(a), int(b)
            if lo > hi:
                lo, hi = hi, lo
            out.extend(range(lo, hi + 1))
        else:
            out.append(int(part))
    return sorted({p for p in out if p > 0})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ruke_ml.handoff",
        description="Run one exclusive heavyweight processing window: take the lease, release "
                    "the main model only if the measured fit requires it, run, persist the "
                    "output, release the worker, restore the model, verify, then release.")
    parser.add_argument("--pdf", default="", help="absolute path to the PDF to OCR")
    parser.add_argument("--language", default="eng", help="explicit document language tag")
    parser.add_argument("--device", default="auto", choices=("auto", "gpu", "cpu"),
                        help="auto = ask the device planner; gpu/cpu = pin it (still validated "
                             "against the runtime's own device capability)")
    parser.add_argument("--allow-unload", action="store_true",
                        help="permit the coordinated unload of the resident main model")
    parser.add_argument("--allow-gpu", action="store_true",
                        help="permit GPU placement; the pinned runtime's own CUDA capability "
                             "still decides whether that is possible")
    parser.add_argument("--pages", default="", help='1-based page spec, e.g. "1-3,7"; default: all')
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--load-timeout", type=float, default=420.0)
    parser.add_argument("--page-timeout", type=float, default=240.0)
    parser.add_argument("--unload-wait", type=float, default=60.0)
    parser.add_argument("--ready-timeout", type=float, default=main_model.DEFAULT_READY_TIMEOUT_S)
    parser.add_argument("--max-free-mib", type=int, default=0,
                        help="safety valve: cancel the job if free physical RAM drops below this")
    parser.add_argument("--inject-primary-failure-page", type=int, default=0,
                        help="fault injection for acceptance: discard the primary result for this "
                             "page so the engine fallback path executes for real")
    parser.add_argument("--resume-results", action="store_true",
                        help="reuse the persisted, content-verified OCR units for this source and "
                             "request instead of re-running an engine for them; off by default so "
                             "an acceptance run always means a real engine execution")
    parser.add_argument("--recover", action="store_true",
                        help="finish an interrupted handoff from the journal without re-processing")
    parser.add_argument("--lease-owner", default="handoff-cli")
    parser.add_argument("--out", default="", help="write the evidence JSON to this path")
    args = parser.parse_args(argv)

    def say(phase: str, note: str = "") -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {phase}: {note}", flush=True)

    if args.recover:
        report = recover(timeout_s=args.ready_timeout)
        print(json.dumps(report, indent=2, default=str))
        return 0 if report.get("ok") else 1

    if not args.pdf:
        parser.error("--pdf is required unless --recover is given")
    from .documents import ocr_cascade, ocr_paddle
    target = Path(args.pdf).resolve()
    if not target.is_file():
        say("rejected", f"no such file: {target}")
        return 2

    est = ocr_paddle.estimate()
    pages = _page_spec(args.pages, 0)
    collected: dict[str, Any] = {}
    state: dict[str, Any] = {"cancel": False}

    watchdog: dict[str, Any] = {"free_min": None, "tripped": 0}

    def guard() -> None:
        if args.max_free_mib <= 0:
            return
        while not state.get("done"):
            measured = _measure()
            free = measured.get("free_physical_mib")
            if isinstance(free, int):
                watchdog["free_min"] = free if watchdog["free_min"] is None else min(
                    watchdog["free_min"], free)
                if free < args.max_free_mib:
                    watchdog["tripped"] = free
                    state["cancel"] = True
                    say("resource_guard", f"free physical RAM fell to {free} MiB; cancelling the "
                                          f"job so this host keeps working (valve "
                                          f"{args.max_free_mib} MiB)")
                    return
            time.sleep(2.0)

    def work(plan: dict[str, Any]) -> dict[str, Any]:
        device = args.device if args.device in ("cpu", "gpu") else str(plan.get("device") or "cpu")
        got, report = ocr_cascade.run(
            str(target), pages, language=args.language, dpi=args.dpi,
            cancel=lambda: bool(state["cancel"]), progress=say,
            per_page_timeout_s=args.page_timeout, job_id=args.lease_owner,
            device_override=device, inside_handoff=True,
            resume=args.resume_results,
            inject_failure_unit=args.inject_primary_failure_page,
            # The plan dict is the payload run_exclusive builds, so this is the same flag the
            # in-process production path reads: True only when THIS window unloaded the model.
            inside_window=bool(plan.get("main_model_unloaded_by_us")))
        collected["pages"] = [p.to_dict() for p in got]
        collected["cascade"] = report["cascade"]
        # The cascade's own operation record is the ONLY account of what this window cost and
        # produced. It used to be rebuilt here from the paddle adapter's counters, which (a) rated
        # an unmeasured peak as 0 MiB and (b) described only the primary attempt, even though the
        # recovery engine had also run inside the window. Fault injection now happens inside the
        # cascade too, so this CLI no longer carries a private copy of the recovery path.
        op = report["cascade"].get("operation") or {}
        unresolved = op.get("unresolved")
        if unresolved is None:
            unresolved = [p.page for p in got if p.state in ("ocr_failed", "raster_failed",
                                                             "skipped")]
        return {
            "peak": op.get("peak") or {},
            "persisted_path": str(op.get("persisted_path", "")),
            "units_persisted": int(op.get("units_persisted", 0) or 0),
            "device_used": str(op.get("device_used", device)),
            "device_echo": op.get("device_echo", {}),
            "pages": int(op.get("pages", len(got)) or 0),
            "recognised": int(op.get("recognised",
                                     sum(1 for p in got if p.state == "recognised")) or 0),
            "unresolved": list(unresolved),
        }

    def _run_all() -> dict[str, Any]:
        return run_exclusive(
            "documents.ocr", work, est_peak_mib=int(est["est_peak_mib"]),
            est_peak_vram_mib=int(est["est_peak_vram_mib"]),
            est_basis=str(est["est_peak_basis"]), est_vram_basis=str(est["est_vram_basis"]),
            allow_gpu=bool(args.allow_gpu), allow_unload=bool(args.allow_unload),
            owner=args.lease_owner, unload_wait_s=args.unload_wait,
            ready_timeout_s=args.ready_timeout, progress=say)

    guard_thread = threading.Thread(target=guard, daemon=True)
    guard_thread.start()
    outcome = _run_all()
    state["done"] = True
    guard_thread.join(timeout=5)
    outcome["work_detail"] = collected
    outcome["watchdog"] = watchdog
    outcome["pages_requested"] = pages
    outcome["arguments"] = {k: v for k, v in vars(args).items()
                            if k not in ("out",)}
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(outcome, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"ok": outcome.get("ok"), "reason": outcome.get("reason", ""),
                      "final_status": outcome.get("final_status", ""),
                      "device": outcome.get("device_used", ""),
                      "freed_physical_mib": outcome.get("freed_physical_mib"),
                      "work": outcome.get("work"), "out": args.out}, indent=2, default=str))
    return 0 if outcome.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
