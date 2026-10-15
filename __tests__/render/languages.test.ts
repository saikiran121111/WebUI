import { describe, it, expect } from "vitest";
import { resolveLanguage, isHighlightable } from "../../lib/render/languages";

describe("language registry", () => {
  it("resolves common aliases to canonical keys", () => {
    expect(resolveLanguage("py").key).toBe("python");
    expect(resolveLanguage("js").key).toBe("javascript");
    expect(resolveLanguage("ts").key).toBe("typescript");
    expect(resolveLanguage("rs").key).toBe("rust");
    expect(resolveLanguage("yml").key).toBe("yaml");
    expect(resolveLanguage("sh").key).toBe("shellscript");
    expect(resolveLanguage("c++").key).toBe("cpp");
    expect(resolveLanguage("md").key).toBe("markdown");
    expect(resolveLanguage("tf").key).toBe("terraform");
    expect(resolveLanguage("dockerfile").key).toBe("docker");
  });

  it("shows human-correct labels for aliases", () => {
    expect(resolveLanguage("py").label).toBe("Python");
    expect(resolveLanguage("js").label).toBe("JavaScript");
    expect(resolveLanguage("yml").label).toBe("YAML");
    expect(resolveLanguage("c++").label).toBe("C++");
  });

  it("is case-insensitive", () => {
    expect(resolveLanguage("PY").key).toBe("python");
    expect(resolveLanguage("TypeScript").key).toBe("typescript");
  });

  it("strips meta info after : ? or space (info strings)", () => {
    expect(resolveLanguage("ts:titlefoo").key).toBe("typescript");
    expect(resolveLanguage("python title.py").key).toBe("python");
  });

  it("borrows the postgres grammar for sql dialects but labels them honestly", () => {
    const mysql = resolveLanguage("mysql");
    expect(mysql.key).toBe("postgresql");
    expect(mysql.label).toBe("MySQL");
    expect(resolveLanguage("sqlite").label).toBe("SQLite");
  });

  it("never mislabels unknown languages — falls back to Plain text", () => {
    const unknown = resolveLanguage("not-a-real-language");
    expect(unknown.key).toBeNull();
    expect(unknown.loader).toBeNull();
    expect(unknown.label).toBe("Plain text");
  });

  it("treats plain-text ids as plain", () => {
    for (const raw of ["text", "plaintext", "txt", "", "none"]) {
      expect(resolveLanguage(raw).key).toBeNull();
    }
  });

  it("resolves across language families (programming, web, shell, data, db, infra, graphics)", () => {
    const families = [
      "go", "java", "kotlin", "swift", "ruby", "php", "lua", "haskell", "elixir", "zig",
      "html", "css", "scss", "vue", "svelte", "astro",
      "powershell", "bat", "nix", "make",
      "json", "yaml", "toml", "xml", "graphql", "proto", "docker",
      "prisma", "cypher", "plsql",
      "hcl", "terraform", "asm", "wasm",
      "glsl", "wgsl", "hlsl", "gdscript",
      "diff", "http", "mermaid", "latex",
    ];
    for (const id of families) {
      expect(resolveLanguage(id).key, `expected ${id} to resolve`).not.toBeNull();
    }
  });

  it("isHighlightable agrees with resolution", () => {
    expect(isHighlightable("py")).toBe(true);
    expect(isHighlightable("text")).toBe(false);
    expect(isHighlightable("bogus-lang")).toBe(false);
  });
});
