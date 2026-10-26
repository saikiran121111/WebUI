/**
 * Golden corpus — upstream failure scenarios (MIGRATION-MAP §6 rule-3
 * checklist items: upstream 4xx/5xx both paths, unreachable upstream both
 * paths, no-response-body both paths).
 *
 * The error MESSAGE STRINGS are part of the wire contract (the client shows
 * them verbatim), so they are pinned byte-exactly by these fixtures.
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
    llmApiUrl: () => MOCK_LLM_URL,
    llmApiKey: () => MOCK_LLM_KEY,
  };
});

// Loaded AFTER setGoldenEnv() via beforeAll (route module must not import under a
// stale env); top-level await would trip tsc (tsconfig target es2015 => TS1378).
let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { POST = (await import("@/app/api/chat/route")).POST; });

const HARNESS = "__tests__/rust-golden/errors.test.ts";
const ENV_PRE = { WEB_SEARCH_GATE_DISABLED: "1", settings_llm_override: MOCK_LLM_URL };

function body(userText: string, stream: boolean): string {
  return JSON.stringify({ model: "strata-mock", stream, messages: [{ role: "user", content: userText }] });
}

async function runAndRecord(o: {
  rel: string;
  scenario: string;
  semantics: string;
  comparison: "byte-exact" | "structural" | "semantic" | "approved-deviation";
  rawBody: string;
  upstream: UpstreamScript;
  notes?: string;
}) {
  const calls = installUpstream([o.upstream]);
  const run = await runChat(POST as never, o.rawBody);
  const logical = parseLogical(run.text);
  const hasStage = logical.frames.some((f) => f.kind === "stage");
  writeJsonFixture(o.rel, {
    request: { rawBody: o.rawBody },
    upstreamCalls: calls.map((c) => ({
      url: c.url,
      method: c.method,
      headers: Object.fromEntries(Object.entries(c.headers).sort()),
      bodyText: c.body,
    })),
    response: {
      status: run.status,
      headers: run.headers,
      body: hasStage
        ? { bodyMsNormalized: normalizeBodyMs(run.text), note: "stage frames carry volatile ms digits; compare logicalFrames + bodyMsNormalized" }
        : bytesRecord(run.bytes),
    },
    logicalFrames: logical.frames,
    streamDone: logical.done,
    unterminatedTail: logical.tail,
  }, {
    scenario: o.scenario,
    semantics: o.semantics,
    comparison: o.comparison,
    harness: HARNESS,
    env: ENV_PRE,
    normalization: 'Stage-event "ms" timing values replaced with "<ms>" in logicalFrames; progress-path bodies are ms-normalized text.',
    notes: o.notes,
  });
  return { run, logical };
}

describe("golden: upstream failures", () => {
  const LONG_ERR = "upstream exploded: " + "X".repeat(300);

  it("01 upstream 400 — legacy path", async () => {
    const { run, logical } = await runAndRecord({
      rel: "errors/01-upstream-400-legacy.json",
      scenario: "upstream HTTP 400 (legacy stream:false path)",
      semantics:
        "Non-2xx upstream on the legacy path: the route answers a JSON error object; upstream status is " +
        "preserved and the message is 'Upstream returned <status>: <first 200 chars of upstream error text>'.",
      comparison: "byte-exact",
      rawBody: body("fail please", false),
      upstream: { status: 400, headers: { "Content-Type": "text/plain" }, chunks: ["bad request details"] },
    });
    expect(run.status).toBe(400);
    expect(JSON.parse(run.text).error).toBe("Upstream returned 400: bad request details");
    expect(logical.frames.length).toBe(0);
  });

  it("02 upstream 400 — progress path", async () => {
    const { run, logical } = await runAndRecord({
      rel: "errors/02-upstream-400-progress.json",
      scenario: "upstream HTTP 400 (progress path)",
      semantics:
        "SSE already open when upstream returns 400: the stage frames emitted so far stay, then ONE " +
        "ruke_error frame with the same 'Upstream returned 400: ...' text, then [DONE]. HTTP status " +
        "stays 200 (headers already committed).",
      comparison: "structural",
      rawBody: body("fail please", true),
      upstream: { status: 400, headers: { "Content-Type": "text/plain" }, chunks: ["bad request details"] },
    });
    expect(run.status).toBe(200);
    expect(logical.frames[0].kind).toBe("stage");
    const err = logical.frames.find((f) => f.kind === "error");
    expect(err && (err as { message: string }).message).toBe("Upstream returned 400: bad request details");
    expect(logical.frames.filter((f) => f.kind === "error").length).toBe(1);
    expect(logical.done).toBe(true);
  });

  it("03 upstream 500 — legacy path (pins 200-char error truncation)", async () => {
    const { run } = await runAndRecord({
      rel: "errors/03-upstream-500-legacy.json",
      scenario: "upstream HTTP 500 with long error text (legacy path)",
      semantics:
        "Same branch as 4xx; the upstream error text is sliced to its FIRST 200 CHARACTERS inside the " +
        "message — fixture pins the exact cut.",
      comparison: "byte-exact",
      rawBody: body("fail hard", false),
      upstream: { status: 500, headers: { "Content-Type": "text/plain" }, chunks: [LONG_ERR] },
    });
    expect(run.status).toBe(500);
    const msg: string = JSON.parse(run.text).error;
    expect(msg).toBe(`Upstream returned 500: ${LONG_ERR.slice(0, 200)}`);
    expect(msg.length).toBe("Upstream returned 500: ".length + 200);
  });

  it("04 upstream 500 — progress path", async () => {
    const { logical } = await runAndRecord({
      rel: "errors/04-upstream-500-progress.json",
      scenario: "upstream HTTP 500 (progress path)",
      semantics: "Stage prefix + one ruke_error + [DONE]; identical truncation semantics as legacy.",
      comparison: "structural",
      rawBody: body("fail hard", true),
      upstream: { status: 500, headers: { "Content-Type": "text/plain" }, chunks: [LONG_ERR] },
    });
    const err = logical.frames.find((f) => f.kind === "error");
    expect(err && (err as { message: string }).message).toBe(`Upstream returned 500: ${LONG_ERR.slice(0, 200)}`);
  });

  it("05 empty upstream body — legacy path", async () => {
    const { run } = await runAndRecord({
      rel: "errors/05-no-body-legacy.json",
      scenario: "upstream 200 with null body (legacy path)",
      semantics: "Upstream responds but has no body -> 502 {error:'No response body from model'}.",
      comparison: "byte-exact",
      rawBody: body("silent model", false),
      upstream: { emptyBody: true },
    });
    expect(run.status).toBe(502);
    expect(JSON.parse(run.text)).toEqual({ error: "No response body from model" });
  });

  it("06 empty upstream body — progress path", async () => {
    const { logical } = await runAndRecord({
      rel: "errors/06-no-body-progress.json",
      scenario: "upstream 200 with null body (progress path)",
      semantics: "Stage frames + ruke_error 'No response body from model' + [DONE]; HTTP stays 200.",
      comparison: "structural",
      rawBody: body("silent model", true),
      upstream: { emptyBody: true },
    });
    const err = logical.frames.find((f) => f.kind === "error");
    expect(err && (err as { message: string }).message).toBe("No response body from model");
    expect(logical.done).toBe(true);
  });

  it("07 unreachable upstream — legacy path", async () => {
    const { run } = await runAndRecord({
      rel: "errors/07-unreachable-legacy.json",
      scenario: "upstream fetch throws (legacy path)",
      semantics:
        "fetch() rejection (connection refused to 127.0.0.1:9) -> 503 " +
        "{error:'Could not reach the model server at <host:port>.'} — the mock settings URL's host:port appears verbatim.",
      comparison: "byte-exact",
      rawBody: body("hello", false),
      upstream: { throwOnFetch: () => new TypeError("fetch failed") },
    });
    expect(run.status).toBe(503);
    expect(JSON.parse(run.text)).toEqual({ error: "Could not reach the model server at 127.0.0.1:9." });
  });

  it("08 unreachable upstream — progress path", async () => {
    const { run, logical } = await runAndRecord({
      rel: "errors/08-unreachable-progress.json",
      scenario: "upstream fetch throws (progress path)",
      semantics:
        "SSE opened first: decision_done (and any pipeline frames) already emitted, then ONE ruke_error " +
        "with the same 503 message text, then [DONE]. The HTTP STATUS stays 200 — the 503 number does " +
        "NOT survive on this path; only the message text is the cross-path contract.",
      comparison: "structural",
      rawBody: body("hello", true),
      upstream: { throwOnFetch: () => new TypeError("fetch failed") },
    });
    expect(run.status).toBe(200);
    expect(logical.frames[0].kind).toBe("stage");
    const err = logical.frames.find((f) => f.kind === "error");
    expect(err && (err as { message: string }).message).toBe("Could not reach the model server at 127.0.0.1:9.");
    expect(logical.done).toBe(true);
  });
});
