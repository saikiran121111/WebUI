/**
 * Golden corpus — two-tier skills (MIGRATION-MAP §6 items: slash skill both
 * paths, unknown slash passthrough, core-tier skill via decision routing,
 * client-pinned decision_mode passthrough).
 *
 * Skill BODIES are never inlined into fixtures: each injection block is
 * replaced by an anchor pinning the block's sha256 + byte length, sourced
 * from the tracked skill files. The Rust port must reproduce the composed
 * block byte-for-byte from the same files with the same loader rules
 * (stripFrontmatter / stripExecutableSections / linked-.md append / 9000-byte
 * cap for core; bundle append + 160000 cap for user tier).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  MOCK_LLM_KEY,
  MOCK_LLM_URL,
  PayloadAnchor,
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

const HARNESS = "__tests__/rust-golden/skills.test.ts";
const ENV_PRE = { WEB_SEARCH_GATE_DISABLED: "1", settings_llm_override: MOCK_LLM_URL };

const SSE_STD: UpstreamScript = {
  chunks: [
    'data: {"id":"k1","choices":[{"index":0,"delta":{"content":"done"}}]}\n\n',
    "data: [DONE]\n\n",
  ],
};

async function runAndRecord(o: {
  rel: string;
  scenario: string;
  semantics: string;
  comparison: "byte-exact" | "structural" | "semantic" | "approved-deviation";
  rawBody: string;
  notes?: string;
  anchorsNote?: string;
}) {
  const calls = installUpstream([SSE_STD]);
  const run = await runChat(POST as never, o.rawBody);
  const logical = parseLogical(run.text);
  const hasStage = logical.frames.some((f) => f.kind === "stage");
  const upstreamCalls = calls.map((c) => {
    let bodyJson: unknown = null;
    let anchors: PayloadAnchor[] = [];
    if (c.body) {
      try {
        const anchored = anchorSkillBlocks(JSON.parse(c.body));
        bodyJson = anchored.payload;
        anchors = anchored.anchors;
      } catch { bodyJson = null; }
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
  writeJsonFixture(o.rel, {
    request: { rawBody: o.rawBody },
    upstreamCalls,
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
    anchors: upstreamCalls.flatMap((c) => c.anchors.flatMap((a) => a.sources)),
  });
  return { run, logical, upstreamCalls };
}

type Frames = ReturnType<typeof parseLogical>["frames"];
type StageFrame = Extract<Frames[number], { kind: "stage" }>;
const stageNames = (frames: Frames) =>
  frames.filter((f): f is StageFrame => f.kind === "stage").map((f) => (f.obj as { stage?: string }).stage);
const stageFrame = (frames: Frames, name: string) =>
  frames.filter((f): f is StageFrame => f.kind === "stage").find((f) => (f.obj as { stage?: string }).stage === name);

describe("golden: skills (two-tier)", () => {
  it("01 slash user skill — progress path", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "skills/01-slash-user-skill-progress.json",
      scenario: "slash-invoked user-tier skill /humanizer (progress path)",
      semantics:
        "SLASH_COMMAND regex strips '/humanizer ' -> forwarded user content is the trimmed remainder; " +
        "the composed <active_skill name=\"humanizer\"> system block is injected before the messages; " +
        "X-Used-Skill header (byte-exact) AND a skill stage frame carrying detail=\"humanizer\" (user " +
        "tier ONLY ever gets detail). Decision still runs on the stripped remainder (standard_chat).",
      comparison: "structural",
      rawBody: JSON.stringify({ messages: [{ role: "user", content: "/humanizer rewrite this paragraph plainly" }] }),
    });
    expect(run.headers["x-used-skill"]).toBe("humanizer");
    expect(stageNames(logical.frames)).toEqual(["decision_done", "skill"]);
    const skillFrame = stageFrame(logical.frames, "skill");
    expect((skillFrame!.obj as { detail?: string }).detail).toBe("humanizer");
    const anchors = upstreamCalls[0].anchors;
    expect(anchors.length).toBe(1);
    expect(anchors[0].kind).toBe("active_skill");
    expect(anchors[0].name).toBe("humanizer");
    const userMsg = (upstreamCalls[0].bodyJson as { messages: { role: string; content: unknown }[] }).messages
      .filter((m) => m.role === "user").pop();
    expect(typeof userMsg!.content === "string" && userMsg!.content.trim()).toBe("rewrite this paragraph plainly");
  });

  it("02 slash user skill — legacy path", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "skills/02-slash-user-skill-legacy.json",
      scenario: "slash-invoked user-tier skill /humanizer (legacy stream:false path)",
      semantics:
        "Same injection + strip on the legacy branch: X-Used-Skill header present, ZERO stage frames; " +
        "metadata (x-decision-mode, x-used-skill) travel only as HEADERS.",
      comparison: "byte-exact",
      rawBody: JSON.stringify({
        stream: false,
        messages: [{ role: "user", content: "/humanizer rewrite this paragraph plainly" }],
      }),
    });
    expect(run.headers["x-used-skill"]).toBe("humanizer");
    expect(logical.frames.some((f) => f.kind === "stage")).toBe(false);
    expect(upstreamCalls[0].anchors[0].kind).toBe("active_skill");
  });

  it("03 unknown slash command passthrough", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "skills/03-unknown-slash-passthrough.json",
      scenario: "unknown slash command /nosuchskill",
      semantics:
        "Slash regex MATCHES but the scenario/skill does not exist -> applySlashSkillRouting returns " +
        "null: NO prefix strip (user text keeps '/nosuchskill '), NO injection, NO X-Used-Skill header, " +
        "NO skill stage frame. The literal text flows to the normal decision branch.",
      comparison: "structural",
      rawBody: JSON.stringify({ messages: [{ role: "user", content: "/nosuchskill hello world" }] }),
    });
    expect(run.headers["x-used-skill"]).toBeUndefined();
    expect(stageNames(logical.frames)).toEqual(["decision_done"]);
    const userMsg = (upstreamCalls[0].bodyJson as { messages: { role: string; content: unknown }[] }).messages
      .filter((m) => m.role === "user").pop();
    expect(userMsg!.content).toBe("/nosuchskill hello world");
    expect(upstreamCalls[0].anchors.length).toBe(0);
  });

  it("04 core-tier skill via decision routing", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "skills/04-core-skill-decision.json",
      scenario: "core-tier (.cskills) skill activated by in-process decision (excel intent)",
      semantics:
        "The word 'spreadsheet' matches INTENT_MATCHERS.excel -> active_mode excel, core skill xlsx is " +
        "loaded through the Hybrid Decision Engine skill-loader: a <decision_skill mode=\"excel\" " +
        "decided_by=\"in-process-deliverable-match\"> block wrapping <core_skill name=\"xlsx\"> (bundle, " +
        "frontmatter stripped, executable sections stripped, capped) + the MODE_CONTRACT text. " +
        "STRICT INVISIBILITY: NO X-Used-Skill header, skill stage frame has NO detail (core tier never " +
        "names itself to the client).",
      comparison: "structural",
      rawBody: JSON.stringify({ messages: [{ role: "user", content: "build me a spreadsheet with the quarterly sales" }] }),
    });
    expect(run.headers["x-decision-mode"]).toBe("excel");
    expect(run.headers["x-used-skill"]).toBeUndefined();
    const skillFrame = stageFrame(logical.frames, "skill");
    expect(skillFrame).toBeTruthy();
    expect((skillFrame!.obj as { detail?: string }).detail).toBeUndefined();
    const anchors = upstreamCalls[0].anchors;
    expect(anchors.length).toBe(1);
    expect(anchors[0].kind).toBe("decision_skill");
    expect(anchors[0].name).toBe("excel");
    expect(anchors[0].sources.some((s) => s.path === ".cskills/xlsx/SKILL.md")).toBe(true);
  });

  it("05 client-pinned decision_mode excel passthrough", async () => {
    const { run, upstreamCalls } = await runAndRecord({
      rel: "skills/05-decision-mode-excel-passthrough.json",
      scenario: "decision_mode: excel repair passthrough (legacy path)",
      semantics:
        "decision_mode is REMOVED from the forwarded payload; envelope = passthrough (decided_by " +
        "\"repair-passthrough\" — this attribute appears INSIDE the decision_skill block header and is " +
        "pinned by block_sha256). Core xlsx skill + excel contract injected exactly as in fixture 04.",
      comparison: "byte-exact",
      rawBody: JSON.stringify({
        decision_mode: "excel",
        stream: false,
        messages: [{ role: "user", content: "re-emit the deliverable for this request" }],
      }),
    });
    expect(run.headers["x-decision-mode"]).toBe("excel");
    expect(upstreamCalls[0].anchors[0].kind).toBe("decision_skill");
    expect(upstreamCalls[0].anchors[0].name).toBe("excel");
  });
});
