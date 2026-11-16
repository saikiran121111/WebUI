"use client";
import { useEffect, useRef, useState } from "react";
import type { Message } from "../lib/types";
import {
  resolveCurrentActivity,
  statusLine,
  activityLine,
  sourcesHeader,
  openActivities,
} from "../lib/progress/currentActivity";

/**
 * RUKE-branded processing line shown while a reply streams. Streaming
 * reliability law (2026-11-12): every verb is derived from an EVENT on the
 * message — never from a timer or a fake verb:
 *
 *   - web:activity frames → the message's activity list names the REAL
 *     in-flight action (searching / reading <host>…) and, once done, its
 *     real counts. The old elapsed-seconds guess cascade is retired:
 *     time passing is not a signal of what the system is doing.
 *   - webCitations / searchGate meta → sources the loop actually minted. They
 *     make the line CLICKABLE and populate the popup trail (queries, source
 *     links, this turn's action trail), but they are EVIDENCE HISTORY: they
 *     never decide what the line claims the system is doing right now
 *     (F18, 2026-11-15). 2026-10-22: the cyan gradient ResearchTrailCard bar
 *     was removed; this popup replaces it — click outside closes.
 *   - toolCalls still open (research mode) → names the live tool call.
 *   - reasoning deltas arriving → "Thinking…" (delta presence is the
 *     signal; the seconds counter is gone).
 *   - nothing yet → the honest "Analyzing your prompt…".
 *
 * F18 (2026-11-15): the priority cascade lives in ONE pure, unit-tested
 * authority (lib/progress/currentActivity). Current work comes only from
 * something actually in flight; a minted citation or a COMPLETED action can no
 * longer display as "Reading web sources" / "Page read complete" while the
 * model is thinking or writing. Completed actions stay in the popup trail.
 *
 * Playwright contract: clickable line `web-search-toggle`; popup
 * `research-trail-card`, its badge `research-trail-gate-badge`, source rows
 * `research-trail-source` (search-gate.spec + greeting.spec guard).
 */

/** Which authority decided for this turn → the badge the user sees. */
const GATE_BADGE: Record<string, string> = {
  deterministic: "Auto-gated",
  "main-model": "Model-gated",
  lfm: "Search-gated", // historical source key — persisted turns still carry it
  rules: "Rule-gated",
};

export default function ProcessingStatus({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rowRef.current?.contains(t) && !popupRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const gate = message.searchGate ?? message.researchLfm;
  const entries = Object.values(message.webCitations ?? {})
    .filter(c => !!c && typeof c.url === "string")
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId, undefined, { numeric: true }));
  // F18: this component renders the line; it does NOT decide the priority.
  // resolveCurrentActivity is the single authority (unit-pinned in
  // __tests__/progress/current-activity.test.ts): only an action or tool call
  // actually in flight, else writing/thinking, else the between-round wait.
  // Citations and completed actions never appear here — see the module law.
  const acts = message.webActivity ?? [];
  const readingLive = openActivities(acts).some(a => a.kind === "read_page");
  const text = statusLine(resolveCurrentActivity({
    activity: acts,
    toolCalls: message.toolCalls,
    hasReasoning: !!message.reasoning,
    hasContent: !!message.content,
  }));

  const logo = (
    <svg
      className="processing-logo"
      width="16" height="16" viewBox="0 0 120 120"
      fill="none" aria-hidden
    >
      <rect x="10" y="10" width="100" height="100" rx="26"
        stroke="currentColor" strokeWidth="8" />
      <g className="processing-logo-mark" fill="currentColor">
        <path d="M 79 37 C 72 33, 63 31, 55 33 C 41 36, 37 46, 39 53 C 41 61, 52 63, 61 60 L 61 45 C 54 48, 48 47, 48.5 43.5 C 49 40, 56 38.5, 65 39.5 C 71 40.3, 76 42.5, 79 45.5 L 79 37 Z" />
        <path d="M 41 83 C 48 87, 57 89, 65 87 C 79 84, 83 74, 81 67 C 79 59, 68 57, 59 60 L 59 75 C 66 72, 72 73, 71.5 76.5 C 71 80, 64 81.5, 55 80.5 C 49 79.7, 44 77.5, 41 74.5 L 41 83 Z" />
      </g>
    </svg>
  );

  return (
    <div
      data-testid="processing-status"
      aria-label="Generating"
      className="relative flex items-start gap-2.5 py-4"
    >
      {entries.length > 0 ? (
        <button
          ref={rowRef} data-testid="web-search-toggle"
          onClick={() => setOpen(v => !v)}
          aria-haspopup="dialog" aria-expanded={open} title="See which sites are being read"
          className="group/websearch flex items-center gap-2.5 text-left cursor-pointer"
        >
          {logo}
          <span className="text-[13px] text-[var(--muted)] leading-none
            underline decoration-white/15 underline-offset-2
            group-hover/websearch:decoration-white/40 transition-colors duration-[120ms]">
            {text}
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-2.5">
          {logo}
          <span className="text-[13px] text-[var(--muted)] leading-none">{text}</span>
        </div>
      )}

      {open && entries.length > 0 && (
        <div
          ref={popupRef} data-testid="research-trail-card"
          role="dialog" aria-label="Web sources"
          className="absolute left-0 top-full z-50 mt-1 p-1.5 rounded-lg
            w-[min(460px,calc(100vw-3rem))] max-h-[280px] overflow-y-auto
            bg-[var(--bg-surface)] border border-[var(--border-strong)]
            shadow-xl shadow-black/50
            animate-in fade-in slide-in-from-top-1
            duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        >
          <div className="flex items-center gap-2 px-1.5 py-1">
            <span className="text-[11px] font-medium text-white/60">
              {sourcesHeader(entries.length, readingLive)}
            </span>
            {gate && (
              <span
                data-testid="research-trail-gate-badge"
                className="ml-auto text-[10px] px-1.5 py-0.5 rounded
                  bg-white/[0.07] text-white/55 font-medium"
              >
                {GATE_BADGE[gate.decidedBy ?? "main-model"] ?? "Gated"}
              </span>
            )}
          </div>

          {gate && gate.queries.length > 0 && (
            <div className="px-1.5 py-1 border-t border-white/[0.05] space-y-0.5">
              {gate.queries.map((q, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px]">
                  <span className="text-white/25 font-mono flex-shrink-0 mt-px">Q{i + 1}</span>
                  <span className="text-white/55">{q.query}</span>
                  <span className="text-white/25 text-[10px] flex-shrink-0">({q.intent})</span>
                </div>
              ))}
            </div>
          )}

          {acts.length > 0 && (
            <div className="px-1.5 py-1 border-t border-white/[0.05] space-y-0.5">
              {acts.slice(-10).map((a, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px]">
                  <span className="text-white/25 font-mono flex-shrink-0 mt-px">R{a.round ?? "-"}</span>
                  <span className="text-white/55">{activityLine(a, a.status === "started")}</span>
                </div>
              ))}
            </div>
          )}

          <div className="px-0.5 pt-1 pb-0.5 border-t border-white/[0.05] space-y-0.5">
            {entries.map(entry => (
              <a
                key={entry.sourceId} href={entry.url}
                target="_blank" rel="noopener noreferrer"
                data-testid="research-trail-source"
                className="flex items-start gap-2 p-1.5 rounded-md
                  hover:bg-white/[0.04] transition-colors duration-[120ms]"
              >
                <span className="font-mono text-[10px] text-white/35 flex-shrink-0 mt-px">
                  [{entry.sourceId}]
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] text-white/70 truncate">
                    {entry.title || entry.domain}
                  </span>
                  <span className="block text-[10px] text-white/30 truncate">
                    {entry.domain}
                    {entry.publishedAt ? ` · ${entry.publishedAt.slice(0, 10)}` : ""}
                  </span>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
