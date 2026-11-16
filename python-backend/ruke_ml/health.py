"""Health and capability reporting without touching a model or the network."""
from __future__ import annotations

import time
from typing import Any

from .config import LIMITS, fingerprint
from .contracts import CAPABILITIES
from .models.registry import catalog


class Health:
    def __init__(self, started_at: float | None = None) -> None:
        self.started_at = started_at or time.time()
        self.state = "starting"        # starting | ready | degraded | draining | stopped
        self.active_jobs = 0
        self.last_error: str = ""

    def snapshot(self) -> dict[str, Any]:
        caps = {}
        for cap in CAPABILITIES:
            caps[cap] = catalog().status_for(cap)
        return {
            "state": self.state,
            "uptime_s": round(time.time() - self.started_at, 3),
            "active_jobs": self.active_jobs,
            "heavy_worker_running": catalog().heavy_worker_running(),
            "heavy_models_resident": catalog().resident_heavy_models(),
            "limits": {"heavy_concurrency": LIMITS.heavy_concurrency,
                       "idle_ttl_s": LIMITS.idle_ttl_s,
                       "mem_budget_mib": LIMITS.mem_budget_mib},
            "capabilities": caps,
            "fingerprint": fingerprint(),
            "last_error": self.last_error,
        }
