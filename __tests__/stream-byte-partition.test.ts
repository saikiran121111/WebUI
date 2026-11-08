import { describe, it, expect, afterEach, vi } from "vitest";
import { createStreamParser } from "../lib/stream/parser";
import type { StreamEvent } from "../lib/types";

/**
 * I01 — byte-partition matrix. The transport (HTTP/TCP) decides where the byte
 * stream is cut; nothing about our parser may depend on that. These tests feed
 * the SAME wire bytes through createStreamParser at EVERY possible cut
 * position (and one-byte-at-a-time), asserting each logical delta arrives
 * EXACTLY once — never duplicated, never lost — and that a genuinely
 * truncated stream reports finishReason "error" instead of pretending the
 * answer completed.
 */

const enc = new TextEncoder();

function stubFetchChunks(chunks: Uint8Array[]): void {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
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

// ---------------------------------------------------------------- fixtures --

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** Content + think tags split across frames + emoji/CJK + stage + tool + usage. */
function mainWire(): string {
  return (
    frame({ choices: [{ delta: { content: "Hello " } }] }) +
    frame({ choices: [{ delta: { content: "<thi" } }] }) +
    frame({ choices: [{ delta: { content: "nk>SECRET" } }] }) +
    frame({ choices: [{ delta: { content: "</th" } }] }) +
    frame({ choices: [{ delta: { content: "ink>🔥 héllo" } }] }) +
    frame({ ruke_stage: { stage: "retrieving" } }) +
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c1", function: { name: "f", arguments: '{"q":1}' } },
            ],
          },
        },
      ],
    }) +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    frame({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
    "data: [DONE]\n\n"
  );
}
const MAIN_CONTENT = "Hello 🔥 héllo";
const MAIN_REASONING = "SECRET";

/** Same stream, CRLF frame terminators. */
function crlfWire(): string {
  return (
    'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
    "data: [DONE]\r\n\r\n"
  );
}

/** Stream that closes cleanly after finish_reason but without [DONE]. */
function finishNoDoneWire(): string {
  return (
    frame({ choices: [{ delta: { content: "done" } }] }) +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] })
  );
}

/** Genuinely truncated: EOF with no finish_reason and no [DONE]. */
function truncatedWire(): string {
  return (
    frame({ choices: [{ delta: { content: "A" } }] }) +
    frame({ choices: [{ delta: { content: "B" } }] }) +
    frame({ choices: [{ delta: { content: "C" } }] })
  );
}

// ------------------------------------------------------------- assertions --

function assertMainShape(events: StreamEvent[], where: string): void {
  const content = events.map((e) => e.content).filter(Boolean).join("");
  const reasoning = events.map((e) => e.reasoning).filter(Boolean).join("");
  expect(content, where).toBe(MAIN_CONTENT);
  expect(reasoning, where).toBe(MAIN_REASONING);
  // Zero think-tag leakage into either channel, at every partition.
  for (const e of events) {
    expect(e.content ?? "", where).not.toMatch(/<think|<\/think/);
    expect(e.reasoning ?? "", where).not.toMatch(/<think|<\/think/);
  }
  const stages = events.filter((e) => e.stage);
  expect(stages.length, where).toBe(1);
  const usage = events.filter((e) => e.usage);
  expect(usage.length, where).toBe(1);
  expect(usage[0].usage?.totalTokens, where).toBe(3);
  const fins = events.filter((e) => e.finishReason);
  expect(fins.length, where).toBe(1);
  expect(fins[0].finishReason, where).toBe("stop"); // never also "error"
  const tools = events.filter((e) => e.toolCalls);
  expect(tools.length, where).toBe(1);
  expect(tools[0].toolCalls?.[0].argsChunk, where).toBe('{"q":1}');
}

/** Run the parser over `bytes` split at position `cut` (two chunks). */
async function runSplit(bytes: Uint8Array, cut: number): Promise<StreamEvent[]> {
  const chunks = [bytes.slice(0, cut), bytes.slice(cut)].filter((c) => c.length > 0);
  stubFetchChunks(chunks);
  return collect();
}

// ------------------------------------------------------------------ tests --

describe("I01 — SSE byte-partition matrix (every cut position)", () => {
  it("delivers every delta exactly once for every 2-way byte cut of the main stream", async () => {
    const bytes = enc.encode(mainWire());
    for (let cut = 1; cut < bytes.length; cut++) {
      assertMainShape(await runSplit(bytes, cut), `cut=${cut}`);
    }
  });

  it("delivers every delta exactly once with single-byte chunks", async () => {
    const bytes = enc.encode(mainWire());
    stubFetchChunks([...bytes].map((b) => Uint8Array.of(b)));
    assertMainShape(await collect(), "1-byte chunks");
  });

  it("single-chunk stream (no split at all) is the baseline", async () => {
    stubFetchChunks([enc.encode(mainWire())]);
    assertMainShape(await collect(), "single chunk");
  });

  it("CRLF terminators survive every cut", async () => {
    const bytes = enc.encode(crlfWire());
    for (let cut = 1; cut < bytes.length; cut++) {
      const events = await runSplit(bytes, cut);
      const content = events.map((e) => e.content).filter(Boolean).join("");
      expect(content, `cut=${cut}`).toBe("ab");
      const fins = events.filter((e) => e.finishReason);
      expect(fins.length, `cut=${cut}`).toBe(1);
      expect(fins[0].finishReason, `cut=${cut}`).toBe("stop");
    }
  });

  it("clean close after finish_reason (no [DONE]) does NOT fabricate an error finish", async () => {
    // Two-way splits always re-form the complete wire inside the parser's
    // buffer — every cut is a clean delivery; a stream that closed after a
    // finish_reason is complete, whatever the TCP framing looked like.
    const bytes = enc.encode(finishNoDoneWire());
    for (let cut = 1; cut < bytes.length; cut++) {
      const events = await runSplit(bytes, cut);
      const content = events.map((e) => e.content).filter(Boolean).join("");
      expect(content, `cut=${cut}`).toBe("done");
      const fins = events.filter((e) => e.finishReason);
      expect(fins.length, `cut=${cut}`).toBe(1);
      expect(fins[0].finishReason, `cut=${cut}`).toBe("stop");
    }
  });

  it("bytes that genuinely never arrive (EOF mid-frame) report an honest error finish", async () => {
    const wire = finishNoDoneWire();
    const frame1 = frame({ choices: [{ delta: { content: "done" } }] });
    const bytes = enc.encode(wire);
    const hard = bytes.slice(0, enc.encode(frame1).length); // the finish frame is NEVER sent
    stubFetchChunks([hard]);
    const events = await collect();
    expect(events.filter((e) => e.content).map((e) => e.content).join("")).toBe("done");
    const fins = events.filter((e) => e.finishReason);
    expect(fins.length).toBe(1);
    expect(fins[0].finishReason).toBe("error");
  });

  it("EOF with no finish_reason and no [DONE] reports exactly one honest error finish, every delta once", async () => {
    const bytes = enc.encode(truncatedWire());
    for (let cut = 1; cut < bytes.length; cut++) {
      const events = await runSplit(bytes, cut);
      const fins = events.filter((e) => e.finishReason);
      expect(fins.length, `cut=${cut}`).toBe(1);
      expect(fins[0].finishReason, `cut=${cut}`).toBe("error");
      // Every terminated frame is recovered EXACTLY once at every partition.
      const content = events.map((e) => e.content).filter(Boolean).join("");
      expect(content, `cut=${cut}`).toBe("ABC");
      for (const letter of ["A", "B", "C"]) {
        expect(events.filter((e) => e.content === letter).length, `cut=${cut} letter=${letter}`).toBe(1);
      }
    }
  });

  it("a frame fully terminated before EOF is never lost at frame-boundary cuts", async () => {
    const bytes = enc.encode(truncatedWire());
    const frameLen = enc.encode(frame({ choices: [{ delta: { content: "A" } }] })).length;
    for (let boundary = 1; boundary <= 3; boundary++) {
      const cut = frameLen * boundary; // cut exactly after N complete frames
      const events = await runSplit(bytes, cut);
      const content = events.map((e) => e.content).filter(Boolean).join("");
      expect(content, `boundary=${boundary}`).toBe("ABC");
      expect(events.filter((e) => e.finishReason)[0]?.finishReason).toBe("error");
    }
  });
});
