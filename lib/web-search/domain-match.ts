/**
 * domain-match.ts — dependency-free domain-suffix helpers.
 *
 * Split out of planner-law.ts (P7 browser-fix 2026-11-02): client components
 * (hooks/useChat.ts → rich-results.ts) legitimately need `domainWithin` for
 * sanitizing rich results, but planner-law pulls the query-planner →
 * metasearch → net.ts chain, and net.ts loads the `impit` native binary —
 * which crashes the Next client bundle ("Node.js binary module … is not
 * supported in the browser"). Pure helpers therefore live in this zero-import
 * leaf so both server and client graphs can share one source of truth.
 *
 * planner-law.ts re-exports both symbols; existing server-side importers are
 * unaffected.
 */

/** Lowercase + strip `www.` + drop any path — registrable-parent style. */
export function normalizeDomain(raw: string): string {
  let d = String(raw ?? "").trim().toLowerCase().split("/")[0];
  d = d.replace(/^www\./, "");
  return d;
}

/** Suffix containment rule (no PSL): host === d or host endsWith ".d". */
export function domainWithin(host: string, domain: string): boolean {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith("." + d);
}
