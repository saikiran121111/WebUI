/**
 * F11/P9 gate support: the document render engines' temp path.
 *
 * Two distinct defects are pinned here.
 *
 * (1) BUILD SAFETY. `next build` traces server dependencies with @vercel/nft.
 * A path expression it can evaluate statically -- e.g.
 *   path.join(os.tmpdir(), `temp_chart_${id}.png`)
 * becomes the GLOB PATTERN "<OS temp>/temp_chart_*.png", and the tracer WALKS
 * the OS temp directory. On Windows that walk climbs into the user profile
 * and dies on the protected "Application Data" junction:
 *   Failed to compile. Error: EPERM: operation not permitted,
 *   scandir 'C:\Users\<user>\Application Data'
 * which is exactly how this repo's production build broke. The fix is a
 * shared helper whose parts are runtime values, so the tracer cannot fold
 * the path. This test greps the engines' SOURCES because the failure only
 * appears in a full `next build`, which no unit test can cheaply re-run.
 *
 * (2) DOC_TEMP_DIR was honored by pdfEngine only, so the docx engine wrote
 * its chart PNG into the shared OS temp dir and the docx test's leftover
 * scan could never see it (an isolation knob with no reader).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { docTempDir, docTempPath } from "../../lib/documents/tempFiles";

const ENGINE_FILES = ["pdfEngine.ts", "docxEngine.ts"];

function readEngine(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "lib", "documents", name), "utf8");
}

/** Drop comment lines: they legitimately name the pattern the code must avoid. */
function engineCode(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("doc temp path helper", () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, "DOC_TEMP_DIR");
  const previous = process.env.DOC_TEMP_DIR;

  beforeEach(() => {
    delete process.env.DOC_TEMP_DIR;
  });
  afterEach(() => {
    if (had) process.env.DOC_TEMP_DIR = previous;
    else delete process.env.DOC_TEMP_DIR;
  });

  it("falls back to the OS temp dir when nothing is configured", () => {
    expect(docTempDir()).toBe(os.tmpdir());
  });

  it("treats a blank setting as unset instead of a usable root", () => {
    process.env.DOC_TEMP_DIR = "   ";
    expect(docTempDir()).toBe(os.tmpdir());
  });

  it("honors an explicit root for BOTH engines", () => {
    const root = path.join(os.tmpdir(), "ruke-tempfiles-test-root");
    process.env.DOC_TEMP_DIR = root;
    for (const ext of [".html", ".png"]) {
      const p = docTempPath("abc-123", ext);
      expect(path.dirname(p)).toBe(root);
      expect(path.basename(p)).toBe(`temp_chart_abc-123${ext}`);
    }
  });

  it("composes names from runtime parts so no bundler can fold them", () => {
    // The helper itself must not contain a join whose every part is static.
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib", "documents", "tempFiles.ts"),
      "utf8",
    );
    expect(src).toMatch(/FILE_PREFIX \+ id \+ ext/);
    expect(src).toMatch(/docTempDir\(\)/);
  });
});

describe("render engines stay opaque to the build tracer", () => {
  it("no engine joins os.tmpdir() inline (the EPERM build failure class)", () => {
    for (const name of ENGINE_FILES) {
      const src = readEngine(name);
      // path.join(<anything>os.tmpdir()<anything>, `template_${...}`) folded
      // into one expression: forbidden. Comments about it are allowed.
      expect(engineCode(src), `${name} must not build a temp path statically`).not.toMatch(
        /path\.join\([^)]*os\.tmpdir\(\)/,
      );
    }
  });

  it("both engines actually call the shared helper", () => {
    for (const name of ENGINE_FILES) {
      const src = readEngine(name);
      expect(src, `${name} must use docTempPath`).toMatch(/docTempPath\(/);
    }
  });

  it("the docx engine no longer ignores DOC_TEMP_DIR", () => {
    const src = readEngine("docxEngine.ts");
    // Code, not the explanatory comment that names the removed pattern.
    expect(engineCode(src)).not.toMatch(/os\.tmpdir\(\)/);
  });
});
