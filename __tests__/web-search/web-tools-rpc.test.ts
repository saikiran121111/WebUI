/**
 * Web-tools RPC contract vectors (rollback 2026-11-03, Section C).
 *
 * These pin the Rust↔TS web-tool bridge grammar: the model-visible envelope
 * strings must stay byte-identical to the retired Rust web_loop inline
 * envelopes, and session lifecycle must degrade honestly (never a hang).
 * Hermetic: no network — exec vectors stop before retrieval (bad args /
 * unknown tool), discover vectors carry no unresolved targets.
 */
import { describe, it, expect } from "vitest";
import { handleWebToolsRpc } from "@/lib/server/web-tools-rpc";

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
    expect(j.budget).toEqual({ maxSearchCalls: 2, maxReadUrls: 12, maxToolRounds: 4 }); // ⇔ locked budget table
    expect(j.remainingBudget).toEqual({ searches: 2, readUrls: 12, rounds: 4 });
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
