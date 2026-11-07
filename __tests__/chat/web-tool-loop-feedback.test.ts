/**
 * MHR-D (brief 2026-11-05): evidence-driven next action. When an answer round
 * diagnoses problems (fabricated [S#], unsupported sentences, research
 * wording on a zero-retrieval turn), the harness HOLDS that text back, feeds
 * ONE diagnosis message into the EXISTING tool loop, and lets the MODEL
 * decide what to do next (retrieve / re-attach citations / state the gap).
 * No second research engine; the harness never rewrites the model's words to
 * "fix" semantics.
 *
 * Wire laws pinned here:
 *  - the held answer's terminal frames never reach the client (its content
 *    was already stripped from live frames by the relay);
 *  - the feedback message is byte-locked (matrix mhrD semantics) and rides
 *    as user-turn + assistant-turn pair in the NEXT upstream body;
 *  - at most ONE feedback per turn;
 *  - feedback consumes a loop iteration, NOT the tool budget
 *    (roundsUsed / web:tools census only count tool rounds);
 *  - the single-[DONE] grammar survives the extra round;
 *  - when the round budget can't spare an iteration, no feedback is faked —
 *    the answer releases through the WS06 audit (MHR-F: integrity only).
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
import { webToolBudgetFor } from "@/lib/web-search/tools";

const dec = new TextDecoder();

function contentDelta(content: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + "\n\n";
}
function reasoningDelta(text: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text }] }, finish_reason: null }] }) +
    "\n\n"
  );
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
const answerRound = (text: string): unknown => sseResponse(contentDelta(text) + finishFrame("stop") + DONE);

interface Harness {
  stages: any[];
  rawText: string;
  closed: number;
  failed: string[];
  fetchBodies: any[];
  calls: number;
}

async function drive(
  rounds: unknown[],
  citationMap: Record<string, any> | null,
  depth: "quick" | "standard" | "deep" = "standard",
): Promise<Harness> {
  const h: Harness = { stages: [], rawText: "", closed: 0, failed: [], fetchBodies: [], calls: 0 };
  const ch: WebProgressChannel = {
    stage: (e) => h.stages.push(e),
    fail: (m) => h.failed.push(m),
    raw: (b) => { h.rawText += dec.decode(b); },
    close: () => { h.closed += 1; },
  };
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    h.fetchBodies.push(JSON.parse(init.body));
    const idx = h.calls++;
    return rounds[Math.min(idx, rounds.length - 1)];
  });
  vi.stubGlobal("fetch", fetchMock);
  await runWebToolLoop({
    payload: { model: "test-model", messages: [{ role: "user", content: "price of boreal?" }] },
    lastUserIdx: 0,
    fullText: "price of boreal?",
    model: "test-model",
    depth,
    webCitationMap: citationMap,
    searchGateMeta: { depth, freshness: "any", decidedBy: "llm", queries: [] },
    ch,
  });
  return h;
}

const countDone = (raw: string): number => raw.split("data: [DONE]").length - 1;
const countStop = (raw: string): number => raw.split('"finish_reason":"stop"').length - 1;
const feedbackMessages = (body: any): any[] =>
  (body.messages ?? []).filter(
    (m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Harness feedback]"),
  );

const S1 = { S1: { sourceId: "S1", url: "https://docs.arborworks.example", title: "Docs", domain: "arborworks.example" } };

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

describe("MHR-D harness feedback in the web tool loop", () => {
  it("a diagnosed-bad answer is HELD BACK; the byte-locked diagnosis reaches the model; the model's corrected answer releases", async () => {
    const h = await drive(
      [answerRound("Boreal costs $99 [S9] per seat."), answerRound("Boreal costs $99 [S1] per seat.")],
      S1,
    );
    expect(h.calls).toBe(2);
    // First upstream body: no feedback yet. Second: held assistant text + diagnosis.
    expect(feedbackMessages(h.fetchBodies[0])).toHaveLength(0);
    const fb = feedbackMessages(h.fetchBodies[1]);
    expect(fb).toHaveLength(1);
    expect(fb[0].content).toBe(
      "[Harness feedback] Your answer text was held back and NOT released to the human. Actual server state this turn:\n" +
        "- Citation marker(s) [S9] do not exist. Sources minted this turn: S1.\n" +
        '- Unsupported claim sentence(s): "Boreal costs $99 [S9] per seat."\n' +
        "Decide the next action yourself: run web_search/read_page to retrieve the missing facts, re-attach your claims to the minted [S#] source ids, or state plainly which requested facts could not be verified. Never repeat the held text unchanged.",
    );
    const msgs = h.fetchBodies[1].messages;
    expect(msgs[msgs.length - 2].role).toBe("assistant");
    expect(msgs[msgs.length - 2].content).toBe("Boreal costs $99 [S9] per seat.");
    expect(msgs[msgs.length - 1].role).toBe("user");
    // The held answer NEVER reached the client — not even repaired (its
    // content was stripped from live frames and its terminal frames dropped).
    expect(h.rawText).not.toContain("[S9]");
    expect(h.rawText).not.toContain("(unverified)");
    // The corrected answer releases byte-clean.
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
    expect(h.failed).toHaveLength(0);
  });

  it("control: a clean answer releases with ZERO feedback rounds (single upstream call)", async () => {
    const h = await drive([answerRound("Boreal costs $99 [S1] per seat.")], S1);
    expect(h.calls).toBe(1);
    expect(h.fetchBodies).toHaveLength(1);
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("at most ONE feedback per turn — a second diagnosed-bad answer releases through the WS06 audit instead", async () => {
    const bad = "Boreal costs $99 [S9] per seat.";
    const h = await drive([answerRound(bad), answerRound(bad)], S1);
    expect(h.calls).toBe(2);
    const inSecond = feedbackMessages(h.fetchBodies[1]);
    expect(inSecond).toHaveLength(1); // the one and only feedback
    // The repeated bad answer now goes out through the integrity audit —
    // MHR-F: the [S9] bytes are stripped, the words are never qualified…
    expect(h.rawText).toContain("Boreal costs $99 per seat.");
    expect(h.rawText).not.toContain("[S9]");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });

  it("feedback costs an ITERATION, not the tool budget: one census, ledger toolRounds=1, execWebSearch once", async () => {
    const narrate = sseResponse(
      contentDelta("Looking it up. ") +
        toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
        toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing","missing_claims":"price"}' } }) +
        finishFrame("tool_calls") +
        DONE,
    );
    const h = await drive(
      [narrate, answerRound("Boreal costs $99 [S9] per seat."), answerRound("Boreal costs $99 [S1] per seat.")],
      S1,
    );
    expect(h.calls).toBe(3);
    expect(mocks.execWebSearch).toHaveBeenCalledTimes(1);
    // Exactly one tool round → one census frame (done=1 of maxRounds=4 for standard).
    const censuses = h.stages.filter((s) => s.stage === "web:tools");
    expect(censuses).toHaveLength(1);
    expect(censuses[0]).toMatchObject({ detail: "web_search", done: 1, total: 8 }); // standard budget (2026-11-07)
    // Ledger snapshot counts TOOL rounds only (exec is mocked here, so the
    // ledger itself stays empty — the snapshot rides the round frame whose
    // gate was satisfied by the minted S2 citation).
    const metas = h.stages.filter((s) => s.stage === "web_meta");
    const completion = metas[metas.length - 1];
    expect(completion.researchLedger).toBeDefined();
    expect(completion.researchLedger.toolRounds).toBe(1);
    expect(completion.researchLedger.actions).toHaveLength(0); // mocked exec records nothing
    // Feedback fired between the tool round and the answer release.
    expect(feedbackMessages(h.fetchBodies[1])).toHaveLength(0); // narrate round
    expect(feedbackMessages(h.fetchBodies[2])).toHaveLength(1); // feedback round
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    expect(h.rawText).not.toContain("[S9]");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
  });

  it("reasoning streams live during the feedback round; the held terminal frames never emit", async () => {
    const h = await drive(
      [
        sseResponse(reasoningDelta("weighing sources") + contentDelta("Boreal costs $99 [S9] per seat.") + finishFrame("stop") + DONE),
        answerRound("Boreal costs $99 [S1] per seat."),
      ],
      S1,
    );
    expect(h.rawText).toContain("weighing sources"); // thinking never gated
    expect(h.rawText).not.toContain("[S9]");
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
  });

  it("no rounds to spare (quick, whole round budget spent): NO feedback is faked — the answer releases through the WS06 audit", async () => {
    const narrate = () =>
      sseResponse(
        contentDelta("Looking it up. ") +
          toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
          toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing","missing_claims":"price"}' } }) +
          finishFrame("tool_calls") +
          DONE,
      );
    // EVERY quick round goes to tools (budget DERIVED, 2026-11-07 re-tune) —
    // the loop then forces its final answer round, and there is nothing left
    // to spend a feedback iteration on.
    const cap = webToolBudgetFor("quick").maxToolRounds;
    const h = await drive(
      [...Array.from({ length: cap }, () => narrate()), answerRound("Boreal costs $99 [S9] per seat.")],
      S1,
      "quick",
    );
    expect(h.calls).toBe(cap + 1);
    expect(h.fetchBodies).toHaveLength(cap + 1);
    for (const b of h.fetchBodies) expect(feedbackMessages(b)).toHaveLength(0);
    // MHR-F: integrity audit only — marker stripped, words untouched.
    expect(h.rawText).toContain("Boreal costs $99 per seat.");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });
});
