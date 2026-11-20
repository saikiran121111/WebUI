"""Pinned model assets: is the weight file actually here, and how to prepare it.

Ordinary startup must never download a model, so presence is answered from the local
cache layout (cheap, no network, no heavy import). Preparation is a SEPARATE explicit
command that a human or a setup script runs.

The cache scan does not pretend to validate checksums. It proves that a snapshot
directory for the pinned repo id exists and contains files; anything stronger is the
downloader's job and is recorded there.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from ..config import ml_cache_dir, model_dir


@dataclass(slots=True)
class AssetState:
    model_id: str
    present: bool
    detail: str
    path: str = ""

    def as_dict(self) -> dict[str, object]:
        return {"model_id": self.model_id, "present": self.present,
                "detail": self.detail, "path": self.path}


def cache_roots() -> list[Path]:
    """Every root a snapshot may legitimately be found in, PROJECT ROOT FIRST.

    Measured defect (F13): `prepare()` downloaded into the per-user Hugging Face cache
    while a worker child runs with `HF_HOME=<repo>/.data/ml-cache/huggingface`, so the
    asset was "prepared" and still reported absent, and the weights also left the
    project, which the project-local-everything rule forbids. Preparation and scanning
    now share ONE resolved root: the worker's own HF hub root, then the explicit model
    dir, then whatever the operator set, then the legacy user cache (read-only fallback
    so an asset prepared before this fix is still honest about being present).
    """
    roots: list[Path] = [hf_hub_root()]
    for base in (model_dir(), model_dir() / "hub"):
        roots.append(base)
    for env in ("RUKE_MODEL_DIR", "HF_HOME", "XDG_CACHE_HOME"):
        value = os.environ.get(env, "").strip()
        if value:
            base = Path(value)
            roots.append(base if (base / "hub").exists() else base)
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    # De-duplicate while keeping order, so the same directory is never scanned twice.
    seen: set[str] = set()
    out: list[Path] = []
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            out.append(root)
    return [r for r in out if r]


def hf_hub_root() -> Path:
    """The hub root a WORKER will actually use, resolved without touching the network.

    `config.child_env()` pins `HF_HOME` to the project ml-cache for every job child, so
    preparation must target the same place or the two halves of the system disagree.
    Hugging Face lays snapshots out as `<HF_HOME>/hub/models--<org>--<name>/snapshots/...`,
    so the hub sub-directory is part of the resolved root, not an extra option.
    """
    env = os.environ.get("HF_HOME", "").strip()
    base = Path(env) if env else (ml_cache_dir() / "huggingface")
    return base / "hub"


def _repo_dir_name(model_id: str) -> str:
    return "models--" + model_id.replace("/", "--")


def verify_files(snapshot: Path, required: Sequence[tuple[str, int]]) -> list[str]:
    """Return the required files that are MISSING or too small in a snapshot directory.

    A non-empty snapshot directory is not proof of a usable model: the amendment states it
    plainly ("a nonempty folder does not prove readiness"). The pinned VL repo needs its
    weights, its config and its tokenizer files; the layout repo needs its Paddle inference
    trio. The names are the ones the pinned revisions actually contain (verified against the
    Hugging Face tree API for those exact commits), and the minimum byte count turns a
    truncated or LFS-pointer-only download into a reported failure instead of a runtime crash
    two minutes into a job.
    """
    problems: list[str] = []
    for name, minimum in required:
        candidate = snapshot / name
        try:
            if not candidate.is_file():
                problems.append(f"{name} is absent")
                continue
            size = candidate.stat().st_size
        except OSError as exc:
            problems.append(f"{name} could not be inspected ({exc.__class__.__name__})")
            continue
        if size < minimum:
            problems.append(f"{name} is {size} B, below the pinned minimum {minimum} B")
    return problems


def asset_state(model_id: str, expected_revision: str = "",
                required: Sequence[tuple[str, int]] = ()) -> AssetState:
    """Is a pinned repo's snapshot actually on this disk? Never touches the network.

    With an `expected_revision`, "present" means the PINNED revision is present: a
    different snapshot on disk is reported as the mismatch it is, because a floating
    "some weights for this repo id exist" answer is exactly how a capability report
    ends up describing a model nobody pinned. Without one, any non-empty snapshot of
    that repo id counts (an intentionally unpinned candidate).

    With `required`, the matching snapshot is additionally checked file-by-file, so an
    incomplete download is a readiness failure rather than a later crash.
    """
    if not model_id:
        return AssetState(model_id, False, "no asset id declared")
    name = _repo_dir_name(model_id)
    want = (expected_revision or "").strip()
    seen: list[str] = []
    for root in cache_roots():
        snap = root / name / "snapshots"
        if not snap.is_dir():
            continue
        found = [entry for entry in snap.iterdir() if entry.is_dir() and any(entry.iterdir())]
        seen += [entry.name for entry in found]
        for entry in found:
            if not want or entry.name == want or entry.name.startswith(want):
                problems = verify_files(entry, required) if required else []
                if problems:
                    return AssetState(
                        model_id, False,
                        f"snapshot {entry.name} is INCOMPLETE: {'; '.join(problems)}; re-run the "
                        f"preparer (it verifies the required files before reporting success)",
                        str(entry))
                where = "the project cache root" if root == hf_hub_root() else "a configured cache root"
                return AssetState(model_id, True,
                                  f"snapshot {entry.name} found in {where}", str(entry))
        if found:
            return AssetState(
                model_id, False,
                f"{snap} holds snapshot(s) {', '.join(sorted(seen))} but NOT the pinned "
                f"revision {want}; re-run the preparer with the pinned revision", str(snap))
    # Second layout, also real and also project-local: a plain checkout of the repo under
    # the model dir (<model_dir>/<repo_id>/onnx/model.onnx), which is what the browser-side
    # embedder downloads. Hub snapshots are checked first because they carry a revision the
    # registry can demand; a plain checkout has no revision directory, so its identity has
    # to be proven by the file bytes (the adapter hashes them at load) rather than here.
    for root in cache_roots():
        plain = root / model_id
        if not plain.is_dir():
            continue
        try:
            contents = list(plain.iterdir())
        except OSError:
            continue
        if not contents:
            continue
        problems = verify_files(plain, required) if required else []
        if problems:
            return AssetState(model_id, False,
                              f"{plain} exists but is INCOMPLETE: {'; '.join(problems)}", str(plain))
        return AssetState(model_id, True,
                          f"project-local asset directory {plain} holds the required files",
                          str(plain))
    return AssetState(model_id, False,
                      "no snapshot for this repo id in any configured cache root", "")


def local_asset_dir(model_id: str) -> Path:
    """The project-local plain checkout used by the digest-pinned ONNX adapters.

    The embedding and cross-encoder adapters identify their weights by sha256, not by a hub
    revision directory, so their files live under `<model_dir>/<repo_id>/...` - the layout
    `asset_state()` also understands. Preparation writes them to the SAME path the worker
    reads, because a download that lands somewhere the runtime never looks is the F13 bug in
    a new costume.
    """
    return model_dir() / model_id


def prepare_local(model_id: str, *, revision: str,
                  allow_patterns: Sequence[str] = (),
                  required: Sequence[tuple[str, int]] = (),
                  force_download: bool = False) -> tuple[AssetState, dict[str, object]]:
    """Download a PINNED revision straight into the project model dir and prove what arrived.

    Unlike `prepare()` (a hub snapshot, which carries a revision directory), a plain checkout
    has no revision on disk, so this writes `asset-manifest.json` next to the files with the
    commit, the retrieval time and the sha256 of every file. Without that record, "the model
    is here" is unanswerable after the fact - which is exactly the hole the MiniLM embedder
    asset was in: present, digest-pinned in code, no reproducible origin on disk.

    Downloads stage through the project cache root, never the user profile, and the result is
    gated by the same required-file check the runtime readiness path uses.
    """
    if not model_id:
        return AssetState(model_id, False, "no asset id declared"), {"ok": False}
    if not revision:
        return (AssetState(model_id, False,
                           "refusing to prepare a project-local asset without a pinned revision"),
                {"ok": False})
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:                                # noqa: BLE001
        return (AssetState(model_id, False,
                           f"downloader unavailable: {type(exc).__name__}: {exc}"),
                {"ok": False})

    import hashlib
    import json
    from datetime import datetime, timezone

    dest = local_asset_dir(model_id)
    staging = ml_cache_dir() / "huggingface"
    try:
        dest.mkdir(parents=True, exist_ok=True)
        staging.mkdir(parents=True, exist_ok=True)
        snapshot_download(model_id, revision=revision, cache_dir=str(staging),
                          local_dir=str(dest), force_download=force_download,
                          allow_patterns=list(allow_patterns) or None)
    except Exception as exc:                                # noqa: BLE001
        state = asset_state(model_id, expected_revision="")
        return (AssetState(model_id, False,
                           f"preparation failed: {type(exc).__name__}: {exc}", state.path),
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    problems = verify_files(dest, required) if required else []
    files: dict[str, object] = {}
    for candidate in sorted(dest.rglob("*")):
        if not candidate.is_file() or ".cache" in candidate.parts or ".git" in candidate.parts:
            continue
        if candidate.name == "asset-manifest.json":
            continue
        digest = hashlib.sha256()
        try:
            with candidate.open("rb") as fh:
                for block in iter(lambda: fh.read(1024 * 1024), b""):
                    digest.update(block)
            files[str(candidate.relative_to(dest)).replace("\\", "/")] = {
                "bytes": candidate.stat().st_size, "sha256": digest.hexdigest()}
        except OSError as exc:
            problems.append(f"{candidate.name} could not be hashed ({exc.__class__.__name__})")

    manifest: dict[str, object] = {
        "model_id": model_id, "pinned_commit": revision,
        "retrieved_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "staged_via": str(staging), "files": files, "problems": problems, "ok": not problems,
    }
    if not problems:
        try:
            (dest / "asset-manifest.json").write_text(
                json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            problems.append(f"manifest could not be written ({exc.__class__.__name__})")
            manifest["ok"] = False
            manifest["problems"] = problems
    state = asset_state(model_id, expected_revision="", required=required)
    return state, manifest


def prepare(model_id: str, *, revision: str = "", force_download: bool = False,
            required: Sequence[tuple[str, int]] = ()) -> AssetState:
    """EXPLICIT preparation only. Startup must call this nowhere."""
    if not model_id:
        return AssetState(model_id, False, "no asset id declared")
    try:
        from huggingface_hub import snapshot_download      # noqa: PLC0415
    except Exception as exc:                                # noqa: BLE001
        return AssetState(model_id, False,
                          f"downloader unavailable: {type(exc).__name__}: {exc}", "")
    try:
        root = hf_hub_root()
        root.mkdir(parents=True, exist_ok=True)
        path = snapshot_download(model_id, revision=revision or None,
                                 force_download=force_download, cache_dir=str(root))
    except Exception as exc:                                # noqa: BLE001
        state = asset_state(model_id)
        return AssetState(model_id, False,
                          f"preparation failed: {type(exc).__name__}: {exc}", state.path)
    # Re-read through the same readiness path the runtime uses, required files included.
    # A "successful" download that left a truncated snapshot must not report ok.
    return asset_state(model_id, expected_revision=revision, required=required)
