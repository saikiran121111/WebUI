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
  // BOM wins — unambiguous. Check UTF-32 before UTF-16 (FF FE is a prefix).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) {
    return { text: decodeUtf32(buf, true, 4), encoding: "utf-32le", lossy: false };
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) {
    return { text: decodeUtf32(buf, false, 4), encoding: "utf-32be", lossy: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buf), encoding: "utf-16le", lossy: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buf), encoding: "utf-16be", lossy: false };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(buf), encoding: "utf-8", lossy: false };
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
