/**
 * F16 (2026-11-15 brief) - TERMINAL OWNERSHIP IN THE RESEARCH TOOL LOOP.
 *
 * The loop parks only a round's TERMINAL frames (finish_reason / [DONE]) so a
 * late integrity revise can still correct what the human sees. That parking is
 * only safe when the turn's final metadata (web_meta: grounded citations,
 * search-gate decision, action ledger) rides BEFORE the one [DONE] - a client
 * that sees [DONE] closes the turn, so metadata after it is dead bytes (the
 * F16 report: "the web loop releases held terminal frames before final
 * metadata").
 *
 * Pinned here:
 *  - ending round release order = integrity revise -> web_meta -> held
 *    terminal frames, with exactly one [DONE] for the whole stream;
 *  - an intermediate tool round never terminates the conversation stream (its
 *    [DONE] is swallowed, the stream stays open, one close per turn);
 *  - the round-cap path keeps exactly one [DONE] and one close, and its
 *    metadata still precedes the restored terminal.
 *
 * Every upstream is a MOCK SSE string: no model, no port 8080, no Strata.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execWebSearch: vi.fn(),
  execReadPage: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@/lib/web-search/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/tools")>()),
  execWebSearchTool: mocks.execWebSearch,
  execReadPageTool: mocks.execReadPage,
}));
vi.mock("@/lib/server/settings", () => ({
  llmApiUrl: () => "http://127.0.0.1:1234/v1/chat/completions",
  llmApiKey: () => "test-key",
}));
vi.mock("@/lib/server/inference-busy", () => ({
  beginUserTurn: mocks.begin,
  endUserTurn: mocks.end,
}));
vi.mock("@/lib/server/logger", () => ({
  childLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { runWebToolLoop, type WebProgressChannel } from "@/lib/chat/web-tool-loop";
// The real ledger recorder survives the importOriginal spread above. A mocked
// executor that mints no action record cannot exercise the ENDING round's
// ledger-gated web_meta, so the mock records the action it simulates; the
// provenance (id/at/round) stays server-minted inside recordAction.
import { recordAction } from "@/lib/web-search/tools";
import { foldDisplay, type LoopEvent } from "./revise-fold";

const dec = new TextDecoder();
const contentDelta = (c: string) =>
  "data: " + JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] }) + "\n\n";
const toolCallDelta = (i: number, rest: Record<string, unknown>) =>
  "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, ...rest }] } }] }) + "\n\n";
const finishFrame = (r: string) =>
  "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: r }] }) + "\n\n";
const DONE = "data: [DONE]\n\n";
const answerRound = (t: string) => contentDelta(t) + finishFrame("stop") + DONE;
const toolRound = (q: string) =>
  contentDelta("Searching " + q + ". ") +
  toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
  toolCallDelta(0, { function: { arguments: JSON.stringify({ query: q }) } }) +
  finishFrame("tool_calls") +
  DONE;

function sseResponse(sse: string, chunkSize = 97): unknown {
  const bytes = new TextEncoder().encode(sse);
  let pos = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => ({
        read: async () => {
          if (pos >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(pos, pos + chunkSize);
          pos += value.length; // deliberate mid-frame splits, like the sibling suite
          return { done: false, value };
        },
      }),
    },
  };
}

interface Harness {
  log: LoopEvent[];
  rawText: string;
  closed: number;
  calls: number;
}

async function drive(rounds: string[], citationMap: Record<string, any> | null): Promise<Harness> {
  const h: Harness = { log: [], rawText: "", closed: 0, calls: 0 };
  const ch: WebProgressChannel = {
    stage: (e) => { h.log.push({ t: "stage", e }); },
    fail: () => {},
    raw: (b) => { const s = dec.decode(b); h.rawText += s; h.log.push({ t: "raw", s }); },
    close: () => { h.closed += 1; },
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, _init: any) => {
    const idx = h.calls++;
    return sseResponse(rounds[Math.min(idx, rounds.length - 1)]);
  }));
  await runWebToolLoop({
    payload: { model: "test-model", messages: [{ role: "user", content: "price of boreal?" }] },
    lastUserIdx: 0,
    fullText: "price of boreal?",
    model: "test-model",
    depth: "quick",
    webCitationMap: citationMap,
    searchGateMeta: { depth: "quick", freshness: "any", decidedBy: "llm", queries: [] },
    ch,
  });
  return h;
}

const first = (h: Harness, pred: (e: LoopEvent) => boolean): number =>
  h.log.findIndex((e) => pred(e));
/** The research loop emits one web_meta per tool round (OVERWRITE law: each
 *  carries the full cumulative set), so terminal ownership is about the turn's
 *  LAST metadata frame, not its first. */
const last = (h: Harness, pred: (e: LoopEvent) => boolean): number => {
  for (let i = h.log.length - 1; i >= 0; i--) if (pred(h.log[i])) return i;
  return -1;
};
const rawHas = (needle: string) => (e: LoopEvent) => e.t === "raw" && e.s.includes(needle);
const stageIs = (name: string) => (e: LoopEvent) => e.t === "stage" && e.e?.stage === name;
const countDone = (raw: string): number => raw.split("data: [DONE]").length - 1;

const S1 = { S1: { sourceId: "S1", url: "https://docs.arborworks.example", title: "Docs", domain: "arborworks.example" } };

beforeEach(() => {
  mocks.execWebSearch.mockReset();
  mocks.execReadPage.mockReset();
  mocks.begin.mockReset();
  mocks.end.mockReset();
  mocks.execWebSearch.mockImplementation(async (session: any, _a: any, fresh: any[]) => {
    fresh.push({ sourceId: "S2", url: "https://retrieved.example/a", title: "A", domain: "retrieved.example" });
    recordAction(session, { tool: "web_search", ok: true, requested: 1, retrieved: 1, failed: 0 });
    return { ok: true, tool: "web_search", results: [] };
  });
});

describe("F16 - the ending round releases metadata BEFORE its terminal frames", () => {
  it("multi-round: revise -> web_meta -> held finish/[DONE], exactly one [DONE], one close", async () => {
    const h = await drive([toolRound("boreal pricing"), answerRound("It costs $50 [S9].")], S1);

    const revise = first(h, stageIs("web:content_revise"));
    const meta = last(h, stageIs("web_meta"));
    const done = last(h, rawHas("[DONE]"));
    expect(revise, "the dangling alias owes an integrity revise frame").toBeGreaterThan(-1);
    expect(meta, "an executed action owes grounded metadata").toBeGreaterThan(-1);
    expect(done, "the wire owes exactly one terminal").toBeGreaterThan(-1);
    expect(revise, "the revise must precede the final metadata").toBeLessThan(meta);
    expect(meta, "web_meta must reach the client BEFORE the terminal that closes the turn").toBeLessThan(done);
    expect(countDone(h.rawText), "exactly one [DONE] for the whole stream").toBe(1);
    expect(h.closed, "one close per turn - a tool round must not close the stream").toBe(1);
    expect(h.calls).toBe(2);
    expect(foldDisplay(h.log), "the displayed bytes are the audited text").not.toContain("[S9]");
  });

  it("clean answer: web_meta still precedes the single [DONE]", async () => {
    const h = await drive([toolRound("boreal pricing"), answerRound("It costs $50 [S2].")], S1);
    const meta = last(h, stageIs("web_meta"));
    const done = last(h, rawHas("[DONE]"));
    expect(meta).toBeGreaterThan(-1);
    expect(meta, "the turn's final metadata precedes its terminal").toBeLessThan(done);
    expect(h.log.some((e) => e.t === "stage" && e.e?.stage === "web:content_revise"), "a clean audit owns no revise").toBe(false);
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
    expect(foldDisplay(h.log)).toBe("Searching boreal pricing. It costs $50 [S2].");
  });

  it("the round-cap path forces its answer without a second terminal", async () => {
    const h = await drive([toolRound("a"), toolRound("b"), toolRound("c"), toolRound("d")], S1);
    expect(h.calls, "the cap plus the forced no-tools final round").toBeGreaterThanOrEqual(2);
    expect(countDone(h.rawText), "exactly one terminal on the wire").toBe(1);
    expect(h.closed, "one close per turn, after the final release").toBe(1);
    const meta = last(h, stageIs("web_meta"));
    const done = last(h, rawHas("[DONE]"));
    expect(meta, "metadata still precedes the restored terminal").toBeLessThan(done);
  });
});