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

/**
 * F17 (2026-11-15) — fence-awareness: an inline tag inside a fenced code
 * block (``` or ~~~) is LITERAL text of the current channel. Every case
 * below mirrors its twin in
 * rust-backend/crates/ruke-server/src/chat/scrubber.rs (cross-engine law).
 */
describe("createThinkSplitter — F17 fence-awareness", () => {
  const feedAll = (pieces: string[]) => {
    const s = createThinkSplitter();
    let content = "";
    let reasoning = "";
    for (const p of pieces) {
      const o = s(p);
      content += o.content;
      reasoning += o.reasoning;
    }
    const f = s.flush();
    return { content: content + f.content, reasoning: reasoning + f.reasoning };
  };

  const FENCED = "pre\n```html\n<think>literal</think>\n```\npost";

  it("a tag inside a fence stays content and never routes to reasoning", () => {
    const out = feedAll([FENCED]);
    expect(out.content).toBe(FENCED);
    expect(out.reasoning).toBe("");
  });

  it("every byte cut of a fenced text routes identically", () => {
    const whole = feedAll([FENCED]);
    for (let cut = 1; cut < FENCED.length; cut++) {
      const out = feedAll([FENCED.slice(0, cut), FENCED.slice(cut)]);
      expect(out, `cut=${cut}`).toEqual(whole);
    }
    const charPieces = [...FENCED].map((c) => c);
    expect(feedAll(charPieces)).toEqual(whole);
  });

  it("tilde fence with info string holds tags literal", () => {
    const text = "~~~js [S9]\nx <think>y\n~~~\nz";
    const out = feedAll([text]);
    expect(out.content).toBe(text);
    expect(out.reasoning).toBe("");
  });

  it("a fence inside a reasoning block protects the close tag", () => {
    const text = "<think>\n```\n</think> is literal\n```\n</think>tail";
    const out = feedAll([text]);
    // The OPEN delimiter itself is consumed (routed markers are never
    // emitted); fenced text — including the `</think>` spelling — stays
    // verbatim reasoning until the fence closes, then the real close tag.
    expect(out.reasoning).toBe("\n```\n</think> is literal\n```\n");
    expect(out.content).toBe("tail");
  });

  it("a shorter close run does not close the fence", () => {
    const text = "```\n<think>t\n``\nu";
    const out = feedAll([text]);
    expect(out.content).toBe(text);
    expect(out.reasoning).toBe("");
  });

  it("a longer close run closes the fence", () => {
    const out = feedAll(["````\nx\n`````\n<think>t</think>y"]);
    expect(out.content).toBe("````\nx\n`````\ny");
    expect(out.reasoning).toBe("t");
  });

  it("a backtick fence whose info contains a backtick is not a fence", () => {
    const out = feedAll(["```a`b\n<think>t\n```"]);
    expect(out.content).toBe("```a`b\n");
    expect(out.reasoning).toBe("t\n```");
  });

  it("an indent of up to three spaces still opens and closes a fence", () => {
    const text = "   ```\n<think>t</think>\n   ```\npost";
    const out = feedAll([text]);
    expect(out.content).toBe(text);
    expect(out.reasoning).toBe("");
  });

  it("four-space indent is never a fence", () => {
    const out = feedAll(["    ```\n<think>t</think>\n    ```\nx"]);
    expect(out.content).toBe("    ```\n\n    ```\nx");
    expect(out.reasoning).toBe("t");
  });

  it("tags inside an unclosed fence are never swallowed (flush keeps all)", () => {
    const out = feedAll(["```x\n<thi"]);
    expect(out.content).toBe("```x\n<thi");
    expect(out.reasoning).toBe("");
  });

  it("an incomplete fence opener flushes as literal", () => {
    const s = createThinkSplitter();
    expect(s("a\n``").content).toBe("a\n");
    expect(s.flush()).toEqual({ content: "``", reasoning: "" });
  });

  it("trailing spaces/tabs after the close run still close the fence", () => {
    const out = feedAll(["```\nx\n``` \t\n<think>t</think>y"]);
    expect(out.content).toBe("```\nx\n``` \t\ny");
    expect(out.reasoning).toBe("t");
  });

  it("a blank line does not close a fence", () => {
    const text = "```\nx\n\n<think>t</think>\n```\ny";
    const out = feedAll([text]);
    expect(out.content).toBe(text);
    expect(out.reasoning).toBe("");
  });
});
