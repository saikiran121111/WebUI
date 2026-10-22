"use client";
import { useEffect, useState } from "react";
import type { Message } from "../lib/types";

/**
 * RUKE-branded processing line shown in place of the old loading dots while
 * a reply is still finding its first token. Every phase it names is derived
 * from a real signal on the message — never a fake "thinking harder" verb:
 *
 *   - webCitations / researchLfm headers → the gated search already ran and
 *     pages were fetched, so the line names the queries and the domains.
 *   - toolCalls still open (research mode) → names the live tool call.
 *   - reasoning deltas arriving → "Thinking… Ns" with the real elapsed time.
 *   - nothing yet → the honest "Analyzing your prompt…".
 */

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

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const secs = Math.max(0, Math.floor((now - message.createdAt) / 1000));

  const cites = message.webCitations ? Object.values(message.webCitations) : [];
  const domains = [...new Set(cites.map(c => c.domain || hostFrom(c.url)))].slice(0, 3);
  const query = message.researchLfm?.queries?.[0]?.query;
  const liveCall = message.toolCalls?.find(tc =>
    tc.status === "streaming" || tc.status === "pending"
    || tc.status === "awaiting_approval" || tc.status === "running");

  let text: string;
  if (liveCall) {
    text = toolCallLine(liveCall.name, liveCall.args ?? "");
  } else if (cites.length > 0) {
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

  return (
    <div
      data-testid="processing-status"
      aria-label="Generating"
      className="flex items-center gap-2.5 py-4"
    >
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
      <span className="text-[13px] text-[var(--muted)] leading-none">{text}</span>
    </div>
  );
}
