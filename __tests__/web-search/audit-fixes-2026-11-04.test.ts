/**
 * AUDIT 2026-11-04 REGRESSION VECTORS — each test reproduces a defect the
 * audit found and pins the repaired contract. Pure exports only; the
 * mocked-cascade vectors (provenance / auth classification) live in
 * extractor-provenance.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  rerank,
  tokenize,
} from "@/lib/web-search/reranker";
import { walkGenericJsonForEntities } from "@/lib/web-search/hydration-unpacker";
import { rulesBasedPlan } from "@/lib/web-search/search-gate";
import type { EvidencePacket } from "@/lib/web-search/types";

describe("chunkMarkdown overlap tail (audit item 15)", () => {
  it("the carried-over overlap is the head of the next chunk, not ''", () => {
    // Repro: flush() CLEARS buf, and the overlap tail used to be read
    // from buf AFTER the flush — always "". Two paragraphs straddling
    // the target boundary now carry the true tail.
    const p1 = "A".repeat(1900);
    const p2 = "B".repeat(400);
    const chunks = chunkMarkdown(p1 + "\n\n" + p2, 2000, 300);
    expect(chunks).toHaveLength(2);
    const tail = p1.slice(-300);
    expect(chunks[0].text).toBe(p1);
    expect(chunks[1].text.startsWith(tail)).toBe(true);
    expect(chunks[1].text).toContain("B".repeat(400));
  });
});

describe("tokenize unicode law (audit item 15)", () => {
  it("keeps non-Latin script tokens instead of erasing them", () => {
    const tokens = tokenize("इडली राइस price — ₹149.00 café naïve");
    expect(tokens).toContain("इडली");
    expect(tokens).toContain("राइस");
    expect(tokens).toContain("café");
    expect(tokens).toContain("naïve");
    expect(tokens).toContain("149");
  });
  it("ASCII behavior is byte-identical to the old class", () => {
    expect(tokenize("Zepto's 2-slot cleanup!")).toEqual([
      "zepto",
      "slot",
      "cleanup",
    ]);
  });
});

describe("rerank all-junk fallback (audit item 15)", () => {
  const packetWith = (text: string): EvidencePacket => ({
    sourceId: "S1",
    url: "https://wall.example/login",
    title: "Wall",
    domain: "wall.example",
    publishedAt: "",
    extraction: "direct",
    passages: [
      {
        sourceId: "S1",
        url: "https://wall.example/login",
        title: "Wall",
        domain: "wall.example",
        publishedAt: "",
        passageText: text,
        bm25Score: 0,
      },
    ],
  });

  it("ALL chunks judged pure junk yields NO passages (no resurrection)", () => {
    const junk =
      "We use cookies to improve your experience. By continuing you agree " +
      "to our privacy policy and terms of use. Log in to continue. Follow " +
      "us on social media. All rights reserved.";
    const out = rerank([packetWith(junk)], "zepto idli rice price", []);
    expect(out).toEqual([]);
  });

  it("the fallback law still protects content whose scoring merely MISSED", () => {
    const real =
      "The delivery zone for this store covers Indiranagar in Bengaluru " +
      "with express slots every evening. Combo meals start at reasonable " +
      "prices listed on the store page. Menu items include rice, idli and " +
      "sambar with daily fresh cooking.";
    // Query shares ZERO tokens with the passage → BM25 misses entirely;
    // the legit fallback must still surface the passage (fallback law).
    const out = rerank([packetWith(real)], "zyloquinox plinxthorp", []);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].passageText).toContain("Indiranagar");
  });
});

describe("walkGenericJsonForEntities subtree pruning (audit item 15)", () => {
  it("a branch deeper than maxDepth prunes ONLY itself — siblings still walk", () => {
    // Repro: the old walker returned true (STOP) on depth overflow, so a
    // deep config blob listed first killed the walk before the product
    // array was ever visited — zero cards.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const root = {
      config: deep,
      products: [
        { name: "Idli Rice Combo", price: "₹149", rating: "4.6" },
        { name: "Masala Dosa", price: "₹99", rating: "4.8" },
      ],
    };
    const out = walkGenericJsonForEntities(root, { label: "repro" });
    expect(out).toContain("Idli Rice Combo");
    expect(out).toContain("Masala Dosa");
  });
});

describe("deterministic gate realtime tier (audit item 9)", () => {
  it("a price question plans with freshness realtime (= live_required)", () => {
    const plan = rulesBasedPlan({
      userPrompt: "What is the price of Nike Air Max right now?",
    });
    expect(plan.decision.freshness).toBe("realtime");
    expect(plan.decision.queries.length).toBeGreaterThan(0);
  });
});
