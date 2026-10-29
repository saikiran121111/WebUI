/**
 * Unit tests for the universal caption wire-format engine
 * (lib/web-search/captionFormats.ts). Pure functions — no browser, no
 * network, no provider URLs: format detection is by shape only, and these
 * fixtures come from the standard wire formats (json3 / WebVTT / srv3 /
 * TTML), not from any single platform.
 */
import { describe, it, expect } from "vitest";
import {
  CAPTION_URL_RE,
  SRT_SHAPE_RE,
  formatCaptionSegments,
  isCaptionCandidateUrl,
  parseCaptionTimeToMs,
  parseJson3Captures,
  parseSrv3Captures,
  parseTtmlCaptures,
  parseSrtCaptures,
  parseVttCaptures,
  sniffCaptures,
} from "@/lib/web-search/captionFormats";

/* ── time parsing ─────────────────────────────────────────────────────── */

describe("parseCaptionTimeToMs", () => {
  it("handles bare seconds (with optional s suffix and decimals)", () => {
    expect(parseCaptionTimeToMs("90.5")).toBe(90500);
    expect(parseCaptionTimeToMs("90.5s")).toBe(90500);
    expect(parseCaptionTimeToMs("0")).toBe(0);
  });
  it("handles clock forms: h:mm:ss, mm:ss, s with comma-decimals", () => {
    expect(parseCaptionTimeToMs("01:02:03.500")).toBe(3_723_500);
    expect(parseCaptionTimeToMs("01:02")).toBe(62_000);
    expect(parseCaptionTimeToMs("1:2")).toBe(62_000);
    expect(parseCaptionTimeToMs("00:01:30,000")).toBe(90_000); // TTML comma style
  });
  it("returns 0 for garbage, empty, and >3 colon parts", () => {
    expect(parseCaptionTimeToMs("")).toBe(0);
    expect(parseCaptionTimeToMs("abc")).toBe(0);
    expect(parseCaptionTimeToMs("1:2:3:4")).toBe(0);
    expect(parseCaptionTimeToMs(null as unknown as string)).toBe(0);
  });
});

/* ── URL candidate filter (shape names, never domains) ───────────────── */

describe("isCaptionCandidateUrl", () => {
  it("matches standard track-format names across providers", () => {
    expect(isCaptionCandidateUrl("https://a.example/timedtext?v=abc&fmt=json3")).toBe(true);
    expect(isCaptionCandidateUrl("https://a.example/subtitles/en.vtt?token=x")).toBe(true);
    expect(isCaptionCandidateUrl("https://a.example/texttracks")).toBe(true);
    expect(isCaptionCandidateUrl("https://a.example/captions/master")).toBe(true);
    expect(isCaptionCandidateUrl("https://a.example/srv3?x=1")).toBe(true);
    expect(isCaptionCandidateUrl("https://a.example/track.vtt")).toBe(true); // end-of-string .vtt
    expect(CAPTION_URL_RE.flags.includes("i")).toBe(true);
  });
  it("passes over media and page URLs", () =>
    expect(isCaptionCandidateUrl("https://a.example/media/hls/master.m3u8")).toBe(false));
});

/* ── format parsers ───────────────────────────────────────────────────── */

describe("parseJson3Captures", () => {
  it("joins segs[].utf8 per event and falls back to tMs", () => {
    const segs = parseJson3Captures(
      JSON.stringify({
        events: [
          { tStartMs: 1500, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
          { tMs: 2000, segs: [{ utf8: "<i>next</i>" }] },
          { tStartMs: 2500, segs: [] }, // empty → skipped
          { tStartMs: 3000, segs: [{ utf8: "U+2028sep" }] },
        ],
      }),
    );
    expect(segs).toEqual([
      { text: "Hello world", startMs: 1500 },
      { text: "next", startMs: 2000 }, // tags stripped
      { text: "U+2028sep", startMs: 3000 },
    ]);
  });
  it("bad JSON or missing events → []", () => {
    expect(parseJson3Captures("{oops")).toEqual([]);
    expect(parseJson3Captures("{}")).toEqual([]);
  });
  it("caps segments at MAX_SEGMENTS (800)", () => {
    const events = Array.from({ length: 810 }, (_, i) => ({ tStartMs: i, segs: [{ utf8: `w${i}` }] }));
    expect(parseJson3Captures(JSON.stringify({ events })).length).toBeLessThanOrEqual(800);
  });
  it("caps total characters at MAX_TOTAL_CHARS (~16k) well before 800 segs", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      tStartMs: i,
      segs: [{ utf8: "x".repeat(400) }],
    }));
    const segs = parseJson3Captures(JSON.stringify({ events }));
    const total = segs.reduce((n, s) => n + s.text.length, 0);
    expect(total).toBeGreaterThanOrEqual(16_000); // crossed the cap…
    expect(segs.length).toBeLessThan(50); // …then stopped
  });
});

describe("parseVttCaptures", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "first cue",
    "wrapped line",
    "",
    "00:01:30.000 --> 00:01:32.000",
    "second cue",
  ].join("\n");
  it("requires the WEBVTT header (BOM-tolerant)", () => {
    expect(parseVttCaptures("<html>nope").length).toBe(0);
    expect(parseVttCaptures("﻿" + vtt).length).toBe(2);
  });
  it("parses cues, joining wrapped text lines", () => {
    expect(parseVttCaptures(vtt)).toEqual([
      { text: "first cue wrapped line", startMs: 1000 },
      { text: "second cue", startMs: 90_000 },
    ]);
  });
});

describe("parseSrtCaptures", () => {
  const srt = ["1", "00:00:01,000 --> 00:00:04,000", "first cue", "wrapped", "", "2", "00:01:30,000 --> 00:01:32,000", "second &amp; cue"].join("\r\n");
  it("parses headerless index+cue blocks (CRLF-tolerant)", () => {
    expect(parseSrtCaptures(srt)).toEqual([
      { text: "first cue wrapped", startMs: 1000 },
      { text: "second & cue", startMs: 90_000 },
    ]);
  });
  it("shape regex distinguishes SRT from plain text and WEBVTT cue blocks", () => {
    expect(SRT_SHAPE_RE.test(srt)).toBe(true);
    expect(SRT_SHAPE_RE.test("WEBVTT\n\n00:01.000 --> 00:04.000\ncue")).toBe(false);
    expect(SRT_SHAPE_RE.test("just prose with --> arrows\nbut no index lines")).toBe(false);
  });
});

describe("parseSrv3Captures", () => {
  it("parses <text start=…> with entity decoding", () => {
    const body =
      '<?xml version="1.0"?><transcript><text start="0" dur="1.5">Hey &amp; ho</text>' +
      '<text start="90.5">Next&#39;s</text></transcript>';
    expect(parseSrv3Captures(body)).toEqual([
      { text: "Hey & ho", startMs: 0 },
      { text: "Next's", startMs: 90_500 },
    ]);
  });
});

describe("parseTtmlCaptures", () => {
  it("parses <p begin=…> with clock times and entities", () => {
    const body =
      '<tt><body><div><p begin="00:01:30.000" end="00:01:32">Line &lt;one&gt;</p>' +
      '<p begin="1:00:05.5">two</p></div></body></tt>';
    expect(parseTtmlCaptures(body)).toEqual([
      { text: "Line <one>", startMs: 90_000 },
      { text: "two", startMs: 3_605_500 },
    ]);
  });
});

/* ── shape-detected dispatch ─────────────────────────────────────────── */

describe("sniffCaptures", () => {
  it("empty body (the token-gate favorite answer: 200 + 0 bytes) → []", () => {
    expect(sniffCaptures("")).toEqual([]);
    expect(sniffCaptures("   \n ")).toEqual([]);
  });
  it("dispatches by shape: JSON → json3, WEBVTT → vtt, SRT index → srt, <text → srv3, <p begin → ttml", () => {
    expect(sniffCaptures('{"events":[{"tStartMs":1,"segs":[{"utf8":"a"}]}]}')).toHaveLength(1);
    expect(sniffCaptures("WEBVTT\n\n00:00.5 --> 00:01.5\nhi")).toEqual([{ text: "hi", startMs: 500 }]);
    // Headerless SRT (Wikimedia/Dailymotion style) — no WEBVTT, no XML:
    expect(sniffCaptures("1\n00:00:01,000 --> 00:00:04,000\nhi\n\n2\n00:00:05,000 --> 00:00:06,000\nthere")).toHaveLength(2);
    expect(sniffCaptures('<transcript><text start="1">a</text></transcript>')).toHaveLength(1);
    expect(sniffCaptures('<body><p begin="00:00:02">a</p></body>')).toHaveLength(1);
  });
  it("JSON with no events / unrecognized XML → []", () => {
    expect(sniffCaptures('{"foo":1}')).toEqual([]);
    expect(sniffCaptures("<html><body>player chrome</body></html>")).toEqual([]);
  });
});

/* ── rendering (must match the InnerTube transcript shape) ──────────── */

describe("formatCaptionSegments", () => {
  it("renders [mm:ss] and h:mm:ss clocks, skipping empty text", () => {
    expect(
      formatCaptionSegments([
        { text: "a", startMs: 0 },
        { text: "   ", startMs: 61_000 },
        { text: "b", startMs: 3_723_400 },
      ]),
    ).toBe("[00:00] a\n[1:02:03] b");
  });
  it("caps the rendered transcript at 12k chars", () => {
    const segs = Array.from({ length: 500 }, (_, i) => ({ text: "y".repeat(60), startMs: i * 1000 }));
    const out = formatCaptionSegments(segs);
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.length).toBeGreaterThan(11_000); // it did fill the cap
  });
});
