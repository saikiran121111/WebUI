"use client";

import { RefreshCw, Server, ShieldAlert, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";
import { useCapabilityStatus } from "../hooks/useCapabilityStatus";
import {
  isTerminalStage,
  stageLabel,
  type BackendView,
  type CapabilityView,
  type WorkerView,
} from "../lib/progress/capabilityStatus";

/**
 * What the capability backend (the Python supervisor behind /api/ruke/ml-status) can
 * actually do on this machine, and what an owned helper process is doing right now.
 *
 * Nothing here is inferred:
 *  - a capability that needs a model nobody has downloaded says so, and says the human
 *    step that would change it;
 *  - a stage we do not recognise is printed raw and marked, never renamed into a
 *    plausible-sounding step;
 *  - there is no progress percentage and no estimated time, because the backend reports
 *    stages and counts, not a forecast - so any such number would be invented.
 */

function StageText({ stage, testid }: { stage: string; testid: string }) {
  if (!stage) return null;
  const labelled = stageLabel(stage);
  return (
    <span
      data-testid={testid}
      data-recognised={labelled.recognised ? "true" : "false"}
      className={cn("text-[10px]", labelled.recognised ? "text-white/55" : "text-amber-300/80")}
    >
      {labelled.label}
    </span>
  );
}

function WorkerRow({ worker }: { worker: WorkerView }) {
  const memory = worker.memoryMiB === null ? "memory not measured" : `${worker.memoryMiB} MiB`;
  const idle = worker.idleSeconds === null ? "idle unknown" : `idle ${worker.idleSeconds}s`;
  const inFlight = !!worker.currentStage && !isTerminalStage(worker.currentStage);
  return (
    <li
      data-testid={`ml-worker-${worker.capability}`}
      data-pid={worker.pid}
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-white/65"
    >
      <span className="text-white/85">{worker.capability}</span>
      <span data-testid={`ml-worker-memory-${worker.capability}`} className="text-white/40">
        {memory}
      </span>
      <span className="text-white/30">pid {worker.pid}</span>
      <span className="text-white/30">{idle}</span>
      {worker.heavy && <span className="text-white/30">heavy slot</span>}
      {worker.resident.length > 0 && (
        <span data-testid={`ml-worker-resident-${worker.capability}`} className="text-white/35">
          loaded: {worker.resident.join(", ")}
        </span>
      )}
      {inFlight ? (
        <StageText stage={worker.currentStage} testid={`ml-worker-stage-${worker.capability}`} />
      ) : (
        <span data-testid={`ml-worker-last-${worker.capability}`} className="text-white/35">
          last job: {stageLabel(worker.lastStage).label}
        </span>
      )}
      {worker.lastDetail && (
        <span data-testid={`ml-worker-detail-${worker.capability}`} className="text-red-300/70">
          {worker.lastDetail}
        </span>
      )}
    </li>
  );
}

function CapabilityRow({ capability }: { capability: CapabilityView }) {
  return (
    <li
      data-testid={`ml-capability-${capability.id}`}
      data-status={capability.status}
      className="flex flex-wrap items-baseline gap-x-2 text-[11px]"
    >
      <span className="text-white/85">{capability.label}</span>
      <span
        data-testid={`ml-capability-status-${capability.id}`}
        className={cn(
          capability.status === "available" ? "text-emerald-300/80"
            : capability.status === "unknown" ? "text-white/35"
              : "text-amber-300/75",
          "text-[10px] uppercase tracking-wider",
        )}
      >
        {capability.statusLabel}
      </span>
      {capability.builtin && (
        <span data-testid={`ml-capability-builtin-${capability.id}`} className="text-white/35">
          this repo's own code
        </span>
      )}
      {capability.detail && (
        <span data-testid={`ml-capability-detail-${capability.id}`} className="text-white/40">
          {capability.detail}
        </span>
      )}
      {capability.qualityNote && (
        <span data-testid={`ml-capability-quality-${capability.id}`} className="text-white/35">
          {capability.qualityNote}
        </span>
      )}
      {capability.humanStep && (
        <span data-testid={`ml-capability-step-${capability.id}`} className="text-white/45">
          {capability.humanStep}
        </span>
      )}
    </li>
  );
}

/** Exported separately so the rendering law is testable without a browser. */
export function CapabilityStatusView({
  view, error, onRefresh,
}: {
  view: BackendView | null;
  error: string | null;
  onRefresh: () => void;
}) {
  if (!view) {
    return (
      <div className="p-3 text-[11px] text-white/45" data-testid="ml-status-loading">
        Reading the capability backend status...
      </div>
    );
  }

  const supervisor = view.supervisor;
  return (
    <div className="p-3 space-y-3 max-h-80 overflow-y-auto" data-testid="ml-status-panel"
      data-state={view.state}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
          <Server className="w-3 h-3" />
          Capability backend
        </span>
        <button
          onClick={onRefresh}
          data-testid="ml-status-refresh"
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/40 hover:text-white/80"
        >
          <RefreshCw className="w-3 h-3" />
          Re-read
        </button>
      </div>

      <div data-testid="ml-status-state" className="text-[11px] text-white/80">
        {view.stateLabel}
        {view.endpoint && <span className="text-white/35"> - {view.endpoint}</span>}
      </div>

      {view.state !== "live" && (
        <div data-testid="ml-status-blocked" className="space-y-1 rounded-lg bg-white/[0.03] p-2">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-300/75">
            <ShieldAlert className="w-3 h-3" />
            {view.reason || "state unavailable"}
          </span>
          {view.detail && <div className="text-[11px] text-white/50">{view.detail}</div>}
          {view.humanStep && <div className="text-[11px] text-white/65">{view.humanStep}</div>}
        </div>
      )}

      {error && (
        <div data-testid="ml-status-transport-error" className="text-[11px] text-red-300/80">
          status request failed: {error}
        </div>
      )}

      {supervisor && (
        <div className="space-y-1">
          <div className="text-[10px] text-white/35 uppercase tracking-wider">Owned helper processes</div>
          <div data-testid="ml-supervisor-summary" className="text-[11px] text-white/55">
            {`state ${supervisor.state || "unknown"}`}
            {supervisor.uptimeSeconds !== null && ` - up ${Math.round(supervisor.uptimeSeconds)}s`}
            {supervisor.activeJobs !== null && ` - active jobs ${supervisor.activeJobs}`}
            {supervisor.heavyImportsAtStartup === false && " - no heavy framework imported at startup"}
            {supervisor.heavyImportsAtStartup === true && " - a heavy framework was imported at startup"}
            {supervisor.heavyImportsAtStartup === null && " - startup import state not reported"}
          </div>
          {supervisor.workers.length === 0 ? (
            <div data-testid="ml-supervisor-idle" className="text-[11px] text-white/40">
              No helper process is alive: heavy models are loaded per job and released when idle.
            </div>
          ) : (
            <ul className="space-y-1">
              {supervisor.workers.map((w) => <WorkerRow key={`${w.capability}-${w.pid}`} worker={w} />)}
            </ul>
          )}
        </div>
      )}

      <div className="space-y-1">
        <span className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
          <Sparkles className="w-3 h-3" />
          Capabilities
        </span>
        {view.capabilities.length === 0 ? (
          <div data-testid="ml-capabilities-empty" className="text-[11px] text-white/40">
            The backend reported no capability table, so nothing is claimed.
          </div>
        ) : (
          <ul className="space-y-1">
            {view.capabilities.map((c) => <CapabilityRow key={c.id} capability={c} />)}
          </ul>
        )}
      </div>

      {view.familyNotes.filter((n) => n.humanStep).length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-white/35 uppercase tracking-wider">What a human must do</div>
          <ul className="space-y-1">
            {view.familyNotes.filter((n) => n.humanStep).map((n) => (
              <li key={n.id} data-testid={`ml-human-step-${n.id}`} className="text-[11px] text-white/55">
                {n.id}: {n.humanStep}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function CapabilityStatusPanel({ active }: { active: boolean }) {
  const { view, transportError, refresh } = useCapabilityStatus(active);
  return <CapabilityStatusView view={view} error={transportError} onRefresh={refresh} />;
}
