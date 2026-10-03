import { describe, it, expect } from "vitest";
import { createSseParser } from "../lib/stream/sse";

/**
 * Regression test for the SSE chunk-boundary bug in parser.ts.
 *
 * createSseParser keeps its own internal buffer. The caller in parser.ts
 * feeds it the raw HTTP chunks via `sse(buf)` and must NOT reset `buf`
 * to "" after each chunk — otherwise events whose JSON spans two reads
 * are emitted twice (incomplete first, complete second) or the first
 * half is silently lost.
 *
 * The parser returns both complete and incomplete events. The caller's
 * job is to feed the *same* buffer back on each read (without clearing
 * it) so that split events are reconstructed from the parser's internal
 * state before any emit.
 */

describe("parser.ts — multi-chunk SSE (caller-loop regression)", () => {
  it("does not emit an incomplete event while waiting for the rest of the JSON", () => {
    const parse = createSseParser();

    // First chunk: opens the SSE event but cuts off mid-JSON-string.
    // The "\n\n" terminator is present but the content value is incomplete.
    const chunk1 = 'data: {"choices":[{"delta":{"content":"He';
    // Second chunk: completes the JSON and the SSE terminator.
    const chunk2 = 'llo"}}]}\n\n';

    const r1 = parse(chunk1);
    // The parser should hold the partial frame internally — not emit it.
    expect(r1.events).toEqual([]);

    const r2 = parse(chunk2);
    // Now the full event arrives intact.
    expect(r2.events.length).toBe(1);
    expect(r2.events[0].data).toContain("Hello");
  });

  it("emits exactly one event when the SSE frame spans two reads (no premature emit)", () => {
    const parse = createSseParser();

    // Chunk 1 starts two separate SSE frames but cuts both short.
    const chunk1 = 'data: A\n\ndata: B';
    // Chunk 2 completes the second frame; the first frame is just "A" with
    // no terminator and must NOT be emitted yet (incomplete).
    const chunk2 = 'C\n\n';

    const r1 = parse(chunk1);
    // "A\n\n" is a complete SSE event — should emit.
    // "B" is incomplete — held internally.
    expect(r1.events).toEqual([{ data: "A" }]);

    const r2 = parse(chunk2);
    // "BC\n\n" is the completion of the second event.
    expect(r2.events).toEqual([{ data: "BC" }]);
  });

  it("does not emit a partial reasoning_content field", () => {
    const parse = createSseParser();

    const chunk1 = 'data: {"choices":[{"delta":{"reasoning_content":"Let';
    const chunk2 = ' me think"}}]}\n\n';

    const r1 = parse(chunk1);
    expect(r1.events).toEqual([]);

    const r2 = parse(chunk2);
    expect(r2.events.length).toBe(1);
    expect(r2.events[0].data).toContain("Let me think");
  });

  it("handles tool_call args split across reads without emitting partial args", () => {
    const parse = createSseParser();

    const chunk1 = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query';
    const chunk2 = '\\":\\"x\\"}}]}}]}\n\n';

    const r1 = parse(chunk1);
    expect(r1.events).toEqual([]); // held — incomplete JSON string

    const r2 = parse(chunk2);
    expect(r2.events.length).toBe(1);
    expect(r2.events[0].data).toContain("query");
    expect(r2.events[0].data).toContain("x");
  });

  it("preserves the [DONE] signal even after split events", () => {
    const parse = createSseParser();

    // Complete event split: content spans two reads.
    const c1 = 'data: {"choices":[{"delta":{"content":"Hel';
    const c2 = 'lo"}}]}\n\ndata: [DONE]\n\n';

    expect(parse(c1).events).toEqual([]);
    const r2 = parse(c2);
    // c2 completes the content event AND delivers [DONE] — both emitted.
    expect(r2.events.length).toBe(2);
    expect(r2.events[0].data).toContain("Hello");
    expect(r2.events[1].data).toBe("[DONE]");
    expect(r2.done).toBe(true);
  });
});
