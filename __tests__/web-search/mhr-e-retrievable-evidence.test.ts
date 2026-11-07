/**
 * MHR-E / WS25 (brief 2026-11-05): read_page evidence must be RETRIEVABLE,
 * not just previewed. Harness laws pinned here (fictional entities only —
 * fernworks/mistlakedaily/cedarbrook are test data, not vocabulary):
 *  - ONE source registry per session: the same document gets the same [S#]
 *    in every wave; citation ids are minted once per document, never per call;
 *  - fetched evidence blocks are ADDRESSABLE (§N refs ride alongside the
 *    returned passages) so a follow-up can point at a specific block;
 *  - `continuation: true` retrieves the REST of an already-fetched document
 *    from the session's retained copy — zero re-fetch, zero re-minted id,
 *    and no read_page URL-budget charge (budgets bound RESOURCES, they never
 *    define what is true);
 *  - a continuation miss fails HONESTLY (structured failure), never a guess;
 *  - the journal carries passages + refs BEYOND the 500-char preview, so a
 *    follow-up turn rehydrates real evidence, not just a headline;
 *  - citation titles never go out empty (fall back to the domain).
 * Retrieval seams are mocked (extractor/ssrf/segment-filter) exactly like
 * the shared vector suite — this pins the envelope contract, never network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The journal module captures WEBUI_DATA_DIR at MODULE LOAD — set the temp
// data dir BEFORE the dynamic imports below (same law as journal.test.ts).
const TMP_DATA = path.join(os.tmpdir(), `mhr-e-journal-${process.pid}`);
process.env.WEBUI_DATA_DIR = TMP_DATA;
fs.rmSync(TMP_DATA, { recursive: true, force: true });
fs.mkdirSync(TMP_DATA, { recursive: true });

const state = vi.hoisted(() => ({
  docs: new Map<string, string[]>(), // url -> fetched passage-block texts
  titles: new Map<string, string>(), // url -> extracted page title
  extractCalls: [] as string[],
}));

vi.mock("@/lib/web-search/ssrf", () => ({
  isSafeUrlWithDns: async () => true,
}));
vi.mock("@/lib/web-search/extractor", () => ({
  extractUrl: async (r: any) => {
    state.extractCalls.push(r.url);
    const blocks = state.docs.get(r.url) ?? [];
    const domain = new URL(r.url).hostname;
    const title = state.titles.get(r.url) ?? "";
    return {
      sourceId: "",
      url: r.url,
      domain,
      title,
      extraction: "direct",
      classification: "SUCCESS_DIRECT",
      passages: blocks.map((t) => ({
        sourceId: "",
        url: r.url,
        domain,
        title,
        passageText: t,
        bm25Score: 0,
      })),
    };
  },
  renumberPackets: (packets: any[], n = 1) => {
    for (const p of packets) {
      p.sourceId = "S" + n++;
      for (const x of p.passages) x.sourceId = p.sourceId;
    }
  },
}));
vi.mock("@/lib/web-search/segment-filter", () => ({
  applySegmentFilter: () => {
    /* focus pruning is exercised by the WS11 suite; identity here keeps the
       §ref/continuation math on the RAW fetched blocks. */
  },
}));

// Dynamic imports: after WEBUI_DATA_DIR was set (tools.ts statically pulls
// lib/persistence/research-journal, which freezes DATA_DIR at load). The
// imports land in beforeAll — same law and tsc-clean shape as
// research-journal.test.ts (no top-level await in the tsc project).
let mod: typeof import("@/lib/web-search/tools");
let journal: typeof import("@/lib/persistence/research-journal");
beforeAll(async () => {
  mod = await import("@/lib/web-search/tools");
  journal = await import("@/lib/persistence/research-journal");
});

const TS_TOOLS = path.resolve(__dirname, "..", "..", "lib", "web-search", "tools.ts");

/* ── fictional fixtures (universal document shapes only) ─────────────────── */

const mkBlock = (token: string, marker: string) =>
  `${token} deployment notes (${token} channel, ${token} rollout, ${token} status, ` +
  `${token} queue, ${token} batch, ${token} wave, ${token} sweep, ${token} pass): ` +
  `${marker}-FACT recorded for tracking. ` +
  `More ${token} notes: ${token} capacity, ${token} quota, ${token} window, ${token} backlog. `.repeat(6);

// One more whole block than MAX_PASSAGES_PER_PAGE: past the per-read cap the
// LAST block is dropped — MHR-E must disclose the drop and make it retrievable
// without a re-fetch. The count is DERIVED from the shipped constant so the
// fixture tracks the harness resource, never literals (2026-11-07).
const buildBlocks = (n: number) =>
  Array.from({ length: n }, (_, i) => mkBlock(`drop${i + 1}`, `DROP${i + 1}`));

// One oversized block of five sections, FOUR focus-matched. Section size is
// DERIVED from MAX_PASSAGE_CHARS so the window arithmetic holds at any cap:
// 6-char tokens keep every section the same length; reps pick the largest
// multiple with THREE whole sections inside the budget (3L ≤ cap) and a
// leftover under selectFocusWindows' 300-char partial-window floor
// (cap − 3L < 300 ⇒ the fourth section cannot be windowed in), so the first
// pass serves exactly walnut+pepper+poplar whole and MUST leave the fourth
// focus-matched section (WILLOW) out — continuation owes it back. The three
// asserts inside are the fixture contract: if a shipped constant changes
// shape, this test fails LOUD before any journey silently degrades.
const docWindow = (cap: number) => {
  const unit = mkBlock("walnut", "WALNUT").length;
  const reps = Math.max(1, Math.floor(cap / 3 / unit));
  const L = unit * reps;
  expect(3 * L).toBeLessThanOrEqual(cap);
  expect(cap - 3 * L).toBeLessThan(300);
  expect(4 * L).toBeGreaterThan(cap); // focus facts live past the plain prefix ⇒ section-aware path, not the byte-locked cut
  return ["walnut", "pepper", "poplar", "willow", "cedars"]
    .map((t) => mkBlock(t, t.toUpperCase()).repeat(reps))
    .join("\n\n");
};
const DOC_FOCUS1 = "walnut pepper poplar willow";
const DOC_FOCUS2 = "willow cedars";

const FERN = "https://fernworks.example/rollout";
const MIST = "https://mistlakedaily.example/pricing";

function freshSession() {
  return mod.makeWebToolSession("standard", 1, "fernworks rollout plan");
}

beforeEach(() => {
  state.docs.clear();
  state.titles.clear();
  state.extractCalls.length = 0;
});

/* ── one registry, one [S#] per document, every wave ────────────────────── */

describe("MHR-E source registry", () => {
  it("the same URL read in two waves keeps ONE [S#] — no second id is minted", async () => {
    state.docs.set(FERN, [mkBlock("pricing", "PRICING")]);
    const s = freshSession();
    const c1: any[] = [];
    const c2: any[] = [];
    await mod.execReadPageTool(s, { urls: [FERN] }, c1);
    expect(c1).toHaveLength(1);
    expect(c1[0].sourceId).toBe("S1");
    expect(s.nextSource).toBe(2);
    const r2 = await mod.execReadPageTool(s, { urls: [FERN] }, c2);
    // THE DEFECT: every wave minted a fresh id — the same document existed
    // under two aliases and the citation map could not join them.
    expect(c2.map((c) => c.sourceId), "registry must reuse the minted alias").toEqual(["S1"]);
    expect((r2.pages as any[])[0].sourceId).toBe("S1");
    expect(s.nextSource, "no re-mint on a registry hit").toBe(2);
    expect(state.extractCalls).toHaveLength(2); // fresh fetch is still a fetch
  });

  it("control: distinct documents still mint distinct sequential ids", async () => {
    state.docs.set(FERN, [mkBlock("pricing", "PRICING")]);
    state.docs.set(MIST, [mkBlock("cost", "COST")]);
    const c: any[] = [];
    await mod.execReadPageTool(freshSession(), { urls: [FERN, MIST] }, c);
    expect(c.map((x) => x.sourceId)).toEqual(["S1", "S2"]);
  });

  it("citation title never goes out empty — it falls back to the domain", async () => {
    state.docs.set(FERN, [mkBlock("pricing", "PRICING")]);
    const c: any[] = [];
    await mod.execReadPageTool(freshSession(), { urls: [FERN] }, c);
    expect(c[0].title, "empty extracted title must not become an empty citation").toBe(
      "fernworks.example",
    );
  });
});

/* ── passage refs: fetched evidence is addressable, not just printable ──── */

describe("MHR-E passage refs", () => {
  it("each returned passage carries a §N ref aligned with its document block", async () => {
    state.docs.set(FERN, [mkBlock("alpha", "ALPHA"), mkBlock("beta", "BETA")]);
    const r = await mod.execReadPageTool(freshSession(), { urls: [FERN] }, []);
    const entry = (r.pages as any[])[0];
    expect(Array.isArray(entry.passageRefs), "passages must be addressable by ref").toBe(true);
    expect(entry.passageRefs).toHaveLength(entry.passages.length);
    expect(entry.passageRefs).toEqual(["§1", "§2"]);
  });

  it("a windowed oversized block is still addressed by its block ref", async () => {
    state.docs.set(FERN, [docWindow(mod.MAX_PASSAGE_CHARS)]);
    const r = await mod.execReadPageTool(
      freshSession(),
      { urls: [FERN], focus: DOC_FOCUS1 },
      [],
    );
    const entry = (r.pages as any[])[0];
    expect(entry.passages.length).toBeGreaterThanOrEqual(1);
    expect(entry.passageRefs).toEqual(["§1"]); // the window belongs to block 1
  });
});

/* ── continuation: retrieve what the first pass left behind ─────────────── */

describe("MHR-E read_page continuation", () => {
  it("the dropped last block comes back with continuation:true — zero re-fetch, same [S#], no budget charge", async () => {
    state.docs.set(FERN, buildBlocks(mod.MAX_PASSAGES_PER_PAGE + 1));
    const s = freshSession();
    const r1 = await mod.execReadPageTool(s, { urls: [FERN] }, []);
    const e1 = (r1.pages as any[])[0];
    expect(e1.passages).toHaveLength(mod.MAX_PASSAGES_PER_PAGE);
    // THE DEFECT: a whole dropped block was invisible — truncated only saw
    // the window-cut flag and the entry carried no block-drop disclosure.
    expect(e1.truncated, "a dropped whole block must disclose truncation").toBe(true);
    expect(e1.droppedBlocks).toBe(1);
    expect(e1.continuationHint ?? "", "the hint must offer continuation").toContain("focus");
    expect(e1.continuationHint ?? "", "the hint must name the continuation flag").toContain("continuation");

    const c2: any[] = [];
    const r2 = await mod.execReadPageTool(s, { urls: [FERN], continuation: true }, c2);
    const e2 = (r2.pages as any[])[0];
    const lastRef = `§${mod.MAX_PASSAGES_PER_PAGE + 1}`;
    expect(e2.passages.join("\n"), "the dropped block must be retrievable").toContain(
      `DROP${mod.MAX_PASSAGES_PER_PAGE + 1}-FACT`,
    );
    expect(e2.passageRefs).toEqual([lastRef]);
    expect(e2.sourceId, "continuation re-serves the SAME document alias").toBe("S1");
    expect(state.extractCalls, "continuation is served from the session's retained copy — no network").toHaveLength(1);
    expect(c2, "no new citation is minted for a retained document").toHaveLength(0);
    expect(s.readUrlsUsed, "zero network ⇒ the read budget is not charged").toBe(1);
    const act = s.actionLedger[s.actionLedger.length - 1];
    expect(act.tool).toBe("read_page");
    expect(act.retrieved).toBeGreaterThanOrEqual(1);
  });

  it("continuation with a different focus returns the REMAINDER of a windowed block (still no re-fetch)", async () => {
    state.docs.set(FERN, [docWindow(mod.MAX_PASSAGE_CHARS)]);
    const s = freshSession();
    const r1 = await mod.execReadPageTool(s, { urls: [FERN], focus: DOC_FOCUS1 }, []);
    const e1 = (r1.pages as any[])[0];
    const t1 = e1.passages.join("\n");
    expect(t1).toContain("WALNUT-FACT");
    expect(t1, "the first pass windows only part of the block").not.toContain("WILLOW-FACT");
    expect(e1.droppedSections).toBeGreaterThanOrEqual(1);

    const r2 = await mod.execReadPageTool(s, { urls: [FERN], focus: DOC_FOCUS2, continuation: true }, []);
    const e2 = (r2.pages as any[])[0];
    expect(e2.passages.join("\n"), "the left-behind focus section must be retrievable").toContain(
      "WILLOW-FACT",
    );
    expect(state.extractCalls).toHaveLength(1);
    expect(e2.sourceId).toBe("S1");
  });

  it("a continuation for a document this session never fetched fails HONESTLY — never a guess", async () => {
    const s = freshSession();
    const r = await mod.execReadPageTool(s, { urls: [FERN], continuation: true }, []);
    expect(r.ok).toBe(true);
    const failures = (r.failures as any[]) ?? [];
    expect(failures.map((f) => f.failure), "unknown continuation target is a structured failure").toContain(
      "continuation_unavailable",
    );
    expect(String(failures[0]?.detail ?? "")).toMatch(/fetch|read/i);
    expect(state.extractCalls, "a failed continuation must not silently re-fetch either").toHaveLength(0);
  });

  it("continuation is NOT blocked by a spent read budget — budgets bound resources, they never define truth", async () => {
    state.docs.set(FERN, buildBlocks(mod.MAX_PASSAGES_PER_PAGE + 1));
    const s = freshSession();
    await mod.execReadPageTool(s, { urls: [FERN] }, []);
    s.readUrlsUsed = s.budget.maxReadUrls; // read budget fully spent
    const r = await mod.execReadPageTool(s, { urls: [FERN], continuation: true }, []);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r), "no budget_exhausted on a zero-network continuation").not.toContain("budget_exhausted");
    expect(((r.pages as any[])[0].passages as string[]).join("\n")).toContain(
      `DROP${mod.MAX_PASSAGES_PER_PAGE + 1}-FACT`,
    );
  });

  it("when nothing is left, continuation says so plainly instead of repeating served text", async () => {
    state.docs.set(FERN, buildBlocks(mod.MAX_PASSAGES_PER_PAGE + 1));
    const s = freshSession();
    await mod.execReadPageTool(s, { urls: [FERN] }, []);
    await mod.execReadPageTool(s, { urls: [FERN], continuation: true }, []);
    const r = await mod.execReadPageTool(s, { urls: [FERN], continuation: true }, []);
    const e = (r.pages as any[])[0];
    expect(e.passages, "exhausted continuation serves nothing new").toHaveLength(0);
    expect(e.exhausted, "the exhausted state must be explicit").toBe(true);
    expect(state.extractCalls).toHaveLength(1);
  });
});

/* ── the model must be TOLD continuation + refs exist ───────────────────── */

describe("MHR-E model-visible read_page surface", () => {
  it("read_page declares the continuation boolean", () => {
    const rp = mod.webToolDefinitions()[1].function.parameters as Record<string, any>;
    expect(rp.properties.continuation?.type, "continuation must be a declared option").toBe("boolean");
    expect(rp.required).toEqual(["urls"]);
    expect(rp.additionalProperties).toBe(false);
  });

  it("the read_page description mentions continuation and refs, exactly once in tools.ts", () => {
    expect(mod.READ_PAGE_TOOL_DESCRIPTION).toMatch(/continuation/i);
    expect(mod.READ_PAGE_TOOL_DESCRIPTION).toMatch(/§|block|section/);
    const src = fs.readFileSync(TS_TOOLS, "utf8").replace(/\r\n/g, "\n");
    expect(src.split(mod.READ_PAGE_TOOL_DESCRIPTION).length - 1).toBe(1);
  });
});

/* ── the journal keeps EVIDENCE, not just a headline ────────────────────── */

describe("MHR-E journal beyond the 500-char preview", () => {
  it("read_page journals fetched passages WITH refs — follow-ups get more than the preview", async () => {
    const conv = "ws25e-j1";
    state.docs.set(FERN, [mkBlock("alpha", "ALPHA"), mkBlock("beta", "BETA")]);
    const s = mod.makeWebToolSession("standard", 1, "fernworks rollout", null, false, {
      id: conv,
      currentDate: "2026-11-05",
    });
    await mod.execReadPageTool(s, { urls: [FERN] }, []);
    const turns = journal.readResearchJournal(conv);
    expect(turns, "read_page findings must journal under the conversation").toHaveLength(1);
    const src: any = turns[0].sources[0];
    expect(src.url).toBe(FERN);
    expect(src.excerpt.length).toBeLessThanOrEqual(500);
    // THE DEFECT: only a ≤500-char preview survived — a follow-up turn could
    // not see a fact the server had demonstrably fetched and served.
    expect(Array.isArray(src.passages), "journaled passages ride beyond the excerpt").toBe(true);
    expect(src.passages!.map((p: { ref: string }) => p.ref)).toEqual(["§1", "§2"]);
    const all = JSON.stringify(src);
    expect(all, "the SECOND block's fact must survive journaling").toContain("BETA-FACT");
    expect(src.passages![0].text.length, "journaled passage beats the preview length").toBeGreaterThan(
      src.excerpt.length,
    );
  });

  it("clampTurn caps journaled passages at 3 x 700 chars — evidence, not an archive", () => {
    const conv = "ws25e-j2";
    journal.recordResearchTurn(conv, {
      at: Date.now(),
      currentDate: "2026-11-05",
      queries: [],
      freshness: "any",
      sources: [
        {
          url: MIST,
          title: "Mistlakedaily",
          domain: "mistlakedaily.example",
          fetchedAt: new Date().toISOString(),
          excerpt: "preview",
          passages: Array.from({ length: 5 }, (_, i) => ({
            ref: `§${i + 1}`,
            text: "x".repeat(900),
          })) as any,
        } as any,
      ],
    });
    const src: any = journal.readResearchJournal(conv)[0].sources[0];
    expect(src.passages).toHaveLength(3);
    for (const p of src.passages) {
      expect(p.text.length).toBeLessThanOrEqual(700);
    }
    expect(src.passages[0].ref).toBe("§1");
  });

  it("prior-evidence blocks carry §-addressed passages and merge same-URL turns under one alias", () => {
    const conv = "ws25e-j3";
    const iso = new Date().toISOString();
    journal.recordResearchTurn(conv, {
      at: 1,
      queries: ["fernworks rollout"],
      freshness: "any",
      sources: [
        {
          url: FERN,
          title: "Fernworks rollout",
          domain: "fernworks.example",
          fetchedAt: iso,
          excerpt: "ALPHA preview headline",
          passages: [{ ref: "§1", text: "…ALPHA-FACT first window…" }],
        } as any,
      ],
    });
    journal.recordResearchTurn(conv, {
      at: 2,
      queries: ["fernworks rollout"],
      freshness: "any",
      sources: [
        {
          url: FERN,
          title: "Fernworks rollout",
          domain: "fernworks.example",
          fetchedAt: iso,
          excerpt: "ALPHA preview headline",
          passages: [{ ref: "§2", text: "…BETA-FACT second block…" }],
        } as any,
      ],
    });
    const turns = journal.readResearchJournal(conv);
    const built = journal.buildPriorEvidenceBlock(turns, "S2");
    expect(Object.keys(built.citations), "one document = one alias across turns").toEqual(["S3"]);
    expect(built.block).toContain("§2:");
    expect(built.block).toContain("BETA-FACT");
    expect(built.block).toContain("§1:");
    expect(built.block.match(/fernworks\.example\/rollout/g), "url appears once").toHaveLength(1);
  });
});
