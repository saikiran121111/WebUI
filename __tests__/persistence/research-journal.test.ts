/**
 * WS05 (audit 2026-11-05, repair item 5 — "research evidence is
 * conversation-persistent only in the client's prose").  The server keeps a
 * SERVER-OWNED research journal per conversation: every completed research
 * turn records the queries, freshness verdict and the fetched documents'
 * provenance (url/title/domain/published date/fetch date/passage excerpt).
 * Follow-up turns rehydrate the relevant entries — passages, provenance and
 * citation aliases — from the JOURNAL ONLY; client-provided text or metadata
 * is never trusted as proof of a fetch (the journal filename can never be
 * written through the conversation-document POST path, and rehydration
 * reads disk state the client cannot forge).
 *
 * Persistence law mirrors lib/persistence/disk.ts exactly: same DATA_DIR,
 * same id sanitizer, module-load dir constant — hence the queue.test.ts
 * env-set-then-dynamic-import pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FRESHNESS_LOOKBACK_DAYS } from "@/lib/web-search/planner-law";

let journal: typeof import("@/lib/persistence/research-journal");
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws05-journal-"));
  process.env.WEBUI_DATA_DIR = tmpDir;
  journal = await import("@/lib/persistence/research-journal");
});

afterAll(() => {
  delete process.env.WEBUI_DATA_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

function turn(id: string, at: number, queries: string[], url: string, extra?: Partial<any>): any {
  return {
    at,
    queries,
    freshness: "week",
    sources: [
      {
        url,
        title: `Doc: ${queries[0] ?? id}`,
        domain: new URL(url).hostname,
        publishedAt: "2026-10-12",
        fetchedAt: "2026-11-05T09:00:00.000Z",
        excerpt: `Pricing tier details for ${id}.`,
        ...(extra?.source ?? {}),
      },
    ],
    ...extra?.turn,
  };
}

describe("server-owned research journal (WS05)", () => {
  it("a recorded research turn round-trips with full provenance", () => {
    journal.recordResearchTurn("ws05-a", turn("ws05-a", 1, ["arborworks boreal pricing"], "https://docs.arborworks.example/pricing"));
    const got = journal.readResearchJournal("ws05-a");
    expect(got).toHaveLength(1);
    expect(got[0].queries).toEqual(["arborworks boreal pricing"]);
    expect(got[0].sources[0]).toMatchObject({
      url: "https://docs.arborworks.example/pricing",
      domain: "docs.arborworks.example",
      publishedAt: "2026-10-12",
      fetchedAt: "2026-11-05T09:00:00.000Z",
    });
  });

  it("the journal file is a SEPARATE document — never the conversation file", () => {
    const fp = journal.researchJournalFile("ws05-a");
    expect(path.basename(fp)).toBe("ws05-a.research.json");
    expect(fs.existsSync(fp)).toBe(true);
    // The conversation document path (disk.ts `${safe}.json`) is untouched.
    expect(fs.existsSync(path.join(tmpDir, "ws05-a.json"))).toBe(false);
  });

  it("an unreadable or corrupt journal reads as empty — never throws", () => {
    expect(journal.readResearchJournal("ws05-never-written")).toEqual([]);
    fs.writeFileSync(journal.researchJournalFile("ws05-corrupt"), "{not json", "utf-8");
    expect(journal.readResearchJournal("ws05-corrupt")).toEqual([]);
  });

  it("an empty conversation id is inert — never a journal write", () => {
    journal.recordResearchTurn("", turn("", 1, ["anything"], "https://x.example/a"));
    expect(journal.readResearchJournal("")).toEqual([]);
    // Nothing landed under the empty-id name either.
    expect(fs.existsSync(path.join(tmpDir, ".research.json"))).toBe(false);
  });

  it("delete removes the journal (conversation deletion parity)", () => {
    journal.recordResearchTurn("ws05-del", turn("ws05-del", 1, ["arborworks"], "https://x.example/a"));
    expect(journal.readResearchJournal("ws05-del")).toHaveLength(1);
    journal.deleteResearchJournal("ws05-del");
    expect(journal.readResearchJournal("ws05-del")).toEqual([]);
  });

  it("retention is bounded to the most recent turns", () => {
    for (let i = 0; i < 30; i++) {
      journal.recordResearchTurn("ws05-cap", turn(`t${i}`, 1_000_000 + i, [`query number ${i}`], `https://cap.example/${i}`));
    }
    const got = journal.readResearchJournal("ws05-cap");
    expect(got.length).toBeLessThanOrEqual(24);
    expect(got.length).toBe(24);
    // The 24 MOST RECENT survive, oldest-first.
    expect(got[0].queries[0]).toBe("query number 6");
    expect(got[got.length - 1].queries[0]).toBe("query number 29");
  });

  it("source count and excerpt size are bounded per turn", () => {
    const t: any = turn("ws05-bounds", 1, ["q"], "https://b.example/0");
    t.sources = Array.from({ length: 20 }, (_, i) => ({
      ...t.sources[0],
      url: `https://b.example/${i}`,
      excerpt: "x".repeat(700),
    }));
    journal.recordResearchTurn("ws05-bounds", t);
    const got = journal.readResearchJournal("ws05-bounds")[0];
    expect(got.sources.length).toBe(12);
    for (const s of got.sources) expect(s.excerpt.length).toBeLessThanOrEqual(500);
  });
});

describe("follow-up rehydration selects on relevance, recency and conversation (WS05)", () => {
  const arborTurn = turn("arbor", 2_000_000, ["arborworks boreal platform documentation"], "https://docs.arborworks.example/platform");
  const weatherTurn = turn("weather", 3_000_000, ["hyderabad weather forecast today"], "https://weather.example/hyderabad");

  it("a follow-up about the research subject selects the matching turn", () => {
    const picked = journal.selectPriorEvidence([arborTurn, weatherTurn], "What did Boreal say about support tiers?");
    expect(picked).toHaveLength(1);
    expect(picked[0].queries.join(" ")).toMatch(/Boreal/i);
  });

  it("an unrelated follow-up selects nothing — no evidence smuggling", () => {
    expect(journal.selectPriorEvidence([arborTurn, weatherTurn], "explain quicksort partitioning")).toEqual([]);
  });

  it("selection is bounded to the most recent matching turns", () => {
    const many = [1, 2, 3, 4, 5].map((i) => turn(`k${i}`, 10_000 + i, [`boreal support update ${i}`], `https://k.example/${i}`));
    const picked = journal.selectPriorEvidence(many, "more on boreal support please");
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.length).toBeLessThanOrEqual(2);
    expect(picked.map((t: any) => t.at).sort((a: number, b: number) => a - b)).toEqual([10_004, 10_005]);
  });

  it("prior sources re-alias AFTER the current turn's source ids — no collision", () => {
    const built = journal.buildPriorEvidenceBlock([arborTurn], "S2");
    expect(Object.keys(built.citations).sort()).toEqual(["S3"]);
    expect(built.citations["S3"]).toMatchObject({
      sourceId: "S3",
      url: "https://docs.arborworks.example/platform",
      domain: "docs.arborworks.example",
    });
    expect(built.block).toContain("https://docs.arborworks.example/platform");
    expect(built.block).toContain("Pricing tier details for arbor.");
    expect(built.block).toContain("2026-10-12"); // published date is rehydrated
  });

  it("with no current sources, aliases start at S1; empty turns build nothing", () => {
    const built = journal.buildPriorEvidenceBlock([arborTurn], "");
    expect(built.citations["S1"]).toMatchObject({ url: "https://docs.arborworks.example/platform" });
    const none = journal.buildPriorEvidenceBlock([], "S2");
    expect(none.block).toBe("");
    expect(none.citations).toEqual({});
  });

  it("the same document across turns re-aliases ONCE", () => {
    const dupA = turn("dup1", 5_000_000, ["boreal docs"], "https://dup.example/page");
    const dupB = turn("dup2", 6_000_000, ["boreal docs again"], "https://dup.example/page");
    const built = journal.buildPriorEvidenceBlock([dupB, dupA], "S1");
    expect(Object.keys(built.citations)).toHaveLength(1);
  });
});

describe("evidence-reuse law (brief 2026-11-13 L193: shared generic token + recency is insufficient)", () => {
  // Fixed clock so band math is deterministic regardless of wall time.
  const NOW = Date.parse("2026-11-13T12:00:00.000Z");
  const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

  const boreal = turn("boreal-x", 2_000_000, ["arborworks boreal platform documentation"], "https://docs.arborworks.example/platform");
  const weather = turn("weather-x", 3_000_000, ["hyderabad weather forecast today"], "https://weather.example/hyderabad");

  it("relevance: an overlap of generic ask vocabulary alone selects nothing", () => {
    // Old law: "today" (in the weather query) + recency rode the block.
    expect(journal.selectPriorEvidence([boreal, weather], "what about today?")).toEqual([]);
  });

  it("relevance: URL boilerplate and modal politeness never identify a subject", () => {
    // Every journaled url carries ".example"; prompts say "please".
    // Old law: both turns shared "example" → newest two were picked.
    const picked = journal.selectPriorEvidence(
      [boreal, weather],
      "what example should I use, please?",
      { nowMs: NOW },
    );
    expect(picked).toEqual([]);
  });

  it("temporal: a banded ask never silently rides stale-dated evidence", () => {
    const stale = turn("stale", 9_000_000, ["boreal price update"], "https://stale.example/p", {
      source: { publishedAt: ago(130), fetchedAt: ago(120) },
    });
    const picked = journal.selectPriorEvidence([stale], "boreal price update", {
      nowMs: NOW,
      freshness: "day",
    });
    expect(picked).toEqual([]);
  });

  it("temporal: the same evidence rides for an unbanded ask (provenance qualifies it)", () => {
    const stale = turn("stale2", 9_000_001, ["boreal price update"], "https://stale.example/p", {
      source: { publishedAt: ago(130), fetchedAt: ago(120) },
    });
    const picked = journal.selectPriorEvidence([stale], "boreal price update", {
      nowMs: NOW,
      freshness: "none",
    });
    expect(picked).toHaveLength(1);
  });

  it("temporal: evidence inside the band rides", () => {
    const fresh = turn("fresh", 9_000_002, ["boreal price update"], "https://fresh.example/p", {
      source: { publishedAt: ago(4), fetchedAt: ago(3) },
    });
    const picked = journal.selectPriorEvidence([fresh], "boreal price update", {
      nowMs: NOW,
      freshness: "week",
    });
    expect(picked).toHaveLength(1);
  });

  it("temporal (§5f): fresh publication rescues an old server re-read", () => {
    const rescued = turn("rescued", 9_000_003, ["boreal price update"], "https://r.example/p", {
      source: { publishedAt: ago(2), fetchedAt: ago(120) },
    });
    const picked = journal.selectPriorEvidence([rescued], "boreal price update", {
      nowMs: NOW,
      freshness: "week",
    });
    expect(picked).toHaveLength(1);
  });

  it("temporal (§5a two-sided): a future junk stamp can never satisfy a band", () => {
    const junk = turn("junk", 9_000_004, ["boreal price update"], "https://j.example/p", {
      source: { publishedAt: "2099-01-01", fetchedAt: ago(1) },
    });
    const picked = journal.selectPriorEvidence([junk], "boreal price update", {
      nowMs: NOW,
      freshness: "week",
    });
    expect(picked).toEqual([]);
  });

  it("temporal: an undated source is attested by its fetch date", () => {
    const undatedFresh = turn("udf", 9_000_005, ["boreal mystery page"], "https://u1.example/p", {
      source: { publishedAt: undefined, fetchedAt: ago(4) },
    });
    expect(
      journal.selectPriorEvidence([undatedFresh], "boreal mystery page", { nowMs: NOW, freshness: "week" }),
    ).toHaveLength(1);
    const undatedStale = turn("uds", 9_000_006, ["boreal mystery page"], "https://u2.example/p", {
      source: { publishedAt: undefined, fetchedAt: ago(120) },
    });
    expect(
      journal.selectPriorEvidence([undatedStale], "boreal mystery page", { nowMs: NOW, freshness: "week" }),
    ).toEqual([]);
  });

  it("control: a genuine one-token subject overlap still rides (floor = ONE distinguishing token)", () => {
    const picked = journal.selectPriorEvidence([boreal, weather], "what did Boreal say about support tiers?", {
      nowMs: NOW,
      freshness: "none",
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].queries.join(" ")).toMatch(/Boreal/i);
  });

  it("the leaf-mirrored band table is byte-identical to planner law's", () => {
    // The mirror exists so lib/persistence stays a leaf module (importing
    // planner-law would drag metasearch/reranker into the persistence
    // graph). Same law, same numbers — pinned, drift is a test failure.
    expect(journal.REUSE_BAND_DAYS).toEqual(FRESHNESS_LOOKBACK_DAYS);
  });
});
