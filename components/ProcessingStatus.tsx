"use client";
import { useEffect, useState } from "react";
import type { Message } from "../lib/types";

/**
 * Claude-style processing line shown in place of the old loading dots while
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
        className="processing-asterisk"
        width="15" height="15" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"
        aria-hidden
      >
        <line x1="12" y1="3.5" x2="12" y2="20.5" />
        <line x1="4.6" y1="7.75" x2="19.4" y2="16.25" />
        <line x1="19.4" y1="7.75" x2="4.6" y2="16.25" />
      </svg>
      <span className="text-[13px] text-[var(--muted)] leading-none">{text}</span>
    </div>
  );
}
