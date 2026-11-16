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
 * F05 (2026-11-15 brief) - IDENTIFIER IDENTITY LAW.
 *
 * The splitter used to treat "+" and "#" as ORDINARY separators, so "C++" and
 * "C#" both collapsed to the bare token "c" on BOTH the query side and the
 * text side. Consequence, reproduced by __tests__/web-search/token-identity:
 * C-language evidence answered a C++ question, and a C++ page counted as
 * confirming a C question - a lexical signal mistaken for identity, which is
 * the defect class the brief calls out.
 *
 * The law encoded below (general mechanism, no per-example exception):
 *   - Shape-preserving identity. A word shape keeps its attached "+"/"#"
 *     modifier run: "C++" -> "c++", "C#" -> "c#", "F#" -> "f#".
 *   - Punctuation tolerance WITHOUT symbol tolerance. Alternate spellings are
 *     derived by joining/splitting ONLY on the neutral separators . _ - and
 *     the apostrophe, so "next.js" <-> "nextjs" <-> "next-js" keep matching
 *     each other (and "O'Brien" <-> "Obrien"), while "c" and "c++" can NEVER
 *     answer for one another in either direction.
 *   - Case invariance stays (both sides lower-case), but the lower-cased form
 *     of a symbol-bearing identifier keeps its symbols: "C++" is "c++".
 *   - Query side and text side share ONE implementation, so they cannot
 *     drift apart - the pre-existing SS5e law, extended rather than forked.
 *
 * Honest limitation, pinned in the tests: shapes are not ALIASES. "c++" does
 * not match "cpp" and "next.js" does not match "next js" (separate words),
 * because an alias table is a different mechanism and inventing one here
 * would be the keyword cascade the brief forbids.
 */

const SHAPE_BODY = "[\\p{L}\\p{N}\\p{M}]+";
const SHAPE_TAIL = "(?:[+#]{1,3})?";

/**
 * How much internal punctuation a shape may contain.
 *   none - every separator splits (the BM25 reranker tokenizer).
 *   dots - only "." joins, so "next.js" survives as one identity.
 *   full - . _ - and the apostrophe join, so "app-router" and "O'Brien" each
 *          yield their raw shape PLUS their joined and per-part forms.
 */
export type IdentityJoin = "none" | "dots" | "full";

const SHAPE_RES: Record<IdentityJoin, RegExp> = {
  none: new RegExp(SHAPE_BODY + SHAPE_TAIL, "gu"),
  dots: new RegExp(SHAPE_BODY + "(?:\\." + SHAPE_BODY + ")*" + SHAPE_TAIL, "gu"),
  full: new RegExp(
    SHAPE_BODY + "(?:[._\\-'\u2019]" + SHAPE_BODY + ")*" + SHAPE_TAIL,
    "gu",
  ),
};

/** Lowercased word shapes with their symbol modifiers preserved. */
export function identityShapes(text: string, join: IdentityJoin = "dots"): string[] {
  return text.toLowerCase().match(SHAPE_RES[join]) ?? [];
}

const SEPARATOR_FORM_RE = /[._\-'\u2019]/g;
const FORM_SPLIT_RE = /[._\-'\u2019]+/g;

/**
 * Punctuation-insensitive identity of one token. "+"/"#" are NEVER folded
 * away: that fold is exactly what made C++ indistinguishable from C.
 */
export function foldIdentityToken(token: string): string {
  return token.toLowerCase().replace(SEPARATOR_FORM_RE, "");
}

/** Every addressable spelling of one shape: raw, joined, and each part. */
export function identityForms(shape: string): string[] {
  const out = [shape];
  const joined = shape.replace(SEPARATOR_FORM_RE, "");
  if (joined !== shape) out.push(joined);
  for (const part of shape.split(FORM_SPLIT_RE)) {
    if (part && part !== shape && part !== joined) out.push(part);
  }
  return out;
}

/**
 * Whole-token mention forms of a text (the SS5b matcher, now shape-aware):
 * a core token counts as mentioned only when it EQUALS one of these forms.
 * Substring coincidences still never count ("rust" in "trust"), and no
 * symbol-bearing identity is ever traded for its bare stem.
 */
export function wordIdentityForms(text: string): Set<string> {
  const out = new Set<string>();
  for (const shape of identityShapes(text, "full")) {
    out.add(shape);
    for (const form of identityForms(shape)) out.add(form);
  }
  return out;
}

/**
 * Lowercase, fold apostrophes, then take identity shapes: with `keepDots`
 * additionally letting "." join inside a token so dotted technical names like
 * "next.js" stay whole (the SS5b punctuation-join law).
 */
export function splitCoreWords(
  text: string,
  opts: { keepDots?: boolean } = {},
): string[] {
  return identityShapes(text.replace(/['\u2019]/g, ""), opts.keepDots ? "dots" : "none");
}
