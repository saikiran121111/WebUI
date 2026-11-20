/**
 * Golden corpus — attachment knowledge-index retrieval (MIGRATION-MAP §6
 * items: retrieval success + failure non-fatal).
 *
 * The on-disk index (.data/attach-index/<attId>/{meta.json,chunks.jsonl}) is
 * SEEDED deterministically via the production store writer, so retrieval
 * itself runs for real (BM25 + RRF + pack are NOT mocked). The ONLY seam is
 * embedOne: the embedding model is not a wire contract, so a fixed pseudo
 * vector is injected (documented in each fixture's _meta).
 *
 * Semantics pinned here:
 *  - refs collected across ALL messages, stripped before forwarding upstream;
 *  - evidence block injected as ONE ephemeral system message right before the
 *    (shifted) user turn; frames appended to the user turn as text+image_url;
 *  - missing/corrupt index -> honest "no longer available" block (still
 *    counts as an injected block: retrieval_done {1,1});
 *  - empty index -> zero blocks -> retrieval_done {0,0}; retrieval never
 *    throws (the route catch branch {0,0} is near-unreachable by design);
 *  - stage frames only on the progress path; legacy path runs the SAME
 *    pipeline with metadata in headers only (fixtures 01 vs 05 prove parity).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  MOCK_LLM_KEY,
  MOCK_LLM_URL,
  UpstreamScript,
  anchorSkillBlocks,
  maskRuntimeClock,
  bytesRecord,
  installUpstream,
  normalizeBodyMs,
  parseLogical,
  runChat,
  setGoldenEnv,
  writeJsonFixture,
} from "./support/golden";
import { removeIndex } from "@/lib/server/attachindex/store";
import { ATT_IDS, QUERY_VEC, seedAttachmentStore } from "./support/attach-seeds";

setGoldenEnv();

vi.mock("@/lib/server/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/settings")>();
  return {
    ...actual,
    llmApiUrl: () => MOCK_LLM_URL,
    llmApiKey: () => MOCK_LLM_KEY,
  };
});

// Deterministic embedding seam: vector retrieval always sees this query vec.
vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => QUERY_VEC,
  embedTexts: async (texts: string[]) => texts.map(() => QUERY_VEC),
}));

// Loaded AFTER setGoldenEnv() via beforeAll (route module must not import under a
// stale env); top-level await would trip tsc (tsconfig target es2015 => TS1378).
let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { POST = (await import("@/app/api/chat/route")).POST; });

const HARNESS = "__tests__/rust-golden/attachments.test.ts";
const ENV_PRE = { WEB_SEARCH_GATE_DISABLED: "1", settings_llm_override: MOCK_LLM_URL };

const SSE_STD: UpstreamScript = {
  chunks: [
    'data: {"id":"a1","choices":[{"index":0,"delta":{"content":"noted"}}]}\n\n',
    "data: [DONE]\n\n",
  ],
};

// Seeds live in ./support/attach-seeds (shared with store-fixture.test.ts —
// the replay fixtures and the committed Rust-side store bytes MUST seed the
// same way).
// I20 (2026-11-08): the store gained a per-attachment "already shown" ledger
// so follow-up turns surface FRESH passages instead of the same top hits.
// That makes retrieval stateful across turns — and scenarios 01/06 share
// att_golden1a while 04/05 share att_golden1d. Every fixture was generated
// from ONE turn against a pristine seed, so every scenario must start from
// that pristine seed again: the seed is re-applied before each test, and
// removeIndex drops the ledger key along with the index. The committed
// fixture bytes are unchanged by this — each recorded turn stays the first
// turn over a fresh seed.
beforeAll(() => {
  for (const id of ATT_IDS) removeIndex(id);
});

beforeEach(() => {
  for (const id of ATT_IDS) removeIndex(id);
  seedAttachmentStore();
});

afterAll(() => {
  for (const id of ATT_IDS) removeIndex(id);
});

function userTurn(question: string, ref: { att_id: string; name: string; category: string }): string {
  return JSON.stringify({
    model: "strata-mock",
    messages: [{ role: "user", content: [
      { type: "text", text: question },
      { type: "attachment_ref", att_id: ref.att_id, name: ref.name, category: ref.category },
    ] }],
  });
}

async function runAndRecord(o: {
  rel: string;
  scenario: string;
  semantics: string;
  comparison: "byte-exact" | "structural" | "semantic" | "approved-deviation";
  rawBody: string;
  streamFalse?: boolean;
  notes?: string;
}) {
  const raw = o.streamFalse
    ? o.rawBody.replace('"model":"strata-mock"', '"model":"strata-mock","stream":false')
    : o.rawBody;
  const calls = installUpstream([SSE_STD]);
  const run = await runChat(POST as never, raw);
  const logical = parseLogical(run.text);
  const hasStage = logical.frames.some((f) => f.kind === "stage");
  const upstreamCalls = calls.map((c) => {
    const bodyText = c.body === null ? null : maskRuntimeClock(c.body);
    let bodyJson: unknown = null;
    let anchors: ReturnType<typeof anchorSkillBlocks>["anchors"] = [];
    if (bodyText) {
      try { const a = anchorSkillBlocks(JSON.parse(bodyText)); bodyJson = a.payload; anchors = a.anchors; } catch { bodyJson = null; }
    }
    return { url: c.url, method: c.method, headers: Object.fromEntries(Object.entries(c.headers).sort()), bodyText, bodyJson, anchors };
  });
  writeJsonFixture(o.rel, {
    request: { rawBody: raw },
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
    env: { ...ENV_PRE, embed_seam: "embedOne fixed pseudo-vector [1,0,0.05]; index seeded via production writeIndex (BM25/RRF/pack unmocked)" },
    normalization: 'Stage-event "ms" timing values replaced with "<ms>" in logicalFrames; progress-path bodies are ms-normalized text. P1 (2026-11-01): the live <runtime_clock> system block carries wall-clock text, so its content is MASKED in bodyText/bodyJson (the clock text itself is pinned by clock unit tests).',
    notes: o.notes,
  });
  return { run, logical, upstreamCalls };
}

const stages = (frames: ReturnType<typeof parseLogical>["frames"]) =>
  frames.filter((f) => f.kind === "stage").map((f) => f.obj as Record<string, unknown>);

const messagesOf = (bodyJson: unknown) =>
  (bodyJson as { messages: Record<string, unknown>[] }).messages;

describe("golden: attachment retrieval", () => {
  it("01 retrieval success (point_qa, text doc)", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "attachments/01-retrieval-success.json",
      scenario: "attachment retrieval success (point_qa hybrid over seeded index)",
      semantics:
        "refs stripped from the forwarded payload; BM25+cosine+RRF over 3 seeded chunks -> pack picks all " +
        "three (TOP_K/neighbor expansion, budget not hit) -> ONE knowledge_index system block appended, " +
        "verbatim: 'Passages relevant to this question, retrieved from ...' + text rules + </knowledge_index>. " +
        "§5k (2026-11-13, brief L195): RE-RECORDED wording law — completeness may only qualify the " +
        "locally-preserved copy, never the shown selection ('nothing was truncated' was a completeness " +
        "over-claim over a retrieval sample); both runtimes + corpus moved together. " +
        "Frames: decision_done, an UNNAMED 'skill' frame (D-070, 2026-11-20: standard_chat now carries " +
        "the fence CATALOGUE block, so block bytes > 0 on every turn and the frame rides — it names " +
        "nothing, the core-tier invisibility law), then retrieval then retrieval_done {1,1} " +
        "(done==total == injected block count). " +
        "MESSAGE ORDER (supersedes the historical §8 'block lands after the user turn' production-bug " +
        "note — that off-by-one was F08-fixed 2026-11-15 by resolveTurnIndex, and D-070 re-armed the " +
        "block itself): standard_chat now carries a decision_skill block, so the observed order in " +
        "upstreamCalls[0].bodyJson is [decision_skill, knowledge_index, response_policy, runtime_clock, " +
        "user] — the marker <decision_skill_block id=\"decision_skill:standard_chat\"> is the FIRST " +
        "system block. Rust Part 6 reproduces the OBSERVED order. " +
        "P1 (2026-11-01): the live-clock injection adds one <runtime_clock> system block; its content " +
        "is MASKED in the fixture (the clock text itself is pinned by clock unit tests).",
      comparison: "structural",
      rawBody: userTurn("According to the indexed lecture notes, what happens in the Calvin cycle?", {
        att_id: "att_golden1a", name: "intro-biology.pdf", category: "text",
      }),
    });
    // D-070 (2026-11-20): the nameless 'skill' frame rides every standard_chat
    // turn now — the catalogue block makes block bytes > 0 (route.ts:496).
    expect(stages(logical.frames).map((s) => s.stage)).toEqual(["decision_done", "skill", "retrieval", "retrieval_done"]);
    const done = stages(logical.frames).find((s) => s.stage === "retrieval_done");
    expect(done).toEqual({ stage: "retrieval_done", done: 1, total: 1 });
    const msgs = messagesOf(upstreamCalls[0].bodyJson);
    const sys = msgs.find((m) => typeof m.content === "string" && String(m.content).startsWith("<knowledge_index"));
    expect(sys).toBeTruthy();
    expect(String(sys!.content)).toContain("The Calvin cycle fixes carbon dioxide using ATP and NADPH.");
    expect(String(sys!.content)).toContain("You have read this document directly; never mention retrieval or indexing.");
    const userMsg = msgs.filter((m) => m.role === "user").pop();
    expect(JSON.stringify(userMsg).includes("attachment_ref")).toBe(false);
    expect(run.headers["x-decision-mode"]).toBe("standard_chat");
  });

  it("02 missing index -> honest block (non-fatal)", async () => {
    const { logical } = await runAndRecord({
      rel: "attachments/02-missing-index-honest-block.json",
      scenario: "attachment index not on disk (retrieval failure is NON-FATAL)",
      semantics:
        "readIndex null -> honest block '<knowledge_index ...>The local knowledge index for this attachment " +
        "is no longer available on disk. Say so honestly if the question needs it.</knowledge_index>' counts " +
        "as an injected block: retrieval_done {1,1}; the turn proceeds to the model normally.",
      comparison: "structural",
      rawBody: userTurn("Summarize the key theorem from the vanished document for me, please.", {
        att_id: "att_golden1b", name: "vanished.pdf", category: "text",
      }),
    });
    const done = stages(logical.frames).find((s) => s.stage === "retrieval_done");
    expect(done).toEqual({ stage: "retrieval_done", done: 1, total: 1 });
  });

  it("03 empty index -> zero evidence {0,0}", async () => {
    const { upstreamCalls } = await runAndRecord({
      rel: "attachments/03-empty-index-zero-evidence.json",
      scenario: "index exists but has no chunks (zero evidence)",
      semantics:
        "meta.json present, chunks.jsonl empty -> retrieveEvidence.text === '' -> block skipped -> " +
        "retrieval_done {0,0}; NO knowledge_index block in the forwarded payload (refs still stripped). " +
        "CONTRACT: the route catch branch emitting {0,0} on THROWN retrieval is near-unreachable — " +
        "buildAttachmentTurn never throws; {0,0} comes from the zero-blocks return.",
      comparison: "structural",
      rawBody: userTurn("What does the empty notes file say about review deadlines?", {
        att_id: "att_golden1c", name: "empty-notes.txt", category: "text",
      }),
    });
    const msgs = messagesOf(upstreamCalls[0].bodyJson);
    expect(msgs.some((m) => String(m.content).includes("<knowledge_index"))).toBe(false);
  });

  it("04 video time_range on standard_chat — keyframes LAND on the user turn (F08 fixed)", async () => {
    const { logical, upstreamCalls } = await runAndRecord({
      rel: "attachments/04-video-time-range-standard-chat.json",
      scenario: "video attachment, explicit timestamp (time_range) on standard_chat — keyframes reach the user turn",
      semantics:
        "'around 1:45:00' -> routeQuery single HMS -> time_range [c-180, c+180] -> only the overlapping " +
        "chunk survives, with a [01:45:00 - 01:46:00] header (fmtStamp). rules() uses the video variant " +
        "(§5k 2026-11-13: the time_range sample of one chunk out of the whole video must never be called a " +
        "complete record — RE-RECORDED header + rules bytes). " +
        "F08 FIXED (2026-11-15, brief §4): the injection index used to be re-derived as lastUserIdx + 1, " +
        "which on standard_chat (no skill block, no shift) pointed PAST the user turn, so the loaded " +
        "keyframe was SILENTLY DROPPED. route.ts/pipeline.ts now resolve the turn slot ONCE " +
        "(resolveTurnIndex) and re-resolve it after every injected block, so the keyframe rides the END " +
        "of the forwarded user turn (intro text + image_url). retrieval_done {1,1} still counts blocks, " +
        "not frames. Injection order for this turn (D-070, 2026-11-20: standard_chat now carries the " +
        "fence-catalogue block): [decision_skill, knowledge_index, response_policy, runtime_clock, " +
        "user]. (The pre-fix fixture name said keyframes-dropped; renamed with the fix.)",
      comparison: "structural",
      rawBody: userTurn("What is happening in the training video around 1:45:00?", {
        att_id: "att_golden1d", name: "pivot-table-training.mp4", category: "video",
      }),
    });
    const done = stages(logical.frames).find((s) => s.stage === "retrieval_done");
    expect(done).toEqual({ stage: "retrieval_done", done: 1, total: 1 });
    const msgs = messagesOf(upstreamCalls[0].bodyJson);
    const sys = msgs.find((m) => String(m.content).startsWith("<knowledge_index"));
    expect(String(sys!.content)).toContain("[01:45:00 - 01:46:00]\nDemo: rendering the pivot table.");
    // F08 (2026-11-15): every injected block lands BEFORE the user turn and the
    // keyframe rides the END of that user turn — no silent drop.
    // D-070 (2026-11-20): the catalogue block now leads every standard_chat turn.
    expect(msgs.map((m) => m.role)).toEqual(["system", "system", "system", "system", "user"]);
    expect(String(msgs[0].content)).toBe("<decision_skill_block id=\"decision_skill:standard_chat\">");
    expect(String(msgs[1].content)).toContain("<knowledge_index name=\"pivot-table-training.mp4\">");
    expect(String(msgs[2].content).startsWith("RESPONSE POLICY FOR THIS ASSISTANT:")).toBe(true);
    expect(String(msgs[3].content).startsWith("<runtime_clock>")).toBe(true);
    const userParts = msgs[4].content as { type: string }[];
    expect(userParts.some((p) => p.type === "image_url")).toBe(true);
    expect(userParts.some((p) => p.type === "attachment_ref")).toBe(false);
  });

  it("05 excel-pinned video — skill block shifts the turn; keyframe lands (shift-correct path)", async () => {
    const { logical, upstreamCalls } = await runAndRecord({
      rel: "attachments/05-video-frames-with-skill-shift.json",
      scenario: "same video retrieval with decision_mode excel (skill block present) — correct injection",
      semantics:
        "CONTRAST FIXTURE for 04: with a skill block, route.ts injects decision_skill at lastUserIdx, " +
        "the user turn really shifts to lastUserIdx+1, and the attachment pipeline then behaves as its " +
        "comment describes: knowledge block lands BEFORE the user turn; the keyframe rides the END of the " +
        "user turn — intro text 'Moments from the attached video...' + image_url (data:image/jpeg;base64," +
        "fixed 1x1 jpeg). Message order after F08 (2026-11-15): [decision_skill, knowledge_index, " +
        "response_policy, runtime_clock, user]. Pre-fix this was the shift-correct contrast proving " +
        "04’s drop was the missing-shift case; the fix makes BOTH paths land the frame. " +
        "§5k (2026-11-13): RE-RECORDED header + video rules bytes (coverage-honest wording).",
      comparison: "structural",
      rawBody: JSON.stringify({
        decision_mode: "excel",
        messages: [{ role: "user", content: [
          { type: "text", text: "What is happening in the training video around 1:45:00?" },
          { type: "attachment_ref", att_id: "att_golden1d", name: "pivot-table-training.mp4", category: "video" },
        ] }],
      }),
    });
    expect(stages(logical.frames).map((s) => s.stage)).toEqual(["decision_done", "skill", "retrieval", "retrieval_done"]);
    const msgs = messagesOf(upstreamCalls[0].bodyJson);
    expect(String(msgs[0].content)).toBe("<decision_skill_block id=\"decision_skill:excel\">");
    expect(upstreamCalls[0].anchors[0].kind).toBe("decision_skill");
    // F08 (2026-11-15): [decision_skill, knowledge_index, policy, clock, user].
    expect(String(msgs[1].content)).toContain("<knowledge_index name=\"pivot-table-training.mp4\">");
    expect(String(msgs[1].content)).toContain("[01:45:00 - 01:46:00]\nDemo: rendering the pivot table.");
    expect(String(msgs[2].content).startsWith("RESPONSE POLICY FOR THIS ASSISTANT:")).toBe(true);
    expect(String(msgs[3].content).startsWith("<runtime_clock>")).toBe(true);
    expect(msgs[4].role).toBe("user");
    const parts = msgs[4].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe("text");
    expect(parts.some((p) => p.type === "text" && String(p.text).startsWith("Moments from the attached video"))).toBe(true);
    const img = parts.find((p) => p.type === "image_url");
    expect(img && img.image_url!.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("06 legacy path runs the SAME retrieval (headers only)", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "attachments/06-legacy-parity.json",
      scenario: "same retrieval on the legacy stream:false path",
      semantics:
        "runTurnPipeline is shared: identical injection/strip behavior on BOTH response shapes — F08 " +
        "(2026-11-15) fixed the standard_chat off-by-one on both paths and D-070 (2026-11-20) re-armed " +
        "the standard_chat block, so every block lands BEFORE the " +
        "user turn: [decision_skill, knowledge_index, response_policy, runtime_clock, user]. Only the stage FRAMES are " +
        "absent on the legacy path (stage() is a no-op), so retrieval_done never appears. " +
        "§5k (2026-11-13): RE-RECORDED header bytes (coverage-honest wording).",
      comparison: "byte-exact",
      streamFalse: true,
      rawBody: userTurn("According to the indexed lecture notes, what happens in the Calvin cycle?", {
        att_id: "att_golden1a", name: "intro-biology.pdf", category: "text",
      }),
    });
    expect(logical.frames.some((f) => f.kind === "stage")).toBe(false);
    const msgs = messagesOf(upstreamCalls[0].bodyJson);
    // F08 (2026-11-15) + D-070: block, knowledge, policy, clock, then the user
    // turn — parity with the progress path.
    expect(msgs.map((m) => m.role)).toEqual(["system", "system", "system", "system", "user"]);
    expect(String(msgs[0].content)).toBe("<decision_skill_block id=\"decision_skill:standard_chat\">");
    expect(String(msgs[1].content)).toContain("<knowledge_index name=\"intro-biology.pdf\">");
    expect(run.headers["x-decision-mode"]).toBe("standard_chat");
  });

});
