/**
 * AUDIT 2026-11-05 (brief item 11 / WS11) — excerpt selection still drops
 * the requested facts.
 *
 * Audit repro (verbatim): "A generic matching footer displaces an actual
 * model name earlier in the document. Two distant requested facts retain
 * only the last window. A long catalog loses the required late row after 30
 * earlier rows match generic terms." Cause: "cutPassageWindow centers a
 * single window on the last occurrence of any focus term. selectExcerpt
 * keeps only the first 30 matching table rows beyond its prefix. There is
 * no continuation handle for the dropped section in these interfaces."
 * Fix (verbatim): "Rank several non-overlapping relevant windows, preserve
 * table headers/row identity, and expose truncation/remaining sections."
 *
 * Universal laws pinned here (no brand/site rules — grammar, coverage and
 * document-position structure only; ArborWorks/Boreal fixtures are fictional
 * test data):
 *  - focus windows rank by DISTINCT focus-token coverage weighted by token
 *    rarity (1/frequency in the document), so a boilerplate tail repeating
 *    an already-covered generic token cannot displace an earlier section
 *    carrying a rare requested fact;
 *  - two distant facts each get their own non-overlapping window;
 *  - evidence-block table rows past the cap are ranked across the WHOLE
 *    document (rarest match first), not truncated at the first 30, and the
 *    kept block re-anchors the table header so row identity survives;
 *  - read_page discards are disclosed with a dropped-section count and a
 *    continuation hint, and the byte-identical plain prefix cut is kept for
 *    prefix-only matches (controls below).
 */
import { it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ docs: new Map<string, string>() }));

vi.mock("@/lib/web-search/ssrf", async (original) => ({
  ...(await original<any>()),
  isSafeUrlWithDns: async () => true,
}));

vi.mock("@/lib/web-search/extractor", () => ({
  extractUrl: async (r: any) => {
    const text = state.docs.get(r.url) ?? "";
    return {
      sourceId: "",
      url: r.url,
      domain: "docs.arborworks.example.com",
      title: "Guide",
      extraction: "direct",
      classification: "SUCCESS_DIRECT",
      passages: [
        {
          sourceId: "",
          url: r.url,
          domain: "docs.arborworks.example.com",
          title: "Guide",
          passageText: text,
          bm25Score: 0,
        },
      ],
    };
  },
  renumberPackets: (packets: any[], n = 1) => {
    for (const p of packets) {
      p.sourceId = "S" + n++;
      for (const x of p.passages) x.sourceId = p.sourceId;
    }
  },
}));

import { execReadPageTool, makeWebToolSession } from "@/lib/web-search/tools";
import { evidenceBlock } from "@/lib/web-search/pipeline";

async function read(url: string, focus: string, queryContext: string) {
  const r = await execReadPageTool(
    makeWebToolSession("standard", 1, queryContext),
    { urls: [url], focus },
    [],
  );
  return { r, entry: (r.pages as any[])[0], text: ((r.pages as any[])[0]?.passages ?? []).join("\n") };
}

/* ── document fixtures (fictional, universal shapes only) ───────────────── */

// 1. Generic matching footer displaces the actual model name EARLIER in
//    the document: the footer repeats the generic focus tokens, so the
//    last-occurrence window lands there and loses the answer. The answer
//    sits before the plain 2000-char tail window can reach it, and "edge"
//    is the rare token only the answer carries.
const DOC_FOOTER =
  "ArborWorks platform overview notes. ".repeat(30) +
  "\n\nAt the edge, ArborWorks supports these foundation models: Boreal-X17 (4-bit) and Cedar-Y23 (8-bit)." +
  "\n\nArborWorks deployment update log entry. ".repeat(50) +
  "\n\n© 2026 ArborWorks Corp. All rights reserved. Contact our support team with questions about foundation models availability. Privacy · Terms · Status page.";

// 2. Two distant requested facts retain only the last window.
const DOC_Distant =
  "The ArborWorks sync engine enters general availability in March 2026." +
  "\n\nArborWorks platform update note. ".repeat(92) +
  "Offline mode ships for existing customers in August 2026.";

// 3. Five focus-matched whole sections (~635 chars each, 3183-byte doc)
//    against the 2000-char passage budget: the section packing returns the
//    first three whole and must disclose the two it dropped and offer
//    continuation. (3×635 fit the budget; the 4th cannot with <300 chars
//    remaining, so exactly three sections are returned.)
const mkSection = (token: string, marker: string) =>
  `${token} deployment notes (${token} channel, ${token} rollout, ${token} status, ` +
  `${token} queue, ${token} batch, ${token} wave, ${token} sweep, ${token} pass): ` +
  `${marker}-FACT recorded for tracking. ` +
  `More ${token} notes: ${token} capacity, ${token} quota, ${token} window, ${token} backlog. `.repeat(6);
const DOC_SECTIONS = [
  mkSection("alpha", "ALPHA"),
  mkSection("beta", "BETA"),
  mkSection("gamma", "GAMMA"),
  mkSection("delta", "DELTA"),
  mkSection("epsilon", "EPSILON"),
].join("\n\n");

// 4. Long catalog: 100 generic "region" rows then the required late row
//    carrying the RARE focus token "enterprise".
const CATALOG_TABLE =
  "| Foundation model | Region notes |\n| --- | --- |\n" +
  Array.from(
    { length: 100 },
    (_, i) =>
      `| Catalog entry ${i} | standard region coverage notes for this tier and its region cluster |`,
  ).join("\n") +
  "\n| Boreal-X17 Enterprise tier | dedicated enterprise region nodes |";

beforeEach(() => {
  state.docs.clear();
});

/* ── read_page windowing (tools) ────────────────────────────────────────── */

it("a generic matching footer cannot displace the actual model name earlier in the document", async () => {
  const url = "https://docs.arborworks.example.com/edge-guide";
  state.docs.set(url, DOC_FOOTER);
  expect(DOC_FOOTER.length).toBeGreaterThan(2500);

  const { text } = await read(
    url,
    "which foundation models does arborworks support at the edge",
    "which foundation models does arborworks support at the edge",
  );
  // THE DEFECT: the window centered on the footer's last occurrence of a
  // generic focus token; the model names were discarded.
  expect(text, "the requested model names must survive windowing").toContain("Boreal-X17");
  expect(text).toContain("Cedar-Y23");
});

it("two distant requested facts both survive the window budget", async () => {
  const url = "https://docs.arborworks.example.com/roadmap";
  state.docs.set(url, DOC_Distant);
  expect(DOC_Distant.length).toBeGreaterThan(2500);

  const { text } = await read(
    url,
    "when does the arborworks sync engine and offline mode ship",
    "when does the arborworks sync engine and offline mode ship",
  );
  // THE DEFECT: a single window on the last occurrence keeps only the
  // later fact; the earlier requested fact is dropped.
  expect(text, "the first requested fact (sync engine, March 2026) must survive").toContain("March 2026");
  expect(text, "the second requested fact (offline mode, August 2026) must survive").toContain("August 2026");
});

it("read_page exposes dropped focus-matched sections and a continuation handle", async () => {
  const url = "https://docs.arborworks.example.com/rollout";
  state.docs.set(url, DOC_SECTIONS);
  expect(DOC_SECTIONS.length).toBeGreaterThan(2500);

  const { entry, text } = await read(
    url,
    "alpha beta gamma delta epsilon",
    "alpha beta gamma delta epsilon",
  );
  // Several non-overlapping windows are returned…
  expect(text, "the first distinct focus sections must be returned").toContain("ALPHA-FACT");
  expect(text).toContain("BETA-FACT");
  expect(text).toContain("GAMMA-FACT");
  // …and the DROPPED sections are no longer invisible: the entry discloses
  // their count and offers a continuation affordance (re-call with a
  // different focus) instead of silently discarding them.
  expect(typeof entry.droppedSections, "remaining-sections disclosure").toBe("number");
  expect(entry.droppedSections).toBeGreaterThanOrEqual(1);
  expect(entry.continuationHint ?? "", "continuation handle for dropped sections").toContain("focus");
});

it("control: a focus match only inside the plain prefix keeps the byte-identical prefix cut", async () => {
  const url = "https://docs.arborworks.example.com/log";
  const doc =
    "Boreal-X17 rollout summary for the arborworks platform. " +
    Array.from({ length: 60 }, (_, i) => `Log line ${i}: routine maintenance completed on host ${i}.`).join("\n\n");
  state.docs.set(url, doc);
  expect(doc.length).toBeGreaterThan(2500);

  const { text } = await read(url, "boreal rollout", "boreal rollout summary");
  // No focus match past the cap → the plain 2000-char prefix cut, byte for
  // byte (the pinned windowing law must not churn non-matching pages).
  expect(text).toBe(doc.slice(0, 2000) + "…");
});

/* ── evidence-block catalog selection (pipeline) ────────────────────────── */

it("a long catalog keeps the required late row even after 30 earlier rows match generic terms", () => {
  expect(CATALOG_TABLE.length).toBeGreaterThan(4000);
  const decision: any = {
    search_required: true,
    reason: "controlled lookup",
    depth: "deep",
    freshness: "any",
    queries: [{ query: "ArborWorks enterprise region support", intent: "docs" }],
  };
  const p: any = {
    sourceId: "S1",
    domain: "docs.arborworks.example.com",
    url: "https://docs.arborworks.example.com/catalog",
    title: "Catalog",
    passageText: CATALOG_TABLE,
    bm25Score: 1,
  };
  const result = evidenceBlock({
    topPassages: [p],
    packets: [{ ...p, extraction: "direct", classification: "SUCCESS_DIRECT", passages: [p] }],
    searchGate: { decision },
  } as any);
  // THE DEFECT: rows past the cap were kept in document order, first 30
  // only — the generic "region" rows filled the allowance and the rare
  // "enterprise" row the question asked for was never shown.
  expect(result, "the rare required catalog row must survive past-cap selection").toContain("Boreal-X17 Enterprise tier");
  // Row identity: the kept block re-anchors the table header (it appears
  // both in the prefix and again above the kept rows), and the selection
  // discloses its ranking across the whole document.
  expect((result.match(/\| Foundation model \| Region notes \|/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect(result, "whole-document ranking must disclose kept/matched counts").toMatch(
    /\d+ of \d+ focus-matched rows/,
  );
  expect(result).toContain("not shown");
});
