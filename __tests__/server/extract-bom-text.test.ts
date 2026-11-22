/**
 * F78-A — BOM'd text must never be sniffed as MP3.
 *
 * A UTF-16LE/UTF-32LE file begins FF FE, which is byte-identical to an MP3
 * frame-sync pair (MPEG-1 Layer I). Large BOM'd text (over the browser's
 * inline limit, so it takes the server extract path) was sniffed STRONG audio,
 * handed to ffmpeg and died with "Invalid data found". The law under test:
 *  - BOM detection is longest-first and SHARED between decodeText and the
 *    magic sniff (lib/files/encoding.ts detectBom);
 *  - the MP3 sniff validates the frame: header fields + the NEXT frame's sync
 *    at the computed stride, so genuine untagged MP3 stays audio and
 *    FF FE-prefixed text does not;
 *  - just below / at / above the 48000-byte threshold the file decodes with
 *    every marker, UTF-8/16/32 controls included, and a large file's
 *    beginning / middle / end content all survive into the index.
 * Offline: ATTACH_EMBED=off selects the documented lexical mode (F10 pattern),
 * so no model runs and the inference slot is untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeText, detectBom } from "@/lib/files/encoding";
import { mp3FrameSync, sniffMagic } from "@/lib/server/extract/sniff";
import { extractFileFromPath } from "@/lib/server/extract/index";
import { removeIndex, readIndex } from "@/lib/server/attachindex/store";

const TEXT_CHAR_LIMIT = 48000; // lib/files/extensions.ts — browser/server boundary
const ATT = "att_f78bom01";
const FIXTURE = path.join("docs", "overnight", "fixtures", "f78", "all-readers", "untagged.mp3");
const PREV_EMBED = process.env.ATTACH_EMBED;

let dir: string;

const BOM: Record<string, number[]> = {
  "utf-16le": [0xff, 0xfe],
  "utf-32le": [0xff, 0xfe, 0x00, 0x00],
  "utf-32be": [0x00, 0x00, 0xfe, 0xff],
  "utf-16be": [0xfe, 0xff],
  "utf-8": [0xef, 0xbb, 0xbf],
};

function encode16(text: string, le: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    if (le) { out[2 * i] = u & 0xff; out[2 * i + 1] = u >> 8; }
    else { out[2 * i] = u >> 8; out[2 * i + 1] = u & 0xff; }
  }
  return out;
}

function encode32(text: string, le: boolean): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    const b = [u & 0xff, (u >> 8) & 0xff, 0, 0];
    out.push(...(le ? b : b.slice().reverse()));
  }
  return new Uint8Array(out);
}

function withBom(enc: string, body: Uint8Array): Uint8Array {
  const bom = BOM[enc];
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

/** ASCII body with BEG/MID/END markers at 0%, 50% and 100% of the file. */
function markers(charCount: number): string {
  const beg = "F78BEG-1001 phase marker\n";
  const mid = "F78MID-2002 middle marker\n";
  const end = "F78END-3003 end marker\n";
  const fillerLen = Math.max(0, charCount - beg.length - mid.length - end.length);
  const half = Math.floor(fillerLen / 2);
  return beg + "x".repeat(half) + mid + "x".repeat(fillerLen - half) + end;
}

/** Exact byte-size file for one encoding: bom + body bytes padded to `bytes`. */
function bomFile(enc: string, bytes: number): Uint8Array {
  const bomLen = BOM[enc].length;
  const perChar = enc === "utf-8" ? 1 : enc.startsWith("utf-16") ? 2 : 4;
  const body = markers(Math.floor((bytes - bomLen) / perChar));
  let out: Uint8Array;
  if (enc === "utf-8") out = new TextEncoder().encode(body);
  else if (enc === "utf-16le") out = encode16(body, true);
  else if (enc === "utf-16be") out = encode16(body, false);
  else if (enc === "utf-32le") out = encode32(body, true);
  else out = encode32(body, false);
  return withBom(enc, out);
}

function scratch(name: string, bytes: Uint8Array): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

beforeAll(() => {
  process.env.ATTACH_EMBED = "off";
  dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f78bom_"));
  removeIndex(ATT);
});

afterAll(() => {
  removeIndex(ATT);
  fs.rmSync(dir, { recursive: true, force: true });
  if (PREV_EMBED === undefined) delete process.env.ATTACH_EMBED;
  else process.env.ATTACH_EMBED = PREV_EMBED;
});

describe("detectBom is longest-first and shared (encoding.ts ⇄ sniff.ts)", () => {
  it("UTF-32LE wins over its own UTF-16LE prefix", () => {
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00]))?.encoding).toBe("utf-32le");
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))?.encoding).toBe("utf-16le");
    expect(detectBom(new Uint8Array([0x00, 0x00, 0xfe, 0xff]))?.encoding).toBe("utf-32be");
    expect(detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))?.encoding).toBe("utf-8");
    expect(detectBom(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))?.encoding).toBe("utf-16be");
    expect(detectBom(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("decodeText labels every BOM and strips it", () => {
    for (const enc of Object.keys(BOM)) {
      const dec = decodeText(bomFile(enc, 512));
      expect(dec.encoding).toBe(enc);
      expect(dec.lossy).toBe(false);
      expect(dec.text.startsWith("F78BEG-1001")).toBe(true);
      expect(dec.text).toContain("F78END-3003");
    }
  });
});

describe("the MP3 sniff validates frames, not just the sync pair", () => {
  it("BOM'd text heads are never media", () => {
    // The audit repro: sample.csv began FF FE 69 00 ("i" in UTF-16LE) — a
    // LEGAL-looking MPEG-1 Layer I header. Frame validation must reject it…
    expect(mp3FrameSync(Buffer.from(bomFile("utf-16le", 512)))).toBe(false);
    // …and the shared BOM rescue must null the sniff before media rules run.
    for (const enc of Object.keys(BOM)) {
      expect(sniffMagic(Buffer.from(bomFile(enc, 512)))).toBeNull();
    }
  });

  it("a genuine untagged MP3 (ffmpeg libmp3lame 128k) stays strong audio", () => {
    const fd = fs.openSync(FIXTURE, "r");
    const head = Buffer.alloc(2048);
    fs.readSync(fd, head, 0, 2048, 0);
    fs.closeSync(fd);
    expect(head[0]).toBe(0xff);
    expect(mp3FrameSync(head)).toBe(true);
    expect(sniffMagic(head)).toEqual({ category: "audio", strong: true });
  });

  it("ID3-tagged MP3 keeps its existing strong audio sniff", () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffMagic(id3)).toEqual({ category: "audio", strong: true });
  });
});

describe("BOM'd text survives the real byte threshold (48000)", () => {
  it("below and at the limit: the browser inline decoder decodes clean", () => {
    for (const enc of Object.keys(BOM)) {
      for (const size of [TEXT_CHAR_LIMIT - 2, TEXT_CHAR_LIMIT]) {
        const dec = decodeText(bomFile(enc, size));
        expect(dec.encoding).toBe(enc);
        expect(dec.text).toContain("F78BEG-1001");
        expect(dec.text).toContain("F78END-3003");
      }
    }
  });

  it("above the limit: the server extract path classifies text, not audio", async () => {
    const cases: Array<[string, string]> = [
      ["utf-16le", "large.csv"], // the exact audit repro (sample.csv large)
      ["utf-32le", "large.md"],
      ["utf-16be", "large.ts"],
      ["utf-32be", "large.log"],
      ["utf-8", "large.txt"],
    ];
    for (const [enc, name] of cases) {
      const p = scratch(name, bomFile(enc, TEXT_CHAR_LIMIT + 2));
      const res = await extractFileFromPath(name, p);
      expect(res.category, `${name} → ${res.category}`).toBe("text");
      expect(res.text).toContain("F78BEG-1001");
    }
  });

  it("far above the limit: beginning, middle and end content all reach the index", async () => {
    // Over TEXT_READ_BYTES (2 MB) → the whole decoded file must be indexed.
    const p = scratch("huge.csv", bomFile("utf-16le", 2 * 1024 * 1024 + 64));
    const res = await extractFileFromPath("huge.csv", p, ATT);
    expect(res.indexed).toBe(true);
    const idx = readIndex(ATT);
    expect(idx).not.toBeNull();
    const full = fs.readFileSync(path.join(process.cwd(), ".data", "attach-index", ATT, "full.txt"), "utf8");
    expect(full).toContain("F78BEG-1001"); // beginning
    expect(full).toContain("F78MID-2002"); // middle
    expect(full).toContain("F78END-3003"); // end
    const all = idx!.chunks.map(c => c.text).join("\n");
    expect(all).toContain("F78MID-2002");
  });
});
