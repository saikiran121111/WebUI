/**
 * I10 (part 2) — RTF escape recovery and binary UTF-16 string scanning.
 *
 * The audit found two silent content destroyers: rtfToText replaced every
 * `\uN` escape with a literal space (all non-ASCII RTF text vanished) and ate
 * the literal `\{ \} \\` escapes; extractStrings' UTF-16 pass required a zero
 * HIGH byte, so legacy Office files in Telugu/CJK/Hindi scanned back empty.
 * These cases lock the fixed contracts.
 */
import { describe, expect, it } from "vitest";
import { rtfToText } from "../../lib/server/extract/rtf";
import { extractStrings } from "../../lib/server/extract/strings";

describe("rtfToText — I10 escape recovery", () => {
  it("\\uN becomes the real character (positive and negative two's-complement)", () => {
    expect(rtfToText("{\\u19990\\u3093}")).toBe("世క"); // CJK + Telugu
    expect(rtfToText(String.raw`{\u-10916?}`)).toBe("\u{D55C}"); // 54620 as negative
  });

  it("\\'hh hex escapes resolve instead of being control-word casualties", () => {
    expect(rtfToText(String.raw`{\rtf1 \'e9 caf\'e9}`)).toBe("é café");
  });

  it("literal \\{ \\} \\\\ survive the control-word stripper intact", () => {
    expect(rtfToText(String.raw`\{a\} b\\ c`)).toBe("{a} b\\ c");
  });
});

describe("extractStrings — I10 UTF-16 recovery", () => {
  it("non-ASCII BMP UTF-16 runs are recovered (Telugu legacy-doc case)", () => {
    const text = "TELEGU-తెలుగు-STRINGS-9K";
    const buf = Buffer.concat([
      Buffer.from([0, 0]),                 // unprintable unit terminates before
      Buffer.from(text, "utf16le"),
      Buffer.from([0xff, 0xff]),           // 0xFFFF terminates after
    ]);
    expect(extractStrings(buf)).toContain(text);
  });

  it("surrogate pairs break a run — never emit broken UTF-16 halves", () => {
    const out = extractStrings(Buffer.from("surrogate-probe-😀-tailpiece-here", "utf16le"));
    expect(out).toContain("surrogate-probe-");
    expect(out).toContain("-tailpiece-here");
    expect(out).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("plain ASCII runs still work through the single-byte pass", () => {
    expect(extractStrings(Buffer.from("a long plain ascii run inside"))).toContain("a long plain ascii run inside");
  });
});
