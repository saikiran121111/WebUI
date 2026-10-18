"use client";
/**
 * Robot mascot progress surfaces:
 *  - GenerationStatus: the in-bubble stage line shown while a chat reply is
 *    waiting for its first token — "Analysing the prompt…" with a
 *    self-calibrated % (prefill), then "Thinking… (12s)" with an
 *    indeterminate shimmer. Replaces the old three-dot wait.
 *  - useBuildProgress + RobotToast: the floating bottom-right toast for slow
 *    document/export builds (no server progress channel) — the robot welds
 *    while a staged ramp climbs, snaps to 100% + celebrates on success, and
 *    lingers with an error face on failure.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import Mascot from "./Mascot";
import { usePrefillProgress } from "../../hooks/usePrefillProgress";
import { BUILD_COMPLETE_PCT, stagedPctAt, stageLabelFor } from "../../lib/ui/stagedProgress";
import type { ChatPhase } from "../../lib/types";

export function GenerationStatus({
  phase,
  startedAt,
  estTokens,
}: {
  phase: ChatPhase;
  startedAt: number;
  estTokens: number | null;
}) {
  const pct = usePrefillProgress(phase === "prefill", estTokens, startedAt);
  const [elapsedS, setElapsedS] = useState(0);

  useEffect(() => {
    if (phase !== "thinking") return;
    const t0 = Date.now();
    setElapsedS(0);
    const id = setInterval(() => setElapsedS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  if (phase !== "prefill" && phase !== "thinking") return null;

  const label = phase === "prefill"
    ? "Analysing the prompt…"
    : elapsedS > 0 ? `Thinking… (${elapsedS}s)` : "Thinking…";
  const indeterminate = phase === "thinking" || pct == null;

  return (
    <div className="gen-status" data-testid="generation-status" role="status" aria-live="polite">
      <Mascot size={26} state="thinking" />
      <div className="gen-status-text">
        <span className="gen-status-label">{label}</span>
        <span className="gen-status-bar">
          <span
            className={"gen-status-fill" + (indeterminate ? " gen-status-fill--indet" : "")}
            style={!indeterminate ? { width: `${pct}%` } : undefined}
          />
        </span>
      </div>
      {phase === "prefill" && pct != null && <span className="gen-status-pct">{pct}%</span>}
    </div>
  );
}

interface BuildState {
  open: boolean;
  pct: number;
  status: "running" | "done" | "error";
  error?: string;
}

export interface BuildProgress {
  start: () => void;
  succeed: () => void;
  fail: (message: string) => void;
  dismiss: () => void;
  toast: ReactNode;
}

/** Drives one RobotToast for a single slow build (document download, export). */
export function useBuildProgress(title: string): BuildProgress {
  const [build, setBuild] = useState<BuildState>({ open: false, pct: 0, status: "running" });
  const startRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (closeRef.current) { clearTimeout(closeRef.current); closeRef.current = null; }
  }, []);

  const start = useCallback(() => {
    clearTimers();
    startRef.current = Date.now();
    setBuild({ open: true, pct: 0, status: "running", error: undefined });
    timerRef.current = setInterval(() => {
      setBuild((s) => (s.status === "running" ? { ...s, pct: Math.round(stagedPctAt(Date.now() - startRef.current)) } : s));
    }, 120);
  }, [clearTimers]);

  const succeed = useCallback(() => {
    clearTimers();
    setBuild((s) => ({ ...s, open: true, pct: BUILD_COMPLETE_PCT, status: "done", error: undefined }));
    closeRef.current = setTimeout(() => setBuild((s) => ({ ...s, open: false })), 1400);
  }, [clearTimers]);

  const fail = useCallback((message: string) => {
    clearTimers();
    setBuild((s) => ({ ...s, open: true, status: "error", error: message }));
  }, [clearTimers]);

  const dismiss = useCallback(() => {
    clearTimers();
    setBuild((s) => ({ ...s, open: false }));
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const toast = (
    <RobotToast
      title={title}
      open={build.open}
      pct={build.pct}
      status={build.status}
      error={build.error}
      onClose={dismiss}
    />
  );
  return { start, succeed, fail, dismiss, toast };
}

function RobotToast({
  title, open, pct, status, error, onClose,
}: {
  title: string;
  open: boolean;
  pct: number;
  status: "running" | "done" | "error";
  error?: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return null;

  const titleText = status === "error" ? `${title} failed` : status === "done" ? `${title} ready` : title;
  const stageText = status === "error"
    ? (error ?? "Generation failed")
    : status === "done"
      ? "Saved to your downloads."
      : stageLabelFor(pct);
  const mascotState = status === "done" ? "done" : status === "error" ? "error" : "working";

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="robot-toast"
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className={
            "robot-toast" +
            (status === "done" ? " robot-toast--done" : "") +
            (status === "error" ? " robot-toast--error" : "")
          }
          data-testid="robot-toast"
          role="status"
          aria-live="polite"
        >
          <Mascot size={44} state={mascotState} />
          <div className="robot-toast-body">
            <div className="robot-toast-title">{titleText}</div>
            <div className="robot-toast-stage">{stageText}</div>
            <div className="robot-toast-track">
              <div
                className={"robot-toast-fill" + (status === "error" ? " robot-toast-fill--error" : "")}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <span className="robot-toast-pct">{pct}%</span>
          <button type="button" className="robot-toast-close" onClick={onClose} aria-label="Dismiss progress">
            <X size={13} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
