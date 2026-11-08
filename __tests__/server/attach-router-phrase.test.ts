/**
 * I22 router additions pinned for TS⇔Rust parity (the ruke-attach router
 * mirrors these exact boundary cases, including the ASCII-word-byte `\b`
 * emulation): "the last N minutes" resolves against the index's own
 * duration at the TURN layer (routeQuery only carries `lastSec`), and the
 * exhaustive phrase list grew the natural continuations users actually
 * type. Adversarial spellings pin the boundary semantics so the Rust
 * word-boundary emulation cannot drift.
 */
import { describe, expect, it } from "vitest";
import { routeQuery } from "@/lib/server/attachindex/router";

describe("last-N-minutes (I22)", () => {
  it("last 10 minutes -> time_range with lastSec only", () => {
    expect(routeQuery("what happened in the last 10 minutes")).toEqual({ mode: "time_range", lastSec: 600 });
  });
  it("last 5 mins / last 2m / last 90 minutes", () => {
    expect(routeQuery("what did he say in the last 5 mins")).toEqual({ mode: "time_range", lastSec: 300 });
    expect(routeQuery("cover the last 2m of the lecture")).toEqual({ mode: "time_range", lastSec: 120 });
    expect(routeQuery("what happened during the last 90 minutes")).toEqual({ mode: "time_range", lastSec: 5400 });
  });
  it("boundary parity spellings (ASCII-word-byte rule)", () => {
    // "lastx": 'x' is a word byte on BOTH sides of the boundary ⇒ no match.
    expect(routeQuery("lastx 10 minutes into it").mode).toBe("point_qa");
    // Trailing glue "minutesx": every minutes?|mins?|m alternative word-glues
    // on 'x' ⇒ no lastSec. With the candidate dead, the rest of the query
    // routes on its own: neutral tail stays point_qa, "summary" is a real
    // whole_video keyword match and takes over.
    expect(routeQuery("last 10 minutesx into it").mode).toBe("point_qa");
    expect(routeQuery("last 10 minutesx summary").mode).toBe("whole_video");
    // "cafélast": é is NOT a word byte in JS \b (non-unicode regex) nor in
    // the Rust emulation ⇒ the boundary before 'l' exists on both sides.
    expect(routeQuery("cafélast 10 minutes summary")).toEqual({ mode: "time_range", lastSec: 600 });
  });
  it("absolute timestamps still win (lastMin rule runs after them)", () => {
    expect(routeQuery("12:34:567")).toEqual({ mode: "time_range", fromSec: 574, toSec: 934 });
  });
});

describe("exhaustive phrase growth (I22)", () => {
  it("new phrasings route to exhaustive", () => {
    for (const q of [
      "list all the mentions of entropy",
      "give me all mentions of the word basically",
      "wherever the professor mentions Gauss's law",
      "any time he says remember this",
      "each mention of the homework deadline",
      "mentioned how often the drop rate changes",
    ]) {
      expect(routeQuery(q).mode, q).toBe("exhaustive");
    }
  });
  it("look-alikes stay point_qa", () => {
    // "everytime" (no space) is not "every time".
    expect(routeQuery("where do we meetup everytime we meet").mode).toBe("point_qa");
    expect(routeQuery("what is the average of all the quiz scores").mode).toBe("point_qa");
  });
});
