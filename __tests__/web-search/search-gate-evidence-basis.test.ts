/**
 * WS03 (audit 2026-11-05, repair item 3 — "evidence-based gating validates
 * an enum, not evidence").  parseMainGateJson accepted ANY string from the
 * NO_SEARCH_BASIS enum — including `available_evidence` — with no check
 * that the conversation actually carries the evidence that basis claims.
 * A recognized enum must not authorize unsupported memory: the ONLY basis
 * that asserts the conversation already HAS the evidence is
 * `available_evidence`, and it is machine-checkable against the turn's
 * evidence-carrying context (attachment/image evidence — the same flags
 * the retrieval stage keys off).  A NO whose basis fails the machine check
 * is UNPARSEABLE: the turn escalates to the rules plan (source "rules"),
 * which force-YESes explicit evidence shapes and keeps genuine local
 * tasks local.  Stable explanations, supplied-material work and small
 * talk keep their no-search paths untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callLlm, runSearchGate } from "@/lib/web-search/search-gate";
import type { SearchGateContext } from "@/lib/web-search/types";

function stubGateModel(verdict: unknown) {
  const spy = vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(verdict) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("no-search bases are machine-checked against actual evidence (WS03)", () => {
  const noEvidenceNo: Record<string, unknown> = {
    // The exact audit shape: an enum-VALID basis string the model had no
    // way to ground — nothing is attached and nothing was retrieved.
    search_required: false,
    no_search_basis: "available_evidence",
    reason: "I know this model's capabilities",
    freshness: "none",
    depth: "quick",
    queries: [],
  };

  it("available_evidence with NO evidence in context is rejected — never a model NO", async () => {
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    stubGateModel(noEvidenceNo);
    const ctx: SearchGateContext = {
      userPrompt: "Does the Boreal-X17 model support function calling?",
    };
    // The parser contract is pinned directly (callLlm ⇔ mainModelGate ⇔
    // parseMainGateJson, no Stage-0 layer): an ungrounded available_evidence
    // NO must be UNPARSEABLE, so the caller escalates to the rules plan.
    const d = await callLlm(ctx);
    expect(d, "ungrounded available_evidence must not authorize a memory answer").toBeNull();
    // End-to-end: the gate's NO then comes from the rules plan, not the model.
    const r = await runSearchGate(ctx);
    expect(r.source, JSON.stringify(r.decision)).not.toBe("model");
    expect(r.decision.reason, JSON.stringify(r.decision)).not.toBe("I know this model's capabilities");
  });

  it("available_evidence WITH attachment evidence is honored — the basis is real there", async () => {
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    stubGateModel(noEvidenceNo);
    const d = await callLlm({
      userPrompt: "Does the attached datasheet for the Boreal-X17 support function calling?",
      hasAttachmentEvidence: true,
    });
    expect(d, "evidence really is present — the basis checks out").not.toBeNull();
    expect(d!.search_required).toBe(false);
    expect(d!.queries).toEqual([]);
  });

  it("context-independent bases stay unaffected by the evidence check", async () => {
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    stubGateModel({
      search_required: false,
      no_search_basis: "stable_general",
      reason: "Stable conceptual explanation",
      freshness: "none",
      depth: "quick",
      queries: [],
    });
    const d = await callLlm({ userPrompt: "Explain binary search." });
    expect(d, JSON.stringify(d)).not.toBeNull();
    expect(d!.search_required).toBe(false);
  });

  it("a missing or confidence-style basis is still rejected (regression pin)", async () => {
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    for (const bad of [
      { ...noEvidenceNo, no_search_basis: undefined },
      { ...noEvidenceNo, no_search_basis: "i am confident" },
    ]) {
      stubGateModel(bad);
      const d = await callLlm({ userPrompt: "Explain binary search." });
      expect(d, JSON.stringify(bad)).toBeNull();
    }
  });

  it("outage stays explicit — the rules plan names the unreachable model (unresolved-evidence law)", async () => {
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("gate model down"); }));
    const local = await runSearchGate({ userPrompt: "Explain Newton's first law." });
    expect(local.decision.search_required).toBe(false);
    // The NO is an explicit rules-plan verdict naming the outage — never a
    // silent "unknown treated as self-contained".
    expect(local.source).toBe("rules");
    expect(local.decision.reason.toLowerCase()).toContain("unreachable");
    // And an explicit evidence shape on the same outage still force-YESes.
    const live = await runSearchGate({ userPrompt: "What is the latest version of Node.js?" });
    expect(live.decision.search_required).toBe(true);
  });
});
