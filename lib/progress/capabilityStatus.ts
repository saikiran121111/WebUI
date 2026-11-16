/**
 * Honest status for the capability backend (the Python supervisor behind
 * GET /api/ruke/ml-status) and for the heavy jobs it runs.
 *
 * Pure: no React, no timers, no invented numbers. The rules below are the point
 * of this module and are under test in __tests__/progress/capability-status.test.ts:
 *
 *  1. A stage name becomes a human label only through a DECLARED vocabulary. An
 *     unrecognised stage is shown as itself and flagged, never renamed into a
 *     plausible-sounding step.
 *  2. NO progress percentage and NO completion time is produced here. The backend
 *     reports stages and real counts, not a completion forecast, so any percent or
 *     ETA would be an invented number.
 *  3. Job stages come from what the owned worker actually reported (see report() in
 *     python-backend/ruke_ml/models/lifecycle.py). A worker the backend did not report
 *     is not rendered, and an unmeasured memory value stays null instead of becoming 0.
 *  4. A status the backend did not actually send is reported as "unknown", which
 *     renders as "state unavailable" rather than as a reassuring default.
 */

export const ML_STATUS_ENDPOINT = "/api/ruke/ml-status";

/* ---------------------------------------------------------------- vocabulary */

/** Capability ids exactly as the contract declares them (ruke_ml.contracts). */
export const CAPABILITY_IDS: readonly string[] = [
  "embeddings", "rerank",
  "documents.parse", "documents.ocr",
  "speech.asr", "speech.align", "speech.diarize",
  "video.scenes", "video.observations", "video.timeline", "video.search_hints",
  "artifacts.xlsx", "artifacts.docx", "artifacts.pptx",
];

const CAPABILITY_LABEL: Record<string, string> = {
  embeddings: "Embeddings",
  rerank: "Reranking",
  "documents.parse": "Document parsing",
  "documents.ocr": "OCR",
  "speech.asr": "Speech to text",
  "speech.align": "Word-level timing",
  "speech.diarize": "Speaker separation",
  "video.scenes": "Video sampling plan",
  "video.observations": "Video observations",
  "video.timeline": "Video timeline",
  "video.search_hints": "Search hints from media",
  "artifacts.xlsx": "Spreadsheet writer",
  "artifacts.docx": "Document writer",
  "artifacts.pptx": "Presentation writer",
};

export function capabilityLabel(id: string): string {
  return CAPABILITY_LABEL[id] ?? id;
}

/** Heavy-job stages the backend really emits. The order is documentation only: a
 *  job is never assumed to pass through every one of them.
 *
 *  This list MUST equal PROGRESS_STATES in python-backend/ruke_ml/contracts.py: the
 *  cross-language test in __tests__/progress/capability-status.test.ts reads that file
 *  and fails on drift. A label invented here for a stage the backend never sends (or a
 *  stage it does send that we do not know) is exactly how a status panel ends up
 *  describing work that is not happening. Chat "thinking" is deliberately NOT here -
 *  turn thinking belongs to lib/progress/turnProgress.ts, not to a capability job. */
export const JOB_STAGES = [
  "queued", "preparing", "download_required", "extracting", "ocr", "transcribing",
  "indexing", "retrieving", "analysing", "writing", "ready", "failed", "cancelled",
] as const;
export type JobStage = (typeof JOB_STAGES)[number];

const JOB_STAGE_LABEL: Record<JobStage, string> = {
  queued: "Queued - waiting for the single heavy slot",
  preparing: "Preparing",
  download_required: "Download required - not started automatically",
  extracting: "Extracting",
  ocr: "Reading text from images",
  transcribing: "Transcribing audio",
  indexing: "Indexing",
  retrieving: "Retrieving evidence",
  analysing: "Analysing",
  writing: "Writing",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TERMINAL_STAGES: ReadonlySet<string> = new Set(["ready", "failed", "cancelled"]);

export function isTerminalStage(stage: string): boolean {
  return TERMINAL_STAGES.has(stage);
}

export interface StageLabel {
  label: string;
  /** false = the backend sent a stage this build does not know, so the raw token
   *  is displayed: the gap stays visible instead of being papered over. */
  recognised: boolean;
}

export function stageLabel(stage: string): StageLabel {
  const known = (JOB_STAGES as readonly string[]).includes(stage);
  return known
    ? { label: JOB_STAGE_LABEL[stage as JobStage], recognised: true }
    : { label: stage, recognised: false };
}

/* ------------------------------------------------------------- status view */

export type CapabilityStatus =
  | "available"
  | "evaluation_required"
  | "not_installed"
  | "not_configured"
  | "license_acceptance_required"
  | "not_supported_by_host"
  | "unknown";

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "available", "evaluation_required", "not_installed", "not_configured",
  "license_acceptance_required", "not_supported_by_host",
]);

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  available: "Available",
  evaluation_required: "Needs a quality gate first",
  not_installed: "Not installed",
  not_configured: "Not configured",
  license_acceptance_required: "Licence acceptance required",
  not_supported_by_host: "Not supported on this machine",
  unknown: "State unavailable",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[(KNOWN_STATUSES.has(status) ? status : "unknown") as CapabilityStatus];
}

export type BackendState = "live" | "unreachable" | "not_configured" | "invalid_endpoint" | "unknown";

const BACKEND_STATE_LABEL: Record<BackendState, string> = {
  live: "Capability backend running",
  unreachable: "Capability backend not answering",
  not_configured: "Capability backend not started",
  invalid_endpoint: "Capability backend endpoint is invalid",
  unknown: "Capability backend state unknown",
};

export function backendStateLabel(state: BackendState): string {
  return BACKEND_STATE_LABEL[state];
}

export interface ModelEntryView {
  id: string;
  revision: string;
  status: CapabilityStatus;
  builtin: boolean;
  heavy: boolean;
  /** Measured load-time peak in MiB, or null when it has never been measured on
   *  this host. A guessed model size would be a false claim. */
  peakMiB: number | null;
  /** What the provider claims, kept verbatim so it is never paraphrased into a
   *  quality statement this host has not measured. */
  coverageClaim: string;
}

export interface CapabilityView {
  id: string;
  label: string;
  status: CapabilityStatus;
  statusLabel: string;
  detail: string;
  humanStep: string;
  /** true when this repository implements the capability itself instead of
   *  loading a third-party model package - which changes what "Available" means. */
  builtin: boolean;
  /** Shown next to "Available" when the thing that runs is not model quality. */
  qualityNote: string;
  models: ModelEntryView[];
}

/** One owned heavy/light helper the supervisor is keeping alive right now. */
export interface WorkerView {
  capability: string;
  pid: number;
  /** Process creation time as reported by the backend - the identity proof against
   *  PID reuse. Rendered as a raw value, never prettified into a fake clock time. */
  created: number;
  idleSeconds: number | null;
  heavy: boolean;
  /** Model weights this process has actually loaded (proven, not expected). */
  resident: string[];
  /** Measured working set in MiB, or null when the host could not measure it. */
  memoryMiB: number | null;
  peakMemoryMiB: number | null;
  /** Newest progress frame the worker sent, "" when it has sent none. */
  currentStage: string;
  currentNote: string;
  /** Terminal state of the last job this worker finished (ready/failed/cancelled). */
  lastStage: string;
  lastDetail: string;
  /** How many progress frames the pool actually captured for this worker. */
  progressFrames: number;
}

export interface SupervisorView {
  state: string;
  activeJobs: number | null;
  heavyWorkerRunning: string | null;
  uptimeSeconds: number | null;
  /** The design promise is that a fresh supervisor imports no heavy ML framework.
   *  This is what the backend actually observed, not what we expect: null = unknown. */
  heavyImportsAtStartup: boolean | null;
  workers: WorkerView[];
}

export interface FamilyNote {
  id: string;
  status: CapabilityStatus;
  humanStep: string;
}

export interface BackendView {
  state: BackendState;
  stateLabel: string;
  reason: string;
  detail: string;
  humanStep: string;
  endpoint: string;
  supervisor: SupervisorView | null;
  capabilities: CapabilityView[];
  /** Per-family answers the backend sends beside the capability table (speech,
   *  ocr, ...); they carry the human step for a gated capability. */
  familyNotes: FamilyNote[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStatus(value: unknown): CapabilityStatus {
  const s = str(value);
  return KNOWN_STATUSES.has(s) ? (s as CapabilityStatus) : "unknown";
}

function modelEntries(raw: unknown): ModelEntryView[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelEntryView[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const claims = asRecord(rec.claims);
    out.push({
      id: str(rec.id),
      revision: str(rec.revision),
      status: toStatus(rec.status),
      builtin: rec.builtin === true,
      heavy: rec.heavy === true,
      peakMiB: typeof rec.est_peak_mib === "number" && rec.est_peak_mib > 0 ? rec.est_peak_mib : null,
      coverageClaim: str(claims?.coverage),
    });
  }
  return out;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Owned helper processes, exactly as the supervisor reported them. The backend sends an
 * OBJECT keyed by capability (`{"rerank": {...}}`), so the key is the capability and the
 * row's `capability` field is a consistency check, never a guess. A row the backend did
 * not report stays unrendered instead of being filled with zeros.
 */
function workersFrom(sup: Record<string, unknown>): WorkerView[] {
  const rows = asRecord(sup.workers);
  if (!rows) return [];
  const out: WorkerView[] = [];
  for (const [capability, value] of Object.entries(rows)) {
    const rec = asRecord(value);
    if (!rec) continue;
    const pid = numOrNull(rec.pid);
    const mem = asRecord(rec.memory);
    const available = mem?.available === 1;
    out.push({
      capability: str(rec.capability) || capability,
      pid: pid ?? 0,
      created: numOrNull(rec.created) ?? 0,
      idleSeconds: numOrNull(rec.idle_s),
      heavy: rec.heavy === true,
      resident: Array.isArray(rec.resident) ? rec.resident.filter((r): r is string => typeof r === "string") : [],
      memoryMiB: available ? numOrNull(mem?.working_set_mib) : null,
      peakMemoryMiB: available ? numOrNull(mem?.peak_working_set_mib) : null,
      currentStage: str(rec.current_stage),
      currentNote: str(rec.current_note),
      lastStage: str(rec.last_state),
      lastDetail: str(rec.last_detail),
      progressFrames: numOrNull(rec.progress_seq) ?? 0,
    });
  }
  out.sort((a, b) => a.capability.localeCompare(b.capability) || a.pid - b.pid);
  return out;
}

function supervisorFrom(sup: Record<string, unknown>): SupervisorView {
  const heavyRaw = sup.heavy_worker_running;
  return {
    state: str(sup.state),
    activeJobs: numOrNull(sup.active_jobs),
    heavyWorkerRunning: typeof heavyRaw === "string" ? heavyRaw : (heavyRaw ? "yes" : null),
    uptimeSeconds: numOrNull(sup.uptime_s),
    heavyImportsAtStartup: boolOrNull(sup.heavy_imports_at_startup),
    workers: workersFrom(sup),
  };
}

/**
 * A bare "Available" for a builtin lexical adapter would over-claim, so the note that
 * qualifies it is the registry's OWN wording (the model entry's coverage claim), never a
 * sentence written here. If the registry states no claim, there is no note: the panel
 * then shows the registry's `detail` line instead, which is the other half of the same
 * honest record. Paraphrasing a provider claim into softer words is how "hashed lexical
 * term weights" quietly becomes "model quality".
 */
function qualityNoteFor(models: ModelEntryView[]): string {
  return models.find((m) => m.coverageClaim)?.coverageClaim ?? "";
}

function viewsFromTable(table: Record<string, unknown>): { caps: CapabilityView[]; notes: FamilyNote[] } {
  const caps: CapabilityView[] = [];
  const notes: FamilyNote[] = [];
  for (const [id, value] of Object.entries(table)) {
    const rec = asRecord(value);
    if (!rec) continue;   // a stray scalar is not a status answer; skip it
    const models = modelEntries(rec.models);
    const status = toStatus(rec.status);
    const detail = str(rec.detail);
    const humanStep = str(rec.human_step);
    caps.push({
      id,
      label: capabilityLabel(id),
      status,
      statusLabel: statusLabel(status),
      detail,
      humanStep,
      builtin: status === "available" && models.some((m) => m.builtin),
      qualityNote: qualityNoteFor(models),
      models,
    });
    if (humanStep) notes.push({ id, status, humanStep });
  }
  caps.sort((a, b) => {
    const ai = CAPABILITY_IDS.indexOf(a.id);
    const bi = CAPABILITY_IDS.indexOf(b.id);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.id.localeCompare(b.id);
  });
  return { caps, notes };
}

/**
 * Turn whatever /api/ruke/ml-status returned into something renderable.
 *
 * Accepts BOTH the flat capability map the Rust endpoint publishes and the
 * supervisor's own envelope, where the map sits one level down under
 * "capabilities". The nested shape is exactly the defect this round fixed (a
 * status table no consumer could read); tolerating it here is a safety net for an
 * older server, not the fix. The fix is split_capabilities() in
 * rust-backend/crates/ruke-server/src/ml_bridge.rs.
 */
export function interpretMlStatus(raw: unknown): BackendView {
  const body = asRecord(raw);
  if (!body) {
    return {
      state: "unknown", stateLabel: backendStateLabel("unknown"), reason: "malformed_response",
      detail: "the status endpoint returned a non-object body", humanStep: "", endpoint: "",
      supervisor: null, capabilities: [], familyNotes: [],
    };
  }
  const configured = body.configured === true;
  const reason = str(body.reason);
  let state: BackendState;
  if (body.live === true) state = "live";
  else if (reason === "not_configured") state = "not_configured";
  else if (reason === "invalid_endpoint") state = "invalid_endpoint";
  else if (reason === "unreachable" || configured) state = "unreachable";
  else state = "unknown";

  const envelope = asRecord(body.capabilities);
  const nested = envelope ? asRecord(envelope.capabilities) : null;
  const table = nested ?? envelope;
  const { caps, notes } = table ? viewsFromTable(table) : { caps: [], notes: [] };

  const details = asRecord(body.capability_details);
  const familyNotes = [...notes];
  if (nested && envelope) {
    // An older server put the per-family answers in the same envelope.
    for (const [id, value] of Object.entries(envelope)) {
      if (id === "capabilities") continue;
      const rec = asRecord(value);
      if (rec && str(rec.human_step)) familyNotes.push({ id, status: toStatus(rec.status), humanStep: str(rec.human_step) });
    }
  }
  if (details) {
    for (const [id, value] of Object.entries(details)) {
      const rec = asRecord(value);
      if (!rec) continue;
      familyNotes.push({ id, status: toStatus(rec.status), humanStep: str(rec.human_step) });
    }
  }

  const sup = asRecord(body.supervisor);
  return {
    state,
    stateLabel: backendStateLabel(state),
    reason,
    detail: str(body.detail),
    humanStep: str(body.human_step),
    endpoint: str(body.endpoint),
    supervisor: sup ? supervisorFrom(sup) : null,
    capabilities: caps,
    familyNotes,
  };
}
