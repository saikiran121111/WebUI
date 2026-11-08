import { describe, it, expect } from "vitest";
import { createThinkSplitter } from "../lib/stream/thinkTags";

/**
 * I02 — the think splitter is a holdback state machine: a delimiter split
 * across ANY chunk boundary must never leak into either channel, and text it
 * was still holding when the stream ended is literal text — released by
 * flush(), not dropped and not treated as a delimiter.
 */

describe("createThinkSplitter — holdback across chunk boundaries", () => {
  it("delimiter split into 4 pieces leaks nothing and routes correctly", () => {
    const s = createThinkSplitter();
    const out = [s("<thi"), s("nk>SECRET"), s("</th"), s("ink>FINAL")];
    const content = out.map((o) => o.content).join("");
    const reasoning = out.map((o) => o.reasoning).join("");
    expect(content).toBe("FINAL");
    expect(reasoning).toBe("SECRET");
    for (const o of out) {
      expect(o.content).not.toMatch(/<think|<\/think/);
      expect(o.reasoning).not.toMatch(/<think|<\/think/);
    }
  });

  it("holds a partial open tag back instead of emitting it as content", () => {
    const s = createThinkSplitter();
    expect(s("abc<")).toEqual({ content: "abc", reasoning: "" });
    expect(s("think>xyz")).toEqual({ content: "", reasoning: "xyz" });
    expect(s("</think>tail")).toEqual({ content: "tail", reasoning: "" });
  });

  it("holds a partial close tag back instead of emitting it as reasoning", () => {
    const s = createThinkSplitter();
    s("x<think>y");
    expect(s("</thin")).toEqual({ content: "", reasoning: "" });
    expect(s("k>z").content).toBe("z");
  });

  it("reopens in a single delta: all four sections route in one call", () => {
    const s = createThinkSplitter();
    const o = s("a<think>b</think>c<think>d</think>e");
    expect(o.content).toBe("ace");
    expect(o.reasoning).toBe("bd");
  });

  it("flush() releases held partial-tag text as literal content", () => {
    const s = createThinkSplitter();
    expect(s("x<thi")).toEqual({ content: "x", reasoning: "" });
    expect(s.flush()).toEqual({ content: "<thi", reasoning: "" });
    // and a second flush is empty — flush is terminal-safe
    expect(s.flush()).toEqual({ content: "", reasoning: "" });
  });

  it("flush() inside a think block releases nothing extra (no partial suffix held)", () => {
    const s = createThinkSplitter();
    expect(s("<think>still thinking")).toEqual({ content: "", reasoning: "still thinking" });
    expect(s.flush()).toEqual({ content: "", reasoning: "" });
  });

  it("flush() releases held partial close suffix as reasoning", () => {
    const s = createThinkSplitter();
    s("<think>abc");
    expect(s("</th")).toEqual({ content: "", reasoning: "" });
    expect(s.flush()).toEqual({ content: "", reasoning: "</th" });
  });

  it("a real delimiter wins over held literal text", () => {
    const s = createThinkSplitter();
    // "<" held back as possible open tag, then completes inside next chunk
    expect(s("<")).toEqual({ content: "", reasoning: "" });
    expect(s("think>in").reasoning).toBe("in");
  });

  it("every byte cut of a tag-heavy stream routes identically (mini matrix)", () => {
    const text = "pre<thin" + "k>mid</thi" + "nk>post<think>x</think>end";
    const ref = createThinkSplitter();
    const whole = ref(text);
    for (let cut = 1; cut < text.length; cut++) {
      const s = createThinkSplitter();
      const a = s(text.slice(0, cut));
      const b = s(text.slice(cut));
      const f = s.flush();
      expect(a.content + b.content + f.content, `cut=${cut}`).toBe(whole.content);
      expect(a.reasoning + b.reasoning + f.reasoning, `cut=${cut}`).toBe(whole.reasoning);
    }
    expect(whole.content).toBe("prepostend");
    expect(whole.reasoning).toBe("midx");
  });
});
