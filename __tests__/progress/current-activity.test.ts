/**
 * F18 (brief 2026-11-15) — "Status reports historical evidence as current work."
 *
 * Pinned law for the ONE authoritative current-activity resolver
 * (lib/progress/currentActivity.ts), which components/ProcessingStatus.tsx must
 * render FROM instead of building its own cascade. Pure-module tests only:
 * this repo has no DOM test infrastructure, so the law lives outside React.
 *
 * The reproduced defects these cases pin closed:
 *   - reasoning + already-minted citations rendered as "Reading web sources".
 *   - a COMPLETED page action rendered as "Page read complete" while the model
 *     was thinking/writing.
 * Both are evidence HISTORY, so they are not inputs to current-work resolution.
 */
import { describe, it, expect } from "vitest";
import {
  resolveCurrentActivity,
  statusLine,
  activityLine,
  openActivities,
  openToolCalls,
  sourcesHeader,
  hostFrom,
  type ActivityEntry,
  type ToolCallRef,
} from "../../lib/progress/currentActivity";

const act = (a: Partial<ActivityEntry> & { kind: string; status: string }): ActivityEntry =>
  a as ActivityEntry;

const open = (kind: string, detail?: string, round = 1) =>
  act({ kind, status: "started", detail, round });
const done = (kind: string, detail?: string, round = 1) =>
  act({ kind, status: "completed", detail, round, done: 3, total: 3 });

const line = (facts: Parameters<typeof resolveCurrentActivity>[0]) =>
  statusLine(resolveCurrentActivity(facts));

describe("F18 — evidence history is never current work", () => {
  it("a live read_page action names the page being read", () => {
    expect(line({
      activity: [open("read_page", "nimbus.example.com")],
      hasReasoning: true,
      hasContent: false,
    })).toBe("Reading nimbus.example.com...");
  });

  it("reasoning plus already-minted citations says Thinking…, not Reading web sources", () => {
    // Citations are NOT an input: the resolver cannot claim reading from them.
    const text = line({ activity: [], hasReasoning: true, hasContent: false });
    expect(text).toBe("Thinking...");
    expect(text).not.toMatch(/reading/i);
    expect(text).not.toContain("Reading web sources");
  });

  it("a completed page action plus reasoning says Thinking…, not Page read complete", () => {
    const acts = [done("read_page", "nimbus.example.com")];
    expect(line({ activity: acts, hasReasoning: true, hasContent: false })).toBe("Thinking...");
    // The completed action stays available for the popup trail (history), but
    // it must never be the current-work line.
    expect(activityLine(acts[0]!, false)).toContain("complete");
  });

  it("completed actions plus finished searches never out-rank streaming content", () => {
    const acts = [
      act({ kind: "search", status: "completed", detail: "nimbus release notes" }),
      done("read_page", "nimbus.example.com"),
      done("read_page", "docs.example.org"),
    ];
    expect(line({ activity: acts, hasReasoning: true, hasContent: true })).toBe("Writing the answer...");
  });

  it("all actions closed with nothing streamed yet is the honest between-round wait", () => {
    expect(line({
      activity: [done("search"), done("read_page", "nimbus.example.com")],
      hasReasoning: false,
      hasContent: false,
    })).toBe("Preparing the next step...");
  });

  it("no activity at all is the honest first-token wait", () => {
    expect(line({ activity: [], hasReasoning: false, hasContent: false }))
      .toBe("Analyzing your prompt...");
    // Undefined fields (older persisted messages, tool-less turns) are tolerated.
    expect(line({ hasReasoning: false, hasContent: false })).toBe("Analyzing your prompt...");
  });

  it("cancelled / interrupted / failed closures are never treated as live", () => {
    for (const status of ["cancelled", "interrupted", "failed", "error", "ok"]) {
      const acts = [act({ kind: "read_page", status, detail: "nimbus.example.com" })];
      expect(openActivities(acts)).toEqual([]);
      expect(line({ activity: acts, hasReasoning: true, hasContent: false })).toBe("Thinking...");
      // No closed status may leak the present-continuous "Reading …" wording.
      expect(activityLine(acts[0]!, false)).not.toMatch(/^Reading\b/);
    }
  });
});

describe("F18 — live work priority and honest concurrency", () => {
  it("a live action out-ranks an unresolved tool call", () => {
    const toolCalls: ToolCallRef[] = [{ name: "web_search", status: "running" }];
    expect(line({
      activity: [open("read_page", "nimbus.example.com")],
      toolCalls,
      hasReasoning: true,
      hasContent: false,
    })).toBe("Reading nimbus.example.com...");
  });

  it("an unresolved tool call is current work; a landed one is not", () => {
    expect(line({
      toolCalls: [{ name: "web_open", args: '{"url":"https://www.nimbus.example.com/a"}', status: "running" }],
      hasReasoning: true,
      hasContent: false,
    })).toBe("Opening nimbus.example.com...");
    expect(line({
      toolCalls: [{ name: "web_search", status: "streaming" }],
      hasReasoning: true,
      hasContent: false,
    })).toBe("Searching the web...");
    expect(line({
      toolCalls: [{ name: "web_search", status: "ok" }, { name: "web_open", status: "error" }],
      hasReasoning: true,
      hasContent: false,
    })).toBe("Thinking...");
    expect(openToolCalls([
      { name: "web_search", status: "awaiting_approval" },
      { name: "web_search", status: "ok" },
    ])).toHaveLength(1);
  });

  it("malformed/partial tool args never fabricate a host", () => {
    expect(line({
      toolCalls: [{ name: "web_open", args: '{"url":', status: "streaming" }],
      hasReasoning: false,
      hasContent: false,
    })).toBe("Opening a page...");
  });

  it("concurrency is claimed only when actions genuinely overlap", () => {
    const one = line({ activity: [open("search")], hasReasoning: false, hasContent: false });
    expect(one).toBe("Searching the web...");
    expect(one).not.toContain("more in flight");

    const two = line({
      activity: [open("read_page", "nimbus.example.com"), open("read_page", "docs.example.org")],
      hasReasoning: false,
      hasContent: false,
    });
    expect(two).toBe("Reading docs.example.org... (+1 more in flight)");
  });

  it("closed siblings do not inflate the concurrency count", () => {
    expect(line({
      activity: [done("read_page", "a.example.org"), open("read_page", "b.example.org"), done("read_page", "c.example.org")],
      hasReasoning: false,
      hasContent: false,
    })).toBe("Reading b.example.org...");
  });

  it("non-ASCII action detail survives verbatim", () => {
    expect(line({
      activity: [open("read_page", "ఉడులు.నెట్ 🌐")],
      hasReasoning: false,
      hasContent: false,
    })).toBe("Reading ఉడులు.నెట్ 🌐...");
  });
});

describe("F18 — popup header describes sources as evidence", () => {
  it("header wording depends only on whether a read is actually live", () => {
    expect(sourcesHeader(3, false)).toBe("3 sources gathered this turn");
    expect(sourcesHeader(3, true)).toBe("Reading 3 sources");
    expect(sourcesHeader(1, false)).toBe("1 source gathered this turn");
    expect(sourcesHeader(1, true)).toBe("Reading 1 source");
  });

  it("hostFrom keeps the display fallback bounded for non-URL detail", () => {
    expect(hostFrom("not a url at all but quite long indeed")).toBe("not a url at all but qui");
    expect(hostFrom("https://www.sub.example.co.uk/x")).toBe("sub.example.co.uk");
  });
});
