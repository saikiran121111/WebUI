/**
 * F77 (brief 2026-11-21): the EMPTY-ANSWER LAW at the stream-completion
 * seam (lib/chat/web-tool-loop.ts ⇔ Rust chat/web_loop.rs).
 *
 * The saved defect shape: `finishReason:"stop"` + one `[DONE]` + answer ""
 * with `rukeError: null` — a "successful" turn with zero visible content.
 * The loop must never ship that shape:
 *  - an ordinary stop with zero visible content for the whole turn gets ONE
 *    bounded repair: the IDENTICAL payload re-issued once (the failed
 *    attempt streamed zero answer bytes, so nothing can duplicate);
 *  - a repair that lands empty fails the turn with an honest ruke_error —
 *    the blank never rides out as a success;
 *  - the repair owns the terminal frames: the dropped attempt's parked
 *    finish/`[DONE]` die with it, so the stream keeps exactly one `[DONE]`;
 *  - NOT this shape (no repair, no fail): content-carrying stops,
 *    cancellations ("abort"/"interrupted"), truncation ("length"), tool
 *    rounds, and turns whose earlier rounds already released visible text.
 * Content-neutral by construction: no fixture phrases, no topic rules.
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
import { foldDisplay, type LoopEvent } from "./revise-fold";

const dec = new TextDecoder();

function contentDelta(content: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + "\n\n";
}
function toolCallDelta(index: number, rest: Record<string, unknown>): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, ...rest }] } }] }) + "\n\n";
}
function finishFrame(reason: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] }) + "\n\n";
}
const DONE = "data: [DONE]\n\n";

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
          pos += value.length;
          return { done: false, value };
        },
      }),
    },
  };
}

/** The saved defect shape: an ordinary stop carrying zero answer bytes. */
const emptyStopRound = (): string => finishFrame("stop") + DONE;
const answerRound = (text: string): string => contentDelta(text) + finishFrame("stop") + DONE;

interface Harness {
  stages: any[];
  log: LoopEvent[];
  rawText: string;
  closed: number;
  failed: string[];
  fetchBodies: any[];
  calls: number;
}

async function drive(rounds: string[]): Promise<Harness> {
  const h: Harness = { stages: [], log: [], rawText: "", closed: 0, failed: [], fetchBodies: [], calls: 0 };
  const ch: WebProgressChannel = {
    stage: (e) => { h.stages.push(e); h.log.push({ t: "stage", e }); },
    fail: (m) => h.failed.push(m),
    raw: (b) => { const s = dec.decode(b); h.rawText += s; h.log.push({ t: "raw", s }); },
    close: () => { h.closed += 1; },
  };
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    h.fetchBodies.push(JSON.parse(init.body));
    const idx = h.calls++;
    return sseResponse(rounds[Math.min(idx, rounds.length - 1)]);
  });
  vi.stubGlobal("fetch", fetchMock);
  await runWebToolLoop({
    payload: { model: "test-model", messages: [{ role: "user", content: "price of boreal?" }] },
    lastUserIdx: 0,
    fullText: "price of boreal?",
    model: "test-model",
    depth: "quick",
    webCitationMap: null,
    searchGateMeta: { depth: "quick", freshness: "any", decidedBy: "llm", queries: [] },
    ch,
  });
  return h;
}

const countDone = (raw: string): number => raw.split("data: [DONE]").length - 1;
const fold = (h: Harness): string => foldDisplay(h.log);

beforeEach(() => {
  mocks.execWebSearch.mockReset();
  mocks.execReadPage.mockReset();
  mocks.begin.mockReset();
  mocks.end.mockReset();
  mocks.execWebSearch.mockImplementation(async (_s: any, _a: any, fresh: any[]) => {
    fresh.push({ sourceId: "S2", url: "https://retrieved.example/a", title: "A", domain: "retrieved.example" });
    return { ok: true, tool: "web_search", results: [] };
  });
});

describe("F77 empty-answer law at the stream-completion seam", () => {
  it("ordinary stop with zero visible content: ONE bounded repair, and the repair's answer is what the client sees", async () => {
    const h = await drive([emptyStopRound(), answerRound("It costs $50 per seat.")]);
    // Bounded: exactly the first attempt + ONE repair, no more.
    expect(h.calls).toBe(2);
    // The repair re-issued the IDENTICAL payload (no feedback bytes, no
    // prompt edits — the lifecycle that lectured the model stays closed).
    expect(JSON.stringify(h.fetchBodies[1].messages)).toBe(JSON.stringify(h.fetchBodies[0].messages));
    // The dropped attempt's parked terminal frames died with it: the
    // client's fold is ONLY the repair's answer, with exactly one [DONE].
    expect(fold(h)).toBe("It costs $50 per seat.");
    expect(countDone(h.rawText)).toBe(1);
    // A repaired turn is NOT a failure: no ruke_error, one clean close.
    expect(h.failed).toEqual([]);
    expect(h.closed).toBe(1);
  });

  it("repair lands empty too: the turn FAILS honestly; zero frames ride out, no blank success", async () => {
    const h = await drive([emptyStopRound()]); // every call lands empty
    expect(h.calls).toBe(2); // bounded: one attempt + one repair, then stop
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toMatch(/empty answer/i);
    // The loop owns no terminal on the failure path: ch.fail mints the
    // ruke_error + [DONE] (route.ts). The blank stop never reached the wire.
    expect(countDone(h.rawText)).toBe(0);
    expect(h.rawText).toBe("");
    expect(h.closed).toBe(0);
  });

  it("whitespace-only answer is the same shape: zero VISIBLE content", async () => {
    const h = await drive([contentDelta("  \n\t") + finishFrame("stop") + DONE, answerRound("Real answer.")]);
    expect(h.calls).toBe(2);
    expect(fold(h)).toBe("Real answer.");
    expect(countDone(h.rawText)).toBe(1);
    expect(h.failed).toEqual([]);
  });

  it("control: a content-carrying stop gets NO repair (one upstream call)", async () => {
    const h = await drive([answerRound("Boreal costs $99 per seat.")]);
    expect(h.calls).toBe(1);
    expect(fold(h)).toBe("Boreal costs $99 per seat.");
    expect(countDone(h.rawText)).toBe(1);
    expect(h.failed).toEqual([]);
  });

  it("cancellation is preserved: an abort terminal is not an empty answer (no repair, no fail)", async () => {
    const h = await drive([finishFrame("abort") + DONE]);
    expect(h.calls).toBe(1);
    expect(h.failed).toEqual([]);
    expect(h.closed).toBe(1);
  });

  it("truncation is preserved: a length terminal with partial content keeps its existing path", async () => {
    const h = await drive([contentDelta("It costs $50 p") + finishFrame("length") + DONE]);
    expect(h.calls).toBe(1);
    expect(fold(h)).toBe("It costs $50 p");
    expect(h.failed).toEqual([]);
  });

  it("a turn whose tool narration already streamed visible text is complete: an empty final stop is NOT repaired away", async () => {
    const narrate =
      contentDelta("Looking it up. ") +
      toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
      toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing"}' } }) +
      finishFrame("tool_calls") +
      DONE;
    const h = await drive([narrate, emptyStopRound(), emptyStopRound()]);
    // The tool round streams narration, so the turn HAS visible content:
    // the empty final stop releases as-is — NO unbounded repair chase.
    expect(h.calls).toBe(2);
    expect(fold(h)).toContain("Looking it up.");
    expect(countDone(h.rawText)).toBe(1);
    expect(h.failed).toEqual([]);
  });

  it("the cap's forced FINAL round is the same law: empty stop there gets the one repair, then an honest fail", async () => {
    // Quick depth = 4 tool rounds. Four silent tool rounds (NO narration,
    // so the whole turn has zero visible content) exhaust the cap; the
    // forced no-tools final round lands empty → the ONE repair lands empty
    // → the turn fails honestly, exactly once, never as a blank success.
    const silentToolRound =
      toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
      toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing"}' } }) +
      finishFrame("tool_calls") +
      DONE;
    const h = await drive([silentToolRound, silentToolRound, silentToolRound, silentToolRound, emptyStopRound(), emptyStopRound()]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toMatch(/empty answer/i);
    expect(h.closed).toBe(0);
    // Tool rounds swallow their own [DONE]; the empty final + repair keep
    // theirs parked and dropped — the loop emitted NO terminal at all.
    expect(countDone(h.rawText)).toBe(0);
    // Bounded repair, once: final round + one replay, on top of the 4
    // capped tool rounds.
    expect(h.calls).toBe(6);
  });
});
