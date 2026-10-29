/**
 * Golden corpus — decision envelope wire contract (MIGRATION-MAP §6 rule-3
 * "decision serialization" item + §6 rule-4 on byte-vs-structural classes).
 *
 * /api/decision returns NextResponse.json(envelope) — the EXACT JSON bytes
 * (key order included) are the contract the Rust DecisionEnvelope serializer
 * must reproduce. `confidence: 1` renders as integer `1` in JS; serde_json
 * would render a Rust f64 as `1.0` — that is a parity TRAP, recorded here as
 * a finding for Parts 3/4 (do NOT silently normalize).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { MOCK_LLM_KEY, MOCK_LLM_URL, headerMap, setGoldenEnv, writeJsonFixture } from "./support/golden";

setGoldenEnv();

vi.mock("@/lib/server/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/settings")>();
  return {
    ...actual,
    llmApiUrl: () => MOCK_LLM_URL,
    llmApiKey: () => MOCK_LLM_KEY,
  };
});

// Loaded AFTER setGoldenEnv() via beforeAll (route module must not import under a
// stale env); top-level await would trip tsc (tsconfig target es2015 => TS1378).
let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { POST = (await import("@/app/api/decision/route")).POST; });

const HARNESS = "__tests__/rust-golden/decision-serialization.test.ts";
const ENV_PRE = { settings_llm_override: MOCK_LLM_URL };

async function postDecision(rawBody: string) {
  const res = await POST(
    new Request("http://localhost:3000/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    }) as never,
  );
  const text = await res.text();
  return { status: res.status, headers: headerMap(res), bodyText: text };
}

async function recordDecision(rel: string, scenario: string, semantics: string, rawBody: string, notes?: string) {
  const r = await postDecision(rawBody);
  let envelope: Record<string, unknown> | null = null;
  try { envelope = JSON.parse(r.bodyText); } catch { /* error shapes */ }
  writeJsonFixture(rel, {
    request: { rawBody },
    response: { status: r.status, headers: r.headers, bodyBytes: r.bodyText },
    envelope,
    envelopeKeyOrder: envelope ? Object.keys(envelope) : null,
  }, {
    scenario,
    semantics,
    comparison: "byte-exact",
    harness: HARNESS,
    env: ENV_PRE,
    normalization: "none — the whole point is that these bytes contain NO timing/volatile fields.",
    notes,
  });
  return { r, envelope };
}

describe("golden: decision envelope serialization", () => {
  it("01 excel intent match — exact response bytes", async () => {
    const { r, envelope } = await recordDecision(
      "decision/01-route-excel-match.json",
      "POST /api/decision — excel intent match",
      "In-process regex router (zero network): response bytes are JSON.stringify(envelope) — compact, " +
        "insertion-order key sequence pinned by envelopeKeyOrder.",
      JSON.stringify({ message: "put these numbers into my spreadsheet" }),
    );
    expect(r.status).toBe(200);
    expect(envelope!.active_mode).toBe("excel");
    expect(envelope!.decided_by).toBe("in-process-deliverable-match");
    expect(envelope!.confidence).toBe(1);
    expect(r.bodyText).toContain('"confidence":1');
    expect(r.bodyText).not.toContain('"confidence":1.0');
  });

  it("02 standard miss with history — stripped_prompt verbatim", async () => {
    const msg = "tell me more about that";
    const { envelope } = await recordDecision(
      "decision/02-route-standard-with-history.json",
      "POST /api/decision — no intent match (standard_chat) with conversationHistory",
      "Regex miss still yields decided_by 'in-process-deliverable-match' with active_mode standard_chat " +
        "(NOT a fallback flag): the envelope is ALWAYS built; stripped_prompt is ALWAYS verbatim equal to " +
        "the incoming message — history never alters it. CONTRACT DISCOVERY: the history field the route " +
        "reads is named 'conversationHistory' (an unknown 'history' key is silently ignored). skill_to_load " +
        "is null for standard_chat; enable_validator is ALWAYS the active mode id; disable_validators is " +
        "every OTHER mode in INTENT_ORDER.",
      JSON.stringify({
        message: msg,
        conversationHistory: [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier reply" }],
      }),
    );
    expect(envelope!.active_mode).toBe("standard_chat");
    expect(envelope!.stripped_prompt).toBe(msg);
    expect(envelope!.skill_to_load).toBeNull();
    expect(envelope!.enable_validator).toBe("standard_chat");
  });

  it("03 whitespace-only message — rejected by the route guard", async () => {
    const { r } = await recordDecision(
      "decision/03-route-whitespace-rejected.json",
      "POST /api/decision — whitespace-only message",
      "The route guard tests message.trim() -> whitespace-only hits 400 {\"error\":\"message required\"}. " +
        "CONTRACT DISCOVERY: fallbackEnvelope (decided_by 'in-process-fallback') is therefore UNREACHABLE " +
        "through the public /api/decision route — it is an INTERNAL-only envelope (e.g. the chat route's " +
        "empty-turn path). Rust must keep it internal too.",
      JSON.stringify({ message: "   " }),
    );
    expect(r.status).toBe(400);
    expect(r.bodyText).toBe('{"error":"message required"}');
  });

  it("04 invalid JSON body", async () => {
    const { r } = await recordDecision(
      "decision/04-route-invalid-json.json",
      "POST /api/decision — malformed JSON",
      "JSON.parse throws -> 400 {\"error\":\"invalid JSON body\"} byte-exact.",
      "{oops",
    );
    expect(r.status).toBe(400);
    expect(r.bodyText).toBe('{"error":"invalid JSON body"}');
  });

  it("05 missing message", async () => {
    const { r } = await recordDecision(
      "decision/05-route-missing-message.json",
      "POST /api/decision — message missing/empty",
      "400 {\"error\":\"message required\"} byte-exact. The guard tests message.trim(), so empty AND " +
        "whitespace-only messages both land here (see fixture 03).",
      JSON.stringify({ history: [] }),
    );
    expect(r.status).toBe(400);
    expect(r.bodyText).toBe('{"error":"message required"}');
  });

  it("06 field-by-field comparison classes (serialization ledger)", async () => {
    const excel = await postDecision(JSON.stringify({ message: "spreadsheet please" }));
    const env = JSON.parse(excel.bodyText) as Record<string, unknown>;

    // 11 rows in EXACTLY the observed insertion order (see fixture 01 envelopeKeyOrder).
    const LEDGER = [
      { path: "active_mode", comparison: "byte-exact", note: "string enum of mode ids" },
      { path: "confidence", comparison: "byte-exact", note: 'JS always emits integer 1 ("1"). serde_json f64 emits "1.0" — BYTE-INEQUAL. Rust serializer must emit 1 (integer). Finding for Parts 3/4; do NOT normalize the TS side.' },
      { path: "decided_by", comparison: "byte-exact", note: '"in-process-deliverable-match" | "in-process-fallback" (internal-only) | (chat-internal-only: "repair-passthrough")' },
      { path: "stripped_prompt", comparison: "byte-exact", note: "ALWAYS verbatim === incoming message" },
      { path: "skill_to_load", comparison: "byte-exact", note: "core skill name (MODE_SKILL) or null; null MUST serialize as JSON null (present), not omitted" },
      { path: "allowed_code_fence", comparison: "byte-exact", note: "string or null; null MUST serialize as JSON null (present), not omitted" },
      { path: "disable_validators", comparison: "byte-exact", note: "string array; ORDER significant (INTENT_ORDER minus active)" },
      { path: "enable_validator", comparison: "byte-exact", note: "ALWAYS the active mode id (observed for excel AND standard_chat)" },
      { path: "task_constraints", comparison: "byte-exact", note: "always [] in the in-process engine" },
      { path: "extracted_entities", comparison: "byte-exact", note: "always [] in the in-process engine" },
      { path: "lfm_latency_ms", comparison: "byte-exact", note: "always 0 (in-process)" },
    ];
    const NEVER_PRESENT = ["lfm_input", "lfm_raw"];

    for (const f of LEDGER) {
      expect(env, `ledger field missing: ${f.path}`).toHaveProperty(f.path);
    }
    for (const k of NEVER_PRESENT) {
      expect(env, `field must be OMITTED (not null): ${k}`).not.toHaveProperty(k);
      expect(excel.bodyText).not.toContain(`"${k}"`);
    }
    const extras = Object.keys(env).filter((k) => !LEDGER.some((f) => f.path === k));
    expect(extras, `envelope carries keys not in the ledger: ${extras.join(",")}`).toEqual([]);

    writeJsonFixture("serialization/01-decision-envelope-fields.json", {
      referenceCall: { message: "spreadsheet please" },
      envelopeKeyOrder: Object.keys(env),
      fields: LEDGER,
      neverPresentFields: NEVER_PRESENT.map((k) => ({ path: k, note: "OMITTED from the JSON object — absence, not null. Rust struct must skip-serialize these (serde default+skip) or leave them out entirely." })),
      keyOrderContract: "TS JSON.stringify preserves object insertion order; fixture 01/02/03 pin envelopeKeyOrder. Rust DecisionEnvelope must serialize in the SAME order to be byte-exact.",
    }, {
      scenario: "DecisionEnvelope field-by-field comparison classes",
      semantics:
        "Ledger of every envelope field with its comparison class. The confidence '1' vs serde '1.0' and " +
        "the omitted-vs-null lfm_input/lfm_raw fields are the two known serializer traps for Parts 3/4.",
      comparison: "semantic",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "none",
      notes: "Part 3/4 must NOT 'fix' the TS side; the Rust serializer conforms to these bytes (or an explicit approved deviation is recorded).",
    });
  });
});
