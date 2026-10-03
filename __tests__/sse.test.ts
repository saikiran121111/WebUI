import { describe, it, expect } from "vitest";
import { createSseParser } from "../lib/stream/sse";
import { createThinkSplitter } from "../lib/stream/thinkTags";

describe("createSseParser", () => {
  it("parses a complete event", () => {
    const parse = createSseParser();
    const r = parse("data: hello\n\n");
    expect(r.events).toEqual([{ data: "hello" }]);
    expect(r.done).toBe(false);
  });

  it("signals [DONE]", () => {
    const parse = createSseParser();
    const r = parse("data: [DONE]\n\n");
    expect(r.done).toBe(true);
  });

  it("handles a tag split across two pushes", () => {
    const parse = createSseParser();
    const r1 = parse("data: hel");
    expect(r1.events).toEqual([]);
    const r2 = parse("lo\n\n");
    expect(r2.events).toEqual([{ data: "hello" }]);
  });

  it("handles CRLF boundaries", () => {
    const parse = createSseParser();
    const r = parse("data: a\r\n\r\ndata: b\r\n\r\n");
    expect(r.events).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("joins multi-line data", () => {
    const parse = createSseParser();
    const r = parse("data: a\ndata: b\n\n");
    expect(r.events).toEqual([{ data: "a\nb" }]);
  });

  it("skips comment lines", () => {
    const parse = createSseParser();
    const r = parse(": heartbeat\ndata: x\n\n");
    expect(r.events).toEqual([{ data: "x" }]);
  });
});

describe("createThinkSplitter", () => {
  it("passes through plain text", () => {
    const s = createThinkSplitter();
    expect(s("hello world")).toEqual({ content: "hello world", reasoning: "" });
  });

  it("splits a complete think block", () => {
    const s = createThinkSplitter();
    expect(s("<think>I should think</think>Answer"))
      .toEqual({ content: "Answer", reasoning: "I should think" });
  });

  it("reassembles an open tag split across chunks", () => {
    const s = createThinkSplitter();
    const a = s("hel<think>rea");
    expect(a.content).toBe("hel");
    // Partial open tag — we emit the tail as reasoning (will be cleaned
    // by a decompressor or show as-is; the important thing is we never
    // leak the <think> marker into the content channel).
    expect(a.reasoning).toBe("rea");
    const b = s("soning</think>done");
    expect(b.content).toBe("done");
    expect(b.reasoning).toBe("soning");
  });

  it("handles open-close pairs correctly", () => {
    const s = createThinkSplitter();
    const out = s("<think>inner</think>Answer");
    expect(out).toEqual({ content: "Answer", reasoning: "inner" });
  });
});
