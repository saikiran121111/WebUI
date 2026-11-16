import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPACTION_SYSTEM_PROMPT,
  DURABLE_BLOCK_TAG,
  collectDurableUserTurns,
  compactConversation,
  renderDurableConstraints,
  type CompactMessage,
} from "@/lib/chat/compact";

/**
 * F21 — compaction may not claim a quality it cannot deliver, and the parts of
 * a conversation that carry the user's authority must survive the fold without
 * depending on the summarising model.
 *
 * The old prompt promised "Zero Knowledge Loss" plus a "~95% compression
 * target". Both are unverifiable claims a small local model cannot keep, so
 * they are gone; what replaced the promise is CODE: the most recent folded user
 * turns ride along verbatim in a bounded, machine-readable block.
 */

const enc = new TextEncoder();
const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function stubCompleteStream(contentChunks: string[]): void {
  const wire =
    contentChunks.map((c) => frame({ choices: [{ delta: { content: c } }] })).join("") +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n";
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(wire));
      c.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ),
  );
}

afterEach(() => {
  // The stubbed fetch must never leak into another case.
  vi.unstubAllGlobals();
});

describe("compaction prompt - no unverifiable quality promise (F21)", () => {
  it("never promises zero knowledge loss or a compression ratio guarantee", () => {
    expect(COMPACTION_SYSTEM_PROMPT).not.toMatch(/Zero Knowledge Loss/i);
    expect(COMPACTION_SYSTEM_PROMPT).not.toMatch(/95%\s*Target/i);
    expect(COMPACTION_SYSTEM_PROMPT).not.toMatch(/Zero quality loss/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/lossy summary/i);
  });
  it("requires the user's own words for constraints", () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/user's own words/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/QUOTE explicit user constraints verbatim/i);
  });
});

describe("collectDurableUserTurns - bounded, model-independent", () => {
  const msg = (role: string, content: string): CompactMessage => ({ role, content });

  it("keeps only user turns, newest-first window returned oldest-first", () => {
    const got = collectDurableUserTurns([
      msg("user", "always answer in Telugu"),
      msg("assistant", "understood"),
      msg("user", "use alpha.com only"),
      msg("system", "standing prompt"),
      msg("tool", "search results"),
      msg("user", "   "),
    ]);
    expect(got.map((t) => t.text)).toEqual(["always answer in Telugu", "use alpha.com only"]);
    expect(got.every((t) => !t.truncated)).toBe(true);
  });

  it("caps the number of turns to the most recent ones", () => {
    const folded = Array.from({ length: 12 }, (_, i) => msg("user", "u" + i));
    const got = collectDurableUserTurns(folded, { maxTurns: 4 });
    expect(got.map((t) => t.text)).toEqual(["u8", "u9", "u10", "u11"]);
  });

  it("bounds each turn and the whole block, and marks truncation honestly", () => {
    const long = "x".repeat(500);
    const got = collectDurableUserTurns([msg("user", long)], { perTurnChars: 100, totalChars: 1000 });
    expect(got).toHaveLength(1);
    expect(got[0].text).toHaveLength(100);
    expect(got[0].truncated).toBe(true);

    const many = Array.from({ length: 10 }, () => msg("user", "y".repeat(200)));
    const bounded = collectDurableUserTurns(many, { perTurnChars: 200, totalChars: 500 });
    // 200*3 = 600 > 500, so at most two turns fit: the NEWER ones survive.
    expect(bounded.length).toBeLessThanOrEqual(2);
    expect(bounded.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(500);
  });

  it("never treats a previous snapshot as the user's own words", () => {
    const got = collectDurableUserTurns([
      msg("user", "<compacted_context>\n## 1\n- stale\n</compacted_context>"),
      msg("user", "keep the report in PDF format"),
    ]);
    expect(got.map((t) => t.text)).toEqual(["keep the report in PDF format"]);
  });
});

describe("renderDurableConstraints - idempotent across repeated compactions", () => {
  it("appends nothing when the summary already quotes the turn verbatim", () => {
    const turns = collectDurableUserTurns([{ role: "user", content: "answer in Telugu" }]);
    expect(renderDurableConstraints(turns, { alreadyInSummary: "## 1\n- answer in Telugu" })).toBe("");
    const block = renderDurableConstraints(turns, { alreadyInSummary: "## 1\n- respond concisely" });
    expect(block).toContain(`<${DURABLE_BLOCK_TAG}`);
    expect(block).toContain("- answer in Telugu");
    expect(block).toContain("</" + DURABLE_BLOCK_TAG + ">");
  });
});

describe("compactConversation - the fold keeps the constraint even if the summary drops it", () => {
  it("the replacement message carries the user's words verbatim plus an honest label", async () => {
    // The model drops the language constraint from its summary entirely.
    stubCompleteStream(["<compacted_context>\n## 1\n- chatted about food\n", "</compacted_context>"]);
    const msgs: CompactMessage[] = [
      { role: "user", content: "Always answer in Telugu, never in English." },
      { role: "assistant", content: "ok" },
      { role: "user", content: "what is a monsoon" },
      { role: "assistant", content: "a seasonal wind" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "yw" },
    ];
    const res = await compactConversation(msgs, { tailSize: 2 });
    expect(res.ok).toBe(true);
    const folded = res.replacementLlmMessages[0].content;
    expect(folded).toContain("Always answer in Telugu, never in English.");
    expect(folded).toContain(`<${DURABLE_BLOCK_TAG} source="verbatim-user-turns"`);
    expect(res.label).toMatch(/folded into a summary/);
    expect(res.label).toMatch(/kept verbatim/);
    // The tail stays verbatim, so the durable block never duplicates it.
    expect(res.replacementLlmMessages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  });

  it("a constraint the summary already kept is not duplicated forever", async () => {
    stubCompleteStream([
      "<compacted_context>\n## 1 User Rules\n- Only use alpha.com\n",
      "</compacted_context>",
    ]);
    const msgs: CompactMessage[] = [
      { role: "user", content: "Only use alpha.com" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
      { role: "assistant", content: "a" },
      { role: "user", content: "more" },
      { role: "assistant", content: "b" },
    ];
    const res = await compactConversation(msgs, { tailSize: 2 });
    const folded = res.replacementLlmMessages[0].content;
    expect(folded.match(/Only use alpha\.com/g)?.length).toBe(1);
  });
});
