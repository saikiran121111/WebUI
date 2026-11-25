/**
 * F153 (2026-11-24) — the fenceRepair TERMINAL-OUTCOME law, brief §2.
 *
 * hooks/useChat's runRepairRounds ends a streamed turn: every exit must
 * RESOLVE the "Auto-repairing…" badge (clean / repaired / aborted /
 * honest terminal notice) — on HEAD the exhausted-rounds exit left the
 * badge spinning forever on a finished turn. The pure validator round-trip
 * is pinned in __tests__/render/fenceRepair.test.ts; this suite drives the
 * hook owner for real (react-dom/server + an SSE fetch stub) and pins the
 * deterministic shape of each outcome:
 *   clean      → ZERO repair round-trips,
 *   repaired   → EXACTLY ONE round-trip, request carries the model its own
 *                broken fence + the exact error, under the SAME decision mode,
 *   exhausted→ AT MOST MAX_FENCE_REPAIRS round-trips (the badge settles at
 *                the loop exit; the broken fence stays so the viewer card
 *                keeps the exact error),
 *   no validator (standard_chat / no header) → ZERO round-trips, a chat
 *                turn never pays a repair round-trip (zero-collision law).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useChat } from "../hooks/useChat";
import { MAX_FENCE_REPAIRS } from "../lib/render/fenceRepair";

// node has no rAF (jsdom is out of repo policy): the hook's frame-batched
// flush needs it, exactly as the browser provides it.
globalThis.requestAnimationFrame = ((cb: any) => setTimeout(() => cb(Date.now()), 0)) as any;
globalThis.cancelAnimationFrame = ((id: any) => clearTimeout(id)) as any;


/* ── SSE stub ─────────────────────────────────────────────────────────── */

const dec = new TextDecoder();

function sseResponse(sse: string, headers: Record<string, string> = {}, chunkSize = 97): unknown {
  const bytes = new TextEncoder().encode(sse);
  let pos = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream", ...headers }),
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

function answerRound(text: string, mode?: string): unknown {
  const frame = (o: unknown) => "data: " + JSON.stringify(o) + "\n\n";
  return sseResponse(
    frame({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n",
    mode ? { "x-decision-mode": mode } : {},
  );
}

/* ── fence fixtures ───────────────────────────────────────────────────── */

const BROKEN =
  "Here is your page:\n```html\njust words about the page, no markup at all\n```";
const FIXED =
  "```html\n<div class=\"report\"><p>the quarterly figures table</p></div>\n```";

/* ── the hook, mounted SSR, endpoint stubbed ──────────────────────────── */

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

const realFetch = globalThis.fetch;
let bodies: any[];
let queue: unknown[];

beforeEach(() => {
  bodies = [];
  queue = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return queue.shift() ?? answerRound("prose describing the fix, no fence");
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

const repairs = () => bodies.slice(1); // body 0 is the user's turn

// send() resolves at ACCEPTANCE; the stream + repair continuation runs
// unawaited behind it (the same reason the retry suite has a settle loop).
const settle = async () => {
  for (let i = 0; i < 80; i++) await new Promise(r => setTimeout(r, 0));
};

describe("runRepairRounds: every outcome settles, the rounds are capped", () => {
  it("clean: a VALID fence under an active mode triggers ZERO repair round-trips", async () => {
    queue.push(answerRound("Report:\n" + FIXED, "html_render"));
    await mountChat().send("make me a page");
    await settle();
    expect(repairs()).toHaveLength(0);
  });

  it("repaired: a broken fence triggers EXACTLY ONE round-trip showing the model its own error", async () => {
    queue.push(answerRound(BROKEN, "html_render"), answerRound(FIXED));
    await mountChat().send("make me a page");
    await settle();
    const r = repairs();
    expect(r).toHaveLength(1);
    const msgs = r[0].messages;
    // The model is shown its own broken output, then the exact-error fix request.
    expect(msgs[msgs.length - 2]).toMatchObject({ role: "assistant", content: expect.stringContaining("no markup at all") });
    expect(msgs[msgs.length - 1].content).toContain("failed to load in the viewer");
    expect(msgs[msgs.length - 1].content).toContain("no HTML markup");
    // The repair rides the SAME decision mode (zero-collision law).
    expect(r[0].decision_mode).toBe("html_render");
  });

  it("exhausted: prose-only repairs stop at MAX_FENCE_REPAIRS round-trips — no endless loop", async () => {
    queue.push(answerRound(BROKEN, "html_render")); // both repair replies default to prose
    await mountChat().send("make me a page");
    await settle();
    expect(repairs()).toHaveLength(MAX_FENCE_REPAIRS);
  });

  it("a standard_chat turn NEVER pays a repair round-trip, even around a broken fence", async () => {
    queue.push(answerRound(BROKEN, "standard_chat"));
    await mountChat().send("make me a page");
    await settle();
    expect(repairs()).toHaveLength(0);
  });

  it("no decision mode on the stream: no validator runs at all (engine down / legacy)", async () => {
    queue.push(answerRound(BROKEN)); // no x-decision-mode header
    await mountChat().send("make me a page");
    await settle();
    expect(repairs()).toHaveLength(0);
  });
});
