/**
 * ONE authoritative current-activity state per turn/round (F18, brief 2026-11-15).
 *
 * Pure (no React, no timers) so the law is unit-pinnable in this repo, which
 * has no DOM test infrastructure. ProcessingStatus renders FROM THIS MODULE;
 * it must not build its own priority cascade.
 *
 * The law this enforces:
 *   - CURRENT WORK comes only from something actually in flight: an unclosed
 *     web:activity action or an unresolved tool call.
 *   - EVIDENCE HISTORY IS HISTORY. Minted citations, finished/failed/cancelled
 *     actions and old reasoning text never render as current work. The old
 *     cascade did exactly that ("Reading web sources - <domains>" the moment
 *     any citation existed; "Page read complete" while the model was thinking),
 *     which told the human the system was doing something it had already done.
 *   - Closed actions close on success / error / cancel / interrupt (see
 *     closeOpenActivityEntries); this resolver trusts that closure law and
 *     reads `status === "started"` as the only live marker.
 *   - Concurrency is claimed ONLY when actions genuinely overlap.
 *   - Between tool rounds, with nothing in flight and nothing streamed yet,
 *     the honest line names what is actually happening: the harness is handing
 *     evidence back to the model ("Preparing the next step..."), not reading.
 */
import type { Message } from "../types";

export type ActivityEntry = NonNullable<Message["webActivity"]>[number];

export interface ToolCallRef {
  name: string;
  args?: string;
  status: string;
}

export interface ActivityFacts {
  activity?: ActivityEntry[];
  toolCalls?: ToolCallRef[];
  /** Reasoning text exists for this turn. History signal, not proof of work. */
  hasReasoning: boolean;
  /** Answer content has started streaming this turn. */
  hasContent: boolean;
}

export type CurrentActivity =
  | { type: "action"; entry: ActivityEntry; concurrent: number }
  | { type: "tool"; name: string; args?: string }
  | { type: "writing" }
  | { type: "thinking" }
  | { type: "between_rounds" }
  | { type: "waiting" };

const OPEN_STATUS = "started";

/** Actions still in flight, in wire order. The closure law guarantees these
 *  are the only entries with an open status once a turn ends. */
export function openActivities(activity?: ActivityEntry[]): ActivityEntry[] {
  return (activity ?? []).filter((a) => a.status === OPEN_STATUS);
}

/** Unresolved tool calls (the model asked for one that has not landed). */
export function openToolCalls(toolCalls?: ToolCallRef[]): ToolCallRef[] {
  return (toolCalls ?? []).filter((tc) =>
    tc.status === "streaming" ||
    tc.status === "pending" ||
    tc.status === "awaiting_approval" ||
    tc.status === "running",
  );
}

/**
 * THE priority order. Live action > live tool call > writing > thinking >
 * between-rounds > first-token wait. Citations and completed actions appear
 * NOWHERE in this order, because they are not work in flight.
 */
export function resolveCurrentActivity(facts: ActivityFacts): CurrentActivity {
  const open = openActivities(facts.activity);
  if (open.length > 0) {
    return { type: "action", entry: open[open.length - 1]!, concurrent: open.length };
  }
  const tools = openToolCalls(facts.toolCalls);
  if (tools.length > 0) {
    const t = tools[tools.length - 1]!;
    return { type: "tool", name: t.name, args: t.args };
  }
  if (facts.hasContent) return { type: "writing" };
  if (facts.hasReasoning) return { type: "thinking" };
  // Nothing live. Anything this turn already produced is history.
  if ((facts.activity ?? []).length > 0) return { type: "between_rounds" };
  return { type: "waiting" };
}

function hostFrom(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url.slice(0, 24); }
}
export { hostFrom };

/** Live tool call - only reachable while the call itself is unresolved. */
export function toolCallLine(name: string, args?: string): string {
  if (name === "web_search") return "Searching the web...";
  if (name === "web_open") {
    let host = "";
    try { host = hostFrom(JSON.parse(args ?? "")?.url ?? ""); } catch { /* partial args */ }
    return host ? `Opening ${host}...` : "Opening a page...";
  }
  if (name === "browser_screenshot") return "Taking a screenshot...";
  return `Running ${name}...`;
}

/**
 * One action entry - live or closed. CLOSED entries are rendered in the trail
 * popup (history), never as the current-activity line.
 */
export function activityLine(a: ActivityEntry, live: boolean): string {
  const what = a.kind === "search" ? "Web search" : a.kind === "read_page" ? "Page read" : a.kind;
  if (live) {
    if (a.kind === "read_page") return a.detail ? `Reading ${a.detail}...` : "Reading a page...";
    if (a.kind === "search") return a.detail ? `Searching the web - ${a.detail}` : "Searching the web...";
    return `Running ${a.kind}...`;
  }
  const counts = a.done != null && a.total != null ? ` - ${a.done} of ${a.total}` : "";
  if (a.status === "completed") return `${what} complete${counts}`;
  if (a.status === "cancelled") return `${what} cancelled`;
  // Client-stamped turn-end closure (2026-11-13 brief section 3): the action was
  // still in flight when the stream ended without it resolving.
  if (a.status === "interrupted") return `${what} interrupted`;
  return `${what} failed`;
}

/** The processing line. `hasSources` is only a POPUP affordance; it can never
 *  change what the line claims the system is doing right now. */
export function statusLine(current: CurrentActivity): string {
  switch (current.type) {
    case "action": {
      const base = activityLine(current.entry, true);
      // Honest concurrency: only when work actually overlaps.
      return current.concurrent > 1 ? `${base} (+${current.concurrent - 1} more in flight)` : base;
    }
    case "tool":
      return toolCallLine(current.name, current.args);
    case "writing":
      return "Writing the answer...";
    case "thinking":
      return "Thinking...";
    case "between_rounds":
      return "Preparing the next step...";
    case "waiting":
      return "Analyzing your prompt...";
  }
}

/** The popup header. Sources are evidence this turn PRODUCE, so the header
 *  describes them as produced unless a read action is actually live. */
export function sourcesHeader(sourceCount: number, readingLive: boolean): string {
  const noun = `${sourceCount} source${sourceCount !== 1 ? "s" : ""}`;
  return readingLive ? `Reading ${noun}` : `${noun} gathered this turn`;
}