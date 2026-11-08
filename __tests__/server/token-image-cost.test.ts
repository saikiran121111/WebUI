/**
 * I05 (2026-11-08): vision attachments must count toward the auto-compact
 * threshold. An attached screenshot previously cost ZERO tokens — keyframes
 * and image attachments are invisible to the ~4-chars/token heuristic. The
 * honest local proxy is a FIXED per-image cost (local vision models bill a
 * patch grid, not characters). Pins: the constant, frames, image-kind data
 * URLs, and — critically — that TEXT-ONLY messages are untouched, so every
 * existing compact-pipeline estimate pin stays green.
 */
import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, IMAGE_TOKEN_COST, estimateMessageTokens } from "@/lib/chat/tokens";

describe("I05 image token cost", () => {
  it("the fixed proxy constant is 768 per served image", () => {
    expect(IMAGE_TOKEN_COST).toBe(768);
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it("text-only estimates are byte-for-byte what they were before", () => {
    expect(estimateMessageTokens({ role: "user", content: "a".repeat(80) })).toBe(20 + 4);
    expect(
      estimateMessageTokens({
        role: "assistant", content: "abc", reasoning: "abcd",
        attachments: [{ text: "xx", transcript: "yyy", spine: "zzzz", name: "n" }],
      }),
    ).toBe(Math.ceil((3 + 4 + 2 + 3 + 4 + 1) / 4) + 4);
    // No frames/dataUrl fields present ⇒ zero image cost.
    expect(estimateMessageTokens({ role: "user", content: "", attachments: [] })).toBe(4);
  });

  it("each served keyframe costs one fixed image allowance", () => {
    const base = estimateMessageTokens({ role: "user", content: "", attachments: [] });
    const withFrames = estimateMessageTokens({
      role: "user", content: "", attachments: [{ frames: [{}, {}, {}] }],
    });
    expect(withFrames - base).toBe(3 * IMAGE_TOKEN_COST);
  });

  it("an image-kind attachment with an inline data URL counts once", () => {
    const base = estimateMessageTokens({ role: "user", content: "", attachments: [] });
    const img = estimateMessageTokens({
      role: "user", content: "", attachments: [{ kind: "image", dataUrl: "data:image/png;base64,AAAA" }],
    });
    expect(img - base).toBe(IMAGE_TOKEN_COST);
    // A frames-bearing video attachment AND its keyframes ride together.
    const both = estimateMessageTokens({
      role: "user",
      content: "",
      attachments: [
        { frames: [{}] },
        { kind: "image", dataUrl: "data:image/png;base64,AAAA" },
      ],
    });
    expect(both - base).toBe(2 * IMAGE_TOKEN_COST);
  });

  it("no data URL on an image kind ⇒ no phantom cost (nothing served)", () => {
    const base = estimateMessageTokens({ role: "user", content: "", attachments: [] });
    const noData = estimateMessageTokens({ role: "user", content: "", attachments: [{ kind: "image" }] });
    expect(noData).toBe(base);
  });
});
