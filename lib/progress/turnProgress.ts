/**
 * Honest turn-progress engine (pure — no React, no timers).
 *
 * The chat route streams real `ruke_stage` phase events (app/api/chat/route.ts)
 * and the parser surfaces them as StreamEvent.stage; useChat feeds every one
 * into a TurnProgressTracker here. Every percentage is DERIVED FROM REAL DATA:
 *   - pre-first-token phases: completion of actual server phases (real decision
 *     ms, real attachment block counts, real search-plan / page / passage
 *     counts from lib/web-search/pipeline.ts)
 *   - thinking: elapsed ÷ median of THIS user's stored reasoningMs
 *   - writing: streamed chars ÷ median of THIS user's stored completion tokens
 *     (mode-tuned default when history is empty)
 * Percents are monotonic and clamped to 95 until the turn actually finishes,
 * so the UI never over-promises. Nothing here ticks on a fake timer.
 */
import type { RendererMode } from "../decision/types";
import type { Message, StageEvent } from "../types";

export type ProgressStepStatus = "pending" | "active" | "done";

export interface ProgressStep {
  id: string;
  label: string;
  status: ProgressStepStatus;
  /** Live 0..100 (clamped 5..95 while active, 100 when done). */
  percent: number;
}

export interface ProgressOutput {
  label: string;
  kind: string;
}

export interface TurnProgressSnapshot {
  overall: number;
  /** "Step 3 of 5" while running; "Done" when finished. */
  chipLabel: string;
  steps: ProgressStep[];
  outputs: ProgressOutput[];
  state: "running" | "complete" | "error" | "aborted";
  startedAt: number;
}

export interface ProgressBaselines {
  /** Median prior reasoningMs (ms). Null = no history yet. */
  reasoningMs: number | null;
  /** Median prior completion tokens. Null = no history yet. */
  completionTokens: number | null;
}

/** Median over completed assistant turns — real per-user ETAs, learned from stored messages. */
export function computeBaselines(messages: Message[]): ProgressBaselines {
  const reason: number[] = [];
  const tokens: number[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || m.state !== "complete") continue;
    if (typeof m.reasoningMs === "number" && m.reasoningMs > 500) reason.push(m.reasoningMs);
    const ct = m.usage?.completionTokens;
    if (typeof ct === "number" && ct > 0) tokens.push(ct);
  }
  return { reasoningMs: median(reason), completionTokens: median(tokens) };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* ── real phase bands (fixed weights; counts subdivide them) ─────────────── */

const WEB_BAND: Record<string, { label: string; band: number }> = {
  "web:gate": { label: "Deciding whether a web search is needed", band: 10 },
  // Legacy alias — streams persisted before the 2026-10-23 LFM→gate rename
  // emitted "web:lfm"; it must keep mapping to the same band.
  "web:lfm": { label: "Deciding whether a web search is needed", band: 10 },
  "web:planning": { label: "Planning the search", band: 25 },
  "web:searching": { label: "Searching the web", band: 55 },
  "web:recovery": { label: "Searching more sources", band: 65 },
  "web:reading": { label: "Reading web sources", band: 80 },
  "web:reranking": { label: "Ranking the evidence", band: 92 },
  "web:gap-search": { label: "Searching for missing details", band: 96 },
  "web:done": { label: "Web evidence ready", band: 100 },
};

const MODE_LABEL: Record<RendererMode, string> = {
  excel: "Building your spreadsheet (XLSX)…",
  docs: "Drafting your document (DOCX)…",
  pdf: "Generating your PDF document…",
  ppt: "Building your presentation (PPTX)…",
  "3d_asset": "Building the 3D asset…",
  cad_blueprint: "Drafting the CAD blueprint…",
  chart: "Composing the chart…",
  html_render: "Rendering the HTML output…",
  standard_chat: "Writing the answer…",
};

const MODE_OUTPUT: Record<RendererMode, ProgressOutput | null> = {
  excel: { label: "Spreadsheet", kind: "XLSX" },
  docs: { label: "Document", kind: "DOCX" },
  pdf: { label: "PDF Document", kind: "PDF" },
  ppt: { label: "Presentation", kind: "PPTX" },
  "3d_asset": { label: "3D Model", kind: "3D" },
  cad_blueprint: { label: "CAD Blueprint", kind: "CAD" },
  chart: { label: "Chart", kind: "Chart" },
  html_render: { label: "HTML Page", kind: "HTML" },
  standard_chat: null,
};

/** Default expected output size when no token history exists yet (chars ≈ 4/token). */
const MODE_DEFAULT_CHARS: Record<RendererMode, number> = {
  excel: 4800,
  docs: 6000,
  pdf: 7200,
  ppt: 8800,
  "3d_asset": 10000,
  cad_blueprint: 10000,
  chart: 1200,
  html_render: 3600,
  standard_chat: 2400,
};

const WEBSEARCH_WEIGHT = 3;
const WRITING_WEIGHT = 3.5;
const THINKING_WEIGHT = 1.5;

interface StepState {
  id: string;
  label: string;
  status: ProgressStepStatus;
  percent: number;
  weight: number;
  /** monotonic floor — percents never walk backwards */
  floor: number;
  thinkingStartedAt?: number;
}

export class TurnProgressTracker {
  private steps: StepState[] = [];
  private outputs: ProgressOutput[] = [];
  private baselines: ProgressBaselines;
  private mode: RendererMode = "standard_chat";
  private webRan = false;
  private webSkipped = false;
  private contentChars = 0;
  private state: TurnProgressSnapshot["state"] = "running";
  /**
   * Monotonic floor for the OVERALL percent. Per-step percents are already
   * monotonic, but discovering a new phase adds weight at a low band — the
   * raw weighted average could dip (e.g. routing 60 → web search opens at
   * 10 → 33). A progress bar that walks backwards reads as broken data, so
   * the overall counter only ever rises until the turn actually finishes.
   */
  private overallFloor = 0;
  readonly startedAt = Date.now();

  constructor(baselines: ProgressBaselines) {
    this.baselines = baselines;
    this.addStep("routing", "Analyzing your request", 1, "active", 10);
  }

  /* ── server phase events (ruke_stage) ─────────────────────────────────── */

  noteStage(e: StageEvent): void {
    switch (e.stage) {
      case "decision_done":
        if (e.mode) this.mode = e.mode;
        this.bump("routing", 60);
        break;
      case "skill":
        this.bump("routing", 80);
        break;
      case "retrieval":
        this.done("routing");
        this.addStep("retrieval", "Reading your attached documents", 1, "active", 50);
        break;
      case "retrieval_done":
        this.done("retrieval");
        break;
      case "web_meta":
        break; // message metadata, handled by useChat — not a progress phase
      default:
        if (e.stage.startsWith("web:")) this.noteWeb(e);
    }
  }

  private noteWeb(e: StageEvent): void {
    if (e.stage === "web:skipped") {
      this.webSkipped = true;
      // Gate decided no search is needed: the step never honestly exists.
      this.remove("websearch");
      return;
    }
    const band = WEB_BAND[e.stage];
    if (!band) return;
    this.done("routing");
    this.webRan = true;
    let label = band.label;
    let percent = band.band;
    if (e.stage === "web:searching" && e.total) {
      label = `Searching the web — ${e.total} query pool(s)`;
    }
    if (e.stage === "web:reading") {
      if (e.total && typeof e.done === "number") {
        // Real per-page counts inside extractAll subdivide the 80..92 band.
        label = `Reading web sources — page ${e.done} of ${e.total}`;
        percent = Math.min(92, 80 + (e.done / Math.max(1, e.total)) * 12);
      } else if (e.total) {
        label = `Reading web sources — ${e.total} pages`;
      }
    }
    if (e.stage === "web:gap-search" && typeof e.coverage === "number") {
      label = `Searching for missing details (${Math.round(e.coverage * 100)}% covered)`;
    }
    this.addStep("websearch", label, WEBSEARCH_WEIGHT, "active", percent);
    if (e.stage === "web:done") this.done("websearch");
  }

  /* ── client-measured signals ──────────────────────────────────────────── */

  noteReasoningStart(): void {
    this.done("routing");
    this.addStep("thinking", "Thinking…", THINKING_WEIGHT, "active", 5);
    this.steps.find((s) => s.id === "thinking")!.thinkingStartedAt = Date.now();
  }

  noteReasoningEnd(): void {
    this.done("thinking");
  }

  /** Called on every content delta with the FULL accumulated length. */
  noteContent(charCount: number): void {
    this.contentChars = charCount;
    this.done("routing");
    this.done("thinking");
    if (this.webRan && !this.webSkipped) this.done("websearch");
    let label = MODE_LABEL[this.mode];
    if (this.webRan && this.mode === "standard_chat") label = "Writing the answer (from web sources)…";
    this.addStep("writing", label, WRITING_WEIGHT, "active", 5);
  }

  /** A mode fence just opened in the streamed content: a real output artifact. */
  openOutput(): void {
    const out = MODE_OUTPUT[this.mode];
    if (!out) return;
    if (!this.outputs.some((o) => o.kind === out.kind)) this.outputs.push(out);
  }

  setRepair(attempt: number, max: number): void {
    const pct = Math.min(95, Math.round(((attempt - 0.5) / Math.max(1, max)) * 100));
    this.addStep(
      "repair",
      `Auto-repairing the 3D/CAD model (round ${attempt} of ${max})`,
      1,
      "active",
      Math.max(5, pct),
    );
  }

  finish(state: "complete" | "error" | "aborted"): void {
    this.state = state;
    const now = Date.now();
    for (const s of this.steps) {
      if (s.status === "active") {
        // Only an actually-finished turn earns 100%; a stopped or failed turn
        // freezes at the honest last-measured percent.
        s.percent = state === "complete"
          ? 100
          : Math.max(s.floor, Math.min(95, this.livePercent(s, now)));
        s.status = "done";
      }
    }
  }

  /* ── snapshot ─────────────────────────────────────────────────────────── */

  snapshot(now: number): TurnProgressSnapshot {
    const steps: ProgressStep[] = this.steps.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      percent: this.livePercent(s, now),
    }));

    let wsum = 0;
    let wtot = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = this.steps[i];
      const pct = steps[i].percent;
      wsum += pct * s.weight;
      wtot += s.weight;
    }
    const computed = wtot > 0 ? Math.round(wsum / wtot) : 0;
    const overall = this.state === "complete"
      ? 100
      : Math.max(1, Math.min(99, Math.max(computed, this.overallFloor)));
    if (this.state !== "complete") this.overallFloor = Math.max(this.overallFloor, computed);

    const activeIdx = steps.findIndex((s) => s.status === "active");
    const doneIdx = steps.filter((s) => s.status === "done").length;
    const stepNo = activeIdx !== -1 ? activeIdx + 1 : Math.min(doneIdx + 1, steps.length);
    const chipLabel =
      this.state === "running"
        ? `Step ${stepNo} of ${steps.length}`
        : this.state === "complete"
          ? "Done"
          : this.state === "aborted"
            ? "Stopped"
            : "Failed";

    return {
      overall,
      chipLabel,
      steps,
      outputs: [...this.outputs],
      state: this.state,
      startedAt: this.startedAt,
    };
  }

  private livePercent(s: StepState, now: number): number {
    if (s.status !== "active") return s.percent;
    let pct = s.percent;
    if (s.id === "thinking" && s.thinkingStartedAt) {
      const eta = this.baselines.reasoningMs ?? 18_000; // median prior, else 18s
      pct = clampPct((now - s.thinkingStartedAt) / eta);
    }
    if (s.id === "writing") {
      const etaTokens = this.baselines.completionTokens;
      const etaChars = etaTokens ? etaTokens * 4 : MODE_DEFAULT_CHARS[this.mode];
      pct = clampPct(this.contentChars / Math.max(1, etaChars));
    }
    return Math.max(s.floor, Math.min(95, pct));
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private addStep(
    id: string,
    label: string,
    weight: number,
    status: ProgressStepStatus,
    percent: number,
  ): void {
    const ex = this.steps.find((s) => s.id === id);
    if (ex) {
      // Stage re-entries (e.g. per-page "reading") update label + floor only.
      if (ex.status !== "done") {
        ex.label = label;
        const p = Math.max(5, Math.min(95, percent));
        ex.percent = Math.max(ex.percent, p);
        ex.floor = ex.percent;
      }
      return;
    }
    const p = status === "active" ? Math.max(5, Math.min(95, percent)) : percent;
    this.steps.push({ id, label, status, weight, percent: p, floor: p });
  }

  private bump(id: string, percent: number): void {
    const s = this.steps.find((x) => x.id === id);
    if (!s || s.status === "done") return;
    s.percent = Math.max(s.percent, Math.min(95, percent));
    s.floor = s.percent;
  }

  private done(id: string): void {
    const s = this.steps.find((x) => x.id === id);
    if (s && s.status !== "pending") {
      s.status = "done";
      s.percent = 100;
    }
  }

  private remove(id: string): void {
    this.steps = this.steps.filter((s) => s.id !== id);
  }
}

/** Active-phase percentages never below 5% or above 95% — snap to 100 only on finish. */
function clampPct(ratio: number): number {
  return Math.max(5, Math.min(95, Math.round(ratio * 100)));
}
