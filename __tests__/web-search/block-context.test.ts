/**
 * Brief §11 — contextual block detection + placeholder isolation.
 *
 * 1. detectBlockInText: the bare keyword "captcha" anywhere in the first
 *    300 chars used to be a wall verdict — it still killed legitimate
 *    security explainers, help docs and bot-gate news. The wall verdict
 *    now needs STRUCTURE: the extraction is thin (challenge copy is the
 *    whole body) or the head pairs the keyword with a distinctive
 *    challenge phrase. HTTP-200 silent challenges stay rejected; the
 *    page-wide quoted wall strings and the HTTP-401/auth classification
 *    (separate status path) stay untouched.
 * 2. chunkMarkdown: page source must never impersonate the chunker's
 *    internal [[ATOMIC_n]] markers (cross-block content injection), and
 *    the atomic-block count is capped so one pathological page cannot
 *    mint unbounded atomic chunks.
 */
import { describe, it, expect } from "vitest";
import { detectBlockInText } from "@/lib/web-search/extractor";
import { chunkMarkdown } from "@/lib/web-search/reranker";

const FILLER =
  "Modern bot management has evolved through decades of adversarial pressure, " +
  "from simple image tests to behavioral telemetry and privacy-preserving attestation. ";

describe("detectBlockInText contextual CAPTCHA law (brief §11)", () => {
  it("a thin extraction whose head mentions the keyword is still a wall (HTTP-200 survivor)", () => {
    const v = detectBlockInText("Complete the captcha below to continue browsing.");
    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/CAPTCHA/);
  });

  it("a long page whose head pairs the keyword with a challenge phrase is a wall", () => {
    const v = detectBlockInText(
      "Captcha required — unusual traffic from your network was detected." + FILLER.repeat(12),
    );
    expect(v.blocked).toBe(true);
  });

  it("a long legitimate article that OPENS with the word is NOT a wall", () => {
    const v = detectBlockInText(
      "The captcha is one of the oldest spam filters on the modern web." + FILLER.repeat(12),
    );
    expect(v.blocked).toBe(false);
  });

  it("quoted wall strings stay page-wide, even deep inside a long article", () => {
    const v = detectBlockInText(FILLER.repeat(12) + " please verify you are human before continuing. " + FILLER.repeat(12));
    expect(v.blocked).toBe(true);
  });

  it("short shells stay blocked on both paths (thin keyword or bare JS shell)", () => {
    const withWord = detectBlockInText("captcha or so");
    expect(withWord.blocked).toBe(true); // thin extraction owns it first
    const bare = detectBlockInText("hi there, nothing else here");
    expect(bare.blocked).toBe(true);
    expect(bare.reason).toMatch(/JS shell/);
  });

  it("login-wall phrases and the head-window challenge phrases are unchanged", () => {
    expect(detectBlockInText("Please log in to continue reading this story." + FILLER.repeat(8)).blocked).toBe(true);
    expect(detectBlockInText(FILLER.repeat(3) + "just a moment while we finalize the layout. " + FILLER.repeat(8)).blocked).toBe(false);
    expect(detectBlockInText("Just a moment — checking your browser before rendering this page.").blocked).toBe(true);
  });
});

describe("chunkMarkdown placeholder isolation + total cap (brief §11)", () => {
  const TABLE = "| column one   | column two   |\n|--------------|--------------|\n| value alpha  | value beta   |";

  it("a literal [[ATOMIC_0]] in page prose never expands into another block's text", () => {
    const chunks = chunkMarkdown(
      "This guide explains how [[ATOMIC_0]] markers swap tables internally.\n\n" + TABLE,
    );
    // The table survives as its own atomic chunk…
    expect(chunks.some((c) => c.text.includes("value alpha"))).toBe(true);
    // …and NO chunk carries an unresolved marker anywhere…
    expect(chunks.every((c) => !c.text.includes("[[ATOMIC"))).toBe(true);
    // …while the neutralized literal stays inert and the table's content
    // was never injected into the prose chunk.
    const prose = chunks.find((c) => c.text.includes("swap tables internally"));
    expect(prose?.text).toContain("[ATOMIC_0]");
    expect(prose?.text.includes("value alpha")).toBe(false);
  });

  it("atomic blocks are capped per page; overflow blocks chunk as normal prose", () => {
    const fence = "```" + "x".repeat(7994) + "```"; // exactly ATOMIC_CAP (8000) chars
    const md = Array.from({ length: 205 }, () => fence).join("\n\n");
    const chunks = chunkMarkdown(md);
    // Full-fence atomic chunks stop at the ceiling…
    expect(chunks.filter((c) => c.text.length === 8000).length).toBe(200);
    // …and the remaining fences still reach the index, sliced as prose.
    expect(chunks.some((c) => c.text.length < 2000 && c.text.includes("xxxx"))).toBe(true);
  });
});
