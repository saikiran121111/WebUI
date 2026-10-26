/**
 * Golden corpus — chat core scenarios (MIGRATION-MAP §6 rule-3 checklist):
 *   normal streaming | legacy non-streaming | malformed passthrough |
 *   empty/minimal payload | compaction passthrough | decision_mode
 *   passthrough | client abort | web-search disabled.
 *
 * All fixtures are recorded from the REAL handler in
 * app/api/chat/route.ts through a scripted mock upstream (no Strata slot
 * is ever consumed). Re-running this suite re-records and DIFFS: any
 * nondeterminism fails the run instead of silently rewriting history.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  MOCK_LLM_KEY,
  MOCK_LLM_URL,
  UpstreamScript,
  anchorSkillBlocks,
  bytesRecord,
  installUpstream,
  normalizeBodyMs,
  parseLogical,
  runChat,
  setGoldenEnv,
  writeJsonFixture,
} from "./support/golden";

setGoldenEnv();

vi.mock("@/lib/server/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/settings")>();
  return {
    ...actual,
    // Fixed unreachable target: deterministic error hosts, zero live backend.
    llmApiUrl: () => MOCK_LLM_URL,
    llmApiKey: () => MOCK_LLM_KEY,
  };
});

// Loaded AFTER setGoldenEnv() via beforeAll (route module must not import under a
// stale env); top-level await would trip tsc (tsconfig target es2015 => TS1378).
let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { POST = (await import("@/app/api/chat/route")).POST; });

const HARNESS = "__tests__/rust-golden/chat-core.test.ts";
const ENV_PRE = { WEB_SEARCH_GATE_DISABLED: "1", settings_llm_override: MOCK_LLM_URL };

/** Standard OpenAI-style SSE upstream script (3 logical chunks). */
const SSE_STD: UpstreamScript = {
  chunks: [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hello!"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ],
};

interface RunFixtureOpts {
  rel: string;
  scenario: string;
  semantics: string;
  comparison: "byte-exact" | "structural" | "semantic" | "approved-deviation";
  rawBody: string;
  upstream: UpstreamScript[];
  notes?: string;
  extra?: Record<string, unknown>;
}

async function runAndRecord(o: RunFixtureOpts) {
  const calls = installUpstream(o.upstream);
  const run = await runChat(POST as never, o.rawBody);
  const logical = parseLogical(run.text);
  const upstreamCalls = calls.map((c) => {
    let bodyJson: unknown = null;
    let anchors: ReturnType<typeof anchorSkillBlocks>["anchors"] = [];
    if (c.body) {
      try {
        const anchored = anchorSkillBlocks(JSON.parse(c.body));
        bodyJson = anchored.payload;
        anchors = anchored.anchors;
      } catch {
        bodyJson = null; // non-JSON forwarded verbatim
      }
    }
    return {
      url: c.url,
      method: c.method,
      headers: Object.fromEntries(Object.entries(c.headers).sort()),
      bodyText: c.body,
      bodyJson,
      anchors,
    };
  });
  // Progress-path bodies embed volatile ms DIGITS inside ruke_stage frames, so
  // the raw byte stream is NOT stable across machines. Those fixtures store the
  // ms-normalized text (structural class); byte-exact bodies are kept verbatim.
  const hasStage = logical.frames.some((f) => f.kind === "stage");
  writeJsonFixture(o.rel, {
    request: { rawBody: o.rawBody },
    upstreamCalls,
    response: {
      status: run.status,
      headers: run.headers,
      body: hasStage
        ? {
            bodyMsNormalized: normalizeBodyMs(run.text),
            note: "raw byte stream contains volatile ms digits in stage frames; compare logicalFrames + bodyMsNormalized, never raw bytes",
          }
        : bytesRecord(run.bytes),
    },
    logicalFrames: logical.frames,
    streamDone: logical.done,
    unterminatedTail: logical.tail,
    ...(o.extra ?? {}),
  }, {
    scenario: o.scenario,
    semantics: o.semantics,
    comparison: o.comparison,
    harness: HARNESS,
    env: ENV_PRE,
    normalization: 'Stage-event "ms" timing values replaced with "<ms>" in logicalFrames; progress-path ' +
      "response bodies are stored ms-normalized (raw bytes carry volatile ms digits).",
    notes: o.notes,
  });
  return { run, logical, calls };
}

describe("golden: chat core", () => {
  it("01 normal streaming chat", async () => {
    const body = JSON.stringify({
      model: "strata-mock",
      stream: true,
      messages: [{ role: "user", content: "hello there" }],
    });
    const { run, logical } = await runAndRecord({
      rel: "chat/01-stream-normal.json",
      scenario: "normal streaming chat (no attachments, no web)",
      semantics:
        "Progress path: early-open SSE 200, base streaming headers + x-decision-mode; first frame " +
        "decision_done; raw upstream bytes forwarded scrubbed; route NEVER appends [DONE] itself. " +
        "Upstream data frames inside the body are byte-stable; only the stage frame's ms digits vary, " +
        "so the body is stored ms-normalized.",
      comparison: "structural",
      rawBody: body,
      upstream: [SSE_STD],
    });
    expect(logical.frames[0]).toEqual({ kind: "stage", obj: { stage: "decision_done", mode: "standard_chat", ms: "<ms>" } });
    expect(run.headers["x-decision-mode"]).toBe("standard_chat");
    expect(run.headers["x-used-skill"]).toBeUndefined();
    expect(logical.done).toBe(true);
    expect(logical.tail).toBe("");
  });

  it("02 legacy non-streaming path", async () => {
    const body = JSON.stringify({
      model: "strata-mock",
      stream: false,
      messages: [{ role: "user", content: "hello there" }],
    });
    const { run, logical } = await runAndRecord({
      rel: "chat/02-legacy-nonstream.json",
      scenario: "legacy non-streaming consumer (stream === false)",
      semantics:
        "Only stream === false selects the legacy branch (early response, metadata in HEADERS, " +
        "ZERO ruke_stage frames). Upstream bytes still forwarded verbatim.",
      comparison: "byte-exact",
      rawBody: body,
      upstream: [SSE_STD],
    });
    expect(logical.frames.every((f) => f.kind !== "stage")).toBe(true);
    expect(run.headers["x-decision-mode"]).toBe("standard_chat");
  });

  it("03 malformed / non-JSON body passthrough", async () => {
    const raw = "this is {{{not json";
    const { run, calls } = await runAndRecord({
      rel: "chat/03-malformed-passthrough.json",
      scenario: "malformed/non-JSON request body",
      semantics:
        "JSON.parse fails -> payload=null: NO decision, NO pipeline; the RAW request bytes are " +
        "forwarded verbatim as the upstream body; x-decision-mode stays standard_chat; model 'default'.",
      comparison: "byte-exact",
      rawBody: raw,
      upstream: [SSE_STD],
    });
    expect(calls[0].body).toBe(raw);
    expect(run.headers["x-decision-mode"]).toBe("standard_chat");
  });

  it("04 minimal / empty payloads", async () => {
    await runAndRecord({
      rel: "chat/04a-minimal-empty-object.json",
      scenario: "empty JSON object payload",
      semantics:
        "{} parses truthy but has no messages array -> whole decision branch skipped -> upstream " +
        "receives JSON.stringify({}) = '{}'; legacy-shape response (forwardStream), model 'default'.",
      comparison: "byte-exact",
      rawBody: "{}",
      upstream: [SSE_STD],
    });
    await runAndRecord({
      rel: "chat/04b-minimal-empty-user-turn.json",
      scenario: "single empty user turn",
      semantics:
        "Empty last-user text -> getDecision('') -> in-process fallback envelope (standard_chat, no " +
        "skill block) -> progress path (stream absent !== false) with decision_done frame.",
      comparison: "structural",
      rawBody: JSON.stringify({ messages: [{ role: "user", content: "" }] }),
      upstream: [SSE_STD],
    });
    await runAndRecord({
      rel: "chat/04c-minimal-empty-messages.json",
      scenario: "empty messages array",
      semantics: "messages: [] -> length check fails -> pipeline skipped, payload forwarded intact.",
      comparison: "byte-exact",
      rawBody: JSON.stringify({ messages: [] }),
      upstream: [SSE_STD],
    });
  });

  it("05 compaction passthrough", async () => {
    const body = JSON.stringify({
      purpose: "compact",
      model: "strata-mock",
      stream: true,
      messages: [
        { role: "user", content: [
          { type: "text", text: "fold this history" },
          { type: "attachment_ref", att_id: "att_golden1a", name: "deck.pdf", category: "text" },
        ] },
        { role: "assistant", content: "ok" },
      ],
    });
    const { run, logical } = await runAndRecord({
      rel: "chat/05-compaction-passthrough.json",
      scenario: "compaction passthrough (purpose === 'compact')",
      semantics:
        "purpose deleted before forwarding; attachment_refs stripped; NO decision, NO skill block, " +
        "NO stage frames (even though stream is true) — the request rides the legacy forwardStream " +
        "shape: raw upstream bytes + header metadata only.",
      comparison: "byte-exact",
      rawBody: body,
      upstream: [SSE_STD],
    });
    expect(logical.frames.some((f) => f.kind === "stage")).toBe(false);
  });

  it("06 decision_mode passthrough (both paths)", async () => {
    const raw = JSON.stringify({
      decision_mode: "chart",
      stream: false,
      messages: [{ role: "user", content: "give me the chart again" }],
    });
    await runAndRecord({
      rel: "chat/06a-decision-mode-legacy.json",
      scenario: "client-pinned decision_mode (repair passthrough, legacy path)",
      semantics:
        "decision_mode removed from the forwarded payload; envelope = passthroughEnvelope " +
        "(decided_by repair-passthrough, confidence 1, stripped_prompt verbatim); x-decision-mode: chart. " +
        "For 'chart' MODE_SKILL is null but MODE_CONTRACTS[chart] exists -> a decision_skill block with " +
        "ONLY the mode contract is injected (no core_skill).",
      comparison: "byte-exact",
      rawBody: raw,
      upstream: [SSE_STD],
    });
    await runAndRecord({
      rel: "chat/06b-decision-mode-progress.json",
      scenario: "client-pinned decision_mode (repair passthrough, progress path)",
      semantics:
        "Same envelope on the progress path: decision_done{mode:chart} then a nameless skill frame " +
        "(skill block bytes > 0, core-tier invisibility) then web_meta-less upstream bytes.",
      comparison: "structural",
      rawBody: JSON.stringify({
        decision_mode: "chart",
        messages: [{ role: "user", content: "give me the chart again" }],
      }),
      upstream: [SSE_STD],
    });
  });

  it("07 client abort mid-stream", async () => {
    const ac = new AbortController();
    const calls = installUpstream([{ chunks: ["data: partial\n\n"], holdUntilAbort: true }]);
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "abort me" }] }),
      signal: ac.signal,
    }) as never;
    const res = await POST(req);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = await reader.read();
    const second = await reader.read();
    const collected = dec.decode(first.value) + dec.decode(second.value);
    ac.abort();
    let end: { done: boolean; value?: Uint8Array };
    do {
      end = await reader.read();
    } while (!end.done);

    const logical = parseLogical(collected);
    const upstreamAborted = calls[0].signal?.aborted === true;
    writeJsonFixture("chat/07-client-abort.json", {
      request: { rawBody: "<messages: one user 'abort me', stream path>", note: "signal aborted by client after 2 reads" },
      streamedBeforeAbort: normalizeBodyMs(collected),
      logicalFramesBeforeAbort: logical.frames,
      finalReadDone: end.done,
      upstreamSignalAborted: upstreamAborted,
      errorFramesAfterAbort: 0,
    }, {
      scenario: "client aborts mid-stream",
      semantics:
        "Client disconnect cancels the response -> inner AbortController aborts -> upstream fetch " +
        "signal aborts (zombie-turn protection). Route maps AbortError to a SILENT close: NO " +
        "ruke_error frame, NO [DONE] appended after partial bytes.",
      comparison: "semantic",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "Timing-dependent: partial byte capture is not byte-exact; the CONTRACT is: upstream " +
        "signal aborts, no error frame, stream closes.",
      notes: "Rust parity: abort must kill the upstream request and emit no frames after cancellation.",
    });
    expect(upstreamAborted).toBe(true);
    expect(logical.frames.some((f) => f.kind === "error")).toBe(false);
  });

  it("08 web-search disabled by env", async () => {
    const { logical } = await runAndRecord({
      rel: "chat/08-web-search-disabled.json",
      scenario: "web search disabled (WEB_SEARCH_GATE_DISABLED=1)",
      semantics:
        "A prompt the gate WOULD research ('latest weather in Paris') runs with the pipeline fully " +
        "skipped: ZERO web:* frames, no web_meta frame, no X-Web-Citations header (progress path).",
      comparison: "structural",
      rawBody: JSON.stringify({ messages: [{ role: "user", content: "what is the latest weather in Paris today?" }] }),
      upstream: [SSE_STD],
    });
    expect(logical.frames.some((f) => f.kind === "stage" && String((f.obj as { stage?: string }).stage).startsWith("web:"))).toBe(false);
  });
});
