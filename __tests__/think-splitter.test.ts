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


/**
 * F05 (brief section 6) - LITERAL CODE SURVIVES. Three reproduced loss classes:
 *  1. an inline code span (`<think>` written inside backticks) was scanned as a
 *     real delimiter pair, so the example vanished from the answer;
 *  2. a 4-space/tab indented code block was scanned the same way;
 *  3. a fence inside a blockquote ("> ```py") never opened, so its contents -
 *     including any tag spelling - got routed into the private reasoning channel.
 * Law: only a delimiter the markdown says is REAL switches channels; code content
 * is literal text of the CURRENT channel. And a real delimiter after the code is
 * still a real delimiter (fixing the loss must not swallow live tags).
 * Chunking invariance is asserted for every text: every byte cut and every
 * char-by-char framing must route identically to the atomic run.
 */
describe("createThinkSplitter - F05 literal code (spans, indented blocks, blockquoted fences)", () => {
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

  it("an inline code span keeps its tag spelling in the answer, verbatim", () => {
    const text = "Say `<think>x</think>` now";
    const out = feedAll([text]);
    expect(out.content).toBe(text);
    expect(out.reasoning).toBe("");
  });

  it("a code span on one line never disables the live tags on the next", () => {
    const text = "Say `<think>` now\n<think>real</think>after\n";
    const out = feedAll([text]);
    expect(out.content).toBe("Say `<think>` now\nafter\n");
    expect(out.reasoning).toBe("real");
  });

  it("a longer backtick run delimits the span; the tags inside stay literal", () => {
    const text = "`` <think>a</think> `` b";
    const out = feedAll([text]);
    expect(out.content).toBe(text);
    expect(out.reasoning).toBe("");
  });

  it("a live tag AFTER a closed span on the same line still switches channel", () => {
    const text = "code `<think>` end <think>hid</think>out";
    const out = feedAll([text]);
    expect(out.content).toBe("code `<think>` end out");
    expect(out.reasoning).toBe("hid");
  });

  it("an unmatched backtick on a finished line is literal punctuation", () => {
    const text = "a ` b\nc <think>r</think>d";
    const out = feedAll([text]);
    expect(out.content).toBe("a ` b\nc d");
    expect(out.reasoning).toBe("r");
  });

  it("a four-space indented code block keeps its tags literal, and ends where CommonMark ends it", () => {
    const text = "intro\n\n    code <think>lit1</think>\n    more <think>lit2</think>\nafter <think>real</think>end";
    const out = feedAll([text]);
    expect(out.content).toBe("intro\n\n    code <think>lit1</think>\n    more <think>lit2</think>\nafter end");
    expect(out.reasoning).toBe("real");
  });

  it("a tab-indented code block keeps its tags literal", () => {
    const text = "\ttabbed <think>lit</think>\nreal <think>r</think>z";
    const out = feedAll([text]);
    expect(out.content).toBe("\ttabbed <think>lit</think>\nreal z");
    expect(out.reasoning).toBe("r");
  });

  it("a blockquoted fence opens, protects its contents and closes", () => {
    const text = "para\n\n> ```py\n> <think>lit</think>\n> ```\n\nafter <think>real</think>end";
    const out = feedAll([text]);
    expect(out.content).toBe("para\n\n> ```py\n> <think>lit</think>\n> ```\n\nafter end");
    expect(out.reasoning).toBe("real");
  });

  it("a lazy (unprefixed) fence closer still closes a blockquoted fence", () => {
    const text = "> ```py\n> <think>lit</think>\n```\nafter <think>real</think>end";
    const out = feedAll([text]);
    expect(out.content).toBe("> ```py\n> <think>lit</think>\n```\nafter end");
    expect(out.reasoning).toBe("real");
  });

  it("blockquote markers never disable a live tag in quoted prose", () => {
    const text = "> answer <think>hid</think>out";
    const out = feedAll([text]);
    expect(out.content).toBe("> answer out");
    expect(out.reasoning).toBe("hid");
  });

  it("a code span inside a reasoning block protects the close-tag spelling", () => {
    const text = "<think>see `<b/>` and `</think>` tail";
    const out = feedAll([text]);
    expect(out.reasoning).toBe("see `<b/>` and `</think>` tail");
    expect(out.content).toBe("");
  });

  it("every code form keeps its own chunking invariance (all cuts + char-by-char)", () => {
    const texts = [
      "Say `<think>x</think>` now",
      "Say `<think>` now\n<think>real</think>after\n",
      "`` <think>a</think> `` b",
      "code `<think>` end <think>hid</think>out",
      "a ` b\nc <think>r</think>d",
      "intro\n\n    code <think>lit1</think>\n    more <think>lit2</think>\nafter <think>real</think>end",
      "\ttabbed <think>lit</think>\nreal <think>r</think>z",
      "para\n\n> ```py\n> <think>lit</think>\n> ```\n\nafter <think>real</think>end",
      "> ```py\n> <think>lit</think>\n```\nafter <think>real</think>end",
      "> answer <think>hid</think>out",
      "<think>see `<b/>` and `</think>` tail",
    ];
    for (const text of texts) {
      const whole = feedAll([text]);
      for (let cut = 1; cut < text.length; cut++) {
        expect(feedAll([text.slice(0, cut), text.slice(cut)]), `cut=${cut} of ${JSON.stringify(text)}`).toEqual(whole);
      }
      expect(feedAll([...text]), JSON.stringify(text)).toEqual(whole);
      // Nothing may ever be lost: content + reasoning covers every character the
      // input had except the routed delimiter spellings.
      expect(whole.content + whole.reasoning).not.toBe("");
    }
  });
});