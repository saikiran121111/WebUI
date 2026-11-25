/**
 * F152 colour-answer grader (2026-11-24 audit, repair 3).
 *
 * The live spec previously graded "did the model perceive the crossing line's
 * colour" by scanning the WHOLE response for any word in a perceptual family
 * map (/violet|purple|magenta|indigo/i for violet, /magenta|purple|violet|pink/i
 * for magenta): an answer naming "pink" passed a violet question, any colour
 * word ANYWHERE in the prose counted, and a listing of every candidate colour
 * passed. That grades vocabulary presence, not the requested relationship.
 *
 * The law here, for the reviewer's four demands:
 *  - Score the fields. The prompt pins a two-line answer ("LABEL: …",
 *    "COLOUR: …"); the label fact and the colour fact are graded SEPARATELY
 *    and reported separately (three-fact law: label, colour, pixels).
 *  - The colour asserted to cross is the COLOUR field, canonicalised through
 *    the synonym families carried in the fixture key — and ONLY that field.
 *    A colour word in prose, in the LABEL field, in a disclaimer, nowhere:
 *    never passes. pink/magenta is NOT a violet answer (measured hues 326°
 *    vs 274°); the old adjacency map is gone.
 *  - Listing every candidate colour ("pink, purple, violet") and negation
 *    ("not pink") are refusals to assert — they fail, loudly.
 *  - The pixel chain is verified, not assumed: the key records the crossing
 *    colour measured on the chart raster, the production region crop's sha256
 *    and the crossing sample ON that crop; verifyCropPixels decodes the crop
 *    bytes and re-measures, so "the answer matched the pixels the model was
 *    given" is a checked fact (the channel-swap defect hid exactly here).
 *
 * Pure Node (node:zlib, no DOM): runs under vitest and inside the Playwright
 * spec. No fixture answers, no question-specific routes — the key is data.
 */
import { inflateSync } from "node:zlib";

export interface PngImage {
  width: number;
  height: number;
  channels: number; // 1 (gray), 3 (RGB) or 6 (RGBA) after channel strip
  /** Row-major bytes, 3 channels per pixel. */
  rows: Uint8Array[];
}

export interface F152Key {
  fixture: string;
  pdf_sha256: string;
  crop_sha256: string;
  crop_dims: [number, number];
  crop_sample_point: [number, number];
  cross_sample_rgb: [number, number, number];
  label_key: string;
  label_text: string;
  color_word: string;
  colour_synonyms: Record<string, string[]>;
  measured_rgb_page: [number, number, number];
  measured_rgb_chart: [number, number, number];
}

/** Decode an 8-bit non-interlaced PNG (colour type 0/2/6) to RGB rows.
 *  The crop production writes is exactly this format (encode_png), and the
 *  spec's browser path hands the same bytes to the model, so decoding here
 *  measures what the model receives. */
export function decodePng(bytes: Uint8Array): PngImage {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error("not a PNG");
  }
  let pos = 8;
  let width = 0, height = 0, depth = 0, ct = 0;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      height = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      depth = data[8]; ct = data[9];
      if (depth !== 8 || ct === 3 || ct === 4 || data[12] !== 0) {
        throw new Error(`unsupported PNG (depth ${depth} ct ${ct} interlace ${data[12]}): grader needs 8-bit non-interlaced ct 0/2/6`);
      }
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of idat) { joined.set(c, off); off += c.length; }
  const raw = inflateSync(joined);
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : 4;
  const bpp = channels; // 8-bit
  const stride = width * bpp;
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pred) & 0xff;
      } else if (filter !== 0) throw new Error(`bad PNG row filter ${filter} at row ${y}`);
      out[x] = v;
    }
    rows.push(channels === 4 ? rgbFromRgba(out) : channels === 1 ? grayToRgb(out) : out);
    prev = out;
  }
  return { width, height, channels: 3, rows };
}

function rgbFromRgba(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length * 3 / 4);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    out[j] = src[i]; out[j + 1] = src[i + 1]; out[j + 2] = src[i + 2];
  }
  return out;
}
function grayToRgb(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length * 3);
  for (let i = 0, j = 0; i < src.length; i++, j += 3) {
    out[j] = out[j + 1] = out[j + 2] = src[i];
  }
  return out;
}

export function samplePixel(img: PngImage, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new Error(`sample (${x},${y}) outside ${img.width}x${img.height}`);
  }
  const row = img.rows[y];
  return [row[x * 3], row[x * 3 + 1], row[x * 3 + 2]];
}

export function hueDeg(r: number, g: number, b: number): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return ((h * 60) + 360) % 360;
}

/** Verify the delivered crop carries the crossing colour the key measured:
 *  decode the crop bytes and re-sample at key.crop_sample_point. This is the
 *  "pixels the model was given" link of the chain; a channel swap (the
 *  2026-11-24 render defect that made violet arrive as pink) fails HERE,
 *  before any answer is graded. */
export function verifyCropPixels(cropPng: Uint8Array, key: F152Key, tol = 8): {
  ok: boolean; measured: [number, number, number]; expected: [number, number, number];
  hueMeasured: number; hueExpected: number;
} {
  const img = decodePng(cropPng);
  const [sx, sy] = key.crop_sample_point;
  const measured = samplePixel(img, sx, sy);
  const expected = key.cross_sample_rgb;
  const ok = Math.abs(measured[0] - expected[0]) <= tol
    && Math.abs(measured[1] - expected[1]) <= tol
    && Math.abs(measured[2] - expected[2]) <= tol;
  return { ok, measured, expected, hueMeasured: hueDeg(...measured), hueExpected: hueDeg(...expected) };
}

export interface AnswerFields {
  label: string | null;
  colour: string | null;
}

/** Pull the pinned LABEL:/COLOUR: (also COLOR:) fields out of the answer.
 *  Last occurrence wins is deliberately NOT allowed: duplicates make the
 *  answer ambiguous, so a second field line of the same name is recorded and
 *  the colour law rejects ambiguity. */
export function parseAnswerFields(text: string): { fields: AnswerFields; duplicateField: boolean } {
  const lines = text.split(/\r?\n/);
  const grab = (name: string) => lines
    .map(l => l.match(new RegExp(`^[ \\t>*-]*${name}[ \\t]*:[ \\t]*(.+)$`, "i")))
    .filter((m): m is RegExpMatchArray => m !== null);
  const labelHits = grab("labels?");
  const colourHits = grab("colou?rs?");
  const dup = labelHits.length > 1 || colourHits.length > 1;
  const pick = (hits: RegExpMatchArray[]) => (hits.length === 1 ? hits[0][1].trim() : null);
  return { fields: { label: pick(labelHits), colour: pick(colourHits) }, duplicateField: dup };
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Recognised colour vocabulary: the union of the key's synonym families.
 *  Data-driven from the key (no fixture answers in code): every family member
 *  maps to its canonical family name. */
export function colourVocabulary(synonyms: Record<string, string[]>): Map<string, string> {
  const vocab = new Map<string, string>();
  for (const [family, members] of Object.entries(synonyms)) {
    vocab.set(family, family);
    for (const m of members) vocab.set(normalize(m), family);
  }
  return vocab;
}

const NEGATION = /\b(not|no|never|isn'?t|aren'?t|cannot|can'?t)\b/i;

export interface ColourVerdict {
  labelOk: boolean;
  colourOk: boolean;
  colourCanonical: string | null;
  colourTokens: string[];
  reasons: string[];
}

/** Grade one answer against one key. labelOk: the LABEL field states the
 *  fixture's label text. colourOk: the COLOUR field asserts exactly ONE
 *  colour, un-negated, whose canonical family equals the family of the
 *  measured colour word key.color_word. Prose and label-field colour words
 *  never count. */
export function gradeAnswer(text: string, key: F152Key): ColourVerdict {
  const vocab = colourVocabulary(key.colour_synonyms);
  const { fields, duplicateField } = parseAnswerFields(text);
  const reasons: string[] = [];

  const labelOk = fields.label !== null && normalize(fields.label).includes(normalize(key.label_text));
  if (!labelOk) reasons.push(fields.label === null ? "no LABEL field" : `LABEL field "${fields.label}" does not state "${key.label_text}"`);

  const accepted = (key.colour_synonyms[key.color_word] ?? [key.color_word]).map(normalize);
  const acceptedFamily = vocab.get(normalize(key.color_word)) ?? key.color_word;

  const colourTokens: string[] = [];
  let colourCanonical: string | null = null;
  let colourOk = false;
  if (duplicateField) {
    reasons.push("duplicated LABEL/COLOUR field line: the asserted colour is ambiguous");
  } else if (fields.colour === null) {
    reasons.push("no COLOUR field");
  } else {
    const field = normalize(fields.colour);
    for (const word of field.split(/[^a-z]+/)) {
      const fam = vocab.get(word);
      if (fam && !colourTokens.includes(word)) colourTokens.push(word);
    }
    if (NEGATION.test(fields.colour)) {
      reasons.push(`COLOUR field "${fields.colour}" is negated — no colour is asserted`);
    } else if (colourTokens.length === 0) {
      reasons.push(`COLOUR field "${fields.colour}" names no recognised colour`);
    } else if (colourTokens.length > 1) {
      reasons.push(`COLOUR field lists ${colourTokens.length} candidate colours (${colourTokens.join(", ")}) — it does not assert which one crosses`);
    } else {
      const fam = vocab.get(colourTokens[0])!;
      colourCanonical = fam;
      if (accepted.includes(colourTokens[0]) && fam === acceptedFamily) colourOk = true;
      else reasons.push(`COLOUR "${colourTokens[0]}" canonicalises to ${fam}; the measured crossing colour "${key.color_word}" accepts only [${accepted.join(", ")}]`);
    }
  }
  return { labelOk, colourOk, colourCanonical, colourTokens, reasons };
}
