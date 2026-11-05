/**
 * route-links.ts — discovered-route harvesting (universal research-depth
 * law, 2026-11-05). Real in-content links (markdown anchors or bare URLs)
 * are inventory, not evidence: harvesting them turns "the page mentions a
 * linked catalog" into a dispatchable route that the next bounded FETCH
 * can convert into evidence. One shared implementation for read_page's
 * `links` inventory (tools.ts) and the pipeline's route-follow hop.
 */

// Anchor href accepts ANY non-space form (audit 2026-11-05 item 8): the
// harvester always resolved raws through new URL(raw, baseUrl), so
// root-relative "/docs/x", parent-relative "../x", protocol-relative
// "//cdn/x" and SPA hash-route "#/view" links were invisible ONLY because
// the regex demanded an absolute scheme — every one of them resolves
// correctly against the page that served the content. The href still
// stops at whitespace (title-syntax links stay skipped — preserved
// limitation) and addRoute's protocol guard keeps javascript:/mailto:/
// data: out.
const MD_LINK_RE = /\[([^\]]{1,160})\]\(([^\s)]{1,600})\)/g;
const BARE_URL_RE = /(?<![\w/."'(])https?:\/\/[^\s)\]}>,"]+/g;

/** Content-word tokens used for route/row focus ranking. WS12 audit
 *  (2026-11-05 item 12): the ASCII-only class silently produced NO tokens
 *  for non-Latin queries — a Hindi question could never rank a route or
 *  steer read_page focus. Split on the general-category classes (every
 *  script's letters/numbers/combining marks; boundaries and Latin tokens
 *  stay byte-identical to the old [^a-z0-9] split); the Latin noise guard
 *  (length > 3) is preserved, and non-Latin content words need only 2
 *  code points — scripts like CJK/Devanagari carry meaning far below
 *  four characters. Counted in CODE POINTS, not UTF-16 units. */
export function focusTokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((w) => (/^[a-z0-9]+$/.test(w) ? w.length > 3 : [...w].length >= 2));
}

/**
 * Enumerate every http(s) route named inside already-read passages,
 * resolved against the URL the content was served from (final origin —
 * relative links must resolve where the page actually lives, not where it
 * was requested), deduped, hash-stripped fragments kept for SPA routes.
 */
export function collectRouteLinks(
  baseUrl: string,
  passages: { passageText: string }[],
  cap = 12,
): { url: string; anchor: string }[] {
  const out: { url: string; anchor: string }[] = [];
  const seen = new Set<string>();
  for (const p of passages) {
    for (const m of p.passageText.matchAll(MD_LINK_RE)) addRoute(out, seen, baseUrl, m[2], m[1]);
    // Bare-URL pass: markdown hrefs are masked first so they can't double-count.
    const bare = p.passageText.replace(MD_LINK_RE, " ");
    for (const m of bare.matchAll(BARE_URL_RE)) addRoute(out, seen, baseUrl, m[0], "");
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

function addRoute(
  out: { url: string; anchor: string }[],
  seen: Set<string>,
  baseUrl: string,
  raw: string,
  anchor: string,
): void {
  const cleaned = raw.replace(/[.,;:!?]+$/, "");
  // Same-document anchors ("#footnote-3": TOC/footnote jumps on the page
  // just read) are NOT routes — following them refetches the same view.
  // A SPA hash-ROUTE ("#/models") changes what the page renders, so it IS
  // a harvestable route (audit 2026-11-05 item 8).
  if (cleaned.startsWith("#") && !cleaned.startsWith("#/")) return;
  try {
    const abs = new URL(cleaned, baseUrl);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return;
    if (abs.href === baseUrl) return; // a route back onto the page just read
    if (seen.has(abs.href)) return;
    seen.add(abs.href);
    out.push({ url: abs.href, anchor: anchor.trim().slice(0, 160) });
  } catch {
    // Malformed href in page content: a dead route candidate, skip it.
  }
}
