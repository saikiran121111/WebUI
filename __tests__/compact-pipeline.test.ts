/**
 * Unit tests for the auto-compact pipeline: the sliding-window split, the
 * <compacted_context> extractor (with its three model-behaviour cases), the
 * token estimator, and the threshold config helpers.
 *
 * No LLM / no network: compactConversation's real model call is exercised
 * separately in the Playwright suite against a mocked /api/chat.
 */
import { describe, it, expect } from "vitest";
import {
  RECENT_TAIL,
  splitForCompaction,
  extractCompactedContext,
  toWireMessage,
} from "../lib/chat/compact";
import {
  estimateConversationTokens,
  estimateMessageTokens,
  formatTokens,
  CHARS_PER_TOKEN,
} from "../lib/chat/tokens";
import {
  COMPACT_PRESETS,
  COMPACT_CUSTOM_MIN,
  COMPACT_CUSTOM_MAX,
  clampCustom,
  isValidCustom,
  compactThresholdsFromSettings,
} from "../lib/chat/compactConfig";
import type { Message } from "../lib/types";

function msg(id: string, role: Message["role"], content: string): Message {
  return {
    id,
    conversationId: "",
    role,
    content,
    reasoning: "",
    attachments: [],
    toolCalls: [],
    citations: [],
    createdAt: 0,
    state: "complete",
    mode: "chat",
  };
}

describe("splitForCompaction", () => {
  it("keeps the last RECENT_TAIL messages raw and folds the rest", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg("m" + i, i % 2 ? "assistant" : "user", "x"));
    const { toCompact, tail } = splitForCompaction(messages);
    expect(toCompact).toHaveLength(10 - RECENT_TAIL);
    expect(tail).toHaveLength(RECENT_TAIL);
    // The tail is exactly the last 4.
    expect(tail[0].id).toBe("m6");
    expect(tail[3].id).toBe("m9");
    // Nothing is lost: toCompact + tail === the original order.
    expect([...toCompact, ...tail].map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("respects a custom tail size", () => {
    const messages = Array.from({ length: 6 }, (_, i) => msg("m" + i, "user", "x"));
    const { toCompact, tail } = splitForCompaction(messages, 2);
    expect(toCompact).toHaveLength(4);
    expect(tail).toHaveLength(2);
  });

  it("when the conversation is smaller than the tail, nothing is compactable", () => {
    const messages = [msg("a", "user", "hi"), msg("b", "assistant", "yo")];
    const { toCompact, tail } = splitForCompaction(messages);
    expect(toCompact).toHaveLength(0);
    expect(tail).toHaveLength(2);
  });
});

describe("extractCompactedContext", () => {
  it("extracts a clean block and strips the analysis scratchpad", () => {
    const raw = [
      "Here is my analysis of the conversation.",
      "<analysis>noise noise noise</analysis>",
      "Some prose before the answer.",
      "<compacted_context>",
      "## 1. User Rules",
      "- be terse",
      "</compacted_context>",
      "Trailing prose the model added.",
    ].join("\n");
    expect(extractCompactedContext(raw)).toBe("## 1. User Rules\n- be terse");
  });

  it("case-insensitively handles tag casing", () => {
    const raw = "<COMPACTED_CONTEXT>state</COMPACTED_CONTEXT>";
    expect(extractCompactedContext(raw)).toBe("state");
  });

  it("recovers a truncated (unclosed) block", () => {
    const raw = "<compacted_context>## 1. User Rules\n- partial, cut off by";
    expect(extractCompactedContext(raw)).toBe("## 1. User Rules\n- partial, cut off by");
  });

  it("drops an unterminated <analysis> scratchpad at the end", () => {
    const raw = "<compacted_context>real</compacted_context><analysis>oops truncated analysis";
    expect(extractCompactedContext(raw)).toBe("real");
  });

  it("returns null when no compacted_context block is present", () => {
    expect(extractCompactedContext("just plain prose, no tags")).toBeNull();
    expect(extractCompactedContext("")).toBeNull();
  });

  it("returns null for an empty block", () => {
    expect(extractCompactedContext("<compacted_context>\n   </compacted_context>")).toBeNull();
  });

  // F153 §2c — the SUMMARY-INTEGRITY law. Prompt rule 2 makes the model QUOTE
  // user constraints verbatim, so a folded turn may itself contain the literal
  // </compacted_context> (this app's own chats discuss compaction). On HEAD the
  // first-close split (a) truncated the snapshot at that quote — sections 2–5
  // silently dropped — and (b) left the close tag inside the body, so the
  // wrapper's "</compacted_context>" in compactConversation closed the promoted
  // block EARLY and every section after the quote rode as unframed prompt text
  // on all later sends. Law: take the WIDEST span (first open → last close)
  // and neutralize embedded closes so the promoted block is always ONE block.
  it("a quoted </compacted_context> inside the body never truncates the snapshot", () => {
    const raw = [
      "<compacted_context>",
      "## 1. User Rules",
      '- user said: "wrap the output in <compacted_context>..</compacted_context> tags"',
      "## 5. Active Context & Next Steps",
      "- **Immediate Open Task:** fix the persistence bug",
      "</compacted_context>",
    ].join("\n");
    const out = extractCompactedContext(raw);
    expect(out).toContain("## 1. User Rules");
    expect(out).toContain("## 5. Active Context & Next Steps");
    expect(out).toContain("fix the persistence bug"); // survived the quote
  });

  it("the extracted body carries NO close tag, so the wrapper stays one block", () => {
    const raw =
      "<compacted_context>\n## 1\n- quote: </compacted_context> end quote\n## 2\n- real state\n</compacted_context>";
    const out = extractCompactedContext(raw);
    expect(out).not.toContain("</compacted_context>");
    expect(out).toContain("real state");
    // The promoted wrapper is then a single well-formed block by construction.
    const wrapped = "<compacted_context>\n" + out + "\n</compacted_context>";
    expect(wrapped.match(/<\/compacted_context>/gi)).toHaveLength(1);
  });

  it("an upper-case embedded close is neutralized too, and prose after the last close is dropped", () => {
    const raw =
      "<compacted_context>\n## 1\n- meta: </COMPACTED_CONTEXT> discussion\n## 2\n- keep me\n</compacted_context>\nprose after";
    const out = extractCompactedContext(raw);
    expect(out).not.toContain("</COMPACTED_CONTEXT>");
    expect(out).toContain("keep me");
    expect(out).not.toContain("prose after");
  });
});

describe("toWireMessage", () => {
  it("inlines attachment text so the model never loses it", () => {
    const m = {
      role: "user" as const,
      content: "look at this",
      attachments: [{ name: "a.pdf", text: "FILE BODY" }],
    };
    expect(toWireMessage(m)).toEqual({
      role: "user",
      content: "look at this\nAttached file: a.pdf\nFILE BODY",
    });
  });

  it("prefers the spine/transcript over raw text when present", () => {
    const m = {
      role: "assistant" as const,
      content: "",
      attachments: [{ name: "v.mp4", transcript: "SPOKEN", spine: "MAP", text: "raw" }],
    };
    // spine is the first non-empty structured field — the compaction model
    // gets the map, not the raw bytes.
    expect(toWireMessage(m).content).toContain("MAP");
  });

  it("returns a plain content string when there are no attachments", () => {
    expect(toWireMessage({ role: "user", content: "hello" })).toEqual({ role: "user", content: "hello" });
  });
});

describe("estimateConversationTokens", () => {
  it("is monotonic in total content length", () => {
    const small = [msg("1", "user", "hi")];
    const big = [msg("1", "user", "hi"), msg("2", "assistant", "a much longer reply ".repeat(50))];
    expect(estimateConversationTokens(big)).toBeGreaterThan(estimateConversationTokens(small));
  });

  it("counts reasoning and attachment text into the estimate", () => {
    const base = estimateMessageTokens({ role: "user", content: "abc" });
    const withReasoning = estimateMessageTokens({ role: "user", content: "abc", reasoning: "xxxxxxxxxxxxxxxx" });
    expect(withReasoning).toBeGreaterThan(base);
    const withAtt = estimateMessageTokens({ role: "user", content: "abc", attachments: [{ name: "f", text: "yyyyyyyyyyyyyyyy" }] });
    expect(withAtt).toBeGreaterThan(base);
  });

  it("uses the ~4 chars/token ratio", () => {
    // 100 chars ≈ 25 tokens of content; the per-message framing overhead is a
    // small constant on top.
    expect(estimateMessageTokens({ role: "user", content: "a".repeat(100) })).toBeCloseTo(
      100 / CHARS_PER_TOKEN + 4, 0,
    );
  });
});

describe("formatTokens", () => {
  it("formats sub-kilobyte counts as raw integers", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(0)).toBe("0");
  });
  it("formats thousands with one decimal and a k suffix", () => {
    expect(formatTokens(5_200)).toBe("5.2k");
    expect(formatTokens(128_400)).toBe("128.4k");
  });
  it("drops the trailing .0", () => {
    expect(formatTokens(10_000)).toBe("10k");
  });
});

describe("threshold config", () => {
  it("exposes the pre-validated presets", () => {
    expect(COMPACT_PRESETS).toEqual([32_000, 64_000, 128_000, 256_000]);
  });

  it("clamps custom values into the [8k, 1M] window", () => {
    expect(clampCustom(1_000)).toBe(COMPACT_CUSTOM_MIN);
    expect(clampCustom(2_000_000)).toBe(COMPACT_CUSTOM_MAX);
    expect(clampCustom(500_000)).toBe(500_000);
    expect(clampCustom(NaN)).toBe(COMPACT_CUSTOM_MIN);
  });

  it("validates custom entries", () => {
    expect(isValidCustom(8_000)).toBe(true);
    expect(isValidCustom(1_000_000)).toBe(true);
    expect(isValidCustom(7_999)).toBe(false);
    expect(isValidCustom(1_000_001)).toBe(false);
  });

  it("parses the server settings shape, defaulting to off", () => {
    expect(compactThresholdsFromSettings({})).toEqual({ auto: 0, tokens: 0 });
    expect(compactThresholdsFromSettings({ compact_thresholds: { auto: 1, tokens: 128_000 } })).toEqual({ auto: 1, tokens: 128_000 });
    // A malformed value must never read as "on".
    expect(compactThresholdsFromSettings({ compact_thresholds: { auto: 99, tokens: -5 } })).toEqual({ auto: 0, tokens: 0 });
  });
});
