"use client";

import { useEffect, useRef, useState } from "react";
import { MlStatusPoller } from "../lib/progress/mlStatusPoller";
import type { BackendView } from "../lib/progress/capabilityStatus";

/**
 * Capability-backend status for the settings panel.
 *
 * The poller exists only while the panel is open: a closed panel must not keep
 * hitting the status endpoint, and unmount must abort the in-flight request
 * (MlStatusPoller.stop does both). Everything rendered from this hook comes from
 * GET /api/ruke/ml-status: the hook fabricates nothing, which is why there is no
 * optimistic first snapshot and no local job list.
 */
export function useCapabilityStatus(active: boolean, intervalMs = 5000): {
  view: BackendView | null;
  transportError: string | null;
  refresh: () => void;
} {
  const [view, setView] = useState<BackendView | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const pollerRef = useRef<MlStatusPoller | null>(null);

  useEffect(() => {
    if (!active) return;
    const poller = new MlStatusPoller({
      intervalMs,
      onView: (v) => {
        setView(v);
        setTransportError(null);
      },
      onTransportFailure: (info) => setTransportError(info.message),
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [active, intervalMs]);

  return {
    view,
    transportError,
    refresh: () => pollerRef.current?.refreshNow(),
  };
}
