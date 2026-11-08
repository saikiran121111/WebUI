import { describe, expect, it } from "vitest";
import {
  captionCoverageNote,
  formatCaptionSegments,
  parseJson3Captures,
  type CaptionParseMeta,
} from "../../lib/web-search/captionFormats";
import { parseStartOffset, transcriptFromInfo } from "../../lib/web-search/youtube";

/**
 * I19: every caption path silently dropped everything past its cue/format
 * cap — a 2-hour video "read" as its first 20 minutes, and the model happily
 * summarized an ending it had never seen. Retrieval caps must now be stated
 * as facts, on BOTH the InnerTube transcript path and the browser capture
 * path, and a "?t=" link offset must reach the model as a fact too.
 */

describe("caption coverage honesty (I19)", () => {
  it("parse-level cue cap is reported through meta, never silently", () => {
    const events = Array.from({ length: 900 }, (_, i) => ({
      tStartMs: i * 1000,
      segs: [{ utf8: "x" }],
    }));
    const body = JSON.stringify({ events });

    const meta: CaptionParseMeta = {};
    const segs = parseJson3Captures(body, meta);
    expect(segs.length).toBe(800); // MAX_SEGMENTS
    expect(meta.parseCapped).toBe(true);

    // meta stays optional — existing callers keep working untouched.
    expect(parseJson3Captures(body).length).toBe(800);
  });

  it("uncapped formatting is byte-identical (no note injected)", () => {
    expect(
      formatCaptionSegments([
        { text: "a", startMs: 0 },
        { text: "b", startMs: 3_723_000 },
      ]),
    ).toBe("[00:00] a\n[1:02:03] b");
  });

  it("parse-capped segments get the coverage note even when rendering is short", () => {
    const out = formatCaptionSegments([{ text: "only cue", startMs: 7000 }], { parseCapped: true });
    expect(out).toBe(`[00:07] only cue\n${captionCoverageNote("00:07", 1)}`);
  });

  it("render-level cap truncates but ANNOUNCES where the transcript stopped", () => {
    const segs = Array.from({ length: 400 }, (_, i) => ({
      text: "c".repeat(40),
      startMs: i * 1000,
    }));
    const out = formatCaptionSegments(segs);
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.length).toBeGreaterThan(11_000);
    expect(out).toContain("[caption coverage:");
    expect(out).toContain("NOT retrieved");
    expect(out).toContain("never assume you know how the video ends");
    expect(out).toMatch(/stops at \d+:\d{2}(:\d{2})? \(\d+ cue\(s\) retrieved\)/);
  });

  it("the coverage note wording names the stop point and the unknown tail", () => {
    const note = captionCoverageNote("1:02:03", 42);
    expect(note).toContain("stops at 1:02:03 (42 cue(s) retrieved)");
    expect(note).toContain("the remainder of the caption track was NOT retrieved");
    expect(note).toContain("never assume you know how the video ends");
  });
});

describe("InnerTube transcript path is coverage-honest (I19)", () => {
  it("short transcript formats exactly, no note", async () => {
    const info = {
      getTranscript: async () => ({
        segments: [
          { start_ms: 0, text: "a" },
          { start_ms: 1000, text: "b" },
          { start_ms: 2000, text: "c" },
        ],
      }),
    };
    expect(await transcriptFromInfo(info)).toBe("[00:00] a\n[00:01] b\n[00:02] c");
  });

  it("long transcript stops at the render cap and says so", async () => {
    const info = {
      getTranscript: async () => ({
        segments: Array.from({ length: 400 }, (_, i) => ({
          start_ms: i * 1000,
          text: "w".repeat(40),
        })),
      }),
    };
    const out = await transcriptFromInfo(info);
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.length).toBeGreaterThan(11_000);
    expect(out).toContain("[caption coverage:");
    expect(out).toContain("never assume you know how the video ends");
  });

  it("transcript failure still degrades to empty string (existing tier behavior)", async () => {
    const info = {
      getTranscript: async () => {
        throw new Error("timed out");
      },
    };
    expect(await transcriptFromInfo(info)).toBe("");
  });
});

describe("requested start offsets survive as facts (I19)", () => {
  const cases: Array<[string, number | null]> = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90", 90],
    ["https://youtu.be/dQw4w9WgXcQ?t=1m30s", 90],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=00:01:30", 90],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s", 3723],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90.5", 90],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0", 0],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", null],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=abc", null],
  ];
  for (const [url, want] of cases) {
    it(`${url.slice(-24)} → ${want}`, () => {
      expect(parseStartOffset(url)).toBe(want);
    });
  }
});
