/** Crude but effective RTF → plain text: resolve escapes, drop control words. */
export function rtfToText(rtf: string): string {
  return rtf
    // Hex and unicode escapes first, before control words eat the digits.
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u-?\d+\s?\??/g, " ")
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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
