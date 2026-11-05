/**
 * P2 web tool loop — lib/chat/web-tool-loop.ts (⇔ Rust chat/web_loop.rs).
 *
 * The upstream model server is faked with a queue of SSE `fetch` stubs, so
 * every invariant that matters is pinned WITHOUT a live model:
 *   - guidance injected in the skill slot (before the last user turn);
 *   - tools array injected, and REMOVED for the forced final round;
 *   - exactly ONE `data: [DONE]` reaches the client across multi-round
 *     turns, including when the model misbehaves on the final round;
 *   - tool-call fragments merge by index into the assistant message;
 *   - citation seeds merge into the [S#] map and re-emit a web_meta frame
 *     (the hooks/useChat OVERWRITE law);
 *   - begin/endUserTurn fires exactly once for the WHOLE loop (Rule 5);
 *   - think-tag scrubbing matches the passthrough path byte-for-byte.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import {
  runWebToolLoop,
  WEB_TOOL_GUIDANCE,
  WEB_TOOL_FINAL_DIRECTIVE,
  type WebProgressChannel,
} from "@/lib/chat/web-tool-loop";
// REAL recordAction: the tools mock only overrides the executors, so a
// WS18 exec mock can record into the loop's own session like production.
import { recordAction } from "@/lib/web-search/tools";
import type { StageEvent } from "@/lib/types";

/* ── SSE plumbing ──────────────────────────────────────────────────────── */

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

/** Response-like stub; the default chunk size deliberately splits frames. */
function sseResponse(sse: string, chunkSize = 97): unknown {
  const bytes = new TextEncoder().encode(sse);
  let pos = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (pos >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(pos, pos + chunkSize);
          pos += chunkSize;
          return { done: false, value };
        },
      }),
    },
  };
}

const toolRound = (name: string, id: string, argsFragments: string[]): unknown => {
  const parts = [
    toolCallDelta(0, { id, function: { name } }),
    ...argsFragments.map((a) => toolCallDelta(0, { function: { arguments: a } })),
  ];
  return sseResponse(parts.join("") + finishFrame("tool_calls") + DONE);
};
const answerRound = (text: string): unknown =>
  sseResponse(contentDelta(text) + finishFrame("stop") + DONE);

/* ── harness ───────────────────────────────────────────────────────────── */

interface Harness {
  stages: StageEvent[];
  rawText: string;
  closed: number;
  failed: string[];
  fetchBodies: any[];
  calls: number;
}

function makeHarness(): Harness {
  return { stages: [], rawText: "", closed: 0, failed: [], fetchBodies: [], calls: 0 };
}

function channelFor(h: Harness): WebProgressChannel {
  return {
    stage: (e) => h.stages.push(e),
    fail: (m) => h.failed.push(m),
    raw: (b) => { h.rawText += dec.decode(b); },
    close: () => { h.closed += 1; },
  };
}

function payloadFor(): any {
  return { model: "test-model", messages: [{ role: "user", content: "what is the latest?" }] };
}

async function drive(
  h: Harness,
  rounds: unknown[],
  opts: {
    payload?: any;
    depth?: "quick" | "standard" | "deep";
    citationMap?: Record<string, any> | null;
    signal?: AbortSignal;
  } = {},
): Promise<ReturnType<typeof vi.fn>> {
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    h.fetchBodies.push(JSON.parse(init.body));
    const idx = h.calls++;
    return rounds[Math.min(idx, rounds.length - 1)];
  });
  vi.stubGlobal("fetch", fetchMock);
  await runWebToolLoop({
    payload: opts.payload ?? payloadFor(),
    lastUserIdx: 0,
    fullText: "what is the latest?",
    model: "test-model",
    depth: opts.depth ?? "standard",
    webCitationMap: opts.citationMap === undefined
      ? { S1: { sourceId: "S1", url: "https://pipeline.example", title: "P", domain: "pipeline.example" } }
      : opts.citationMap,
    searchGateMeta: { depth: opts.depth ?? "standard", freshness: "any", decidedBy: "llm", queries: [] },
    signal: opts.signal,
    ch: channelFor(h),
  });
  return fetchMock;
}

const countDone = (raw: string): number => raw.split("data: [DONE]").length - 1;

beforeEach(() => {
  mocks.execWebSearch.mockReset();
  mocks.execReadPage.mockReset();
  mocks.execWebSearch.mockImplementation(async (_s: any, _a: any, fresh: any[]) => {
    fresh.push({ sourceId: "S9", url: "https://fresh.example", title: "Fresh", domain: "fresh.example", publishedAt: "2026-10-30" });
    return { ok: true, tool: "web_search", marker: "search-envelope" };
  });
  mocks.execReadPage.mockResolvedValue({ ok: true, tool: "read_page", marker: "read-envelope" });
  mocks.begin.mockReset();
  mocks.end.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── tests ─────────────────────────────────────────────────────────────── */

describe("plain-answer round", () => {
  it("forwards deltas, keeps the single [DONE], closes once, releases the slot once", async () => {
    const h = makeHarness();
    const fetchMock = await drive(h, [sseResponse(contentDelta("Hel") + contentDelta("lo") + finishFrame("stop") + DONE, 13)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // DELIBERATELY EVOLUED 2026-11-05 (WS06, audit item 6): content deltas
    // are no longer relayed per-piece — the round's answer text is buffered,
    // run through the server release check (lib/chat/answer-release.ts), and
    // released as ONE audited delta. The chunk-split law this test originally
    // pinned still holds: the 13-byte split frames reassembled inside the
    // relay (both pieces plus the terminal frames below prove it); only the
    // release SHAPE changed. Release order law pinned here: repaired content
    // precedes the round's terminal frames.
    expect(h.rawText).toContain('"content":"Hello"');
    expect(h.rawText.indexOf('"content":"Hello"')).toBeLessThan(
      h.rawText.indexOf('"finish_reason":"stop"'),
    );
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
    expect(h.failed).toEqual([]);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("injects guidance in the skill slot and the tool surface on the first round", async () => {
    const h = makeHarness();
    const fetchMock = await drive(h, [answerRound("done")]);
    const body = fetchMock.mock.calls[0][1] as { body: string };
    const sent = JSON.parse(body.body);
    // skill-slot law: system block BEFORE the last user turn
    expect(sent.messages[0]).toEqual({ role: "system", content: WEB_TOOL_GUIDANCE });
    expect(sent.messages[1].role).toBe("user");
    expect(sent.tools).toHaveLength(2);
    expect(sent.tools.map((t: any) => t.function.name)).toEqual(["web_search", "read_page"]);
  });

  it("think tags are scrubbed on the wire, same as the passthrough path", async () => {
    const h = makeHarness();
    await drive(h, [sseResponse(contentDelta("vis<think>hidden reasoning</think>ible") + finishFrame("stop") + DONE)]);
    expect(h.rawText).toContain("visible");
    expect(h.rawText).not.toContain("hidden");
  });

  it("upstream HTTP failure uses the verbatim ruke_error contract, not close", async () => {
    const h = makeHarness();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "model overloaded" })));
    await runWebToolLoop({
      payload: payloadFor(),
      lastUserIdx: 0,
      fullText: "q",
      model: "test-model",
      depth: "quick",
      webCitationMap: null,
      searchGateMeta: null,
      ch: channelFor(h),
    });
    expect(h.failed).toEqual(["Upstream returned 500: model overloaded"]);
    expect(h.closed).toBe(0);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("unreachable server fails with the host-specific message", async () => {
    const h = makeHarness();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await runWebToolLoop({
      payload: payloadFor(), lastUserIdx: 0, fullText: "q", model: "test-model",
      depth: "quick", webCitationMap: null, searchGateMeta: null, ch: channelFor(h),
    });
    expect(h.failed).toEqual(["Could not reach the model server at 127.0.0.1:1234."]);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("a pre-aborted signal closes the channel without any upstream call (Rule 5 slot still released)", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = await drive(h, [answerRound("never")], { signal: controller.signal });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.closed).toBe(1);
    expect(h.failed).toEqual([]);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});

describe("tool round → merged conversation → final answer", () => {
  it("merges call fragments by index, runs the tool, re-emits web_meta, ONE [DONE] total", async () => {
    const h = makeHarness();
    const r1 = toolRound("web_search", "call-1", ['{"queries":["a b"],"mi', 'ssing_claims":["c"]}']);
    await drive(h, [r1, answerRound("final answer")]);

    expect(h.fetchBodies).toHaveLength(2);
    const second = h.fetchBodies[1];
    const assistant = second.messages.find((m: any) => m.role === "assistant");
    const toolMsg = second.messages.find((m: any) => m.role === "tool");
    // fragments merged across frames
    expect(assistant.tool_calls).toEqual([
      { id: "call-1", type: "function", function: { name: "web_search", arguments: '{"queries":["a b"],"missing_claims":["c"]}' } },
    ]);
    expect(assistant.content).toBeNull(); // no content deltas this round
    expect(JSON.parse(toolMsg.content)).toEqual({ ok: true, tool: "web_search", marker: "search-envelope" });
    expect(mocks.execWebSearch).toHaveBeenCalledTimes(1);

    // stage contract: web:tools census + progress
    const toolsStage = h.stages.find((s) => s.stage === "web:tools");
    expect(toolsStage).toMatchObject({ detail: "web_search", done: 1, total: 4 });

    // OVERWRITE law: new citations ride a MERGED web_meta map (pipeline S1 + fresh S9)
    const metaStage = h.stages.find((s) => s.stage === "web_meta");
    expect(metaStage).toBeTruthy();
    expect(Object.keys(metaStage!.webCitations!)).toEqual(["S1", "S9"]);
    expect(metaStage!.searchGate).toMatchObject({ depth: "standard" });

    // round 1's [DONE] was swallowed; only the answer round's survives
    expect(countDone(h.rawText)).toBe(1);
    expect(h.rawText).toContain("final answer");
    expect(h.closed).toBe(1);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("unknown tool and malformed arguments get honest envelopes; the loop continues", async () => {
    const h = makeHarness();
    const unknown = toolRound("shell_exec", "c1", ["{}"]);
    const badArgs = toolRound("web_search", "c2", ["not-json"]);
    await drive(h, [unknown, badArgs, answerRound("recovered")]);

    const afterUnknown = h.fetchBodies[1].messages.find((m: any) => m.role === "tool");
    expect(JSON.parse(afterUnknown.content)).toMatchObject({
      ok: false, tool: "shell_exec", error: "unknown_tool",
      detail: "only web_search and read_page are available in this turn",
    });
    const toolMsgs = h.fetchBodies[2].messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(JSON.parse(toolMsgs[1].content)).toMatchObject({
      ok: false, tool: "web_search", error: "invalid_arguments",
      detail: "tool arguments are not a JSON object",
    });
    expect(mocks.execWebSearch).not.toHaveBeenCalled();
    // WS18 deliberate fixture evolution (audit item 18 — "failed research
    // attempts disappear from persisted ledger metadata"): the rejected
    // calls ARE recorded (invalidArgsEnvelope/unknown-tool sites call the
    // real recordAction), so every round's ledger growth now emits its own
    // web_meta and the completion re-emits the final ledger — 3 frames,
    // not 1. Each frame still ships the merged (pipeline-seeded) citation
    // map, and each carries the ledger SNAPSHOT as of its emission round —
    // frame 0 saw exactly the unknown_tool rejection.
    const metaStages = h.stages.filter((s) => s.stage === "web_meta");
    expect(metaStages).toHaveLength(3);
    for (const m of metaStages) expect(Object.keys(m.webCitations!)).toEqual(["S1"]);
    expect(metaStages[0].researchLedger!.actions.map((a) => a.error)).toEqual(["unknown_tool"]);
    expect(metaStages[1].researchLedger!.actions.map((a) => a.error)).toEqual([
      "unknown_tool", "invalid_arguments",
    ]);
    expect(metaStages[2].researchLedger).toEqual({
      toolRounds: 2,
      actions: [
        expect.objectContaining({ tool: "shell_exec", ok: false, error: "unknown_tool", requested: 0, retrieved: 0, failed: 0, round: 1 }),
        expect.objectContaining({ tool: "web_search", ok: false, error: "invalid_arguments", requested: 0, retrieved: 0, failed: 0, round: 2 }),
      ],
    });
    for (const [i, a] of metaStages[2].researchLedger!.actions.entries()) {
      expect(a.id).toMatch(new RegExp(`-a${i + 1}$`));
      expect(Number.isNaN(Date.parse(a.at))).toBe(false);
    }
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });
});

describe("round-cap behaviour (documented deviation: forced final round)", () => {
  it("cap hit → tools removed + final directive + one more request; final [DONE] survives", async () => {
    const h = makeHarness();
    const rounds = [
      toolRound("web_search", "c1", ['{"queries":["q1"],"missing_claims":["m"]}']),
      toolRound("read_page", "c2", ['{"urls":["https://x.example"]}']),
      answerRound("forced final answer"),
    ];
    await drive(h, rounds, { depth: "quick" }); // budget rounds = 2

    expect(h.fetchBodies).toHaveLength(3);
    const finalBody = h.fetchBodies[2];
    expect(finalBody.tools).toBeUndefined();
    const lastMsg = finalBody.messages[finalBody.messages.length - 1];
    expect(lastMsg).toEqual({ role: "system", content: WEB_TOOL_FINAL_DIRECTIVE });
    expect(h.rawText).toContain("forced final answer");
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
    // the read_page envelope rode the conversation too
    const toolMsgs = h.fetchBodies[2].messages.filter((m: any) => m.role === "tool");
    expect(JSON.parse(toolMsgs[1].content).marker).toBe("read-envelope");
    expect(mocks.execReadPage).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("model misbehaves on the final round → synthetic [DONE] restores the grammar (still ONE)", async () => {
    const h = makeHarness();
    const rounds = [
      toolRound("web_search", "c1", ['{"queries":["q1"],"missing_claims":["m"]}']),
      toolRound("web_search", "c2", ['{"queries":["q2"],"missing_claims":["m"]}']),
      toolRound("web_search", "c3", ['{"queries":["q3"],"missing_claims":["m"]}']), // final round: tools again
    ];
    await drive(h, rounds, { depth: "quick" });
    // round 1 tool_calls → conversation; round 2 = loop's cap round (roundsUsed 2)
    // round 3 is the forced final round: tools already removed from payload
    expect(h.fetchBodies[2].tools).toBeUndefined();
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
    expect(h.failed).toEqual([]);
    expect(mocks.execWebSearch).toHaveBeenCalledTimes(2); // forced-round calls are never executed
  });
});

/* ── WS18 (audit 2026-11-05 item 18): failed research stays persisted ────
   The completion web_meta used to REQUIRE a nonempty citation map, and the
   per-round re-emission required NEWLY ADDED citations — so a turn whose
   tools all failed minted zero citations and its action ledger never
   reached the persisted message at all. "A no-source failure is when
   truthful diagnostics matter most." ⇔ web_loop.rs mirror. */

describe("WS18 — ledger persistence independent of citations", () => {
  it("a zero-citation failed turn still emits web_meta carrying the ledger", async () => {
    // Production-faithful: the real executor records an ok action whose
    // every lookup FAILED (failed:1) and mints no citations at all.
    mocks.execWebSearch.mockImplementation(async (s: any, _a: any, _fresh: any[]) => {
      recordAction(s, { tool: "web_search", ok: true, requested: 1, retrieved: 0, failed: 1 });
      return { ok: true, tool: "web_search", failures: [{ query: "latest x", failure: "engine_unavailable" }] };
    });
    const h = makeHarness();
    await drive(
      h,
      [
        toolRound("web_search", "c1", ['{"queries":["latest x"],"missing_claims":["what happened yesterday"]}']),
        answerRound("Every research lookup failed; nothing could be verified."),
      ],
      { citationMap: null },
    );
    const metas = h.stages.filter((s) => s.stage === "web_meta");
    // After the fix: ONE per-round re-emission (the ledger grew) + ONE
    // completion frame — citations play no part in either gate.
    expect(metas, "failed attempts with zero citations must still persist the ledger (WS18)").toHaveLength(2);
    for (const m of metas) {
      expect(m.webCitations).toEqual({});
      expect(m.researchLedger?.toolRounds).toBe(1);
      expect(m.researchLedger?.actions).toHaveLength(1);
      expect(m.researchLedger?.actions?.[0]).toMatchObject({ tool: "web_search", ok: true, failed: 1 });
    }
    // OVERWRITE law untouched: an empty map only ever replaces an empty map.
    expect(h.closed).toBe(1);
    expect(countDone(h.rawText)).toBe(1);
  });

  it("a round that records actions but mints no citations re-emits the ledger that round", async () => {
    mocks.execWebSearch.mockImplementation(async (s: any, _a: any, _fresh: any[]) => {
      recordAction(s, { tool: "web_search", ok: true, requested: 1, retrieved: 0, failed: 1 });
      return { ok: true, tool: "web_search", failures: [{ query: "q", failure: "engine_unavailable" }] };
    });
    const h = makeHarness();
    await drive(
      h,
      [
        toolRound("web_search", "c1", ['{"queries":["q1"],"missing_claims":["m1"]}']),
        toolRound("web_search", "c2", ['{"queries":["q2"],"missing_claims":["m2"]}']),
        answerRound("Both searches failed."),
      ],
      { citationMap: null },
    );
    const metas = h.stages.filter((s) => s.stage === "web_meta");
    // Per-round emission tracks growth: 1 action, then 2, then completion.
    expect(metas, "each ledger-growing round re-emits the record (WS18)").toHaveLength(3);
    expect(metas[0].researchLedger?.actions).toHaveLength(1);
    expect(metas[1].researchLedger?.actions).toHaveLength(2);
    expect(metas[2].researchLedger?.actions).toHaveLength(2);
  });
});
