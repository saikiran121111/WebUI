/**
 * WS06 (audit 2026-11-05 item 6): the research tool loop must NOT release
 * answer content to the client before the server-side action/citation/claim
 * check has repaired or qualified it (lib/chat/answer-release.ts ⇔ Rust
 * chat/answer_release.rs wired into web_loop.rs).
 *
 * Wire law pinned here:
 *  - answer CONTENT is buffered for the round and released (repaired)
 *    BEFORE the round's terminal frames;
 *  - reasoning/think frames are NOT delayed (they are not final research
 *    assertions — only content is gated);
 *  - the single-[DONE] SSE grammar, tool narration, and the citation/web_meta
 *    law are untouched by the gate;
 *  - ordinary chat never passes through this loop at all (the route calls
 *    runWebToolLoop only when the gate produced a bundle — pinned by the
 *    existing route tests, not re-litigated here).
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
    depth: "quick",
    webCitationMap: citationMap,
    searchGateMeta: { depth: "quick", freshness: "any", decidedBy: "llm", queries: [] },
    ch,
  });
  return h;
}

const countDone = (raw: string): number => raw.split("data: [DONE]").length - 1;

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
  it("normal completion: content is buffered, repaired, and released before terminal frames", async () => {
    const h = await drive([answerRound("Boreal costs $99 [S9] per seat.")], S1);
    // Repaired text reaches the client…
    expect(h.rawText).toContain("Boreal costs $99 per seat (unverified).");
    // …and the dangling alias never does.
    expect(h.rawText).not.toContain("[S9]");
    // Buffering law: released content precedes the round's terminal frames.
    expect(h.rawText.indexOf("(unverified)")).toBeLessThan(h.rawText.indexOf('"finish_reason":"stop"'));
    expect(countDone(h.rawText)).toBe(1);
    expect(h.closed).toBe(1);
  });

  it("control: a fully-cited answer releases byte-identical", async () => {
    const h = await drive([answerRound("Boreal costs $99 [S1] per seat.")], S1);
    expect(h.rawText).toContain("Boreal costs $99 [S1] per seat.");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("multi-round: tool narration survives, exactly one [DONE], the final answer is audited", async () => {
    const narrate = sseResponse(
      contentDelta("Looking it up. ") +
        toolCallDelta(0, { id: "c1", function: { name: "web_search" } }) +
        toolCallDelta(0, { function: { arguments: '{"query":"boreal pricing","missing_claims":"price"}' } }) +
        finishFrame("tool_calls") +
        DONE,
    );
    const h = await drive([narrate, answerRound("It costs $50 [S1].")], S1);
    expect(h.calls).toBe(2);
    expect(h.rawText).toContain("Looking it up.");
    expect(h.rawText).toContain("It costs $50 [S1].");
    expect(countDone(h.rawText)).toBe(1);
  });

  it("zero retrieval + research-claiming wording: the server check line reaches the client", async () => {
    const h = await drive([answerRound("According to my searches, Boreal leads.")], null);
    expect(h.rawText).toContain(SERVER_CHECK_LINE);
    expect(countDone(h.rawText)).toBe(1);
  });

  it("reasoning streams live; only content is gated", async () => {
    const h = await drive(
      [sseResponse(reasoningDelta("weighing sources") + contentDelta("It costs $50.") + finishFrame("stop") + DONE)],
      S1,
    );
    // The thinking frame passes through unbuffered, before the gated release.
    expect(h.rawText.indexOf("weighing sources")).toBeLessThan(h.rawText.indexOf("$50"));
    // The content itself is still repaired.
    expect(h.rawText).toContain("It costs $50 (unverified).");
  });
});
