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
  sessionDateString,
  utcOffset,
} from "@/lib/chat/clock-context";

const PINNED_BLOCK = [
  "<runtime_clock>",
  "Current date/time: Sunday 2026-11-01 18:30:00 (UTC+05:30) — session timezone: Asia/Kolkata (IANA).",
  "This clock is authoritative and live: the server injects it fresh into every turn, immediately before the current user message.",
  "Answer any current-time, date, or day-of-week question directly from this line, in the session timezone shown. NEVER claim that you lack a clock, cannot see the current time, or that your knowledge is frozen at a training cutoff.",
  'Use this clock silently as background context: resolve "today", "now", "this week", or staleness against it WITHOUT announcing the date, time, or timezone. Do not greet with or otherwise state the current date/time unless the user asks for it, an as-of date materially helps the answer, or you need to explain a temporal ambiguity.',
  "The clock does NOT update your knowledge of the outside world: facts that change over time (prices, releases, officeholders, news, availability) still need a web search when verification matters — never answer them from this line alone.",
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

describe("sessionDateString (brief §5: one instant + session tz across chat/gate/research)", () => {
  it("rolls the calendar with the SESSION zone, not UTC (midnight boundary)", () => {
    // 2026-11-04T19:00Z is still Nov 4 in UTC, but it is 00:30 on Nov 5 in
    // Kolkata — the gate's "today" freshness must be judged against the
    // SAME date the model's <runtime_clock> block shows.
    expect(sessionDateString(new Date("2026-11-04T19:00:00Z"), "Asia/Kolkata")).toBe("2026-11-05");
  });

  it("rolls the YEAR with the session zone", () => {
    // 2026-12-31T19:00Z is still Dec 31 in UTC — but 00:30 IST on Jan 1,
    // 2027. Positive-offset zones LEAD UTC across the year line; a zone
    // like New York trails UTC and can never cross while UTC reads 2026.
    expect(sessionDateString(new Date("2026-12-31T19:00:00Z"), "Asia/Kolkata")).toBe(
      "2027-01-01",
    );
  });

  it("equals the date the clock block itself displays for the same instant+zone", () => {
    // The consistency contract: the route passes this value as the gate
    // ctx currentDate; it must NEVER disagree with the block the answering
    // model sees in the same turn.
    const now = new Date("2026-11-04T19:00:00Z");
    const block = buildClockContext({ now, browserTimezone: "Asia/Kolkata" });
    const shown = /Current date\/time: [A-Za-z]+ (\d{4}-\d{2}-\d{2})/.exec(block)![1];
    expect(shown).toBe(sessionDateString(now, "Asia/Kolkata"));
  });

  it("garbage/missing zones fall back to the server zone (⇔ Rust session_date fallback law)", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(sessionDateString(new Date("2026-07-04T23:30:00Z"), "Not/AZone!!")).toBe(
      sessionDateString(new Date("2026-07-04T23:30:00Z"), server),
    );
  });
});
