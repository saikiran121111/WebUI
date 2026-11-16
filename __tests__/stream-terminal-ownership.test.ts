/**
 * F16 (2026-11-15 brief) - STREAM TERMINAL OWNERSHIP.
 *
 * Two defects are pinned here, both of which made "the stream ended" mean
 * something different depending on how the network chopped the bytes:
 *
 *  A. POST-DONE METADATA LOSS. `[DONE]` ends the model's TOKENS, not the
 *     read loop. The client used to stop reading at `[DONE]`, so usage /
 *     final-metadata frames that the upstream put in a LATER read vanished
 *     while the identical bytes coalesced into one read survived. Content,
 *     status, history and metadata MUST be invariant under chunking.
 *
 *  B. FAKE SUCCESS. `ChatClient.chat()` resolved normally on every path, and
 *     the parser turns an upstream error into an EVENT rather than a throw -
 *     so the caller could not tell success from error / abort / truncation /
 *     an orphaned tool-call EOF. The explicit terminal outcome now rides all
 *     the way up as `StreamSettlement` (`handle.settled()`).
 *
 * Every case is a deterministic MOCKED upstream: no model, no port 8080.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createStreamParser,
  POST_DONE_DRAIN_MS,
  type StreamSettlement,
} from "@/lib/stream/parser";
import { ChatClient } from "@/lib/chat/client";
import type { StreamEvent } from "@/lib/types";

const enc = new TextEncoder();
const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const contentDelta = (content: string) =>
  frame({ choices: [{ delta: { content }, finish_reason: null }] });
const finishFrame = (reason: string) =>
  frame({ choices: [{ delta: {}, finish_reason: reason }] });
const toolCallFrame = () =>
  frame({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }],
        },
      },
    ],
  });
const DONE = "data: [DONE]\n\n";
const USAGE = frame({ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });

interface StreamProbe {
  cancelled: boolean;
  chunks: Uint8Array[];
}

/** Response whose body closes after the given chunks (normal transport). */
function stubClosedStream(chunks: Uint8Array[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
          },
          cancel() {
            probe.cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    ),
  );
}
const probe: StreamProbe = { cancelled: false, chunks: [] };

/**
 * Response that enqueues everything but NEVER closes - the upstream holding a
 * connection open after `[DONE]`. `signal` is wired the way undici wires it:
 * an abort errors the pending read with an AbortError.
 */
function stubOpenStream(chunks: Uint8Array[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          for (const ch of chunks) c.enqueue(ch);
        },
        cancel() {
          probe.cancelled = true;
        },
      });
      init?.signal?.addEventListener("abort", () => {
        try {
          ctrl.error(new DOMException("The operation was aborted", "AbortError"));
        } catch {
          /* already closed/errored */
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

async function collect(opts: Parameters<typeof createStreamParser>[0]): Promise<StreamEvent[]> {
  // LAW: `createStreamParser` starts its pump synchronously and resolves the
  // global `fetch` at that moment, so the transport MUST be stubbed first.
  const handle = createStreamParser(opts);
  const out: StreamEvent[] = [];
  while (true) {
    const r = await handle.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

const settledOf = async (
  chunks: Uint8Array[],
  opts: { postDoneDrainMs?: number; stub?: "closed" | "open" | "none" } = {},
): Promise<{ events: StreamEvent[]; settled: StreamSettlement | null }> => {
  // LAW: stub FIRST - the parser captures `fetch` when it is created.
  if (opts.stub === "open") stubOpenStream(chunks);
  else if (opts.stub !== "none") stubClosedStream(chunks);
  const handle = createStreamParser({ url: "http://test/api/chat", body: {}, ...opts });
  const events: StreamEvent[] = [];
  let settledBeforeDone: StreamSettlement | null = null;
  while (true) {
    const r = await handle.next();
    if (r.done) break;
    events.push(r.value);
    // LAW: nothing is settled while the iterator is still running - a partial
    // read must never be reported as a finished turn.
    settledBeforeDone = handle.settled();
    if (settledBeforeDone) break;
  }
  expect(settledBeforeDone, "no settlement may exist before the single terminal").toBeNull();
  return { events, settled: handle.settled() };
};

const bytes = (s: string) => enc.encode(s);
const perByte = (s: string) => [...enc.encode(s)].map((b) => Uint8Array.of(b));

afterEach(() => {
  vi.unstubAllGlobals();
  probe.cancelled = false;
});

// --------------------------------------------------------------------------
// A. the post-[DONE] metadata law is chunking-invariant
// --------------------------------------------------------------------------

describe("F16 A - metadata after [DONE] survives every chunk boundary", () => {
  // The wire the F16 report reproduced: answer, finish, [DONE], THEN usage.
  const wire = contentDelta("the answer") + finishFrame("stop") + DONE + USAGE;

  const shape = (events: StreamEvent[]) =>
    JSON.stringify(
      events.map((e) => ({
        c: e.content ?? null,
        f: e.finishReason ?? null,
        u: e.usage?.totalTokens ?? null,
      })),
    );

  it("keeps the trailing usage frame when [DONE] ends a read and usage starts the next", async () => {
    const cut = enc.encode(contentDelta("the answer") + finishFrame("stop") + DONE).length;
    stubClosedStream([bytes(wire).slice(0, cut), bytes(wire).slice(cut)]);
    const events = await collect({ url: "http://test/api/chat", body: {} });
    const usage = events.filter((e) => e.usage);
    expect(usage, "the usage frame rode a LATER read than [DONE]").toHaveLength(1);
    expect(usage[0].usage?.totalTokens).toBe(7);
    expect(events.map((e) => e.content).filter(Boolean).join("")).toBe("the answer");
    expect(events.filter((e) => e.finishReason).map((e) => e.finishReason)).toEqual(["stop"]);
  });

  it("one chunk, the split-at-[DONE] cut and byte-per-chunk produce IDENTICAL events", async () => {
    const seen: string[] = [];
    for (const [label, chunks] of [
      ["single read", [bytes(wire)]],
      ["[DONE] ends read 1", (() => {
        const cut = enc.encode(contentDelta("the answer") + finishFrame("stop") + DONE).length;
        return [bytes(wire).slice(0, cut), bytes(wire).slice(cut)];
      })()],
      ["every byte its own read", perByte(wire)],
    ] as [string, Uint8Array[]][]) {
      stubClosedStream(chunks);
      seen.push(shape(await collect({ url: "http://test/api/chat", body: {} })));
    }
    expect(new Set(seen).size, `partitions diverged: ${seen.join(" | ")}`).toBe(1);
    expect(seen[0]).toContain('"u":7');
  });

  it("the terminal is emitted only AFTER every metadata event has been queued", async () => {
    // The read loop keeps draining past [DONE]; the iterator's single terminal
    // must therefore arrive after usage, never between tokens and metadata.
    const cut = enc.encode(contentDelta("the answer") + finishFrame("stop") + DONE).length;
    stubClosedStream([bytes(wire).slice(0, cut), bytes(wire).slice(cut)]);
    const handle = createStreamParser({ url: "http://test/api/chat", body: {} });
    const order: string[] = [];
    while (true) {
      const r = await handle.next();
      if (r.done) {
        order.push("terminal");
        break;
      }
      const e = r.value;
      if (e.usage) order.push("usage");
      if (e.finishReason) order.push("finish:" + e.finishReason);
      if (e.content) order.push("content");
    }
    expect(order).toEqual(["content", "finish:stop", "usage", "terminal"]);
  });

  it("a server that never closes after [DONE] is bounded, releases the reader, and still reports success", async () => {
    const t0 = Date.now();
    const { events, settled } = await settledOf(
      [bytes(contentDelta("answer text") + finishFrame("stop") + DONE)],
      { postDoneDrainMs: 25, stub: "open" },
    );
    const waited = Date.now() - t0;
    expect(events.map((e) => e.content).filter(Boolean).join("")).toBe("answer text");
    expect(settled).toMatchObject({
      outcome: "success",
      finishReason: "stop",
      trailingDrainExpired: true,
    });
    expect(probe.cancelled, "the abandoned read must release the connection, not leak it").toBe(true);
    expect(waited).toBeLessThan(2_000);
    expect(POST_DONE_DRAIN_MS, "the production default bounds the wait without hanging").toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// B. the explicit terminal outcome
// --------------------------------------------------------------------------

describe("F16 B - every ending is a distinct, explicit outcome", () => {
  it("clean stop + [DONE] => success", async () => {
    const { settled } = await settledOf([bytes(contentDelta("ok") + finishFrame("stop") + DONE)]);
    expect(settled).toMatchObject({ outcome: "success", finishReason: "stop" });
  });

  it("a ruke_error frame followed by a clean [DONE] is an ERROR, not success", async () => {
    const wire =
      frame({ ruke_error: { message: "Model endpoint is busy; please retry." } }) + DONE;
    const { events, settled } = await settledOf([bytes(wire)]);
    expect(settled?.outcome).toBe("error");
    expect(settled?.errorMessage, "the server's actual reason must survive").toContain(
      "Model endpoint is busy",
    );
    expect(events.filter((e) => e.finishReason).map((e) => e.finishReason)).toEqual(["error"]);
  });

  it("a transport failure is an ERROR with its message, never a silent success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8080");
      }),
    );
    const { settled } = await settledOf([bytes(contentDelta("partial") + DONE)], {
      stub: "none",
    });
    expect(settled?.outcome).toBe("error");
    expect(settled?.errorMessage).toContain("ECONNREFUSED");
  });

  it("the caller aborting mid-stream => cancelled", async () => {
    stubOpenStream([bytes(contentDelta("half an answer"))]);
    const handle = createStreamParser({ url: "http://test/api/chat", body: {} });
    const got = await handle.next(); // the content delta lands first
    expect(got.done).toBe(false);
    handle.abort();
    while (true) {
      const r = await handle.next();
      if (r.done) break;
    }
    expect(handle.settled()?.outcome).toBe("cancelled");
  });

  it("EOF with no finish_reason and no [DONE] => truncated (partial text kept)", async () => {
    const { events, settled } = await settledOf([bytes(contentDelta("A") + contentDelta("B"))]);
    expect(settled?.outcome).toBe("truncated");
    expect(events.map((e) => e.content).filter(Boolean).join("")).toBe("AB");
    expect(events.filter((e) => e.finishReason).map((e) => e.finishReason)).toEqual(["error"]);
  });

  it("finish_reason length => truncated, not complete", async () => {
    const { settled } = await settledOf([bytes(contentDelta("cut mid sentence") + finishFrame("length") + DONE)]);
    expect(settled).toMatchObject({ outcome: "truncated", finishReason: "length" });
  });

  it("tool_calls followed by EOF with no [DONE] => incomplete_tool_round, NOT success", async () => {
    const { settled } = await settledOf([bytes(toolCallFrame() + finishFrame("tool_calls"))]);
    expect(settled?.outcome).toBe("incomplete_tool_round");
    expect(settled?.errorMessage).toMatch(/tool/i);
  });

  it("a server-capped round that emitted its own [DONE] stays a finished turn", async () => {
    // LAW: the web loop's round cap synthesises [DONE] for the round it
    // deliberately terminated. sawDone is what separates that honest cap from
    // an orphaned tool-call EOF, so this must NOT become incomplete_tool_round.
    const { settled } = await settledOf([bytes(toolCallFrame() + finishFrame("tool_calls") + DONE)]);
    expect(settled).toMatchObject({ outcome: "success", finishReason: "tool_calls" });
  });
});

// --------------------------------------------------------------------------
// C. the outcome reaches the caller that owns persistence
// --------------------------------------------------------------------------

describe("F16 C - ChatClient.chat() hands the caller the real outcome", () => {
  it("returns the settlement, and an upstream error is not a resolved success", async () => {
    stubClosedStream([bytes(frame({ ruke_error: { message: "upstream exploded" } }) + DONE)]);
    const events: StreamEvent[] = [];
    const settlement = await new ChatClient("http://test/api/chat").chat(
      { messages: [{ role: "user", content: "hi" }] } as any,
      (e) => events.push(e),
    );
    expect(settlement.outcome).toBe("error");
    expect(settlement.errorMessage).toContain("upstream exploded");
    // The partial-answer path keeps its text and still reports the truth.
    stubClosedStream([bytes(contentDelta("cut") + finishFrame("length") + DONE)]);
    const s2 = await new ChatClient("http://test/api/chat").chat(
      { messages: [{ role: "user", content: "hi" }] } as any,
      () => {},
    );
    expect(s2.outcome).toBe("truncated");
    stubClosedStream([bytes(contentDelta("fine") + finishFrame("stop") + DONE)]);
    const s3 = await new ChatClient("http://test/api/chat").chat(
      { messages: [{ role: "user", content: "hi" }] } as any,
      () => {},
    );
    expect(s3.outcome).toBe("success");
  });
});
