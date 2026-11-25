import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  decodePng,
  gradeAnswer,
  hueDeg,
  parseAnswerFields,
  samplePixel,
  verifyCropPixels,
  type F152Key,
} from "../tests/lib/f152-colour-grader";

/**
 * F152 audit (2026-11-24), repair 3: the live spec graded the colour question
 * by regex-scanning the whole response for any word in a perceptual family
 * (/violet|purple|magenta|indigo/), so "pink" passed violet, prose mentions
 * passed, and listings of every candidate colour passed. These controls pin
 * the replacement law: grade the COLOUR FIELD, canonicalise through the key's
 * synonym families (pink is NOT violet), reject negation and listing, keep the
 * label and colour facts separate, and verify the DELIVERED PIXELS separately
 * from the answer (the channel-swap defect proved the two must not be
 * conflated: the model answered "pink" honestly about pink pixels).
 */

// ---------------------------------------------------------------- PNG fixtures

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = len >>> 24; out[1] = (len >>> 16) & 0xff; out[2] = (len >>> 8) & 0xff; out[3] = len & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = crc >>> 24; out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff; out[11 + data.length] = crc & 0xff;
  return out;
}
/** Encode rows (Uint8Array per row, one byte per channel) with per-row PNG
 *  filters applied, so the grader's unfilter path is exercised for real. */
function pngEncode(width: number, ct: number, rows: Uint8Array[], filters: number[]): Uint8Array {
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : 4;
  const height = rows.length;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  let prev: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = filters[y];
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y][x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + x] = (rows[y][x] - pred) & 0xff;
    }
    prev = rows[y];
  }
  const ihdr = new Uint8Array(13);
  ihdr[0] = width >>> 24; ihdr[1] = (width >>> 16) & 0xff; ihdr[2] = (width >>> 8) & 0xff; ihdr[3] = width & 0xff;
  ihdr[4] = height >>> 24; ihdr[5] = (height >>> 16) & 0xff; ihdr[6] = (height >>> 8) & 0xff; ihdr[7] = height & 0xff;
  ihdr[8] = 8; ihdr[9] = ct; // depth 8, colour type
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ----------------------------------------------------------------- key fixture

const VIOLET_KEY: F152Key = {
  fixture: "f152-survey.pdf",
  pdf_sha256: "0".repeat(64),
  crop_sha256: "1".repeat(64),
  crop_dims: [1060, 481],
  crop_sample_point: [1000, 111],
  cross_sample_rgb: [150, 61, 219],
  label_key: "kappa",
  label_text: "KAPPA 9",
  color_word: "violet",
  colour_synonyms: {
    red: ["red", "crimson", "scarlet", "maroon"],
    orange: ["orange", "amber", "tangerine", "peach"],
    yellow: ["yellow", "gold"],
    green: ["green", "lime", "emerald", "olive"],
    cyan: ["cyan", "turquoise", "teal", "aqua"],
    blue: ["blue", "navy", "azure", "cornflower"],
    violet: ["violet", "purple", "indigo", "purplish", "lavender"],
    magenta: ["magenta", "fuchsia", "pink", "rose"],
    grey: ["grey", "gray", "silver"],
  },
  measured_rgb_page: [150, 61, 219],
  measured_rgb_chart: [150, 61, 219],
};

// ------------------------------------------------------------------- decoder

describe("PNG decoder (the delivered-pixel leg of the chain)", () => {
  it("round-trips 8-bit RGB through every row filter (0-4)", () => {
    const png = pngEncode(2, 2, [
      new Uint8Array([150, 61, 219, 10, 200, 30]),
      new Uint8Array([255, 0, 0, 3, 3, 3]),
    ], [0, 4]);
    const img = decodePng(png);
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(samplePixel(img, 0, 0)).toEqual([150, 61, 219]);
    expect(samplePixel(img, 1, 0)).toEqual([10, 200, 30]);
    expect(samplePixel(img, 0, 1)).toEqual([255, 0, 0]);
    expect(samplePixel(img, 1, 1)).toEqual([3, 3, 3]);
  });

  it("round-trips rows filtered 1, 2 and 3", () => {
    const png = pngEncode(2, 2, [
      new Uint8Array([150, 61, 219, 10, 200, 30]),
      new Uint8Array([255, 0, 0, 3, 3, 3]),
    ], [0, 1]);
    expect(samplePixel(decodePng(png), 1, 0)).toEqual([10, 200, 30]);
    const png3 = pngEncode(1, 2, [new Uint8Array([9, 250, 7]), new Uint8Array([130, 3, 90])], [2, 3]);
    expect(samplePixel(decodePng(png3), 0, 0)).toEqual([9, 250, 7]);
    expect(samplePixel(decodePng(png3), 0, 1)).toEqual([130, 3, 90]);
  });

  it("decodes RGBA (ct 6) and gray (ct 0) crops", () => {
    const rgba = new Uint8Array([150, 61, 219, 255, 5, 6, 7, 128]);
    const img = decodePng(pngEncode(2, 6, [rgba], [0]));
    expect(samplePixel(img, 0, 0)).toEqual([150, 61, 219]);
    expect(samplePixel(img, 1, 0)).toEqual([5, 6, 7]);
    const gray = decodePng(pngEncode(2, 0, [new Uint8Array([17, 200])], [0]));
    expect(samplePixel(gray, 0, 0)).toEqual([17, 17, 17]);
    expect(samplePixel(gray, 1, 0)).toEqual([200, 200, 200]);
  });

  it("verifyCropPixels PASSES the true-RGB crop and FAILS the channel-swapped delivery", () => {
    const [sx, sy] = VIOLET_KEY.crop_sample_point;
    const mk = (px: [number, number, number], w: number, h: number) => {
      const row = new Uint8Array(w * 3);
      for (let x = 0; x < w; x++) { row[x * 3] = px[0]; row[x * 3 + 1] = px[1]; row[x * 3 + 2] = px[2]; }
      return pngEncode(w, 2, Array.from({ length: h }, () => row), new Array(h).fill(0));
    };
    // The delivered crop, true RGB (post-fix production): sample matches.
    const good = verifyCropPixels(mk([150, 61, 219], sx + 1, sy + 1), VIOLET_KEY);
    expect(good.ok).toBe(true);
    expect(good.hueMeasured).toBeCloseTo(274, 0);
    // The 2026-11-24 defect: pdfium BGR passed through, violet arrived at
    // hue 326 = pink. The chain check must fail BEFORE any answer is graded.
    const swapped = verifyCropPixels(mk([219, 61, 150], sx + 1, sy + 1), VIOLET_KEY);
    expect(swapped.ok).toBe(false);
    expect(swapped.hueMeasured).toBeCloseTo(326, 0);
    expect(swapped.hueExpected).toBeCloseTo(274, 0);
  });

  it("hueDeg separates violet (274) from pink (326) — the old adjacency map's blind spot", () => {
    expect(hueDeg(150, 61, 219)).toBeCloseTo(274, 0);
    expect(hueDeg(219, 61, 150)).toBeCloseTo(326, 0);
  });
});

// ------------------------------------------------------------------- grader

describe("gradeAnswer: the colour ASSERTED TO CROSS, not any colour word", () => {
  const ok = (text: string) => {
    const v = gradeAnswer(text, VIOLET_KEY);
    expect(v.labelOk, text).toBe(true);
    expect(v.colourOk, text).toBe(true);
  };
  const colourFail = (text: string) => {
    const v = gradeAnswer(text, VIOLET_KEY);
    expect(v.colourOk, text).toBe(false);
    return v;
  };

  it("the honest answer passes; in-family synonyms (purple, indigo, purplish) pass", () => {
    ok("LABEL: KAPPA 9\nCOLOUR: violet");
    ok("LABEL: KAPPA 9\nCOLOR: purple");
    ok("Some preamble prose.\nLABEL: KAPPA 9\nCOLOUR: indigo\nTrailing note.");
    expect(gradeAnswer("LABEL: KAPPA 9\nCOLOUR: purplish", VIOLET_KEY).colourCanonical).toBe("violet");
  });

  it("KAPPA 9 — pink KEEPS FAILING (measured 274°, pink is 326°: not a violet synonym)", () => {
    const v = colourFail("LABEL: KAPPA 9\nCOLOUR: pink");
    expect(v.colourCanonical).toBe("magenta");
    expect(v.reasons.join(" ")).toContain("violet");
    colourFail("LABEL: KAPPA 9\nCOLOUR: magenta");
    colourFail("LABEL: KAPPA 9\nCOLOUR: fuchsia");
  });

  it("swapped relationships fail: navy-for-violet, and a label field naming the right colour", () => {
    const v = colourFail("LABEL: KAPPA 9\nCOLOUR: navy"); // navy → blue family
    expect(v.colourCanonical).toBe("blue");
    // The colour word sits in the LABEL field: the colour fact is still pink.
    const w = gradeAnswer("LABEL: KAPPA 9 violet\nCOLOUR: pink", VIOLET_KEY);
    expect(w.labelOk).toBe(true);
    expect(w.colourOk).toBe(false);
  });

  it("negation and listing are refusals to assert, not correct answers", () => {
    colourFail("LABEL: KAPPA 9\nCOLOUR: not pink");
    colourFail("LABEL: KAPPA 9\nCOLOUR: it is not violet, it is pink");
    const listing = colourFail("LABEL: KAPPA 9\nCOLOUR: pink, purple, violet");
    expect(listing.reasons.join(" ")).toContain("lists");
    colourFail("LABEL: KAPPA 9\nCOLOUR: violet or magenta");
  });

  it("the right colour mentioned in prose (or nowhere in the field) must not pass", () => {
    // The old whole-response regex passed all of these for violet.
    colourFail("The line is clearly violet and crosses the threshold.\nLABEL: KAPPA 9");
    colourFail("The chart shows a violet legend while the crossing line is pink.\nLABEL: KAPPA 9\nCOLOUR: pink");
    const v = colourFail("LABEL: KAPPA 9\nCOLOUR: it looks like a warm colour");
    expect(v.reasons.join(" ")).toContain("no recognised colour");
  });

  it("label and colour are separate facts: label-ok + colour-fail reports exactly one failed fact", () => {
    const v = gradeAnswer("LABEL: KAPPA 9\nCOLOUR: pink", VIOLET_KEY);
    expect(v.labelOk).toBe(true);
    expect(v.colourOk).toBe(false);
    const w = gradeAnswer("LABEL: THRESHOLD\nCOLOUR: violet", VIOLET_KEY);
    expect(w.labelOk).toBe(false);
    expect(w.colourOk).toBe(true);
  });

  it("missing/duplicated/ambiguous fields fail with a stated reason", () => {
    expect(colourFail("LABEL: KAPPA 9").reasons.join(" ")).toContain("no COLOUR field");
    const dup = colourFail("LABEL: KAPPA 9\nCOLOUR: pink\nCOLOUR: violet");
    expect(dup.reasons.join(" ")).toContain("ambiguous");
    expect(parseAnswerFields("LABEL: KAPPA 9\nCOLOUR: violet").fields).toEqual({ label: "KAPPA 9", colour: "violet" });
  });
});
