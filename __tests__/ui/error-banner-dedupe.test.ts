/**
 * F153 (2026-11-25) — single-visible-status law for turn failures.
 *
 * Live evidence (conversation c_owaqq1ya1mwuw0bb1): the parked-handoff
 * refusal rendered TWICE — the assistant bubble (ChatMessage.tsx:224-232,
 * no Retry) and the global banner (app/page.tsx, with Retry) — because
 * useChat's settlement records the identical reason on both surfaces
 * (hooks/useChat.ts:994-997, and the catch path :1026-1030).
 *
 * Seam: the PURE predicate app/page.tsx renders on (lib/chat/errorSurface).
 * Laws pinned here:
 *  1. a terminal turn error is ONE visible status: when the latest assistant
 *     message is in state "error" carrying this exact reason, the banner is
 *     suppressed (the bubble shows it in the turn's place);
 *  2. the banner survives every banner-only outcome: truncation (the bubble
 *     stays complete), a mid-stream failure over an older complete bubble,
 *     a refusal before any assistant turn settled (no messages), and a
 *     reason that is NOT the one the bubble shows;
 *  3. a completed later turn (user message after the error) re-exposes the
 *     banner so the Retry affordance is reachable.
 */
import { describe, expect, it } from "vitest";
import { showRetryBanner } from "../../lib/chat/errorSurface";
import type { Message } from "../../lib/types";

const msg = (over: Partial<Message> & { role: Message["role"] }): Message =>
  ({ id: `m${Math.random()}`, conversationId: "c", content: "", reasoning: "", attachments: [], toolCalls: [], citations: [], createdAt: 0, state: "complete", mode: "chat", ...over }) as Message;

const PARKED = "A document or media job has the model parked; retry in a moment.";

describe("F153 single-visible-status law", () => {
  it("a terminal turn error shows ONCE: the bubble carries it, the banner is suppressed", () => {
    const messages = [
      msg({ role: "user", content: "what does figure 2 show?" }),
      msg({ role: "assistant", state: "error", error: PARKED }),
    ];
    expect(showRetryBanner(PARKED, messages)).toBe(false);
  });

  it("truncation keeps the banner: the bubble is COMPLETE and shows no reason", () => {
    const truncated = "The model stopped before finishing the answer. The text above is what it managed to write.";
    const messages = [msg({ role: "assistant", state: "complete" })];
    expect(showRetryBanner(truncated, messages)).toBe(true);
  });

  it("a refusal with no settled assistant turn (preflight) keeps the banner", () => {
    expect(showRetryBanner(PARKED, [])).toBe(true);
    expect(showRetryBanner(PARKED, [msg({ role: "user", content: "q" })])).toBe(true);
  });

  it("a mid-stream failure over an older COMPLETE bubble keeps the banner", () => {
    const messages = [msg({ role: "assistant", state: "complete", content: "older good answer" })];
    expect(showRetryBanner("Network connection lost.", messages)).toBe(true);
  });

  it("a different reason than the bubble's is still shown (never swallowed)", () => {
    const messages = [msg({ role: "assistant", state: "error", error: "Generation failed" })];
    expect(showRetryBanner(PARKED, messages)).toBe(true);
  });

  it("after a new user message the banner returns, so Retry stays reachable", () => {
    const messages = [
      msg({ role: "assistant", state: "error", error: PARKED }),
      msg({ role: "user", content: "try again" }),
    ];
    expect(showRetryBanner(PARKED, messages)).toBe(true);
  });

  it("no error → no banner", () => {
    expect(showRetryBanner(null, [msg({ role: "assistant", state: "complete" })])).toBe(false);
  });
});
