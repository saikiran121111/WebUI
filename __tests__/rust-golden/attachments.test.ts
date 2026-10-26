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
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { indexDir, removeIndex, writeIndex } from "@/lib/server/attachindex/store";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

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
const QUERY_VEC = [1, 0, 0.05];
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

// 1x1 black JPEG (fixed constant — frame bytes are part of the data-url).
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAAB" +
  "AAIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjV1dX" +
  "V1pnaGprbW5vb3Bxc3V3eHl6f4ABf/ZQ==";

function seededIndex(attId: string, name: string, category: string, chunks: IndexChunk[], frames: IndexMeta["frames"] = []): void {
  const meta: IndexMeta = {
    attId, name, category: category as IndexMeta["category"], createdAt: 0,
    chunkCount: chunks.length, spine: "", spineBlocks: [], frames,
  };
  writeIndex(attId, meta, chunks, chunks.map((c) => c.text).join("\n"));
  if (frames.length) {
    // FrameEntry.file is index-dir-relative (see nearestFrames in turn.ts).
    for (const f of frames) {
      const p = path.join(indexDir(attId), f.file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(TINY_JPEG_B64, "base64"));
    }
  }
}

const ATT_IDS = ["att_golden1a", "att_golden1b", "att_golden1c", "att_golden1d"];

beforeAll(() => {
  for (const id of ATT_IDS) removeIndex(id);
  seededIndex("att_golden1a", "intro-biology.pdf", "text", [
    { i: 0, startSec: null, endSec: null, text: "Photosynthesis converts light into chemical energy in the chloroplast.", vec: [1, 0, 0] },
    { i: 1, startSec: null, endSec: null, text: "The Calvin cycle fixes carbon dioxide using ATP and NADPH.", vec: [0, 1, 0] },
    { i: 2, startSec: null, endSec: null, text: "Stomata regulate gas exchange on the underside of leaves.", vec: [0, 0, 1] },
  ]);
  // att_golden1b: deliberately NEVER seeded -> missing-index honest block.
  seededIndex("att_golden1c", "empty-notes.txt", "text", []);
  seededIndex(
    "att_golden1d",
    "pivot-table-training.mp4",
    "video",
    [
      { i: 0, startSec: 60, endSec: 180, text: "Intro slide: course objectives.", vec: [0, 0, 1] },
      { i: 1, startSec: 6300, endSec: 6360, text: "Demo: rendering the pivot table.", vec: [0, 0, 1] },
      { i: 2, startSec: 7000, endSec: 7060, text: "Outro recap.", vec: [0, 0, 1] },
    ],
    // FrameEntry.file is resolved relative to indexDir (turn.ts nearestFrames), not framesDir.
    [{ at: 6310, file: "frames/f_golden1.jpg" }],
  );
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
    let bodyJson: unknown = null;
    let anchors: ReturnType<typeof anchorSkillBlocks>["anchors"] = [];
    if (c.body) {
      try { const a = anchorSkillBlocks(JSON.parse(c.body)); bodyJson = a.payload; anchors = a.anchors; } catch { bodyJson = null; }
    }
    return { url: c.url, method: c.method, headers: Object.fromEntries(Object.entries(c.headers).sort()), bodyText: c.body, bodyJson, anchors };
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
    normalization: 'Stage-event "ms" timing values replaced with "<ms>" in logicalFrames; progress-path bodies are ms-normalized text.',
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
        "verbatim: 'Passages retrieved from the complete content ...' + text rules + </knowledge_index>. " +
        "Frames: retrieval then retrieval_done {1,1} (done==total == injected block count). " +
        "PRODUCTION BUG RECORDED (not fixed, §8): the route ALWAYS passes lastUserIdx+1 to " +
        "buildAttachmentTurn (route.ts:450) assuming a skill block was injected at lastUserIdx — but " +
        "buildDecisionSkillBlock returns null for standard_chat (skill-loader.ts:88), so the 'shift' never " +
        "happened and the block lands AFTER the user turn instead of before it (message order in " +
        "upstreamCalls[0].bodyJson: user, then system). Rust Part 6 must reproduce the OBSERVED order.",
      comparison: "structural",
      rawBody: userTurn("According to the indexed lecture notes, what happens in the Calvin cycle?", {
        att_id: "att_golden1a", name: "intro-biology.pdf", category: "text",
      }),
    });
    expect(stages(logical.frames).map((s) => s.stage)).toEqual(["decision_done", "retrieval", "retrieval_done"]);
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

  it("04 video time_range on standard_chat — keyframes DROPPED by the off-by-one (bug recorded)", async () => {
    const { logical, upstreamCalls } = await runAndRecord({
      rel: "attachments/04-video-time-range-keyframes-dropped.json",
      scenario: "video attachment, explicit timestamp (time_range) on standard_chat — keyframes lost",
      semantics:
        "'around 1:45:00' -> routeQuery single HMS -> time_range [c-180, c+180] -> only the overlapping " +
        "chunk survives, with a [01:45:00 - 01:46:00] header (fmtStamp). rules() uses the video variant. " +
        "PRODUCTION BUG RECORDED (not fixed, §8): nearestFrames DID load the keyframe, but " +
        "buildAttachmentTurn appends frames to messages[userIdx] (turn.ts:224) where userIdx = lastUserIdx+1 — " +
        "undefined on standard_chat (no skill block, no shift) — so the frame is SILENTLY DROPPED: the " +
        "forwarded user turn has NO image_url part. retrieval_done still reports {1,1} (blocks, not frames).",
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
    // Off-by-one: block AFTER the user turn; frame dropped (messages[userIdx] undefined).
    expect(msgs.map((m) => m.role)).toEqual(["user", "system"]);
    const userParts = msgs[0].content as { type: string }[];
    expect(userParts.some((p) => p.type === "image_url")).toBe(false);
    expect(userParts.some((p) => p.type === "attachment_ref")).toBe(false);
  });

  it("05 excel-pinned video — skill block shifts the turn; keyframe lands (shift-correct path)", async () => {
    const { logical, upstreamCalls } = await runAndRecord({
      rel: "attachments/05-video-frames-with-skill-shift.json",
      scenario: "same video retrieval with decision_mode excel (skill block present) — correct injection",
      semantics:
        "CONTRAST FIXTURE for 04: with a skill block, route.ts:429 injects decision_skill at lastUserIdx, " +
        "the user turn really shifts to lastUserIdx+1, and the attachment pipeline then behaves as its " +
        "comment describes: knowledge block lands BEFORE the user turn; the keyframe rides the END of the " +
        "user turn — intro text 'Moments from the attached video...' + image_url (data:image/jpeg;base64," +
        "fixed 1x1 jpeg). Message order: [decision_skill, knowledge_index, user]. Proves the off-by-one in " +
        "04 is specifically the missing-shift case, not the whole injection design.",
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
    expect(String(msgs[1].content)).toContain("<knowledge_index name=\"pivot-table-training.mp4\">");
    expect(String(msgs[1].content)).toContain("[01:45:00 - 01:46:00]\nDemo: rendering the pivot table.");
    expect(msgs[2].role).toBe("user");
    const parts = msgs[2].content as { type: string; text?: string; image_url?: { url: string } }[];
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
        "runTurnPipeline is shared: identical injection/strip behavior on BOTH response shapes (including " +
        "the standard_chat off-by-one: block after the user turn); only the stage FRAMES are absent on the " +
        "legacy path (stage() is a no-op), so retrieval_done never appears.",
      comparison: "byte-exact",
      streamFalse: true,
      rawBody: userTurn("According to the indexed lecture notes, what happens in the Calvin cycle?", {
        att_id: "att_golden1a", name: "intro-biology.pdf", category: "text",
      }),
    });
    expect(logical.frames.some((f) => f.kind === "stage")).toBe(false);
    const msgs = messagesOf(upstreamCalls[0].bodyJson);
    expect(msgs.map((m) => m.role)).toEqual(["user", "system"]);
    expect(run.headers["x-decision-mode"]).toBe("standard_chat");
  });

});
