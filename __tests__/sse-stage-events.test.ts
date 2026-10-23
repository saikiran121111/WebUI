import { describe, it, expect, afterEach, vi } from "vitest";
import { createStreamParser } from "../lib/stream/parser";
import type { StreamEvent } from "../lib/types";

/**
 * The chat route streams `ruke_stage` progress frames before the model's
 * first byte (app/api/chat/route.ts). The parser must surface them as
 * StreamEvent.stage, map `ruke_error` to finishReason "error" (same client
 * surface as a non-200 upstream), and leave plain upstream SSE — every mock
 * spec and third-party stream — completely untouched.
 */

const enc = new TextEncoder();

function mockFetchWithSse(frames: string[]): void {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })));
}

async function collect(): Promise<StreamEvent[]> {
  const handle = createStreamParser({ url: "http://test/api/chat", body: {} });
  const out: StreamEvent[] = [];
  while (true) {
    const r = await handle.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parser — ruke_stage progress frames", () => {
  it("passes a ruke_stage frame through as StreamEvent.stage", async () => {
    mockFetchWithSse([
      'data: {"ruke_stage":{"stage":"decision_done","mode":"ppt","ms":1234}}\n\n',
      'data: {"ruke_stage":{"stage":"web:reading","detail":"Read 2 of 5 pages…","done":2,"total":5}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect();
    const stages = events.filter(e => e.stage).map(e => e.stage!);
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ stage: "decision_done", mode: "ppt", ms: 1234 });
    expect(stages[1]).toMatchObject({ stage: "web:reading", done: 2, total: 5 });
  });

  it("maps a ruke_error frame to finishReason 'error' (same UI as a failed upstream)", async () => {
    mockFetchWithSse([
      'data: {"ruke_error":{"message":"Could not reach the model server at 127.0.0.1:8080."}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect();
    const finished = events.filter(e => e.finishReason);
    expect(finished.some(e => e.finishReason === "error")).toBe(true);
  });

  it("leaves plain upstream SSE (no ruke_* keys) exactly as before", async () => {
    mockFetchWithSse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect();
    expect(events.filter(e => e.stage)).toHaveLength(0);
    const content = events.map(e => e.content).filter(Boolean).join("");
    expect(content).toBe("Hello world");
    expect(events.some(e => e.finishReason === "stop")).toBe(true);
  });

  it("interleaves stage frames and content deltas without losing either", async () => {
    mockFetchWithSse([
      'data: {"ruke_stage":{"stage":"web:searching","total":3}}\n\n',
      'data: {"choices":[{"delta":{"content":"An"}}]}\n\n',
      'data: {"ruke_stage":{"stage":"web:done","total":12}}\n\n',
      'data: {"choices":[{"delta":{"content":"swer"}}],"usage":{"completion_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect();
    expect(events.filter(e => e.stage).map(e => e.stage!.stage))
      .toEqual(["web:searching", "web:done"]);
    expect(events.map(e => e.content).filter(Boolean).join("")).toBe("Answer");
    const usage = events.map(e => e.usage).filter(Boolean).pop();
    expect(usage?.completionTokens).toBe(7);
  });
});
