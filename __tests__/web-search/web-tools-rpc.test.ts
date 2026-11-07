/**
 * Web-tools RPC contract vectors (rollback 2026-11-03, Section C).
 *
 * These pin the Rust↔TS web-tool bridge grammar: the model-visible envelope
 * strings must stay byte-identical to the retired Rust web_loop inline
 * envelopes, and session lifecycle must degrade honestly (never a hang).
 * Hermetic: no network — exec vectors stop before retrieval (bad args /
 * unknown tool), discover vectors carry no unresolved targets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWebToolsRpc } from "@/lib/server/web-tools-rpc";

// Repair (brief 2026-11-05 §5): journal READS are stubbed for hermetic
// determinism, but selectPriorEvidence / buildPriorEvidenceBlock stay
// REAL — the rehydration grammar (relevance gate + [S#] alias numbering)
// must be pinned against the actual law, not a fake of it.
const journalMock = vi.hoisted(() => ({ readResearchJournal: vi.fn((): unknown[] => []) }));
vi.mock("@/lib/persistence/research-journal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/persistence/research-journal")>()),
  readResearchJournal: journalMock.readResearchJournal,
}));

const ENFORCEABLE_SCOPE = {
  intent: "site_info" as const,
  targets: [
    {
      phrase: "Example Site",
      state: "resolved" as const,
      host: "example.com",
      url: "https://example.com/",
      candidates: [],
      provenance: "resolved_search" as const,
    },
  ],
  excludedPhrases: [],
  authorizedHosts: [],
};

describe("web-tools RPC (Rust chat-loop bridge)", () => {
  it("create returns the session contract (tools, guidance, budget)", async () => {
    const res = await handleWebToolsRpc({
      action: "create",
      depth: "standard",
      citationSeed: 4,
      question: "what is the pricing page",
      scope: ENFORCEABLE_SCOPE,
    });
    expect(res.status).toBe(200);
    const j = res.json as any;
    expect(typeof j.sessionId).toBe("string");
    expect(j.sessionId.startsWith("ws-")).toBe(true);
    expect(Array.isArray(j.tools)).toBe(true);
    expect(j.tools.map((t: any) => t.function.name)).toEqual([
      "web_search",
      "read_page",
    ]);
    expect(typeof j.guidance).toBe("string");
    expect(j.guidance.length).toBeGreaterThan(0);
    expect(j.maxRoundsCap).toBe(20);
    expect(j.budget).toEqual({ maxSearchCalls: 3, maxReadUrls: 16, maxToolRounds: 8 }); // ⇔ locked budget table (2026-11-07 re-tune)
    expect(j.remainingBudget).toEqual({ searches: 3, readUrls: 16, rounds: 8 });
  });

  it("create rejects an unknown depth", async () => {
    const res = await handleWebToolsRpc({ action: "create", depth: "gigantic" });
    expect(res.status).toBe(400);
  });

  it("§9: create maps gate freshness onto the session (realtime ⇒ liveRequired)", async () => {
    const vectors: [unknown, boolean][] = [
      ["realtime", true], // live_required — read_page never replays the page cache
      ["day", false],     // live_preferred is not live_required
      ["week", false],
      ["any", false],
      [undefined, false], // legacy callers / absent gate
      [42, false],        // non-string DTO junk degrades to "any"
    ];
    for (const [freshness, expected] of vectors) {
      const res = await handleWebToolsRpc({
        action: "create",
        depth: "quick",
        question: "q",
        ...(freshness === undefined ? {} : { freshness }),
      });
      expect(res.status, `freshness=${String(freshness)}`).toBe(200);
      expect((res.json as any).liveRequired, `freshness=${String(freshness)}`).toBe(expected);
    }
  });

  it("exec with unparseable arguments gets the exact invalid_arguments envelope", async () => {
    const created = (
      await handleWebToolsRpc({ action: "create", depth: "quick", question: "q" })
    ).json as any;
    const res = await handleWebToolsRpc({
      action: "exec",
      sessionId: created.sessionId,
      tool: "web_search",
      argsRaw: "not json at all",
      roundsUsed: 1,
    });
    expect(res.status).toBe(200);
    const env = (res.json as any).envelope;
    expect(env).toMatchObject({
      ok: false,
      tool: "web_search",
      error: "invalid_arguments",
      detail: "tool arguments are not a JSON object",
    });
    // ⇔ Rust web_loop envelope: no searchSessionId on parse-level errors.
    expect(env.searchSessionId).toBeUndefined();
    expect(env.remainingBudget).toBeTruthy();
    expect((res.json as any).citations).toEqual([]);
  });

  it("exec with a non-object JSON value is invalid_arguments too", async () => {
    const created = (
      await handleWebToolsRpc({ action: "create", depth: "quick", question: "q" })
    ).json as any;
    const res = await handleWebToolsRpc({
      action: "exec",
      sessionId: created.sessionId,
      tool: "read_page",
      argsRaw: "[1,2]",
    });
    expect((res.json as any).envelope.error).toBe("invalid_arguments");
  });

  it("exec with an unknown tool gets the exact unknown_tool envelope", async () => {
    const created = (
      await handleWebToolsRpc({ action: "create", depth: "quick", question: "q" })
    ).json as any;
    const res = await handleWebToolsRpc({
      action: "exec",
      sessionId: created.sessionId,
      tool: "browse_web",
      argsRaw: "{}",
    });
    const env = (res.json as any).envelope;
    expect(env).toMatchObject({
      ok: false,
      tool: "browse_web",
      error: "unknown_tool",
      detail: "only web_search and read_page are available in this turn",
    });
    expect(env.searchSessionId).toBeUndefined();
  });

  it("a vanished session degrades honestly (never hangs, never throws)", async () => {
    const res = await handleWebToolsRpc({
      action: "exec",
      sessionId: "ws-gone",
      tool: "web_search",
      argsRaw: "{}",
    });
    expect(res.status).toBe(200);
    expect((res.json as any).envelope.error).toBe("session_expired");
  });

  it("§10: cancellation is honored pre-dispatch, never retracted for completed calls", async () => {
    const created = (
      await handleWebToolsRpc({ action: "create", depth: "quick", question: "q" })
    ).json as any;
    const ac = new AbortController();
    // Deferred semantics (documented shortcut at the web-tools-rpc exec
    // handler): a call that already dispatched runs to completion — an
    // abort issued after it cannot retract an envelope already returned.
    const during = await handleWebToolsRpc(
      {
        action: "exec",
        sessionId: created.sessionId,
        tool: "web_search",
        argsRaw: "nope",
        roundsUsed: 1,
      },
      ac.signal,
    );
    expect((during.json as any).envelope.error).toBe("invalid_arguments");
    ac.abort(); // the turn stops BETWEEN tool calls
    const after = await handleWebToolsRpc(
      {
        action: "exec",
        sessionId: created.sessionId,
        tool: "web_search",
        argsRaw: '{"query":"anything"}',
      },
      ac.signal,
    );
    const env = (after.json as any).envelope;
    expect(env).toMatchObject({
      ok: false,
      tool: "web_search",
      error: "cancelled",
      detail: "the turn was stopped before this tool ran",
    });
    // Never dispatched ⇒ no budget payload, no citations.
    expect(env.remainingBudget).toBeUndefined();
    expect((after.json as any).citations).toEqual([]);
    // The cancelled check precedes the session lookup — a stopped turn is
    // told "cancelled", never "session_expired", even for a vanished id.
    const gone = await handleWebToolsRpc(
      { action: "exec", sessionId: "ws-gone", tool: "web_search", argsRaw: "{}" },
      ac.signal,
    );
    expect((gone.json as any).envelope.error).toBe("cancelled");
  });

  it("close removes the session", async () => {
    const created = (
      await handleWebToolsRpc({ action: "create", depth: "quick", question: "q" })
    ).json as any;
    const closed = await handleWebToolsRpc({
      action: "close",
      sessionId: created.sessionId,
    });
    expect(closed.json).toEqual({ ok: true });
    const again = await handleWebToolsRpc({
      action: "exec",
      sessionId: created.sessionId,
      tool: "web_search",
      argsRaw: "{}",
    });
    expect((again.json as any).envelope.error).toBe("session_expired");
  });

  it("discover passes through a scope with no unresolved targets (no session, no network)", async () => {
    const res = await handleWebToolsRpc({
      action: "discover",
      scope: ENFORCEABLE_SCOPE,
      question: "open the pricing page",
    });
    expect(res.status).toBe(200);
    expect(res.json.scope).toEqual(ENFORCEABLE_SCOPE);
  });

  it("discover tolerates a missing scope", async () => {
    const res = await handleWebToolsRpc({ action: "discover", question: "x" });
    expect(res.status).toBe(200);
    expect(res.json.scope).toBeNull();
  });

  it("unknown action is a 400 (never a silent no-op)", async () => {
    const res = await handleWebToolsRpc({ action: "teleport" });
    expect(res.status).toBe(400);
  });
});

/* ── Repair (brief 2026-11-05 §5): journaling + prior-evidence rehydration
   across the bridge. The create response carries the journaled evidence
   block the Rust transport injects (⇔ web_loop.rs priorEvidence), and the
   numbering law guarantees ONE [S#] sequence per turn: prior aliases are
   numbered FIRST, starting clear of the caller's seed, and the session's
   own mints continue after the highest prior alias — never a collision. ── */

const JOURNAL_TURNS = [
  {
    at: 1762200000000,
    currentDate: "2026-11-04",
    queries: ["Voltara Systems funding round"],
    freshness: "week",
    sources: [
      {
        url: "https://voltara.example/news/series-b",
        title: "Voltara Systems raises Series B",
        domain: "voltara.example",
        publishedAt: "2026-11-01",
        fetchedAt: "2026-11-04T09:00:00.000Z",
        excerpt: "Voltara Systems closed a Series B round.",
      },
      {
        url: "https://techwire.example/voltara-series-b",
        title: "Halden Capital leads Voltara Systems Series B",
        domain: "techwire.example",
        publishedAt: "",
        fetchedAt: "2026-11-04T09:00:00.000Z",
        excerpt: "The round was led by Halden Capital.",
      },
    ],
  },
];

/** The pinned globalThis store — the seed pin reads the session object
    directly, so no networked exec is needed to observe mint numbering. */
function storedSession(sessionId: string): any {
  const store = (globalThis as any).__webuiWebToolsSessions as
    | Map<string, { session: any }>
    | undefined;
  const entry = store?.get(sessionId);
  if (!entry) throw new Error(`session ${sessionId} missing from the store`);
  return entry.session;
}

describe("web-tools RPC: journaling + prior-evidence rehydration (brief §5)", () => {
  beforeEach(() => {
    // Spy call bookkeeping must not leak across the §5 vectors (the
    // negative vectors assert NOT-to-have-been-called).
    journalMock.readResearchJournal.mockReset();
    journalMock.readResearchJournal.mockReturnValue([]);
  });

  it("create rehydrates journaled evidence, numbered clear of the caller seed, session mints after", async () => {
    journalMock.readResearchJournal.mockReturnValue(JOURNAL_TURNS);
    const res = await handleWebToolsRpc({
      action: "create",
      depth: "standard",
      citationSeed: 5,
      question: "anything new on the Voltara Systems funding round?",
      conversation: { id: "conv-rehydrate-1", currentDate: "2026-11-05" },
    });
    expect(res.status).toBe(200);
    const j = res.json as any;

    // The Rust transport injects this verbatim; the grammar is the TS law.
    expect(typeof j.priorEvidence.block).toBe("string");
    expect(j.priorEvidence.block).toContain("<prior_research_evidence>");
    // Numbering law: caller seed 5 ⇒ prior aliases start at S5/S6.
    expect(Object.keys(j.priorEvidence.citations)).toEqual(["S5", "S6"]);
    expect(j.priorEvidence.citations.S5).toMatchObject({
      sourceId: "S5",
      url: "https://voltara.example/news/series-b",
      domain: "voltara.example",
    });
    expect(j.priorEvidence.block).toContain("[S5]");
    expect(j.priorEvidence.block).toContain("[S6]");

    // The session's OWN mint continues after the highest prior alias —
    // two citations must never share one [S#] label on a turn.
    const session = storedSession(j.sessionId);
    expect(session.nextSource).toBe(7);
    expect(session.conversation).toMatchObject({ id: "conv-rehydrate-1", currentDate: "2026-11-05" });
  });

  it("no conversation ⇒ no rehydration and no journal identity (identity routes nothing else)", async () => {
    journalMock.readResearchJournal.mockReturnValue(JOURNAL_TURNS);
    const res = await handleWebToolsRpc({
      action: "create",
      depth: "standard",
      citationSeed: 4,
      question: "anything new on the Voltara Systems funding round?",
    });
    const j = res.json as any;
    expect(j.priorEvidence).toBeNull();
    const session = storedSession(j.sessionId);
    expect(session.conversation).toBeNull();
    expect(session.nextSource).toBe(4); // untouched by absent journaling
  });

  it("a malformed conversation DTO degrades to no journaling (fail-closed DTO gate)", async () => {
    journalMock.readResearchJournal.mockReturnValue(JOURNAL_TURNS);
    const res = await handleWebToolsRpc({
      action: "create",
      depth: "standard",
      citationSeed: 2,
      question: "anything new on the Voltara Systems funding round?",
      conversation: { id: "   ", currentDate: 42 },
    });
    const j = res.json as any;
    expect(res.status).toBe(200);
    expect(j.priorEvidence).toBeNull();
    expect(storedSession(j.sessionId).conversation).toBeNull();
    expect(journalMock.readResearchJournal).not.toHaveBeenCalled();
  });

  it("irrelevant prior turns are not dumped into context (relevance gate)", async () => {
    journalMock.readResearchJournal.mockReturnValue(JOURNAL_TURNS);
    const res = await handleWebToolsRpc({
      action: "create",
      depth: "standard",
      citationSeed: 1,
      question: "how do I rebase a stale branch safely?",
      conversation: { id: "conv-irrelevant-1", currentDate: "2026-11-05" },
    });
    const j = res.json as any;
    expect(j.priorEvidence).toBeNull();
    expect(storedSession(j.sessionId).nextSource).toBe(1);
  });
});
