/**
 * §3 activity-closure law (2026-11-13 brief): an activity opened by a
 * web:activity "started" frame must CLOSE when the turn ends — including
 * when the engine's terminal frame never arrives (user cancel, stream
 * error, dropped connection). The hook wiring in useChat is thin; the
 * law itself lives in lib/chat/streamHelpers.closeOpenActivityEntries and
 * is pinned here (the hook itself is not React-testable in this repo —
 * no DOM test infra by design).
 *
 * Positive controls mirror the wire grammar in lib/chat/web-tool-loop.ts
 * (started/completed/failed per action, kind+round pairing) so the test
 * exercises REAL shapes, not invented ones.
 */
import { describe, expect, it } from "vitest";
import { closeOpenActivityEntries } from "@/lib/chat/streamHelpers";

type Act = { kind: string; status: string; detail?: string; done?: number; total?: number; round?: number };

const started = (kind: string, round: number): Act => ({ kind, status: "started", round, detail: `${kind}-${round}` });
const closed = (kind: string, round: number, status: string): Act => ({ kind, status, round, done: 3, total: 5 });

describe("§3: turn-end closure of open web activities", () => {
  it("user-cancel stamps cancelled on in-flight actions only", () => {
    const list = [
      closed("search", 1, "completed"),
      started("read_page", 2),
      closed("search", 3, "failed"),
      started("search", 4),
    ];
    const out = closeOpenActivityEntries(list, "cancelled")!;
    expect(out.map(a => a.status)).toEqual(["completed", "cancelled", "failed", "cancelled"]);
    // The engine's terminal records keep their REAL counts untouched.
    expect(out[0].done).toBe(3);
    expect(out[2].done).toBe(3);
    // Cancelled closures carry no invented counts.
    expect(out[1].done).toBeUndefined();
    expect(out[3].done).toBeUndefined();
    // Closure keeps the action identity (kind + round) for the popup lines.
    expect(out[3]).toMatchObject({ kind: "search", round: 4, detail: "search-4" });
  });

  it("stream-error/disconnect stamps interrupted; already-resolved entries never rewritten", () => {
    const list = [started("search", 1), closed("read_page", 2, "completed")];
    const out = closeOpenActivityEntries(list, "interrupted")!;
    expect(out[0].status).toBe("interrupted");
    expect(out[1].status).toBe("completed");
    expect(out[1].done).toBe(3);
  });

  it("idempotent and reference-stable: nothing open → the SAME list object (no re-render churn)", () => {
    const allClosed = [closed("search", 1, "completed"), closed("read_page", 2, "failed")];
    expect(closeOpenActivityEntries(allClosed, "cancelled")).toBe(allClosed);
    const empty: Act[] = [];
    expect(closeOpenActivityEntries(empty, "interrupted")).toBe(empty);
    expect(closeOpenActivityEntries(undefined, "cancelled")).toBeUndefined();
    // Second application is a no-op on the already-closed result.
    const once = closeOpenActivityEntries([started("search", 1)], "cancelled")!;
    expect(closeOpenActivityEntries(once, "interrupted")).toBe(once);
  });

  it("renderer vocabulary is exactly the statuses activityLine understands", () => {
    // ProcessingStatus.activityLine: completed / cancelled / interrupted /
    // (fallback) failed. Closure must never invent a status that would
    // silently render as "failed".
    const out = closeOpenActivityEntries([started("search", 1)], "cancelled")!;
    expect(["completed", "cancelled", "interrupted", "failed"]).toContain(out[0].status);
  });
});
