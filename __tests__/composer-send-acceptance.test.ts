/**
 * F153 (2026-11-24) — the attachment-only send law, §1 data loss.
 *
 * Three owners disagreed about "ready file, no typed text":
 *   • composerGate.canSend  — the gate OPENS (the file is the request);
 *   • ChatInput.handleSend  — forwarded it and EMPTIED the tray up front;
 *   • hooks/useChat.send    — `if (!text.trim()) return;` silently dropped it.
 * Net effect: the ready file vanished from the tray, no request was ever
 * made, and nothing was reported. The fix makes acceptance one law
 * (composerGate.acceptsTurn: text OR ready evidence), enforced by the owner
 * that starts the turn, and ChatInput clears the draft/tray only after the
 * owner answers true — a refused send (busy) leaves both exactly intact.
 *
 * The pure law is pinned directly; the hook owner is driven through the
 * production path (react-dom/server renders useChat; the local model endpoint
 * is a queue of SSE fetch stubs, the same fake as chat/web-tool-loop.test.ts).
 * The click-through of the home composer and the in-chat composer is the live
 * row (fr-f152 live batch), which runs exclusively at final validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { acceptsTurn, canSend } from "../lib/chat/composerGate";
import { useChat } from "../hooks/useChat";
import type { Attachment } from "../lib/types";

const ready = (over: Partial<Attachment> = {}): Attachment => ({
  id: "att_ready",
  name: "figures.txt",
  kind: "document",
  mime: "text/plain",
  size: 24,
  status: "ready",
  text: "quarterly figures: 4,18,25,000",
  ...over,
});
const pending = (): Attachment => ready({ id: "att_pend", status: "pending" });

describe("acceptsTurn: the gate and the send owner share ONE acceptance law", () => {
  it("a ready file with NO typed text is a complete turn (gate and owner agree)", () => {
    const state = { text: "", attachments: [ready()], isLoading: false };
    expect(canSend(state)).toBe(true);      // gate opens (B11 law, pinned)
    expect(acceptsTurn(state)).toBe(true);  // owner must not drop it
  });

  it("text alone is accepted; nothing at all is refused", () => {
    expect(acceptsTurn({ text: "hi", attachments: [] })).toBe(true);
    expect(acceptsTurn({ text: "   ", attachments: [] })).toBe(false);
    expect(acceptsTurn({ text: "", attachments: [] })).toBe(false);
  });

  it("a not-yet-ready attachment is not evidence: pending-only sends are refused", () => {
    expect(acceptsTurn({ text: "", attachments: [pending()] })).toBe(false);
    // Mixed tray: ChatInput forwards ONLY ready chips; acceptance counts the
    // same set — the law reads ready evidence, present among others.
    expect(acceptsTurn({ text: "", attachments: [pending(), ready()] })).toBe(true);
  });
});

/* ── the hook owner, driven for real ─────────────────────────────────── */

const dec = new TextDecoder();

function sseResponse(sse: string, chunkSize = 97): unknown {
  const bytes = new TextEncoder().encode(sse);
  let pos = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => ({
        read: async () => {
          if (pos >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(pos, pos + chunkSize);
          pos += chunkSize;
          return { done: false, value };
        },
      }),
    },
  };
}

function answerRound(text: string): unknown {
  const frame = (o: unknown) => "data: " + JSON.stringify(o) + "\n\n";
  return sseResponse(
    frame({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n",
  );
}

const API_URL = "http://127.0.0.1:9/v1/chat/completions";

function mountChat(): ReturnType<typeof useChat> {
  let api: ReturnType<typeof useChat> | null = null;
  // SSR renders the hook body once (no effects) and hands out the live hook
  // object — send() runs its real production path; state setters on the
  // finished render are inert, which is fine: the assertions are on the
  // ACCEPTANCE return and on the request the client actually built.
  const Probe = () => {
    api = useChat({ apiUrl: API_URL, apiKey: "test-key", model: "test-model" });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  if (!api) throw new Error("probe did not mount");
  return api;
}

describe("useChat.send: the owner accepts a ready file with no text", () => {
  const realFetch = globalThis.fetch;
  let bodies: any[];

  beforeEach(() => {
    bodies = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return answerRound("noted");
    }) as any;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("plain text send: accepted, ONE request, the text rides as content", async () => {
    const chat = mountChat();
    const accepted = await chat.send("hello there");
    expect(accepted).toBe(true);
    expect(bodies).toHaveLength(1);
    const user = bodies[0].messages.find((m: any) => m.role === "user");
    expect(user.content).toBe("hello there");
  });

  it("ATTACHMENT-ONLY send: accepted, and the file's evidence rides in the request", async () => {
    const chat = mountChat();
    const accepted = await chat.send("", { attachments: [ready()] });
    expect(accepted).toBe(true);
    expect(bodies).toHaveLength(1);
    const user = bodies[0].messages.find((m: any) => m.role === "user");
    expect(Array.isArray(user.content), "attachment send must ride as a parts array, not empty text").toBe(true);
    const text = user.content.map((p: any) => p.text ?? "").join("\n");
    expect(text).toContain("quarterly figures: 4,18,25,000");
  });

  it("empty text with NO evidence: refused (false) and NOTHING is requested", async () => {
    const chat = mountChat();
    expect(await chat.send("   ")).toBe(false);
    expect(await chat.send("", { attachments: [] })).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  it("a pending attachment alone is refused — the gate's law, enforced by the owner too", async () => {
    const chat = mountChat();
    expect(await chat.send("", { attachments: [pending()] })).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  it("busy: the second concurrent send is REFUSED, so the composer keeps its draft intact", async () => {
    const chat = mountChat();
    const first = chat.send("one");
    expect(await chat.send("two")).toBe(false);
    expect(await first).toBe(true);
    expect(bodies).toHaveLength(1);
  });
});
