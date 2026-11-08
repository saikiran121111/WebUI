/**
 * Crude but effective RTF → plain text: resolve escapes, drop control words.
 *
 * I10: `\uN` escapes used to be replaced with a literal space — every accented
 * letter, CJK character, and Telugu glyph in the document vanished. Negative
 * values (two's-complement of >32767) are now converted back to the character,
 * and the literal escapes `\{ \} \\` are protected before control words are
 * stripped (they used to be destroyed).
 */

// Private-use sentinel chars: RTF source never contains raw non-ASCII text,
// so stashing literal escapes here can't collide with document content.
const LBRACE = "";
const RBRACE = "";
const BACKSLASH = "";

export function rtfToText(rtf: string): string {
  return rtf
    // Protect literal escapes FIRST so the control-word stripper can't eat them.
    .replace(/\\([{}\\])/g, (_, c) => (c === "{" ? LBRACE : c === "}" ? RBRACE : BACKSLASH))
    // Hex and unicode escapes next, before control words eat the digits.
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d{1,5})\s?\??/g, (_, d) => {
      let n = parseInt(d, 10);
      if (n < 0) n += 65536; // RTF stores >32767 as a negative two's-complement value
      return n >= 0 && n <= 0xffff ? String.fromCharCode(n) : " ";
    })
    // Structural breaks.
    .replace(/\\par[d]?|\\line|\\sect/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\cell|\\row|\\nestcell|\\nestrow/g, "\n")
    // Skip binary picture data wholesale.
    .replace(/\\pict[\s\S]*?(?={|\\par)/g, " ")
    // Control words (with optional numeric arg) and single-char controls.
    .replace(/\\[a-zA-Z]{1,32}-?\d{0,10} ?/g, "")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/[{}]/g, "")
    // Restore the protected literal escapes.
    .split(LBRACE).join("{")
    .split(RBRACE).join("}")
    .split(BACKSLASH).join("\\")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
