/**
 * F82 (2026-11-23): the unanswerable-row scorer, extracted from
 * fr-live-regression.spec.ts so the refusal detector is unit-testable
 * (negative control included) model-free, away from the inference slot.
 *
 * C3 evidence: fr-P9 answered the unanswerable Kestrel question CORRECTLY —
 * "The report names no chief engineer — it is signed only as 'Prepared by the
 * basin engineering group.'" — and the old REFUSAL regex called that a name
 * answer. The scorer, not the product, was the first failing layer.
 *
 * The law: an unanswerable row passes on an explicit absence statement about
 * the asked-for thing, and a concrete asserted name/number FAILS. Patterns are
 * absence-of-X phrasings only; nothing here matches an answer that ASSERTS an
 * entity, so "The chief engineer is John Smith" scores as not-a-refusal.
 */
// F147 (2026-11-24): f93-long-1 fr-P9 answered correctly — "No chief
// engineer is named anywhere…" — and the lexicon MISSED it: the qualifying
// adjective ("chief") separated "no" from the role noun. Added the
// "No <role> is <absence-verb>" family (+ the credited mirror of the
// signed-only forms). Negative control extended in
// __tests__/f82-f84-scorer.test.ts: asserted-name answers still score false.
export const REFUSAL =
  /not (be )?(found|present|in the file|stated|available|mentioned|contain)|cannot|can't|no information|not mention|absent|unable|doesn.t (contain|include|mention|name|list|state)|nothing (about|in)|refus|names? no |no (such |named )?(engineer|name|author|signer|person)|no [a-z ]{0,20}?(engineer|name|author|signer|person) (is|was) (named|credited|listed|identified|signed)|isn.t (named|signed|attributed)|not (named|signed by|attributed)|signed only|only signed|credited only|only credited|no one (is|appears|signed)|nobody (is|appears|signed)|not in (the )?(file|report|document|deck)/i;

export const isRefusal = (s: string): boolean => REFUSAL.test(s);
