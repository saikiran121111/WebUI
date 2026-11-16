/**
 * F06 (2026-11-16 brief) - preserved web text must be RECOVERABLE by the
 * consumers that need it, not just copied into a side field nobody reads.
 *
 * The defect chain:
 *   segment-filter drops long zero-coverage prose from the working view,
 *   tools.ts retains THAT filtered view as the session's "retained copy",
 *   so even a correct `read_page ... continuation:true` round can only give
 *   back blocks the filter never pruned - an answer phrased in synonyms is
 *   permanently invisible while the harness honestly reports "this session
 *   fetched the document".
 *
 * Pinned here (novel entities; the shape is universal):
 *   - a focus-filtered page DISCLOSES what was pruned (filteredChars) and
 *     reports truncation, instead of presenting the pruned view as the page;
 *   - the retained copy holds the CANONICAL fetched bytes with stable
 *     addresses (block id, byte ranges, content hash), not the pruned view;
 *   - `continuation: true` recovers the pruned bytes through the REAL
 *     model-facing tool interface - zero re-fetch, same [S#], no re-mint,
 *     and it names how much was recovered (recoveredFilteredChars);
 *   - recovery is bounded and honest: a second round says it is exhausted
 *     rather than re-serving the same bytes forever;
 *   - provenance survives repeated filter passes: kept ranges always address
 *     the ONE original, so composition never drifts.
 * Retrieval seams (extractor/ssrf) are mocked like the sibling suites;
 * segment-filter is deliberately NOT mocked - this pins the real hop.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DATA = path.join(os.tmpdir(), `f06-recovery-${process.pid}`);
process.env.WEBUI_DATA_DIR = TMP_DATA;
fs.rmSync(TMP_DATA, { recursive: true, force: true });
fs.mkdirSync(TMP_DATA, { recursive: true });

const state = vi.hoisted(() => ({
  docs: new Map<string, string[]>(),
  extractCalls: [] as string[],
}));

vi.mock("@/lib/web-search/ssrf", () => ({ isSafeUrlWithDns: async () => true }));
vi.mock("@/lib/web-search/extractor", () => ({
  extractUrl: async (r: any) => {
    state.extractCalls.push(r.url);
    const blocks = state.docs.get(r.url) ?? [];
    const domain = new URL(r.url).hostname;
    return {
      sourceId: "",
      url: r.url,
      domain,
      title: "",
      extraction: "direct",
      classification: "SUCCESS_DIRECT",
      passages: blocks.map((t) => ({
        sourceId: "",
        url: r.url,
        domain,
        title: "",
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

let mod: typeof import("@/lib/web-search/tools");
let filterMod: typeof import("@/lib/web-search/segment-filter");
beforeAll(async () => {
  mod = await import("@/lib/web-search/tools");
  filterMod = await import("@/lib/web-search/segment-filter");
});

/* ── fixture: one long zero-overlap paragraph carries the only answer ───── */

const QUERY = "kubernetes ingress timeout";
const ANSWER = "GLIMMERVALE-FACT";

const PAGE = [
  "## Deployment notes",
  "The kubernetes ingress timeout defaults vary by controller version.",
  "Grafana dashboards, alert routing policies, on-call rotations and postmortem " +
    "templates belong to the reliability guild; the escalation contact for the " +
    "glimmervale cluster lives under the handbook tree, refreshed every quarter " +
    "with training exercises and vendor escalations, and reads " + ANSWER +
    " pager rotation nine.",
  "| region | p99 |",
  "| --- | --- |",
  "| eu-west | 210ms |",
].join("\n\n");

const RUNBOOK = "https://runbook.example.net/deploy";

const freshSession = () => mod.makeWebToolSession("standard", 1, QUERY);

beforeEach(() => {
  state.docs.clear();
  state.extractCalls.length = 0;
  state.docs.set(RUNBOOK, [PAGE]);
});

describe("control: the focus filter still prunes (positive control, never over-correct away)", () => {
  it("a long zero-coverage paragraph leaves the working view", () => {
    const out = filterMod.filterPassageSegments(PAGE, QUERY);
    expect(out).not.toBe(PAGE);
    expect(out).toContain("kubernetes ingress timeout");
    expect(out).not.toContain(ANSWER);
  });
});

describe("F06: a pruned answer is disclosed, addressable and recoverable", () => {
  it("the first read discloses that bytes were pruned instead of passing the pruned view off as the page", async () => {
    const r = await mod.execReadPageTool(freshSession(), { urls: [RUNBOOK], focus: QUERY }, []);
    const entry = (r.pages as any[])[0];
    expect(entry.passages.join("\n")).not.toContain(ANSWER);
    expect(entry.filteredChars ?? 0, "the pruned characters must be reported").toBeGreaterThan(0);
    expect(entry.truncated, "a pruned page is a truncated page").toBe(true);
    expect(String(entry.continuationHint ?? "")).toContain("continuation");
  });

  it("continuation:true recovers the pruned answer through the tool - no re-fetch, same [S#], counted honestly", async () => {
    const s = freshSession();
    const r1 = await mod.execReadPageTool(s, { urls: [RUNBOOK], focus: QUERY }, []);
    expect((r1.pages as any[])[0].passages.join("\n")).not.toContain(ANSWER);
    expect(state.extractCalls).toHaveLength(1);

    const c2: any[] = [];
    const r2 = await mod.execReadPageTool(s, { urls: [RUNBOOK], continuation: true, focus: QUERY }, c2);
    const entry = (r2.pages as any[])[0];
    expect(entry.continuation).toBe(true);
    expect(entry.sourceId, "continuation never mints a second alias").toBe("S1");
    expect(c2, "continuation never re-journals a citation").toHaveLength(0);
    expect(entry.passages.join("\n"), "THE DEFECT: the pruned block was unrecoverable").toContain(ANSWER);
    expect(entry.recoveredFilteredChars ?? 0, "recovery must be reported, not silent").toBeGreaterThan(0);
    expect(state.extractCalls, "zero network on a continuation read").toHaveLength(1);
  });

  it("recovery terminates: the next round reports exhaustion rather than re-serving bytes", async () => {
    const s = freshSession();
    await mod.execReadPageTool(s, { urls: [RUNBOOK], focus: QUERY }, []);
    const r2 = await mod.execReadPageTool(s, { urls: [RUNBOOK], continuation: true, focus: QUERY }, []);
    expect((r2.pages as any[])[0].truncated, "nothing may stay hidden once served").toBe(false);
    const r3 = await mod.execReadPageTool(s, { urls: [RUNBOOK], continuation: true, focus: QUERY }, []);
    const entry = (r3.pages as any[])[0];
    expect(entry.exhausted).toBe(true);
    expect(entry.passages).toHaveLength(0);
    expect(entry.provenanceMismatch ?? false, "the retained copy must still hash to what was fetched").toBe(false);
  });

  it("the retained copy is the canonical fetched bytes with a stable address, not the pruned view", async () => {
    const s = freshSession();
    const r1 = await mod.execReadPageTool(s, { urls: [RUNBOOK], focus: QUERY }, []);
    const doc = [...s.docStore.values()][0];
    const blk = doc.blocks[0];
    const served = (r1.pages as any[])[0].passages.join("");
    expect(blk.text, "retention stores the source bytes, pruned text included").toContain(ANSWER);
    expect(blk.text.length).toBeGreaterThan(served.length);
    expect(blk.id, "block 1 of [S1] has one stable address").toBe("S1#b1");
    expect(blk.contentHash).toMatch(/^[0-9a-f]{8}$/);
    expect(blk.filteredOutRanges.length, "the pruned span is addressable").toBeGreaterThan(0);
    const servedChars = blk.servedRanges.reduce((n, [a, b]) => n + (b - a), 0);
    expect(servedChars).toBeLessThan(blk.text.length);
    expect(blk.servedRanges.every(([a, b]) => a >= 0 && b <= blk.text.length && a < b)).toBe(true);
  });
});

describe("F06: provenance composes across repeated filter passes (never drifts off the original)", () => {
  it("two hops keep addressing the ONE original passage bytes", () => {
    const { applySegmentFilter, mapSpansThroughKept } = filterMod;
    const passage: any = {
      sourceId: "S9",
      url: RUNBOOK,
      domain: "runbook.example.net",
      title: "",
      passageText: PAGE,
      bm25Score: 0,
    };
    const packet: any = { sourceId: "S9", url: RUNBOOK, domain: "runbook.example.net", passages: [passage] };

    applySegmentFilter([packet], QUERY);
    const first = passage.passageText;
    const canonical = passage.originalPassageText;
    expect(first).not.toContain(ANSWER);
    expect(canonical).toBe(PAGE);

    // Second hop, different focus terms: it filters the WORKING VIEW, so its
    // kept ranges are view coordinates - composition must fold them back onto
    // the original bytes, never onto the intermediate view.
    applySegmentFilter([packet], "region p99 eu-west");
    const view2 = passage.passageText;
    const kept = passage.filterKeptRanges as Array<[number, number]>;
    const rebuilt = kept.map(([a, b]) => canonical.slice(a, b)).join("\n\n");
    expect(rebuilt, "kept ranges must reconstruct the current view from the original").toBe(view2);
    expect(kept.map(([a]) => a).every((a) => a >= 0)).toBe(true);
    // The pruned answer span is still recoverable by address, two hops later.
    const gap = canonical.length - kept.reduce((n, [a, b]) => n + (b - a), 0);
    expect(gap).toBeGreaterThan(0);
    expect(mapSpansThroughKept(kept, [[0, 3]])[0]).toEqual([kept[0][0], kept[0][0] + 3]);
  });
});
