/**
 * Shared byte→text decoding (client and server safe: TextDecoder only).
 *
 * I10: UTF-16 uploads used to be decoded as UTF-8, producing a wall of
 * replacement characters. This detects BOMs explicitly and falls back to a
 * single-byte legacy encoding when strict UTF-8 fails — and LABELS the result,
 * so lossy paths can say so downstream instead of pretending the bytes were
 * clean text.
 */

export interface DecodedText {
  text: string;
  /** Label of the encoding actually used ("utf-8", "utf-16le", "windows-1252"…). */
  encoding: string;
  /** True when the decoding can't be trusted to be faithful (legacy fallback). */
  lossy: boolean;
}

const FATAL = new TextDecoder("utf-8", { fatal: true });
const CP1252 = new TextDecoder("windows-1252");

/**
 * Node's TextDecoder has no UTF-32 labels (it raises RangeError for them), so
 * UTF-32 code points are decoded by hand. Out-of-range or surrogate code points
 * become the replacement glyph instead of crashing the read.
 */
function decodeUtf32(buf: Uint8Array, le: boolean, afterBom: number): string {
  let s = "";
  for (let i = afterBom; i + 3 < buf.length; i += 4) {
    const cp = le
      ? (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0
      : ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
    s += cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "�";
  }
  return s;
}

export interface Bom {
  /** Encoding label the BOM declares (same labels decodeText returns). */
  encoding: string;
  /** Byte length of the BOM itself. */
  length: number;
}

/**
 * Shared BOM table — the single authority for encoding.ts AND the server's
 * magic sniffer (F78-A: a UTF-16LE/UTF-32LE text file begins FF FE, which is
 * also a valid MP3 frame-sync byte pair, so the sniff classified it as audio).
 * Order is LONGEST-FIRST: FF FE 00 00 (UTF-32LE) must be tested before its
 * own FF FE prefix (UTF-16LE).
 */
const BOMS: { bytes: number[]; encoding: string }[] = [
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: "utf-32le" },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: "utf-32be" },
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
];

export function detectBom(buf: Uint8Array): Bom | null {
  for (const bom of BOMS) {
    if (buf.length >= bom.bytes.length && bom.bytes.every((b, i) => buf[i] === b)) {
      return { encoding: bom.encoding, length: bom.bytes.length };
    }
  }
  return null;
}

function utf16HasAlternatingNul(buf: Uint8Array, parity: number): boolean {
  let nul = 0, nonzero = 0;
  const n = Math.min(buf.length - parity, 4096);
  for (let i = parity; i < n; i += 2) {
    if (buf[i] === 0) nul++; else nonzero++;
  }
  // Plain UTF-16 ASCII puts a NUL in EVERY second byte of the dominant parity,
  // so nul == nonzero there — `>` would never fire on real UTF-16 text.
  // Random binary hits nul >= nonzero essentially never.
  return nul >= 8 && nul >= nonzero;
}

export function decodeText(buf: Uint8Array): DecodedText {
  // BOM wins — unambiguous, longest-first (see detectBom, shared with the
  // server sniff so detection and decoding are one law, F78-A).
  const bom = detectBom(buf);
  if (bom) {
    if (bom.encoding === "utf-32le") return { text: decodeUtf32(buf, true, bom.length), encoding: "utf-32le", lossy: false };
    if (bom.encoding === "utf-32be") return { text: decodeUtf32(buf, false, bom.length), encoding: "utf-32be", lossy: false };
    // TextDecoder strips a matching BOM for utf-8 / utf-16le / utf-16be.
    return { text: new TextDecoder(bom.encoding).decode(buf), encoding: bom.encoding, lossy: false };
  }

  // No BOM: a BOM-less UTF-16 file alternates NUL bytes through its ASCII body.
  // The parity of the NULs decides the endianness: ASCII in UTF-16BE has the
  // NUL as the HIGH byte, i.e. at even offsets; UTF-16LE puts it at odd ones.
  if (utf16HasAlternatingNul(buf, 0)) {
    return { text: new TextDecoder("utf-16be").decode(buf), encoding: "utf-16be (no BOM)", lossy: false };
  }
  if (utf16HasAlternatingNul(buf, 1)) {
    return { text: new TextDecoder("utf-16le").decode(buf), encoding: "utf-16le (no BOM)", lossy: false };
  }

  try {
    return { text: FATAL.decode(buf), encoding: "utf-8", lossy: false };
  } catch {
    // Not valid UTF-8: legacy single-byte. cp1252 maps every byte to SOME
    // character, which is strictly better than replacement glyphs — but it is
    // a guess, so the path is labeled lossy.
    return { text: CP1252.decode(buf), encoding: "windows-1252 (best guess)", lossy: true };
  }
}
