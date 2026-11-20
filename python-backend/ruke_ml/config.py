"""Runtime, cache and path configuration. Project-local by default; per-process env is set by the owner.

Every path resolution here is Windows-correct: HOME is not assumed (Windows has USERPROFILE),
and WEBUI_DATA_DIR wins over the repository default, matching lib/persistence/dataRoot.ts.
"""
from __future__ import annotations

import hashlib
import os
import platform
import sys
from dataclasses import dataclass, field
from pathlib import Path

ENV_DATA_DIR = "WEBUI_DATA_DIR"
ENV_MODEL_DIR = "RUKE_MODEL_DIR"
ENV_ML_CACHE = "RUKE_ML_CACHE_DIR"
ENV_RUNTIME_DIR = "RUKE_PY_RUNTIME_DIR"
ENV_RPC_URL = "RUKE_ML_URL"
ENV_RPC_TOKEN = "RUKE_ML_TOKEN"
ENV_SECRET_FILE = "RUKE_ML_SECRET_FILE"
ENV_PARENT_PID = "RUKE_ML_PARENT_PID"
ENV_JOB_ID = "RUKE_ML_JOB_ID"
ENV_MEM_BUDGET = "RUKE_ML_MEM_BUDGET_MIB"
ENV_MEM_CEILING = "RUKE_ML_MEM_CEILING_BYTES"

DEFAULT_MEM_BUDGET_MIB = 4096
# Hard maximum for the Ruke runtime tree plus its processing children, excluding the main
# LLM and the coding agent. Enforced, not polled: see models/job_limits.py.
DEFAULT_MEM_CEILING_BYTES = 5_000_000_000
DEFAULT_LIGHT_WORKER_CEILING_MIB = 1536


def repo_root() -> Path:
    env = os.environ.get("RUKE_REPO_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    here = Path(__file__).resolve()
    # python-backend/ruke_ml/config.py -> repo root is two parents above python-backend
    return here.parents[2]


def data_dir() -> Path:
    env = os.environ.get(ENV_DATA_DIR)
    if env:
        return Path(env).expanduser()
    return repo_root() / ".data"


def model_dir() -> Path:
    return Path(os.environ.get(ENV_MODEL_DIR) or (data_dir() / "models")).expanduser()


def ml_cache_dir() -> Path:
    return Path(os.environ.get(ENV_ML_CACHE) or (data_dir() / "ml-cache")).expanduser()


def runtime_dir() -> Path:
    return Path(os.environ.get(ENV_RUNTIME_DIR) or (data_dir() / "python")).expanduser()


def env_dir() -> Path:
    """uv-managed environment for this project (project-local, never global)."""
    return repo_root() / "python-backend" / ".venv"


def home_dir() -> Path:
    """Never assume HOME: on Windows it is usually absent while USERPROFILE exists."""
    return Path(os.path.expanduser("~"))


def ensure_dirs() -> None:
    for d in (model_dir(), ml_cache_dir(), runtime_dir(), runtime_dir() / "tmp"):
        d.mkdir(parents=True, exist_ok=True)


def child_env(job_id: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Per-child environment: caches stay project-local and per-job scratch is bounded."""
    env = dict(os.environ)
    # The owner may start us from any cwd (Rust starts the server from the repo root), so a
    # child resolving `python -m ruke_ml...` needs the package root on its path explicitly.
    pkg_root = str(Path(__file__).resolve().parents[1])
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = pkg_root + ((os.pathsep + existing) if existing else "")
    env["HOME"] = str(home_dir())          # only for this child, never globally
    env["TORCH_HOME"] = str(model_dir() / "torch")
    env["HF_HOME"] = str(ml_cache_dir() / "huggingface")
    env["XDG_CACHE_HOME"] = str(ml_cache_dir())
    env["PADDLE_PDX_CACHE_HOME"] = str(ml_cache_dir() / "paddle")
    scratch = runtime_dir() / "tmp"
    scratch.mkdir(parents=True, exist_ok=True)   # a child may start without ensure_dirs()
    env["RUKE_SCRATCH_DIR"] = str(scratch)
    env["TMPDIR"] = env["TEMP"] = env["TMP"] = str(scratch)
    env[ENV_MODEL_DIR] = str(model_dir())
    env[ENV_ML_CACHE] = str(ml_cache_dir())
    env[ENV_JOB_ID] = job_id
    # Line-delimited JSON on a pipe is a BYTE protocol. Left to the Windows locale, a child
    # writing smart quotes emitted cp1252 bytes (0x92) into a stream the supervisor decodes as
    # UTF-8, which killed the reader thread and lost a perfectly good parse result. Pin the
    # child's stdio codecs instead of inheriting whatever the parent's console used to be.
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # CPU-only policy, bounded resources: heavy capability jobs are serialized by the
    # pool, so a multi-threaded BLAS/OpenMP backend only oversubscribes the machine and
    # allocates one scratch buffer set per core. Pinning the native thread pools to one
    # thread keeps a worker's peak memory predictable under the runtime budget. Set
    # before the child starts because these variables are read once, inside the
    # extension's own init, and cannot be changed after numpy is imported.
    for threads_var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
                        "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        env.setdefault(threads_var, "1")
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env


def fingerprint() -> str:
    """Stable key for setup caching: lock + interpreter + platform + relevant config."""
    h = hashlib.sha256()
    lock = repo_root() / "python-backend" / "uv.lock"
    h.update(lock.read_bytes() if lock.exists() else b"<no-lock>")
    py = repo_root() / "python-backend" / ".python-version"
    h.update(py.read_bytes() if py.exists() else b"<no-pin>")
    h.update(("|" + sys.version + "|" + platform.platform(terse=True) + "|" + platform.machine()).encode())
    return h.hexdigest()[:16]


@dataclass(slots=True)
class Limits:
    """Hard resource bounds a worker may not exceed. Not advisory."""
    heavy_concurrency: int = 1
    worker_deadline_s: float = 900.0
    # A worker must announce itself before it is trusted with a job. This is a startup
    # bound, not a work bound: alive-but-silent is detected here, not after a 15-minute
    # job deadline has already been consumed.
    worker_ready_timeout_s: float = 45.0
    idle_ttl_s: float = 120.0
    terminate_grace_s: float = 5.0
    max_request_bytes: int = 1 << 20
    max_response_bytes: int = 64 << 20
    max_archive_entries: int = 4096
    max_archive_uncompressed_bytes: int = 256 << 20
    max_archive_ratio: float = 200.0
    mem_budget_mib: int = field(default_factory=lambda: int(os.environ.get(ENV_MEM_BUDGET, DEFAULT_MEM_BUDGET_MIB)))
    # Aggregate hard ceiling for the runtime tree (job object) and the ceiling applied to a
    # worker whose capability has no measured peak yet. Both are enforced limits.
    mem_ceiling_bytes: int = field(default_factory=lambda: int(
        os.environ.get(ENV_MEM_CEILING, DEFAULT_MEM_CEILING_BYTES)))
    light_worker_ceiling_mib: int = DEFAULT_LIGHT_WORKER_CEILING_MIB


LIMITS = Limits()
