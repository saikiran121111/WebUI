/**
 * F153 (2026-11-24) — the navigation-ownership law, §1 data loss (item c).
 *
 * app/page.tsx's handleSelect awaits getConversation(id); the 2026-11-24
 * audit found the await unguarded, so the LAST RESOLVER owned the screen.
 * The page now takes a generation per navigation and discards a resolution
 * whose generation is superseded. This suite drives the law through the
 * OWNER CONTRACT with a fake store (the exact select/New sequences from the
 * brief: slow-A/fast-B, New-while-A-loads, the next-request history after
 * the race). The click-through of the real sidebar is the live row, run
 * exclusively at final validation.
 */
import { describe, it, expect } from "vitest";

import { createNavOwner } from "../lib/chat/navOwner";
import type { Conversation, Message } from "../lib/types";

const msg = (id: string, content: string): Message => ({
  id,
  conversationId: "c",
  role: "user",
  content,
  reasoning: "",
  attachments: [],
  toolCalls: [],
  citations: [],
  createdAt: 1,
  state: "complete",
  mode: "chat",
});

const conv = (id: string, content: string): Conversation => ({
  id,
  meta: {
    id, title: id, createdAt: 1, updatedAt: 1,
    pinned: false, archived: false, mode: "chat", preview: content, messageCount: 1,
  },
  messages: [msg(id + "_u", content)],
});

/** The page owner's select/New contract, mirrored from app/page.tsx. */
function makeScreen(delays: Record<string, number>) {
  const navOwner = createNavOwner();
  let screen: { id: string | null; messages: Message[] } = { id: null, messages: [] };
  const select = async (id: string) => {
    const gen = navOwner.begin();
    await new Promise(r => setTimeout(r, delays[id] ?? 0)); // getConversation(id)
    if (!navOwner.isCurrent(gen)) return;                   // discard whole
    const c = conv(id, `messages of ${id}`);
    screen = { id, messages: c.messages };
  };
  const newChat = () => { navOwner.cancel(); screen = { id: null, messages: [] }; };
  return { select, newChat, screen: () => screen };
}

describe("the latest navigation owns the screen", () => {
  it("plain open paints the chat it loaded", async () => {
    const s = makeScreen({ A: 5 });
    await s.select("A");
    expect(s.screen().id).toBe("A");
  });

  it("slow A then fast B: B owns the screen; A's late resolve is DISCARDED", async () => {
    const s = makeScreen({ A: 40, B: 5 });
    const a = s.select("A");
    const b = s.select("B");
    await Promise.all([a, b]);
    expect(s.screen().id).toBe("B");
    // B's next request reads the screen's history: it is B's, never A's.
    expect(s.screen().messages.map(m => m.content)).toEqual(["messages of B"]);
  });

  it("New while A loads: the fresh chat stays; A's late resolve is DISCARDED", async () => {
    const s = makeScreen({ A: 40 });
    const a = s.select("A");
    s.newChat();
    await a;
    expect(s.screen().id).toBeNull();
    expect(s.screen().messages).toEqual([]);
  });

  it("a navigation after a New still paints (ownership is per navigation, not sticky)", async () => {
    const s = makeScreen({ A: 40 });
    const a = s.select("A");
    s.newChat();
    const b = s.select("B");
    await Promise.all([a, b]);
    expect(s.screen().id).toBe("B");
  });

  it("the pure gate: only the latest generation is current", () => {
    const nav = createNavOwner();
    const gA = nav.begin();
    expect(nav.isCurrent(gA)).toBe(true);
    const gB = nav.begin();
    expect(nav.isCurrent(gA)).toBe(false);
    expect(nav.isCurrent(gB)).toBe(true);
    nav.cancel();
    expect(nav.isCurrent(gB)).toBe(false);
  });
});
