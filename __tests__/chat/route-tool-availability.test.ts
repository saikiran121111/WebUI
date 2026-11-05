/**
 * Repair contract (brief 2026-11-05 §4/§11) — app/api/chat/route.ts entry path:
 * the MAIN MODEL decides whether to search. The chat route must arm the
 * server-owned web tool surface (runWebToolLoop) on ordinary research turns
 * WITHOUT any prefetched evidence bundle, and WITHOUT running the mandatory
 * search gate/prefetch pipeline before the model gets its tools.
 *
 * Pinned contracts:
 *   T1 tools are armed on a plain chat turn (no gate bundle exists), depth
 *      "standard", and the loop — not the route — owns research;
 *   T2 runWebResearch (gate + prefetch + waves) is NEVER invoked by a chat
 *      turn — no auxiliary model call before the answering model;
 *   T3 explicit disable (WEB_SEARCH_GATE_DISABLED) prevents web execution
 *      entirely and never injects tools upstream;
 *   T4 a client-supplied tools array is never overwritten (coexistence);
 *   T5 the armed turn carries the conversation identity (conversationId +
 *      session currentDate) so the LOOP can journal findings and rehydrate
 *      prior evidence — route-level contract only; the journal law itself
 *      is pinned in __tests__/chat/web-tool-loop.test.ts;
 *   T6 the route itself never journals research (recording lives in the
 *      tool-session layer now — single implementation for both paths).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runWebResearch: vi.fn(),
  runWebToolLoop: vi.fn(),
  buildMainModelContext: vi.fn(() => ""),
  readResearchJournal: vi.fn((): unknown[] => []),
  recordResearchTurn: vi.fn(),
  journalTurnFromBundle: vi.fn(() => ({ at: "", currentDate: "", queries: [], freshness: "any", sources: [] })),
  begin: vi.fn(),
  end: vi.fn(),
  getDecision: vi.fn(async (prompt: string) => ({
    active_mode: "standard_chat",
    decided_by: "test",
    stripped_prompt: prompt,
  })),
  buildDecisionSkillBlock: vi.fn(() => null),
  applySlashSkillRouting: vi.fn(async () => null),
  fetchUpstream: vi.fn(),
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
vi.mock("@/lib/server/rustProxy", () => ({
  rustEnabled: () => false,
  rustProxy: () => {
    throw new Error("rust proxy must not run in this test");
  },
}));
vi.mock("@/lib/web-search/pipeline", () => ({
  runWebResearch: mocks.runWebResearch,
  buildMainModelContext: mocks.buildMainModelContext,
}));
vi.mock("@/lib/web-search/search-gate", () => ({
  gateDisabledByEnv: () => process.env.WEB_SEARCH_GATE_DISABLED === "1",
}));
vi.mock("@/lib/chat/web-tool-loop", () => ({
  runWebToolLoop: mocks.runWebToolLoop,
}));
vi.mock("@/lib/persistence/research-journal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/persistence/research-journal")>()),
  readResearchJournal: mocks.readResearchJournal,
  recordResearchTurn: mocks.recordResearchTurn,
  journalTurnFromBundle: mocks.journalTurnFromBundle,
}));
vi.mock("@/lib/decision/client", () => ({
  getDecision: mocks.getDecision,
}));
vi.mock("@/lib/decision/skill-loader", () => ({
  buildDecisionSkillBlock: mocks.buildDecisionSkillBlock,
}));
vi.mock("@/lib/skills/lazy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/skills/lazy")>()),
  applySlashSkillRouting: mocks.applySlashSkillRouting,
}));

import { POST } from "@/app/api/chat/route";

/* ── helpers ───────────────────────────────────────────────────────────── */

const dec = new TextDecoder();

function sseResponse(sse: string): unknown {
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
          const value = bytes.slice(pos, pos + 200);
          pos += 200;
          return { done: false, value };
        },
      }),
    },
  };
}

const upstreamAnswer = () =>
  sseResponse(
    "data: " + JSON.stringify({ choices: [{ delta: { content: "An answer." }, finish_reason: null }] }) +
      "\n\ndata: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      "\n\ndata: [DONE]\n\n",
  );

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "test-model",
    stream: true,
    messages: [{ role: "user", content: "any updates on Nimbus Robotics lately?" }],
    ...extra,
  };
}

/** Close the stream from the mocked loop so res.text() resolves. */
function loopClosesStream(opts: any): void {
  opts.ch.close();
}

const JOURNAL_TURN = {
  at: "2026-11-04T10:00:00.000Z",
  currentDate: "2026-11-04",
  queries: ["Nimbus Robotics funding"],
  freshness: "any",
  sources: [
    {
      url: "https://nimbusrobotics.example/news",
      title: "Nimbus Robotics news",
      domain: "nimbusrobotics.example",
      publishedAt: "",
      fetchedAt: "2026-11-04T10:00:00.000Z",
      excerpt: "Nimbus Robotics announced a new funding round.",
    },
  ],
};

/* ── battery ───────────────────────────────────────────────────────────── */

describe("chat route: model-directed web tool availability (no prefetched bundle)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    delete process.env.WEB_SEARCH_GATE_DISABLED;
    mocks.runWebResearch.mockReset();
    mocks.runWebResearch.mockResolvedValue(null);
    mocks.runWebToolLoop.mockReset();
    mocks.runWebToolLoop.mockImplementation(loopClosesStream);
    mocks.buildMainModelContext.mockReset();
    mocks.buildMainModelContext.mockReturnValue("");
    mocks.readResearchJournal.mockReset();
    mocks.readResearchJournal.mockReturnValue([]);
    mocks.recordResearchTurn.mockReset();
    mocks.journalTurnFromBundle.mockReset();
    mocks.begin.mockReset();
    mocks.end.mockReset();
    mocks.getDecision.mockReset();
    mocks.getDecision.mockImplementation(async (prompt: string) => ({
      active_mode: "standard_chat",
      decided_by: "test",
      stripped_prompt: prompt,
    }));
    mocks.fetchUpstream.mockReset();
    mocks.fetchUpstream.mockImplementation(async () => upstreamAnswer());
    vi.stubGlobal("fetch", mocks.fetchUpstream);
  });

  afterEach(() => {
    delete process.env.WEB_SEARCH_GATE_DISABLED;
    vi.unstubAllGlobals();
  });

  it("T1: arms the web tool loop on a plain chat turn without any gate bundle", async () => {
    const res = await post(chatBody());
    await res.text();

    expect(mocks.runWebToolLoop).toHaveBeenCalledTimes(1);
    const opts = mocks.runWebToolLoop.mock.calls[0][0];
    expect(opts.depth).toBe("standard");
    // No gate exists on this path anymore: no gate meta, no presentation plan,
    // no prefetched citation map.
    expect(opts.searchGateMeta ?? null).toBeNull();
    expect(opts.presentation ?? null).toBeNull();
    expect(opts.richResults ?? null).toBeNull();
    expect(opts.fullText).toContain("Nimbus Robotics");
    // The turn scope still reaches the session (security + explicit
    // constraints), folded from the request's own user turns.
    expect(opts.scope).toBeTruthy();
    expect(opts.scope.intent).toBeDefined();
    expect(mocks.runWebResearch).not.toHaveBeenCalled();
  });

  it("T2: a chat turn never runs the mandatory search gate / prefetch pipeline", async () => {
    await (await post(chatBody({
      messages: [{ role: "user", content: "what is the current price of Nimbus One parts?" }],
    }))).text();
    expect(mocks.runWebResearch).not.toHaveBeenCalled();
  });

  it("T3: explicit research disable prevents web execution and injects no tools upstream", async () => {
    process.env.WEB_SEARCH_GATE_DISABLED = "1";
    const res = await post(chatBody());
    await res.text();

    expect(mocks.runWebToolLoop).not.toHaveBeenCalled();
    expect(mocks.fetchUpstream).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(mocks.fetchUpstream.mock.calls[0][1].body));
    expect(body.tools).toBeUndefined();
  });

  it("T4: a client-supplied tools array is never overwritten", async () => {
    const custom = [{ type: "function", function: { name: "client_tool" } }];
    const res = await post(chatBody({ tools: custom }));
    await res.text();

    expect(mocks.runWebToolLoop).not.toHaveBeenCalled();
    const body = JSON.parse(String(mocks.fetchUpstream.mock.calls[0][1].body));
    expect(body.tools).toEqual(custom);
  });

  it("T5: the armed turn carries the conversation identity for journaling/rehydration", async () => {
    // Post-repair the loop (not the route) reads the journal and builds the
    // prior-evidence block; the route's contract is to hand the loop the
    // server-derived conversation id and the session-timezone date.
    const res = await post(chatBody({ browser_session: "conv-journal-1" }));
    await res.text();

    expect(mocks.runWebToolLoop).toHaveBeenCalledTimes(1);
    const opts = mocks.runWebToolLoop.mock.calls[0][0];
    expect(opts.conversationId).toBe("conv-journal-1");
    expect(opts.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No prefetched citation map rides from the route: the loop starts from
    // its own session (prior citations, if any, are minted inside it).
    expect(opts.webCitationMap ?? null).toBeNull();
  });

  it("T6: the route does not journal research itself (the tool-session layer owns recording)", async () => {
    // Regression guard: journaling moved into the tool-session layer
    // (lib/web-search/tools.ts journalWebSearchSources). The route must not
    // re-grow its own record/journalTurnFromBundle call — even when prior
    // journal turns exist, only the loop/session touches the journal.
    mocks.readResearchJournal.mockReturnValue([JOURNAL_TURN]);
    await (await post(chatBody({ browser_session: "conv-journal-2" }))).text();
    expect(mocks.recordResearchTurn).not.toHaveBeenCalled();
    expect(mocks.journalTurnFromBundle).not.toHaveBeenCalled();
  });
});
