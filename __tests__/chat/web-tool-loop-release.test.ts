/**
 * Streaming reliability law (2026-11-12 — REPLACES the WS06 hold-back
 * buffering): the research tool loop streams answer content LIVE, byte-for-
 * byte, while the round generates; only the round's TERMINAL frames park.
 * When the server-side action/citation/claim check (lib/chat/answer-
 * release.ts ⇔ Rust chat/answer_release.rs wired into web_loop.rs) changes
 * the answer text, the change ships as a `web:content_revise` frame
 * (contentCutTo = UTF-16 offset into the turn's already-live content,
 * contentText = replacement from that offset to the end) BEFORE the parked
 * terminal frames — never as a synthetic delta replay.
 *
 * Wire laws pinned here (updated WITH the law — the user amendment forbade
 * keeping pins that assume buffering):
 *  - content deltas reach the client DURING the round, before its finish/
 *    [DONE] frames (measured 2026-11-12 under hold-back: TS 139 deltas /
 *    5472 chars and Rust 183 / 5295 arrived at ZERO clients);
 *  - what the client DISPLAYS — live deltas + revise frames folded in wire
 *    order (./revise-fold, the client reducer's law) — equals the audited
 *    text: dangling aliases never survive the fold, retracted text never
 *    survives its replay doubled;
 *  - reasoning/think frames are never gated (they are not final research
 *    assertions);
 *  - the single-[DONE] SSE grammar, tool narration, and the citation/
 *    web_meta law are untouched;
 *  - MHR-A (2026-11-05): the loop is armed for every progress-path turn;
 *    the legacy stream:false path is a plain forward that never enters here.
 *
 * MHR-D (2026-11-05, amended 2026-11-12): a diagnosed-bad answer is
 * RETRACTED IN PLACE (revise frame, empty contentText) before ONE harness-
 * feedback round; these pins observe the RELEASE pass — the replayed second
 * answer (feedback already used) exits through the MHR-F integrity audit
 * (markers stripped via revise, semantics never rewritten). Fresh response
 * per upstream call is required (SSE readers are one-shot).
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
          pos += value.length; // split-deliberate framing like the sibling suite
          return { done: false, value };
        },
      }),
    },
  };
}
// Rounds are SSE STRINGS; drive() builds a FRESH reader per upstream call
// (one-shot readers would starve the MHR-D feedback round).
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

async function drive(
  rounds: string[],
  citationMap: Record<string, any> | null,
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
    return sseResponse(rounds[Math.min(idx, rounds.length - 1)]);
  });
  vi.stubGlobal("fetch", fetchMock);
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

const countDone = (raw: string): number => raw.split("data: [DONE]").length - 1;
const fold = (h: Harness): string => foldDisplay(h.log);

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

describe("grounded answer release in the web tool loop (WS06)", () => {
  it("normal completion: content streams LIVE; the audit repair ships as a web:content_revise frame before the terminal frames", async () => {
    // MHR-D: the first pass is diagnosed bad — its text streamed LIVE,
    // then a revise frame retracted it in place — before one feedback
    // round; the replayed second pass (feedback used) streams live again
    // and exits through the MHR-F integrity audit via a revise frame (the
    // [S9] bytes removed, the words untouched).
    const h = await drive([answerRound("Boreal costs $99 [S9] per seat."), answerRound("Boreal costs $99 [S9] per seat.")], S1);
    expect(h.calls).toBe(2);
    // Live-forward law: content bytes rode the wire BEFORE any terminal
    // frame (the first emitted stop belongs to the SECOND round — the
    // first round's parked frames died with the retraction).
    expect(h.rawText.indexOf("Boreal costs $99")).toBeLessThan(h.rawText.indexOf('"finish_reason":"stop"'));
    // Revise frames, in wire order: the retraction, then the repair.
    const revs = h.stages.filter((s) => s.stage === "web:content_revise");
    expect(revs).toHaveLength(2);
    expect(revs[0]).toMatchObject({ stage: "web:content_revise", contentCutTo: 0, contentText: "" });
    // The dangling alias DID ride the live wire (no hidden buffer), but the
    // DISPLAYED text — live deltas plus revise frames folded in wire order
    // (exactly the client reducer's law) — never carries it. An exact fold
    // also pins the ordering: a revise applied before its content would
    // leave the bad bytes in the fold.
    expect(h.rawText).toContain("[S9]");
    expect(fold(h)).toBe("Boreal costs $99 per seat.");
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });

  it("control: a fully-cited answer streams live byte-identical with NO revise frame", async () => {
    const h = await drive([answerRound("Boreal costs $99 [S1] per seat.")], S1);
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    // Live-forward: the content bytes precede the round's finish frame AND
    // its [DONE] frame — nothing is withheld until generation ends.
    expect(h.rawText.indexOf("[S1] per seat.")).toBeLessThan(h.rawText.indexOf('"finish_reason":"stop"'));
    expect(h.rawText.indexOf("[S1] per seat.")).toBeLessThan(h.rawText.indexOf("data: [DONE]"));
    // A clean audit owns nothing: no revise frame is ever minted.
    expect(h.stages.some((s) => s.stage === "web:content_revise")).toBe(false);
    expect(fold(h)).toBe("Boreal costs $99 [S1] per seat.");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("multi-round: live narration + real tool activity frames, exactly one [DONE], the final answer is audited", async () => {
    const narrate =
      contentDelta("Looking it up. ") +
      toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
      toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing","missing_claims":"price"}' } }) +
      finishFrame("tool_calls") +
      DONE;
    const h = await drive([narrate, answerRound("It costs $50 [S1].")], S1);
    expect(h.calls).toBe(2);
    expect(h.rawText).toContain("Looking it up.");
    expect(h.rawText).toContain("It costs $50 [S1].");
    // §D law: REAL per-action activity frames emitted INSIDE execution —
    // started before the exec, completed/failed after — never a generic
    // timer label. (Mocked exec mints no ledger record, so counts ride the
    // real-executor path; the lifecycle + round pairing is pinned here.)
    const acts = h.stages.filter((s) => s.stage === "web:activity");
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ stage: "web:activity", activity: "search", activityStatus: "started", round: 1 });
    expect(acts[1]).toMatchObject({ activity: "search", activityStatus: "completed", round: 1 });
    // Offsets accumulate ACROSS rounds (narration release advanced
    // streamedTotal): the answer fold continues where narration ended.
    expect(fold(h)).toBe("Looking it up. It costs $50 [S1].");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("zero retrieval + research-claiming wording: the server check line reaches the client through a revise frame", async () => {
    // MHR-D: claimsResearch fires the feedback round first (the live claim
    // bytes retracted in place); the second pass streams live again and
    // releases with the server check line prepended — shipped as the
    // second revise frame, applied by the fold.
    const claim = answerRound("According to my searches, Boreal leads.");
    const h = await drive([claim, claim], null);
    expect(h.calls).toBe(2);
    const revs = h.stages.filter((s) => s.stage === "web:content_revise");
    expect(revs).toHaveLength(2);
    expect(revs[0]).toMatchObject({ contentCutTo: 0, contentText: "" });
    expect(fold(h)).toContain(SERVER_CHECK_LINE);
    expect(fold(h)).toContain("According to my searches, Boreal leads.");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("reasoning streams live; retracted content replays exactly ONCE in the display fold", async () => {
    // MHR-D: the bad content round streamed live, was retracted in place,
    // and its reasoning streamed unbuffered either way.
    const round = reasoningDelta("weighing sources") + contentDelta("It costs $50.") + finishFrame("stop") + DONE;
    const h = await drive([round, round], S1);
    // The thinking frame passes through live, ahead of the content delta.
    expect(h.rawText.indexOf("weighing sources")).toBeLessThan(h.rawText.indexOf('"content":"It costs $50."'));
    // MHR-F integrity: no markers → the audit owns nothing on this
    // sentence; no qualifier is ever added and no repair revise exists.
    const revs = h.stages.filter((s) => s.stage === "web:content_revise");
    expect(revs).toHaveLength(1); // the MHR-D retraction only
    // The old buffering contract showed this text once; the live+revise
    // contract must show it once TOO — retracted + replayed, never twice.
    expect(fold(h)).toBe("It costs $50.");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("revise content rides UTF-16 whole — emoji and Telugu survive cut and repair intact", async () => {
    const text = "Pricing 😀🔥 తెలుగు details [S9] end.";
    const h = await drive([answerRound(text), answerRound(text)], S1);
    const revs = h.stages.filter((s) => s.stage === "web:content_revise");
    expect(revs).toHaveLength(2); // retraction, then the repair
    // Whole-round replace semantics (locked law): the cut sits at the
    // round's offset — reset to 0 by the retraction — and contentText
    // carries the full audited round. The astral/Telugu integrity risk
    // (byte-vs-UTF-16 offset drift) is pinned engine-side by Rust's
    // utf16_len pins; here the WIRE + fold must never mangle the text.
    expect(revs[1].contentCutTo).toBe(0);
    const shown = fold(h);
    expect(shown).not.toContain("[S9]");
    expect(shown).toContain("😀🔥");
    expect(shown).toContain("తెలుగు");
    // The cut never split an astral surrogate pair or orphaned a mark.
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(shown).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(countDone(h.rawText)).toBe(1);
  });
});
