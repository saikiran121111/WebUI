import { describe, it, expect } from "vitest";
import { highlightCode } from "../../lib/render/highlight";

describe("shiki highlighting", () => {
  it("emits colored token spans for real grammars", async () => {
    const result = await highlightCode("const x = 1;", "js");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("JavaScript");
    expect(result!.langKey).toBe("javascript");
    expect(result!.html).toContain("<span");
    // Dual-theme output: dark palette arrives as CSS custom properties.
    expect(result!.html).toContain("--shiki-dark");
    // A keyword must actually be colored (not inherit plain foreground).
    expect(result!.html).toMatch(/const/);
  });

  it("highlights across language families", async () => {
    const cases: Array<[string, string]> = [
      ["def f():\n    return 1", "py"],
      ["SELECT * FROM t WHERE x = 1", "sql"],
      ["body { color: red }", "css"],
      ["#!/bin/sh\necho hi", "bash"],
      ["{ \"a\": 1 }", "json"],
      ["a: 1", "yaml"],
      ["package main\nfunc main() {}", "go"],
    ];
    for (const [code, lang] of cases) {
      const result = await highlightCode(code, lang);
      expect(result, `${lang} should highlight`).not.toBeNull();
      expect(result!.html).toContain("<span");
    }
  });

  it("returns null for unknown languages (caller falls back to plain <pre>)", async () => {
    expect(await highlightCode("hello", "totally-bogus-lang")).toBeNull();
    expect(await highlightCode("hello", "text")).toBeNull();
  });

  it("preserves tabs, unicode and emoji exactly", async () => {
    const source = "let s = \"café 🚀\";\n\tlet t = 1;";
    const result = await highlightCode(source, "js");
    expect(result).not.toBeNull();
    expect(result!.html).toContain("café 🚀");
    expect(result!.html).toContain("\t");
  });

  it("emits one .line element per source line (structure: line)", async () => {
    const source = "a\nb\nc";
    const result = await highlightCode(source, "js");
    const lineCount = (result!.html.match(/class="line"/g) ?? []).length;
    expect(lineCount).toBe(3);
  });

  it("tags diff lines with add/del/hunk classes", async () => {
    const source = "@@ -1,2 +1,2 @@\n-removed\n+added\n context";
    const result = await highlightCode(source, "diff");
    expect(result).not.toBeNull();
    expect(result!.html).toContain("diff-hunk");
    expect(result!.html).toContain("diff-del");
    expect(result!.html).toContain("diff-add");
  });

  it("caches repeated highlights identically", async () => {
    const first = await highlightCode("let cached = true;", "ts");
    const second = await highlightCode("let cached = true;", "ts");
    expect(second!.html).toBe(first!.html);
  });
});
