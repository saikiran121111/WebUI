/**
 * TeX delimiter detection, kept separate from the KaTeX bundle so the
 * cheap check never pulls in katex CSS/plugins for plain messages.
 */
const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n\\]+(?:\\.[^$\n\\]*)*\$/;

export function containsMath(content: string): boolean {
  return MATH_PATTERN.test(content);
}
