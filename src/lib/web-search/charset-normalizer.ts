/**
 * Universal charset & encoding normalizer.
 *
 * Detects the response charset from the Content-Type header, falls back
 * to <meta charset> / <meta http-equiv="Content-Type">, and re-decodes
 * the body bytes via TextDecoder. This is what lets international and
 * legacy sites (Shift_JIS, GB18030, EUC-KR, ISO-8859-1, Windows-1252)
 * produce clean text instead of garbled UTF-8.
 */

/**
 * Map the charset strings that appear in Content-Type headers and
 * <meta> tags to the canonical label TextDecoder accepts.
 */
const CHARSET_ALIASES: Record<string, string> = {
  "utf-8": "utf-8",
  "utf8": "utf-8",
  "iso-8859-1": "latin1",
  "iso-8859-15": "latin1",
  "iso-8859-2": "latin2",
  "iso-8859-9": "latin5",
  "iso-8859-10": "latin10",
  "iso-8859-13": "latin7",
  "iso-8859-14": "latin8",
  "iso-8859-16": "latin9",
  "windows-1252": "windows-1252",
  "cp1252": "windows-1252",
  "windows-1251": "windows-1251",
  "cp1251": "windows-1251",
  "koi8-r": "koi8-r",
  "shift_jis": "shift-jis",
  "shift-jis": "shift-jis",
  "sjis": "shift-jis",
  "x-sjis": "shift-jis",
  "gb18030": "gb18030",
  "gbk": "gb18030",
  "gb2312": "gb18030",
  "euc-kr": "euc-kr",
  "ks_c_5601-1987": "euc-kr",
  "big5": "big5",
  "euc-jp": "utf-8",
  "utf-16": "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
};

/**
 * Detect the charset for a response, in priority order:
 *   1. Content-Type header (e.g. `text/html; charset=Shift_JIS`)
 *   2. <meta charset="..."> in the first 4KB of body
 *   3. <meta http-equiv="Content-Type" content="...; charset=...">
 *   4. BOM sniffing (UTF-8 / UTF-16LE / UTF-16BE)
 *   5. Fallback to UTF-8 (the Web default)
 *
 * Returns the canonical label TextDecoder accepts, or "utf-8".
 */
export function detectCharset(
  contentType: string,
  bodyBytes: Uint8Array,
): string {
  // 1. Content-Type header
  const ctMatch = contentType.match(/charset\s*=\s*["']?([\w-]+)/i);
  if (ctMatch) {
    const alias = ctMatch[1].toLowerCase();
    const label = CHARSET_ALIASES[alias];
    if (label) return label;
  }

  // 2 & 3: <meta> tags in the first 4KB
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bodyBytes.slice(0, 4096),
  );
  const metaCharset = head.match(/<meta[^>]*charset\s*=\s*["']?([\w-]+)/i);
  if (metaCharset) {
    const alias = metaCharset[1].toLowerCase();
    const label = CHARSET_ALIASES[alias];
    if (label) return label;
  }
  const metaHttpEquiv = head.match(
    /<meta[^>]*http-equiv=["']?Content-Type["']?[^>]*content=["'][^"']*charset\s*=\s*([\w-]+)/i,
  );
  if (metaHttpEquiv) {
    const alias = metaHttpEquiv[1].toLowerCase();
    const label = CHARSET_ALIASES[alias];
    if (label) return label;
  }

  // 4. BOM sniffing
  const b = bodyBytes;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return "utf-8";
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return "utf-16le";
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return "utf-16be";
  }

  // 5. Fallback
  return "utf-8";
}

/**
 * Re-decode a raw byte body with the detected charset. Returns the
 * decoded string (or the empty string when the bytes are empty).
 */
export function normalizeBody(
  bodyBytes: Uint8Array,
  contentType: string,
): string {
  if (bodyBytes.length === 0) return "";
  const charset = detectCharset(contentType, bodyBytes);
  try {
    return new TextDecoder(charset).decode(bodyBytes);
  } catch {
    // TextDecoder threw on an unknown label — fall back to UTF-8
    return new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes);
  }
}
