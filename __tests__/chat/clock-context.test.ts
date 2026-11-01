/**
 * P1 clock grounding — mirrors the Rust unit tests in
 * ruke-server/src/chat/clock.rs (fixed_instant_emits_the_pinned_block /
 * dst_aware_offset_across_the_year / garbage_zone_falls_back_without_failing):
 * identical instants, identical pinned block strings. The exact block here
 * IS the byte-parity contract with the Rust mirror.
 */
import { describe, expect, it } from "vitest";
import {
  buildClockBlock,
  buildClockContext,
  resolveSessionTimezone,
  utcOffset,
} from "@/lib/chat/clock-context";

const PINNED_BLOCK = [
  "<runtime_clock>",
  "Current date/time: Sunday 2026-11-01 18:30:00 (UTC+05:30) — session timezone: Asia/Kolkata (IANA).",
  "This clock is authoritative and live: the server injects it fresh into every turn, immediately before the current user message.",
  "Answer any current-time, date, or day-of-week question directly from this line, in the session timezone shown. NEVER claim that you lack a clock, cannot see the current time, or that your knowledge is frozen at a training cutoff.",
  'Use this clock — never a web search — whenever you reason about "today", "now", "this year", or staleness.',
  "</runtime_clock>",
].join("\n");

describe("buildClockContext (P1 clock grounding)", () => {
  it("fixed instant emits the pinned block (⇔ Rust fixed_instant_emits_the_pinned_block)", () => {
    expect(
      buildClockContext({
        now: new Date("2026-11-01T13:00:00Z"),
        browserTimezone: "Asia/Kolkata",
      }),
    ).toBe(PINNED_BLOCK);
  });

  it("utcOffset is DST-aware (⇔ Rust dst_aware_offset_across_the_year)", () => {
    expect(utcOffset(new Date("2026-07-04T16:00:00Z"), "America/New_York")).toBe("-04:00");
    expect(utcOffset(new Date("2026-01-15T16:00:00Z"), "America/New_York")).toBe("-05:00");
    expect(utcOffset(new Date("2026-11-01T13:00:00Z"), "Asia/Kolkata")).toBe("+05:30");
  });

  it("garbage/missing zones fall back to the server zone without throwing (⇔ Rust garbage_zone…)", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const bad of [undefined, "", "   ", "Not/AZone!!"]) {
      expect(resolveSessionTimezone(bad)).toBe(server);
    }
    const block = buildClockContext({ now: new Date("2026-07-04T16:00:00Z") });
    expect(block.startsWith("<runtime_clock>\nCurrent date/time: ")).toBe(true);
    expect(block).toContain(`session timezone: ${server} (IANA).`);
  });

  it("valid zones pass through verbatim (trimmed)", () => {
    expect(resolveSessionTimezone(" Europe/London ")).toBe("Europe/London");
    expect(resolveSessionTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("buildClockBlock is the shared text assembly the Rust format! mirrors", () => {
    expect(buildClockBlock("Sunday", "2026-11-01", "18:30:00", "+05:30", "Asia/Kolkata")).toBe(
      PINNED_BLOCK,
    );
  });
});
