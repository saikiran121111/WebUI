import { describe, it, expect } from "vitest";
import { languageKeys } from "../../lib/render/languages";
import { highlightCode } from "../../lib/render/highlight";

/**
 * Validation pass over the whole language registry: every canonical key must
 * load its grammar and produce line spans without throwing, and the popular
 * languages must actually emit colored tokens (the reported bug was HTML/CSS
 * rendering with no colors at all).
 */

const SNIPPETS: Record<string, string> = {
  python: "def greet(name):\n    return f\"hi {name}\"  # comment",
  javascript: "const add = (a, b) => a + b; // sum",
  typescript: "const add = (a: number, b: number): number => a + b;",
  html: '<!DOCTYPE html>\n<html lang="en">\n  <head><meta charset="utf-8"></head>\n</html>',
  css: "body { color: red; margin: 0 auto; }",
  json: '{ "name": "webui", "version": 1 }',
  yaml: "server:\n  port: 8080\n  debug: true",
  sql: "SELECT name, COUNT(*) FROM users WHERE active = 1 GROUP BY name;",
  shellscript: "#!/bin/sh\necho 'hello' | grep hello",
  go: "package main\n\nfunc main() {\n\tx := 42\n}",
  rust: "fn main() {\n\tlet x: i32 = 42;\n}",
  java: "public class Main { public static void main(String[] a) {} }",
  c: "int main(void) { return 0; }",
  cpp: "#include <iostream>\nint main() { return 0; }",
  csharp: "class P { static void Main() { System.Console.WriteLine(); } }",
  php: "<?php echo \"hi\"; ?>",
  ruby: "def greet\n  puts 'hi'\nend",
  markdown: "# Title\n\n- point one\n- point two",
  diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
};
const GENERIC_SNIPPET = "x = 1\n# comment\nvalue = 2.5";

describe("every registry language highlights", () => {
  const keys = languageKeys();

  it("registry is broad", () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  for (const key of keys) {
    it(`${key} produces line spans without throwing`, async () => {
      const result = await highlightCode(SNIPPETS[key] ?? GENERIC_SNIPPET, key);
      expect(result, `${key} should resolve to a grammar`).not.toBeNull();
      // Line spans may carry extra classes (diff tints add diff-add/diff-del),
      // so match the class attribute prefix rather than the exact string.
      expect(result!.html).toMatch(/class="line(\s|")/);
    }, 15_000);
  }

  it("popular languages emit colored tokens", async () => {
    for (const key of ["python", "javascript", "html", "css", "sql", "json", "yaml", "go", "rust", "java", "typescript"]) {
      const result = await highlightCode(SNIPPETS[key], key);
      expect(result, `${key} should highlight`).not.toBeNull();
      expect(result!.html, `${key} should emit colored spans`).toMatch(/--shiki-dark:/);
    }
  });
});
