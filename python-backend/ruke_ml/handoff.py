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
import os
import time
import uuid
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import repo_root, runtime_dir
from .models import devices, main_model, resources

COORD_DIR_REL = ".ai-coordination"
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
    """The shared browser lock, read the same way. Never deletes anything."""
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
    return {"held": True, "state": "ok", "uncertain": False, "stale": not alive, "alive": alive,
            "proof": why, "holder": holder, "path": str(path)}


def acquire(owner: str = "ruke-python", phase: str = "waiting", *,
            break_stale: bool = False) -> Lease:
    """Atomic exclusive acquire. Raises PlaywrightHeld / LeaseHeld, never steals."""
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


def _freed_vram_mib(before: dict[str, Any] | None,
                    after: dict[str, Any] | None) -> tuple[int | None, str]:
    return _freed_amount(before, after, "free_vram_mib", "free VRAM")


def run_exclusive(capability: str, work: Callable[[dict[str, Any]], dict[str, Any]], *,
                  est_peak_mib: int, est_peak_vram_mib: int = 0,
                  est_basis: str = "", est_vram_basis: str = "",
                  allow_gpu: bool = True, allow_unload: bool = False,
                  owner: str = "ruke-python", unload_wait_s: float = 60.0,
                  ready_timeout_s: float = main_model.DEFAULT_READY_TIMEOUT_S,
                  progress: Callable[[str, str], None] | None = None) -> dict[str, Any]:
    """Lease -> (unload if needed) -> work -> release worker -> restore model -> ready.

    `work` receives the plan and must persist its own results before returning; it must not
    keep the loaded weights alive after it returns.
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
        lease = acquire(owner=owner, phase="waiting")
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

        plan = devices.device_plan(
            capability, est_peak_mib=est_peak_mib, est_peak_vram_mib=est_peak_vram_mib,
            est_basis=est_basis, est_vram_basis=est_vram_basis, allow_gpu=allow_gpu,
            main_model=original)
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

        if not plan.fits:
            # Neither backend fits even after the handoff: that is an acceptance failure to
            # report, not something to paper over by skipping pages.
            outcome.update(reason="resource_limit", detail=plan.reason,
                           final_status="resource_limit")
            if unloaded:
                phase("restoring_main_model", plan.reason)
                outcome["restore"], outcome["restore_ready"] = restore(
                    str(original.get("endpoint") or ""))
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
