"use client";
/**
 * Claude-desktop-style turn progress: a white pill chip in the top bar
 * ("Step 4 of 6") that opens a Progress panel — vertical timeline (dim done
 * steps, bright current step with live %, pending steps), "K earlier steps"
 * collapse, and an Outputs section naming real artifacts (Presentation /
 * PPTX …). Every number comes from lib/progress/turnProgress.ts: real phase
 * counts and measured ETAs, never a fake spinner.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X, PanelLeft, FileText, Sheet, Presentation, Boxes, BarChart3, Code2, Ruler,
} from "lucide-react";
import type { ProgressOutput, TurnProgressSnapshot } from "../lib/progress/turnProgress";
import { cn } from "../lib/utils";

const OUTPUT_ICON: Record<string, typeof FileText> = {
  XLSX: Sheet,
  DOCX: FileText,
  PDF: FileText,
  PPTX: Presentation,
  "3D": Boxes,
  CAD: Ruler,
  Chart: BarChart3,
  HTML: Code2,
};

const MAX_VISIBLE_STEPS = 7;

export default function ProgressChip({
  progress,
  onDismiss,
}: {
  progress: TurnProgressSnapshot | null;
  onDismiss: () => void;
}) {
  // Opens ONLY on chip click (like the reference desktop app): an auto-opened
  // 300px z-50 popup under the top bar would cover the chat controls that sit
  // at the top-right of a fresh thread — the "just sent" user bubble's Edit
  // button in particular (regression caught by tests/edit-stop-collapse).
  const [open, setOpen] = useState(false);

  if (!progress) return null;

  const dismissable = progress.state !== "running";

  const closePanel = () => {
    setOpen(false);
    if (dismissable) onDismiss();
  };

  const collapsed = Math.max(0, progress.steps.length - MAX_VISIBLE_STEPS);
  const visible = collapsed > 0 ? progress.steps.slice(-MAX_VISIBLE_STEPS) : progress.steps;

  return (
    <div className="relative">
      {/* ── Chip (white treatment per the user's deviation) ───────────── */}
      <button
        data-testid="progress-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Turn progress: ${progress.chipLabel}`}
        onClick={() => setOpen(o => !o)}
        className={cn(
          "h-7 px-2.5 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5",
          "border border-[rgba(255,255,255,0.55)] text-white bg-white/[0.04]",
          "hover:bg-white/[0.08] transition-colors duration-[120ms]",
        )}
      >
        <span className="tabular-nums">{progress.chipLabel}</span>
        <PanelLeft className="w-3.5 h-3.5 opacity-70" />
      </button>

      {/* ── Panel ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="progress-panel"
            role="dialog"
            aria-label="Progress"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute right-0 top-[calc(100%+8px)] w-[300px] z-50
              surface-glass rounded-xl border border-[var(--border)] p-3"
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            {/* Header */}
            <div className="flex items-center mb-2">
              <span className="text-[15px] font-semibold text-white">Progress</span>
              <button
                onClick={closePanel}
                aria-label="Close progress"
                title="Close"
                className="ml-auto w-6 h-6 rounded-md flex items-center justify-center
                  text-white/35 hover:text-white/80 hover:bg-white/[0.06]
                  transition-colors duration-[120ms]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Overall bar */}
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 h-[3px] rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-[400ms] ease-out"
                  style={{ width: `${progress.overall}%` }}
                />
              </div>
              <span className="text-[11.5px] tabular-nums text-white/50 w-8 text-right">
                {progress.overall}%
              </span>
            </div>

            {/* Timeline */}
            <div className="relative flex flex-col">
              <span
                aria-hidden
                className="absolute left-[6.5px] top-2 bottom-2 w-px bg-white/10"
              />
              {collapsed > 0 && (
                <div className="flex items-center h-6 text-[12px] text-white/35 pl-[22px]">
                  {collapsed} earlier step{collapsed === 1 ? "" : "s"}
                </div>
              )}
              {visible.map((s) => (
                <div key={s.id} className="flex items-center gap-2 min-h-[26px]">
                  <span className="relative z-[1] flex w-[14px] justify-center">
                    {s.status === "active" ? (
                      <span className="w-2 h-2 rounded-full bg-white ring-[3px] ring-white/10" />
                    ) : s.status === "done" ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-white/35" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-white/15" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-[13.5px] leading-tight",
                      s.status === "done" && "text-white/45",
                      s.status === "active" && "text-white",
                      s.status === "pending" && "text-white/75",
                    )}
                  >
                    {s.label}
                  </span>
                  {s.status === "active" && (
                    <span className="ml-auto text-[11.5px] tabular-nums text-white/55">
                      {s.percent}%
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Outputs (only once a real artifact has opened in the stream) */}
            {progress.outputs.length > 0 && (
              <div className="border-t border-[var(--border)] mt-3 pt-2.5">
                <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5">
                  Outputs
                </div>
                {progress.outputs.map((o) => (
                  <OutputRow key={o.kind} output={o} />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function OutputRow({ output }: { output: ProgressOutput }) {
  const Icon = OUTPUT_ICON[output.kind] ?? FileText;
  return (
    <div className="flex items-center gap-2 min-h-[24px]">
      <Icon className="w-3.5 h-3.5 text-white/55 flex-shrink-0" />
      <span className="text-[13px] text-white/80">{output.label}</span>
      <span className="ml-auto text-[11px] text-white/40">{output.kind}</span>
    </div>
  );
}
