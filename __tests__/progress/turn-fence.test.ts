/**
 * F18 — turn ownership fence (lib/progress/turnFence.ts).
 *
 * Pins the law that made ProcessingStatus lie: a frame must be applied only
 * while the turn that PRODUCED it is current. Late frames from an abandoned
 * (conversation switch) or superseded (stop + resend) turn are dropped, not
 * re-pointed at the newest assistant message.
 */
import { describe, it, expect } from "vitest";
import { createTurnFence } from "../../lib/progress/turnFence";

describe("turn fence — stale frames never reach the current turn", () => {
  it("a turn is current until a newer turn begins", () => {
    const f = createTurnFence();
    const a = f.begin("a_1");
    expect(f.owns(a)).toBe(true);
    const b = f.begin("a_2");
    expect(f.owns(b)).toBe(true);
    expect(f.owns(a)).toBe(false);
    expect(f.droppedStale).toBe(1);
    // Ids ride along: the fence never has to guess which message a frame owns.
    expect(b.id).toBe("a_2");
    expect(a.id).toBe("a_1");
  });

  it("abandoning a turn without starting a new one invalidates everything", () => {
    const f = createTurnFence();
    const a = f.begin("a_1");
    f.invalidate(); // user switched chats: no turn is current
    expect(f.owns(a)).toBe(false);
    const b = f.begin("a_2");
    expect(f.owns(b)).toBe(true);
  });

  it("missing frames are stale, and tokens never repeat", () => {
    const f = createTurnFence();
    expect(f.owns(null)).toBe(false);
    expect(f.owns(undefined)).toBe(false);
    expect(f.owns({ id: "a_9", token: 0 })).toBe(false);
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const t = f.begin(`a_${i}`);
      expect(seen.has(t.token)).toBe(false);
      seen.add(t.token);
      expect(f.owns(t)).toBe(true);
    }
    expect(f.droppedStale).toBe(3);
  });

  it("an old turn's frames stay rejected across interleaved pumps", () => {
    const f = createTurnFence();
    const oldTurn = f.begin("a_old");
    const newTurn = f.begin("a_new");
    // Two pumps delivering in lockstep: only the current turn lands.
    const accepted: string[] = [];
    for (const frame of [oldTurn, newTurn, oldTurn, newTurn, oldTurn]) {
      if (f.owns(frame)) accepted.push(frame.id);
    }
    expect(accepted).toEqual(["a_new", "a_new"]);
    expect(f.droppedStale).toBe(3);
  });
});
