/**
 * Web tool loop release law (MHR-D 2026-11-05; streaming law 2026-11-12;
 * feedback lifecycle CLOSED by the 2026-11-13 brief): a diagnosed problem
 * NEVER retracts a streamed answer and NEVER feeds a "[Harness feedback]"
 * message back to the model. The answer streams LIVE; at round end the
 * harness DIAGNOSES for the server log only, then releases through the
 * INTEGRITY audit — a fabricated [S#] is stripped via one in-place
 * `web:content_revise` frame (the ONLY rewrite the harness makes), and the
 * terminal frames ride out exactly once.
 *
 * Wire laws pinned here (the fold in ./revise-fold is the client reducer's
 * law: live deltas + revise frames applied in wire order):
 *  - a diagnosed-bad answer costs ZERO extra upstream calls — no second
 *    round is bought by a heuristic flag;
 *  - NO fetch body ever contains harness feedback (the contract is deleted
 *    in both languages);
 *  - a content_revise NEVER carries an empty contentText erasing live text
 *    (the retraction half of the old lifecycle is gone);
 *  - a minted [S#] is never removed; only markers resolving to nothing are;
 *  - reasoning frames stream live untouched whatever the diagnosis says;
 *  - the single-[DONE] grammar survives every path;
 *  - research-claiming wording on a zero-retrieval turn composes the
 *    ledger check line (R3) into the SAME revise frame.
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
import { SERVER_CHECK_LINE } from "@/lib/chat/answer-release";
import { foldDisplay, type LoopEvent } from "./revise-fold";

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
  log: LoopEvent[];
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
const fold = (h: Harness): string => foldDisplay(h.log);
const feedbackMessages = (body: any): any[] =>
  (body.messages ?? []).filter(
    (m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Harness feedback]"),
  );
const revs = (h: Harness): any[] => h.stages.filter((s) => s.stage === "web:content_revise");

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

describe("web tool loop release law (feedback lifecycle CLOSED 2026-11-13)", () => {
  it("a diagnosed-bad answer streams LIVE and releases via ONE integrity revise — zero extra upstream calls, zero feedback messages", async () => {
    const h = await drive([answerRound("Boreal costs $99 [S9] per seat.")], S1);
    // The heuristic flag buys NO second round: exactly one upstream call.
    expect(h.calls).toBe(1);
    for (const b of h.fetchBodies) expect(feedbackMessages(b)).toHaveLength(0);
    // The bad text rode the live wire (streaming reliability law — no
    // hidden buffer); the revise frame strips ONLY the broken reference.
    expect(h.rawText).toContain("[S9]");
    expect(revs(h)).toHaveLength(1);
    expect(revs(h)[0]).toMatchObject({
      stage: "web:content_revise",
      contentCutTo: 0,
      contentText: "Boreal costs $99 per seat.",
    });
    // Anti-retraction law: an empty-contentText erase of live text is gone.
    expect(revs(h).some((r) => r.contentText === "")).toBe(false);
    expect(fold(h)).toBe("Boreal costs $99 per seat.");
    expect(fold(h)).not.toContain("(unverified)");
    // Terminal frames parked during the round ride out exactly once.
    expect(countStop(h.rawText)).toBe(1);
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
    expect(h.failed).toHaveLength(0);
  });

  it("control: a clean answer streams live with ZERO revise frames (single upstream call)", async () => {
    const h = await drive([answerRound("Boreal costs $99 [S1] per seat.")], S1);
    expect(h.calls).toBe(1);
    expect(h.fetchBodies).toHaveLength(1);
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    expect(revs(h)).toHaveLength(0);
    expect(fold(h)).toBe("Boreal costs $99 [S1] per seat.");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("a dangling marker in an otherwise-sourced sentence: the MINTED citation survives; only the broken reference is stripped", async () => {
    const h = await drive([answerRound("Boreal supports SAML [S1] and SCIM [S7].")], S1);
    expect(h.calls).toBe(1);
    expect(revs(h)).toHaveLength(1);
    expect(revs(h)[0].contentText).toBe("Boreal supports SAML [S1] and SCIM.");
    expect(fold(h)).toBe("Boreal supports SAML [S1] and SCIM.");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
  });

  it("tool round then a bad answer: narration STAYS live; the integrity revise cuts at the round's live offset; budget/census/activity law unchanged", async () => {
    const narrate = sseResponse(
      contentDelta("Looking it up. ") +
        toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
        toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing","missing_claims":"price"}' } }) +
        finishFrame("tool_calls") +
        DONE,
    );
    const h = await drive(
      [narrate, answerRound("Boreal costs $99 [S9] per seat.")],
      S1,
    );
    // Narration round + ONE answer round. The diagnosis never buys another
    // iteration: no feedback round exists.
    expect(h.calls).toBe(2);
    for (const b of h.fetchBodies) expect(feedbackMessages(b)).toHaveLength(0);
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
    // §D law: REAL per-action activity frames INSIDE execution — started +
    // completed pair for the one web_search (mocked exec mints no ledger
    // record, so counts ride the real-executor path; lifecycle pinned here).
    const acts = h.stages.filter((s) => s.stage === "web:activity");
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ activity: "search", activityStatus: "started", round: 1 });
    expect(acts[1]).toMatchObject({ activity: "search", activityStatus: "completed", round: 1 });
    // Live law: the narration streamed and STAYED (offsets accumulate); the
    // bad answer streamed live, then ONE integrity revise replaced ONLY the
    // broken-reference marker from the round's offset (15 live narration
    // bytes before it).
    expect(revs(h)).toHaveLength(1);
    expect(revs(h)[0].contentCutTo).toBe(15);
    expect(fold(h)).toBe("Looking it up. Boreal costs $99 per seat.");
    expect(fold(h)).not.toContain("[S9]");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
  });

  it("reasoning streams live during a flagged round; the parked terminal frames never double-emit", async () => {
    const h = await drive(
      [sseResponse(reasoningDelta("weighing sources") + contentDelta("Boreal costs $99 [S9] per seat.") + finishFrame("stop") + DONE)],
      S1,
    );
    expect(h.calls).toBe(1);
    expect(h.rawText).toContain("weighing sources"); // thinking never gated
    // The content rode the live wire; the integrity revise replaces it
    // in-place with the stripped text (no retraction, no regeneration).
    expect(h.rawText).toContain("[S9]");
    expect(fold(h)).toBe("Boreal costs $99 per seat.");
    expect(fold(h)).not.toContain("[S9]");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
  });

  it("zero-retrieval research wording composes the ledger check line (R3) into the SAME revise frame", async () => {
    const h = await drive([answerRound("According to my searches, Boreal is the market leader.")], null);
    expect(h.calls).toBe(1);
    expect(revs(h)).toHaveLength(1);
    expect(revs(h)[0].contentText).toBe(
      SERVER_CHECK_LINE + "\nAccording to my searches, Boreal is the market leader.",
    );
    expect(fold(h)).toContain(SERVER_CHECK_LINE);
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });

  it("whole tool budget spent (quick): the forced final answer ships through the integrity audit — nothing is faked", async () => {
    const narrate = () =>
      sseResponse(
        contentDelta("Looking it up. ") +
          toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
          toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing","missing_claims":"price"}' } }) +
          finishFrame("tool_calls") +
          DONE,
      );
    // EVERY quick round goes to tools (budget DERIVED, 2026-11-07 re-tune) —
    // the loop then forces its final answer round.
    const cap = webToolBudgetFor("quick").maxToolRounds;
    const h = await drive(
      [...Array.from({ length: cap }, () => narrate()), answerRound("Boreal costs $99 [S9] per seat.")],
      S1,
      "quick",
    );
    expect(h.calls).toBe(cap + 1);
    expect(h.fetchBodies).toHaveLength(cap + 1);
    for (const b of h.fetchBodies) expect(feedbackMessages(b)).toHaveLength(0);
    // Every narration round streamed LIVE and was retained (each round
    // narrated for real — offsets accumulate across releases). The forced
    // final answer streamed live too, then MHR-F integrity stripped the
    // dangling marker via a REVISE frame — words untouched.
    expect(revs(h)).toHaveLength(1);
    expect(revs(h)[0].contentCutTo).toBe(15 * cap); // offset law: every live narration byte counted
    expect(fold(h)).toBe("Looking it up. ".repeat(cap) + "Boreal costs $99 per seat.");
    expect(fold(h)).not.toContain("[S9]");
    expect(countDone(h.rawText)).toBe(1);
    expect(countStop(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });
});
