"use client";
import { useEffect, useRef, useState } from "react";
import type { Message } from "../lib/types";

/**
 * RUKE-branded processing line shown in place of the old loading dots while
 * a reply is still finding its first token. Every phase it names is derived
 * from a real signal on the message — never a fake "thinking harder" verb:
 *
 *   - webCitations / searchGate headers → the gated search already ran and
 *     pages were fetched, so the line names the queries and the domains.
 *     While sources exist the line is clickable and opens a popup with the
 *     queries + source links (2026-10-22: the cyan gradient ResearchTrailCard
 *     bar was removed; this popup replaces it — click outside closes).
 *   - toolCalls still open (research mode) → names the live tool call.
 *   - reasoning deltas arriving → "Thinking… Ns" with the real elapsed time.
 *   - nothing yet → the honest "Analyzing your prompt…".
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

function hostFrom(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url.slice(0, 24); }
}

function toolCallLine(name: string, args: string): string {
  if (name === "web_search") return "Searching the web…";
  if (name === "web_open") {
    let host = "";
    try { host = hostFrom(JSON.parse(args)?.url ?? ""); } catch { /* partial args */ }
    return host ? `Opening ${host}…` : "Opening a page…";
  }
  if (name === "browser_screenshot") return "Taking a screenshot…";
  return `Running ${name}…`;
}

export default function ProcessingStatus({ message }: { message: Message }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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

  const secs = Math.max(0, Math.floor((now - message.createdAt) / 1000));

  const gate = message.searchGate ?? message.researchLfm;
  const entries = Object.values(message.webCitations ?? {})
    .filter(c => !!c && typeof c.url === "string")
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId, undefined, { numeric: true }));
  const domains = [...new Set(entries.map(c => c.domain || hostFrom(c.url)))].slice(0, 3);
  const query = gate?.queries?.[0]?.query;
  const liveCall = message.toolCalls?.find(tc =>
    tc.status === "streaming" || tc.status === "pending"
    || tc.status === "awaiting_approval" || tc.status === "running");

  let text: string;
  if (liveCall) {
    text = toolCallLine(liveCall.name, liveCall.args ?? "");
  } else if (entries.length > 0) {
    text = query
      ? `Searching the web for “${query}” — reading ${domains.join(", ")}`
      : `Reading web sources — ${domains.join(", ")}`;
  } else if (message.reasoning) {
    text = `Thinking… ${secs}s`;
  } else if (secs < 2) {
    text = "Analyzing your prompt…";
  } else {
    text = secs < 6 ? "Thinking…" : `Thinking… ${secs}s`;
  }

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
              Reading {entries.length} source{entries.length !== 1 ? "s" : ""}
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
