/**
 * §5e (2026-11-13 brief) — SHARED language-aware word splitting.
 *
 * One splitter, one law. The three query-side tokenizers of the retrieval
 * pipeline (`metasearch.queryCoreTokens`, `pipeline.stripFillers`, and the
 * `query-planner` gap-word path) all call this, so they can never drift
 * apart or drift away from the TEXT-side matchers, which were already
 * Unicode-aware: `mentionTokenSet`/`WORD_SHAPE_RE` (metasearch, §5b) and
 * the reranker tokenizer (2026-11-04 audit, `\p{L}\p{N}\p{M}`).
 *
 * The bug this kills: every query-side splitter used an ASCII-only class
 * (`[^a-z0-9\s…]`), so any Telugu / Devanagari / Japanese / Cyrillic query
 * arrived as an EMPTY token set — and the §5b honesty law (empty core set
 * proves nothing; zero relevance, never "all relevant") then correctly,
 * uselessly rejected every result the vertical engines had actually
 * returned, and the recovery pass searched for "". Honest, but dead ends.
 *
 * Laws encoded here (generalizations — no per-example exceptions):
 *   • Every script's letters, numbers and COMBINING MARKS survive
 *     (`\p{M}` keeps Devanagari matras inside their word — the 2026-11-04
 *     audit lesson, applied on the query side too).
 *   • NO raw code-unit length filter: length is script-dependent — one Han
 *     character is a whole word, "C"/"Go" are real entities. English
 *     function words ("it", "we", …) belong on the callers' stop-lists
 *     EXPLICITLY instead of being smuggled out by an implicit character-
 *     count rule that silently mangled every non-Latin script.
 *   • Apostrophes fold BEFORE splitting, so contractions land on the
 *     stop-lists as whole words ("don't" → "dont", "what's" → "whats")
 *     instead of resurrecting single-letter junk ("t", "s") once the
 *     length filter is gone — the deleted filter had been cleaning those
 *     up by accident, and accidental cleanup is not a law.
 *   • Segmentation is a graceful fallback, not a claim: unsegmented Han
 *     runs stay one token on BOTH sides (splitter and matcher), a
 *     documented limitation pinned honestly in the §5e tests, never papered
 *     over with fake word boundaries.
 */

/**
 * Lowercase, fold ASCII + curly apostrophes, then split on everything that
 * is not a letter, number, combining mark, or whitespace (with `keepDots`
 * additionally letting "." survive inside tokens so dotted technical names
 * like "next.js" stay whole — the §5b punctuation-join law).
 */
export function splitCoreWords(
  text: string,
  opts: { keepDots?: boolean } = {},
): string[] {
  const stripRe = opts.keepDots
    ? /[^\p{L}\p{N}\p{M}\s.]/gu
    : /[^\p{L}\p{N}\p{M}\s]/gu;
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(stripRe, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
