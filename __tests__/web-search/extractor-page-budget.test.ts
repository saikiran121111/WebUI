/**
 * APPROVED PART-10 PARITY DEVIATION — §11.3 per-page extraction budget
 * (MIGRATION-MAP). Mirrors the Rust unit tests in
 * ruke-websearch/src/extractor.rs
 * (page_budget_abandons_slow_page_into_snippet_fallback /
 *  timeout_fallback_packet_shape_mirrors_terminal_fallback).
 *
 * The behavioral slow-net proof lives on the Rust side (the epoch that
 * ships); here we pin the TS oracle's fallback shape so both epochs fold a
 * budget-exhausted page into the SAME terminal packet — the only new
 * artifact in either epoch is the "PAGE_BUDGET_TIMEOUT" classification,
 * which never appears in golden fixtures because replays are in-process and
 * the timer cannot fire there.
 */
import { describe, expect, it } from "vitest";
import { timeoutFallbackPacket } from "@/lib/web-search/extractor";
import type { RankedResult } from "@/lib/web-search/types";

const r = (url: string, title: string, snippet: string): RankedResult =>
  ({
    canonical: url,
    title,
    snippet,
    domain: "example.com",
    publishedDate: "",
  }) as unknown as RankedResult;

describe("§11.3 page-budget fallback packet (TS oracle mirror)", () => {
  it("baseline-quality result gets the SERP baseline passage, snippet-only", () => {
    const p = timeoutFallbackPacket(
      r("https://e/x", "Title Here", "a snippet long enough for baseline"),
    );
    expect(p.classification).toBe("PAGE_BUDGET_TIMEOUT");
    expect(p.extraction).toBe("snippet-only");
    expect(p.passages).toHaveLength(1);
    expect(p.passages[0].passageText.startsWith("[SERP snippet baseline")).toBe(true);
    expect(p.url).toBe("https://e/x");
  });

  it("no baseline: title carries the passage; empty title yields the marker", () => {
    // Both fields under the 12-char baseline floor (serpBaselinePassage gate).
    const tiny = timeoutFallbackPacket(r("https://e/y", "Ti", "ab"));
    expect(tiny.passages[0].passageText).toBe("Ti");

    const none = timeoutFallbackPacket(r("https://e/z", "", "ab"));
    expect(none.passages[0].passageText).toBe(
      "(page read timed out — no content extracted)",
    );
    expect(none.classification).toBe("PAGE_BUDGET_TIMEOUT");
  });
});
