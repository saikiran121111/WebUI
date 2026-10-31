/**
 * Phase 13 omnibox ranking pins (pure TS, node env — no DOM, no .tsx).
 * Pins the omnibox contract: prefix ranks over contains, recency order
 * is preserved inside each tier, URLs dedupe, cap at 8, empty text is
 * silent, and matching is case-insensitive across URL AND title.
 */
import { describe, expect, it } from "vitest";
import {
  OMNIBOX_MAX_RESULTS,
  omniboxSuggest,
  type OmniboxSuggestEntry,
} from "../lib/browser-client/omniboxSuggest";

function e(url: string, title?: string): OmniboxSuggestEntry {
  return title === undefined ? { url } : { url, title };
}

describe("omniboxSuggest (Phase 13)", () => {
  it("returns nothing for empty or whitespace input", () => {
    const entries = [e("https://example.com"), e("https://beta.example", "Example")];
    expect(omniboxSuggest("", entries)).toEqual([]);
    expect(omniboxSuggest("   ", entries)).toEqual([]);
  });

  it("matches URL substrings and title substrings, case-insensitively", () => {
    const entries = [
      e("https://site.com/Docs/Report", "Quarterly"),
      e("https://other.org/page", "docs reference"),
      e("https://nope.org", "nothing here"),
    ];
    // "other.org/page" TITLE-prefixes "doc" → ranks above the entry
    // that only contains it in its URL.
    const got = omniboxSuggest("DOC", entries);
    expect(got.map((x) => x.url)).toEqual([
      "https://other.org/page",
      "https://site.com/Docs/Report",
    ]);
  });

  it("prefix-ranks scheme-less URLs (typing a domain wins over mid-URL hits)", () => {
    const entries = [
      e("https://site.com/search?q=github", "Query"),
      e("https://github.com/torvalds", "Torvalds"),
    ];
    expect(omniboxSuggest("github", entries).map((x) => x.url)).toEqual([
      "https://github.com/torvalds",
      "https://site.com/search?q=github",
    ]);
  });

  it("ranks prefix matches above contains matches; recency order survives inside each tier", () => {
    // Engine returns newest-first; "exa" prefix-matches the second and
    // third entries, contains-matches only the first.
    const entries = [
      e("https://site.com/search?q=exa", "Query"),
      e("https://example.com/newest", "Example site"),
      e("https://exa.io/older", "Exa"),
    ];
    expect(omniboxSuggest("exa", entries).map((x) => x.url)).toEqual([
      "https://example.com/newest",
      "https://exa.io/older",
      "https://site.com/search?q=exa",
    ]);
  });

  it("title prefix counts as a prefix rank", () => {
    const entries = [
      e("https://site.com/a?exa", "find exa here"),
      e("https://site.com/b", "Example page"),
    ];
    expect(omniboxSuggest("exa", entries).map((x) => x.url)).toEqual([
      "https://site.com/b",
      "https://site.com/a?exa",
    ]);
  });

  it("dedupes repeated visits to the same URL, keeping the first (newest)", () => {
    const entries = [
      e("https://dup.com/latest", "Latest"),
      e("https://dup.com/latest", "Latest (again)"),
      e("https://dup.com/other", "Other dup"),
    ];
    const got = omniboxSuggest("dup", entries);
    expect(got).toHaveLength(2);
    expect(got[0].title).toBe("Latest");
  });

  it("caps at OMNIBOX_MAX_RESULTS with prefix tier winning", () => {
    const entries: OmniboxSuggestEntry[] = [
      e("https://site.com?q=git", "contains one"),
    ];
    for (let i = 0; i < 12; i++) entries.push(e(`https://github.com/p/${i}`, `Repo ${i}`));
    const got = omniboxSuggest("git", entries);
    expect(got).toHaveLength(OMNIBOX_MAX_RESULTS);
    expect(got.every((x) => x.url.startsWith("https://github.com"))).toBe(true);
  });

  it("tolerates entries with no title (engine omits blank titles)", () => {
    const entries = [e("https://untitled.dev/page")];
    expect(omniboxSuggest("untitled", entries)).toEqual(entries);
  });
});
