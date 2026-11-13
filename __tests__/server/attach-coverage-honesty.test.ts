/**
 * §5k coverage-honesty law (brief 2026-11-13 L195-196): sampled/retrieved
 * attachment content must never be CALLED complete when the coverage the
 * model is being shown is a selection. Completeness may only qualify the
 * LOCALLY PRESERVED copy ("its complete text is preserved locally"), never
 * the passages in front of the model ("nothing was truncated" / "You are
 * given this video's complete saved record" over a partial retrieval).
 *
 * Material-limitation communication already exists in rules() ("If the
 * question concerns a time range or section NOT present below, state that
 * you cannot see that part…") — the old wording contradicted it and
 * suppressed it; these pins keep the claim and the instruction consistent.
 *
 * ⇔ ruke-attach turn.rs mirrors rules()/block bytes exactly (golden
 * attachment_replay forwards them) — the Rust unit asserts move with the
 * wording in the same commit. The NON-indexed inline path (the whole saved
 * record really is presented) keeps its "complete saved record" claim: that
 * boundary is pinned here and by video-narration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import { attachmentParts } from "@/lib/chat/client";
import { removeIndex, writeIndex } from "@/lib/server/attachindex/store";
import type { Attachment } from "@/lib/types";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

const DOC = "att_chonesty1";
const VID = "att_chonesty2";
const AUD = "att_chonesty3";

function padTo(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + "q".repeat(n - s.length);
}

function seed(attId: string, name: string, category: IndexMeta["category"]) {
  const chunks: IndexChunk[] = Array.from({ length: 6 }, (_, i) => ({
    i,
    startSec: category === "text" ? null : i * 60,
    endSec: category === "text" ? null : i * 60 + 60,
    text: padTo(`widget ${attId}${i} `, 200),
    vec: [],
  }));
  const meta: IndexMeta = {
    attId, name, category, createdAt: 0, chunkCount: 6,
    spine: "", spineBlocks: [], frames: [],
  };
  writeIndex(attId, meta, chunks, chunks.map((c) => c.text).join("\n"));
}

const Q = "According to the indexed record, describe everything about widget usage generally.";

function messages() {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: Q },
        { type: "attachment_ref", att_id: DOC, name: "doc-h.txt", category: "text" },
        { type: "attachment_ref", att_id: VID, name: "clip-h.mp4", category: "video" },
        { type: "attachment_ref", att_id: AUD, name: "talk-h.mp3", category: "audio" },
      ],
    },
  ];
}

const systemBlocks = (msgs: unknown[]) =>
  (msgs as { role: string; content: unknown }[])
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content));

beforeAll(() => {
  for (const id of [DOC, VID, AUD]) removeIndex(id);
  seed(DOC, "doc-h.txt", "text");
  seed(VID, "clip-h.mp4", "video");
  seed(AUD, "talk-h.mp3", "audio");
});

afterAll(() => {
  for (const id of [DOC, VID, AUD]) removeIndex(id);
});

describe("per-turn evidence blocks: completeness qualifies the local copy, never the selection (§5k)", () => {
  it("the block header never claims the shown selection is complete or untruncated", async () => {
    const msgs = messages();
    await buildAttachmentTurn(msgs as never[], 0, Q);
    const sys = systemBlocks(msgs).join("\n");
    // The old over-claims must be gone from every retrieved-evidence block.
    expect(sys).not.toContain("nothing was truncated");
    expect(sys).not.toContain("the complete content");
    // Completeness rides ONLY on the locally-preserved copy + selection disclosure.
    expect(sys).toContain(
      'Passages relevant to this question, retrieved from "doc-h.txt" (its complete text is preserved locally — the passages below are the parts the retrieval matched):',
    );
  });

  it("video rules keep the record-honesty law WITHOUT calling the shown parts a complete record", async () => {
    const msgs = messages();
    await buildAttachmentTurn(msgs as never[], 0, Q);
    const sys = systemBlocks(msgs).join("\n");
    expect(sys).not.toContain("You are given this video's complete saved record");
    expect(sys).toContain(
      "This video's complete saved record is kept locally and you are shown the parts of it that matter to this question",
    );
    // P3a law preserved verbatim around the changed sentence.
    expect(sys).toContain("its visuals and its speech are one thing");
    expect(sys).toContain("never claim to have watched, seen or heard it yourself");
    expect(sys).toContain("never attribute content to a particular frame");
    // Limitation instruction (L196) still present and now un-contradicted.
    expect(sys).toContain("state that you cannot see that part of the content clearly enough to answer it");
  });

  it("audio rules keep the record-honesty law WITHOUT calling the shown parts a complete record", async () => {
    const msgs = messages();
    await buildAttachmentTurn(msgs as never[], 0, Q);
    const sys = systemBlocks(msgs).join("\n");
    expect(sys).not.toContain("You are given this recording's complete saved record");
    expect(sys).toContain(
      "This recording's complete saved record is kept locally and you are shown the parts that matter to this question: speak of what the recording says; never claim to have heard it yourself, and never mention transcription, retrieval or indexing.",
    );
  });

  it("document rules stay byte-identical (no completeness claim existed there)", async () => {
    const msgs = messages();
    await buildAttachmentTurn(msgs as never[], 0, Q);
    const sys = systemBlocks(msgs).join("\n");
    expect(sys).toContain("You have read this document directly; never mention retrieval or indexing.");
  });
});

describe("history spine: indexed preview vs non-indexed inline record (§5k boundary)", () => {
  it("the indexed spine ties completeness to the index and never to what is shown", () => {
    const parts = attachmentParts({
      id: "att_hspine1", indexId: "att_hspine1", name: "long-clip.mp4", kind: "video", mime: "video/mp4",
      size: 4096, status: "ready", category: "video", indexed: true,
      transcript: "the opening words zephyr", spine: "1. opening", frames: [{ dataUrl: "data:image/png;base64,AAAA", at: 1.2 }],
      durationSec: 3600,
    } as Attachment);
    const joined = parts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n");
    // The retention claim (TRUE about the index) stays…
    expect(joined).toContain("complete content is kept in a local knowledge index");
    // …but the shown material is never called a complete record.
    expect(joined).not.toContain("You are given this video's complete saved record");
    expect(joined).toContain("kept whole in the index");
    expect(joined).toContain("you are shown parts of it");
    // P3a clauses survive the rewording.
    expect(joined).toContain("never claim to have watched it yourself");
    expect(joined).toContain("never attribute content to a particular frame");
  });

  it("the non-indexed inline path STILL calls the whole saved record complete (all of it is presented)", () => {
    const parts = attachmentParts({
      id: "att_hspine2", name: "short-clip.mp4", kind: "video", mime: "video/mp4",
      size: 1024, status: "ready", category: "video",
      frames: [{ dataUrl: "data:image/png;base64,AAAA", at: 1.2 }],
      transcript: "the codeword is zephyr",
    } as Attachment);
    const joined = parts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n");
    expect(joined).toContain("complete saved record");
    expect(joined).toContain("[spoken content begins]");
    expect(joined).toContain("Never claim to have watched it yourself");
  });
});
