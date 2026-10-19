import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  anchorQuery,
  buildAttachmentTurn,
  stripAttachmentRefs,
} from "../lib/server/attachindex/turn";
import { indexDir, removeIndex, writeIndex } from "../lib/server/attachindex/store";
import { embedOne } from "../lib/server/attachindex/embed";
import type { IndexChunk, IndexMeta } from "../lib/server/attachindex/types";

/**
 * Production hardening for the retrieval payload:
 *  (c1) custom attachment_ref parts are stripped from every message before
 *       the payload goes upstream (strict OpenAI-compatible backends reject
 *       unknown part types) — unit + a contract check that the chat route
 *       strips right before forwardStream;
 *  (c2) keyframe image_url parts live ONLY in the final user message, never
 *       inside the injected system block;
 *  (d) short pronoun follow-ups are anchored to the previous user question
 *       so BM25/vector retrieval stays on topic.
 */

describe("attachment_ref sanitizing before the upstream call", () => {
  it("removes custom ref parts from every message, keeping text and images", () => {
    const messages: any[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "what happens at minute 4?" },
          { type: "attachment_ref", att_id: "att_test01", name: "v.mp4", category: "video" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
        ],
      },
      { role: "user", content: "plain string stays" },
    ];
    stripAttachmentRefs(messages);
    expect(messages[1].content.length).toBe(2);
    expect(messages[1].content.every((p: any) => p.type !== "attachment_ref")).toBe(true);
    expect(messages[1].content.some((p: any) => p.type === "image_url")).toBe(true);
    expect(messages[2].content).toBe("plain string stays");
  });

  it("the chat route strips immediately before forwardStream (contract order)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app", "api", "chat", "route.ts"), "utf8");
    const strip = src.lastIndexOf("stripAttachmentRefs(payload.messages)");
    const fwd = src.lastIndexOf("return forwardStream(");
    expect(strip).toBeGreaterThan(-1);
    expect(fwd).toBeGreaterThan(-1);
    expect(strip, "refs must be gone before the payload is forwarded upstream").toBeLessThan(fwd);
  });
});

describe("multi-turn follow-up anchoring", () => {
  it("anchors a short pronoun follow-up to the previous user question", () => {
    const messages: any[] = [
      { role: "user", content: "How does turbine blade resonance work in the Zephyr protocol?" },
      { role: "assistant", content: "The blades vibrate at a fixed frequency…" },
      { role: "user", content: "why does that happen?" },
    ];
    const q = anchorQuery("why does that happen?", messages, 2);
    expect(q).toContain("turbine blade resonance");
    expect(q.endsWith("why does that happen?")).toBe(true);
  });

  it("uses the FIRST text part of an array-content previous message (question, not spine/preview)", () => {
    const messages: any[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is coastal sediment drift?" },
          { type: "text", text: "SPINE TABLE OF CONTENTS …" },
          { type: "attachment_ref", att_id: "att_test01" },
        ],
      },
      { role: "user", content: "and how fast?" },
    ];
    const q = anchorQuery("and how fast?", messages, 1);
    expect(q).toContain("coastal sediment drift");
    expect(q).not.toContain("SPINE");
  });

  it("leaves a long self-contained question verbatim", () => {
    const long = "According to Marisol's theorem, how often does coastal sediment drift double per tidal cycle?";
    const messages: any[] = [
      { role: "user", content: "an earlier unrelated question" },
      { role: "user", content: long },
    ];
    expect(anchorQuery(long, messages, 1)).toBe(long);
  });

  it("returns the question unchanged when there is no previous user message", () => {
    const messages: any[] = [{ role: "user", content: "why does that happen?" }];
    expect(anchorQuery("why does that happen?", messages, 0)).toBe("why does that happen?");
  });
});

describe("keyframes stay inside the user turn, never the system block", () => {
  const ATT = "att_hardframe01";

  afterAll(() => removeIndex(ATT));

  it("evidence is a system string block; image_url parts are appended to the user message", async () => {
    removeIndex(ATT);
    const texts = [
      "The lecture opens with course logistics and the grading policy for the semester.",
      "The Zephyr protocol calibrates turbine blade resonance at exactly ninety-one hertz.",
    ];
    const chunks: IndexChunk[] = [];
    for (let i = 0; i < texts.length; i++) {
      chunks.push({
        i,
        startSec: i === 0 ? 0 : 95,
        endSec: i === 0 ? 90 : 125,
        text: texts[i],
        vec: await embedOne(texts[i]),
      });
    }
    const meta: IndexMeta = {
      attId: ATT,
      name: "lecture.mp4",
      category: "video",
      createdAt: Date.now(),
      durationSec: 600,
      chunkCount: chunks.length,
      spine: "[00:00:00 - 00:10:00] logistics, resonance",
      spineBlocks: [],
      frames: [{ at: 100, file: "frames/f_00001.jpg" }],
    };
    writeIndex(ATT, meta, chunks, texts.join(" "));
    fs.mkdirSync(path.join(indexDir(ATT), "frames"), { recursive: true });
    fs.writeFileSync(
      path.join(indexDir(ATT), "frames", "f_00001.jpg"),
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]),
    );

    const question = "What frequency calibrates the turbine blade resonance?";
    const messages: any[] = [{
      role: "user",
      content: [
        { type: "text", text: question },
        { type: "attachment_ref", att_id: ATT, name: "lecture.mp4", category: "video" },
      ],
    }];
    const injected = await buildAttachmentTurn(messages, 0, question);
    expect(injected).toBe(1);

    // The evidence block is a SYSTEM message with plain string content —
    // strict backends never see image parts (or refs) inside a system turn.
    const sys = messages.find(m => m.role === "system");
    expect(sys).toBeTruthy();
    expect(typeof sys.content).toBe("string");
    expect(sys.content).toContain("<knowledge_index");
    expect(sys.content).toContain("[00:01:35 - 00:02:05]");
    expect(sys.content).toContain("ninety-one hertz");
    expect(sys.content).not.toContain("image_url");

    // The keyframe rides at the end of the final USER message.
    const user = messages[messages.length - 1];
    expect(user.role).toBe("user");
    expect(Array.isArray(user.content)).toBe(true);
    const imgs = user.content.filter((p: any) => p.type === "image_url");
    expect(imgs.length).toBe(1);
    expect(imgs[0].image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  }, 120_000);
});
