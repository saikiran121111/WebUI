/**
 * F153 (2026-11-24) — the retry/edit single-use law, §1 data loss.
 *
 * Four defects, one owner (hooks/useChat):
 *   • retry REWOUND FIRST and sent second. When the send was refused (busy,
 *     or nothing sendable), the conversation stayed rewound — the last turn
 *     was gone with nothing re-sent. The law: rewind + ACCEPTED resend is
 *     ONE operation; a refused retry is a no-op.
 *   • the old rewind removed only the assistant reply, so the resent
 *     request carried the ORIGINAL user turn twice (its own fresh bubble
 *     plus the one left in history). The law: retry reuses the original
 *     user turn and its attachments EXACTLY ONCE — the rewind drops the
 *     reply AND its user message (retryRewind), send() appends the fresh
 *     one, and the request carries the evidence a single time.
 *   • an EDIT truncated both histories BEFORE validating. An empty (or
 *     busy-refused) edit destroyed the conversation with nothing sent.
 *     The law: validate with composerGate.acceptsEdit BEFORE touching
 *     history.
 *   • the deferred edit resend (setTimeout) ran against whatever chat was
 *     OPEN when the timer fired — switching chats in between injected the
 *     edited question into the new chat. The law: the resend is bound to
 *     the history generation captured by the edit; a load/clear abandons it.
 *
 * retryRewind (the UI rewind) is pinned as a pure function; the model
 * request leg and the refusals run the hook for real (react-dom/server
 * renders useChat; the endpoint is an SSE fetch stub; load() seeds the
 * production histories synchronously — the same path a sidebar click takes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useChat, retryRewind } from "../hooks/useChat";
import { acceptsEdit } from "../lib/chat/composerGate";
import type { Attachment, Conversation, Message } from "../lib/types";

/* ── fixtures ─────────────────────────────────────────────────────────── */

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

const msg = (id: string, role: "user" | "assistant", content: string, attachments: Attachment[] = []): Message => ({
  id,
  conversationId: "c_seed",
  role,
  content,
  reasoning: "",
  attachments,
  toolCalls: [],
  citations: [],
  createdAt: 1,
  state: "complete",
  mode: "chat",
});

const conv = (id: string, messages: Message[]): Conversation => ({
  id,
  meta: {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    mode: "chat",
    preview: messages[messages.length - 1]?.content ?? "",
    messageCount: messages.length,
  },
  messages,
});

/** A completed turn with attachment evidence, exactly as persistence hands it back. */
const seededChat = (id = "c_seed") =>
  conv(id, [
    msg("u_seed", "user", "read the figures file", [ready()]),
    msg("a_seed", "assistant", "the figures say Q1 was 4,18,25,000"),
  ]);

/* ── the pure UI rewind ───────────────────────────────────────────────── */

describe("retryRewind: drop the last (user, assistant) pair — the pair send() re-creates", () => {
  it("rewinds exactly the LAST turn pair; earlier turns are untouched", () => {
    const hist = [msg("u1", "user", "one"), msg("a1", "assistant", "r1"), msg("u2", "user", "two"), msg("a2", "assistant", "r2")];
    const { filtered, removedIds } = retryRewind(hist);
    expect(filtered.map(m => m.id)).toEqual(["u1", "a1"]);
    expect(removedIds).toEqual(["u2", "a2"]); // user first: both ids feed the llm-history filter
  });

  it("a single exchange rewinds to empty (the resent bubble replaces the old pair)", () => {
    const { filtered, removedIds } = retryRewind([msg("u1", "user", "one"), msg("a1", "assistant", "r1")]);
    expect(filtered).toEqual([]);
    expect(removedIds).toEqual(["u1", "a1"]);
  });

  it("nothing to retry (no assistant reply): a NO-OP, not a truncation", () => {
    const hist = [msg("u1", "user", "one")];
    const { filtered, removedIds } = retryRewind(hist);
    expect(removedIds).toEqual([]);
    expect(filtered).toBe(hist);
  });

  it("an assistant with no user before it: only the reply is removed", () => {
    const { filtered, removedIds } = retryRewind([msg("a1", "assistant", "r1")]);
    expect(removedIds).toEqual(["a1"]);
    expect(filtered).toEqual([]);
  });
});

/* ── the hook owner, driven for real ──────────────────────────────────── */

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
  const Probe = () => {
    api = useChat({ apiUrl: API_URL, apiKey: "test-key", model: "test-model" });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  if (!api) throw new Error("probe did not mount");
  return api;
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
};

const userTexts = (body: any): string[] =>
  (body.messages ?? [])
    .filter((m: any) => m.role === "user")
    .map((m: any) => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("\n") : m.content));

describe("useChat.retry: rewind + accepted resend is ONE operation", () => {
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

  it("retry reuses the original turn + attachment EXACTLY ONCE in the model request", async () => {
    const chat = mountChat();
    chat.load(seededChat());
    const baseTokens = chat.activeTokenCount(); // the seeded [u_seed, a_seed]
    expect(await chat.send("what about Q3?")).toBe(true);
    expect(bodies).toHaveLength(1);

    chat.retry();
    await settle();
    expect(bodies).toHaveLength(2);
    const retried = bodies[1];
    // The retried request replays ONLY the seeded turn, then the resent
    // question: the evidence rides exactly once, never twice.
    expect(retried.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(userTexts(retried).filter(t => t.includes("what about Q3?"))).toHaveLength(1);
    expect(JSON.stringify(retried).split("quarterly figures: 4,18,25,000").length - 1).toBe(1);
    // The rewind rolled back EXACTLY the retried turn: the model-facing
    // history is the seeded pair again (the old reply is not replayed and
    // the seeded turn is not destroyed).
    expect(chat.activeTokenCount()).toBe(baseTokens);
  });

  it("busy: retry while a turn is generating is a NO-OP — the histories stay intact", async () => {
    const chat = mountChat();
    chat.load(seededChat());
    const baseTokens = chat.activeTokenCount();
    const inFlight = chat.send("generating");
    chat.retry(); // sendBusyRef is set synchronously: this must refuse
    await settle();
    await inFlight;
    expect(bodies).toHaveLength(1);
    expect(chat.activeTokenCount()).toBe(baseTokens);
  });

  it("nothing to retry: zero requests, zero damage", async () => {
    const chat = mountChat();
    chat.retry();
    await settle();
    expect(bodies).toHaveLength(0);
  });
});

describe("useChat.edit: validate BEFORE touching history; the resend belongs to its chat", () => {
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

  it("the pure law: whitespace is not an edit", () => {
    expect(acceptsEdit("   ")).toBe(false);
    expect(acceptsEdit("fixed question")).toBe(true);
  });

  it("EMPTY edit: refused — the conversation is intact and NOTHING is sent", async () => {
    const chat = mountChat();
    chat.load(seededChat());
    const baseTokens = chat.activeTokenCount();
    chat.edit("u_seed", "   ");
    await settle(); // let the (abandoned) deferred resend fire
    expect(chat.activeTokenCount()).toBe(baseTokens);
    expect(bodies).toHaveLength(0);
  });

  it("edit WHILE GENERATING: refused — history intact, no extra request", async () => {
    const chat = mountChat();
    chat.load(seededChat());
    const baseTokens = chat.activeTokenCount();
    const inFlight = chat.send("generating");
    chat.edit("u_seed", "replacement question");
    await settle();
    await inFlight;
    expect(chat.activeTokenCount()).toBe(baseTokens);
    expect(bodies).toHaveLength(1); // only the in-flight turn
  });

  it("accepted edit: rewinds its turn and resends it exactly ONCE, in the chat that asked", async () => {
    const chat = mountChat();
    chat.load(seededChat());
    chat.edit("u_seed", "fixed question");
    await settle();
    expect(bodies).toHaveLength(1);
    const sent = bodies[0].messages;
    // The edited user message replaces the whole rewound pair: the request
    // carries "fixed question" exactly once, and nothing precedes it.
    expect(sent.map((m: any) => m.role)).toEqual(["user"]);
    expect(userTexts(bodies[0]).filter(t => t.includes("fixed question"))).toHaveLength(1);
  });

  it("switching chats before the deferred resend: the resend is ABANDONED, not injected", async () => {
    const chat = mountChat();
    chat.load(seededChat());
    chat.edit("u_seed", "fixed question");
    chat.load(conv("c_other", [])); // a chat switch between the edit and its timer
    await settle();
    expect(bodies).toHaveLength(0);
    expect(chat.activeTokenCount()).toBe(0); // the NEW chat's (empty) history owns the screen now
  });
});
