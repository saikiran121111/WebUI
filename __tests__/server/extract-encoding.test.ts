/**
 * I10 — byte→text encoding contract (lib/files/encoding.ts).
 *
 * Before the fix, UTF-16 uploads decoded as UTF-8 and became walls of
 * replacement characters / NUL garbage with no warning. These cases lock the
 * detection order (UTF-32 BOM before UTF-16 BOM — FF FE is a UTF-32LE prefix)
 * and the rule that EVERY lossy path is labeled: a guess must never present
 * itself as a fact.
 */
import { describe, expect, it } from "vitest";
import { decodeText } from "../../lib/files/encoding";

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};
const utf16le = (s: string) => new Uint8Array(Buffer.from(s, "utf16le"));
const utf16be = (s: string) => { const b = Buffer.from(s, "utf16le"); b.swap16(); return new Uint8Array(b); };

describe("decodeText — I10 encoding detection", () => {
  it("clean UTF-8 stays lossless with the right label", () => {
    const d = decodeText(new TextEncoder().encode("héllo 世界"));
    expect(d.text).toBe("héllo 世界");
    expect(d.encoding).toBe("utf-8");
    expect(d.lossy).toBe(false);
  });

  it("a UTF-8 BOM is stripped and still labeled utf-8", () => {
    const d = decodeText(concat(new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode("x")));
    expect(d.text).toBe("x");
    expect(d.encoding).toBe("utf-8");
    expect(d.lossy).toBe(false);
  });

  it("UTF-16LE with BOM — the original replacement-char wall case", () => {
    const s = "Report — Q3 summary";
    const d = decodeText(concat(new Uint8Array([0xff, 0xfe]), utf16le(s)));
    expect(d.text).toBe(s);
    expect(d.encoding).toBe("utf-16le");
    expect(d.lossy).toBe(false);
  });

  it("UTF-16BE with BOM", () => {
    const s = "Report — Q3 summary";
    const d = decodeText(concat(new Uint8Array([0xfe, 0xff]), utf16be(s)));
    expect(d.text).toBe(s);
    expect(d.encoding).toBe("utf-16be");
    expect(d.lossy).toBe(false);
  });

  it("UTF-32 BOMs win over the UTF-16 prefix match (FF FE 00 00 is NOT UTF-16)", () => {
    const le = concat(
      new Uint8Array([0xff, 0xfe, 0x00, 0x00]),
      new Uint8Array([0x61, 0, 0, 0, 0x62, 0, 0, 0]),
    );
    expect(decodeText(le)).toMatchObject({ text: "ab", encoding: "utf-32le", lossy: false });
    const be = concat(
      new Uint8Array([0x00, 0x00, 0xfe, 0xff]),
      new Uint8Array([0, 0, 0, 0x61]),
    );
    expect(decodeText(be)).toMatchObject({ text: "a", encoding: "utf-32be", lossy: false });
  });

  it("BOM-less UTF-16 is caught by the alternating-NUL heuristic, both parities", () => {
    const s = "Plain ASCII body long enough to trip the NUL heuristic safely.";
    const le = decodeText(utf16le(s));
    expect(le.text).toBe(s);
    expect(le.encoding).toBe("utf-16le (no BOM)");
    expect(le.lossy).toBe(false);
    const be = decodeText(utf16be(s));
    expect(be.text).toBe(s);
    expect(be.encoding).toBe("utf-16be (no BOM)");
    expect(be.lossy).toBe(false);
  });

  it("invalid UTF-8 falls back to windows-1252 AND admits it is a guess", () => {
    // 0xE9 alone is invalid UTF-8; in windows-1252 it is é.
    const d = decodeText(new Uint8Array([0x54, 0xe9, 0x73, 0x74]));
    expect(d.text).toBe("Tést"); // T é s t — the bad byte becomes the cp1252 glyph
    expect(d.text).toContain("é");
    expect(d.lossy).toBe(true);
    expect(d.encoding).toBe("windows-1252 (best guess)");
  });

  it("0x80/0x92 map to the cp1252 glyphs (not control chars, not U+FFFD)", () => {
    const d = decodeText(new Uint8Array([0x80, 0x20, 0x92]));
    expect(d.text).toBe("€ ’"); // € '
    expect(d.lossy).toBe(true);
  });
});
