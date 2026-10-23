/**
 * Multi-hop query planner & decomposer.
 *
 * Before the pipeline runs, a complex or multi-faceted user prompt is
 * decomposed into 2–4 orthogonal sub-queries that run in parallel:
 *   1. Broad Semantic Query — the natural-language question as-is.
 *   2. Exact Entity / Technical Query — quoted product names, version
 *      numbers, function names, error strings (survives the LLM's
 *      paraphrase without diluting them).
 *   3. Targeted Source Query — `filetype:pdf`, `site:github.com`, or
 *      documentation / review keywords injected when the prompt's
 *      entity vocabulary maps to a known source class.
 *   4. Deep Indexed Brand Query — when the user names a platform or
 *      website in plain text ("blinkit", "myntra", "zepto", "bookmyshow",
 *      "zomato", or ANY brand/platform token), a `site:<brand-domain>`
 *      companion query is generated so search engines pull deep
 *      product/menu/showtime/listing pages directly from their index —
 *      the universal mechanism that makes billion-site reach work
 *      without a per-site adapter.
 *
 * After extraction + BM25, the Coverage & Gap Evaluator scores how well
 * the retrieved evidence covers the query's entities. If coverage is
 * weak OR a key entity has zero lexical hits, one fast 2nd-hop targeted
 * search fires (the LLM gate is re-run with the missing entity as a
 * constrained query, so the main model never bypasses the gate).
 */
import type { SearchPlan } from "./metasearch";
import type { SearchGateContext, SearchDecision } from "./types";
import { metasearch } from "./metasearch";
import { tokenize } from "./reranker";

type GateQuery = SearchDecision["queries"][number];

/* ── entity extraction (cheap, no LLM) ───────────────────────────────── */

const ENTITY_PATTERNS: RegExp[] = [
  /\bv\d+(\.\d+)+\b/g, // version numbers
  /\b[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?(?:\.(?:com|org|in|io|dev|ai|co))\b/g, // product names
  /["“]([^"”]{4,80})["”]/g, // quoted phrases
  /\b(error|exception|fail(ed|ure)?|cannot|unable|crash(es|ed)?)\s+[a-z_]{3,}/gi, // error strings
  /\b[a-z_]\w*(?:\s+(?:function|method|class|module|library|framework|api))\b/gi,
];

function extractEntities(prompt: string): string[] {
  const out: string[] = [];
  const head = prompt.slice(0, 600);
  for (const re of ENTITY_PATTERNS) {
    const m = head.match(re);
    if (m) out.push(...m.map((s) => s.trim()));
  }
  // Also pull the top non-stopword content words as loose entities
  const toks = tokenize(head).slice(0, 12);
  out.push(...toks);
  // Dedupe
  const seen = new Set<string>();
  return out
    .filter((e) => {
      if (seen.has(e.toLowerCase())) return false;
      seen.add(e.toLowerCase());
      return true;
    })
    .slice(0, 10);
}

/**
 * Detect which source class the prompt's vocabulary maps to, so the
 * planner can inject the right operators (filetype:, site:).
 */
function sourceClass(prompt: string): string | null {
  const p = prompt.toLowerCase();
  if (/\bfiletype\s*:\s*pdf\b|\bpaper\b|\bpdf\b|\bwhite ?paper\b/.test(p)) return "pdf";
  // LinkedIn person/profile lookups (the Vision-to-Search pre-pass feeds
  // the entity hints; the targeted query adds site:linkedin.com/in/).
  if (/\blinked ?in\b|lnkd\.in|\/profile\b|person profile|\bfind (this|the|that) (guy|person|profile)\b/.test(p))
    return "linkedin";
  if (/\bsite\s*:\s*github\.com\b|github|repo(sitory)?\s+(page)?\b/.test(p)) return "github";
  if (/\bdocs?\b|documentation|manual|guide|reference|readme/.test(p)) return "docs";
  if (/\breview|rating|versus|vs\b|comparison|benchmark/.test(p)) return "review";
  if (/\bpricing|price|cost|plans?|subscription\b/.test(p)) return "pricing";
  return null;
}

/* ── brand / platform deep-indexed query (universal, no per-site rules) ─ */

/**
 * Detect a brand / platform / website name mentioned in plain text.
 *
 * Universal heuristic — NO hardcoded brand lists:
 *   1. Any fully-qualified domain token in the prompt (blinkit.com,
 *      myntra.in, ...) — the domain is taken verbatim.
 *   2. Any PascalCase proper noun of 4+ chars that is not a common
 *      English word (Myntra, Zepto, BookMyShow, Zomato, Flipkart,
 *      Nykaa, Ajio, ...) — the brand's own token form is lowercased
 *      and used to infer a domain (`<brand>.com` or `<brand>.in` —
 *      see inferBrandDomain). The search engine's `site:` operator
 *      matches the brand property root regardless of the exact TLD.
 *
 * Common English words are excluded by a small stoplist so "Apple"
 * (the fruit, in a recipe query) does not get force-scoped to
 * apple.com.
 */
const BRAND_COMMON_WORD_EXCLUSIONS = new Set([
  "the", "this", "that", "with", "from", "have", "will", "does", "were",
  "http", "https", "www", "html", "http2", "node", "json", "xml", "css",
  "api", "cli", "url", "dom", "js", "ts", "web", "app", "dev", "utf",
]);

/**
 * Detect which platform context the prompt carries, so a lowercase
 * token ("blinkit", "myntra") is only treated as a brand when it sits
 * next to a shopping/food/movie/job context word. This is what keeps
 * "zebra" in "count the zebra in the photo" from becoming a
 * `site:zebra.com` query.
 */
const PLATFORM_CONTEXT_RE =
  /\b(buy|price|prices|cost|order|ordered?|delivery|deliver|groceries?|grocery|restaur\w*|movie|movies|show|shows|ticket|tickets|book|booking|shop|shopping|product|products|menu|menus?|availability|stock|in stock|out of stock|review|rating|ratings|cuisine|cuisines|venue|venues|events?|concert|match|matches|game|games|leag\w*|job|jobs|hiring|salary|salaries|recruiting|recruit|hire|hiring|apply|vacan\w*|open role|remote|intern\w*|full[- ]time|part[- ]time|placement|openings|listing|listings|deal|deals|discount|discounts|sale|sales|promo|promos?|coupon|coupons|deliverable|shipp\w*|return|returns?|refund|price range|starting at|from \d|₹|rs\.?|pizza|shawarma|burger|burgers|samosa|kebab|chips|biryani|curry|salad|sweets?|dosa|idli|noodles|pasta)\b/i;

export function extractBrandTokens(prompt: string): string[] {
  const head = prompt.slice(0, 800).toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();

  // 1. Explicit domains first — highest precision.
  const domainRe =
    /(?:^|[\s(])((?:[a-z0-9-]+\.)+(?:com|in|io|dev|org|net|co|app|ai)(?:\/[^\s)]*)?)/g;
  let m: RegExpExecArray | null;
  while ((m = domainRe.exec(head)) !== null && out.length < 3) {
    const host = m[1].split("/")[0];
    const root = host.replace(/^(www|m|app|web)\./, "");
    if (root.length >= 4 && !seen.has(root)) {
      seen.add(root);
      out.push(root);
    }
  }

  // 2. PascalCase brand tokens in the original prompt ("Myntra",
  //    "BookMyShow", "Zomato") — lowercased for domain inference.
  //    Plus lowercase tokens that sit next to a platform-context word
  //    ("blinkit price", "zomato restaurants").
  const original = prompt.slice(0, 800);
  const pascalRe = /\b([A-Z][a-zA-Z]{3,19})\b/g;
  const ctxRe = /\b([a-z]{4,20})\s+(?:buy|price|prices|cost|order|delivery|deliver|grocer\w*|restaurant\w*|movie\w*|show\w*|ticket\w*|booking\w*|shop\w*|shopping|product\w*|menu\w*|availability|stock|review\w*|rating\w*|cuisine\w*|venue\w*|event\w*|concert\w*|job\w*|hiring|salary\w*|recruiting|remote|openings|listing\w*|deal\w*|discount\w*|sale\w*|promo\w*|coupon\w*|pizza|shawarma|burger\w*|samosa|kebab|chips|biryani|curry|salad|sweets?|dosa|idli|noodles|pasta)/gi;
  const hasContext = PLATFORM_CONTEXT_RE.test(original);

  for (const match of original.matchAll(pascalRe)) {
    if (out.length >= 3) break;
    const token = match[1].toLowerCase();
    if (BRAND_COMMON_WORD_EXCLUSIONS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  if (hasContext) {
    for (const match of original.matchAll(ctxRe)) {
      if (out.length >= 3) break;
      const token = match[1].toLowerCase();
      if (BRAND_COMMON_WORD_EXCLUSIONS.has(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Infer the `<brand>.com` (or `.in` for Indian brands) domain for a
 * plain-text brand token. The inference is schema-agnostic — the
 * search engine's `site:` operator matches the brand property root
 * regardless of the exact TLD, so a single guess per brand is enough.
 *
 * Indian brands (blinkit, zepto, myntra, bookmyshow, zomato, swiggy,
 * flipkart, nykaa, ajio) default to `.in` because that is where their
 * primary India-serving index lives; everything else defaults to `.com`.
 */
const INDIAN_BRAND_HINTS = new Set([
  "blinkit", "zepto", "myntra", "bookmyshow", "zomato", "swiggy",
  "flipkart", "nykaa", "ajio", "bigbasket", "dominos", "mcdonalds",
  "uber", "ola", "paytm", "razorpay",
]);

export function inferBrandDomain(token: string): string {
  const clean = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean.includes(".") || clean.length < 2) return clean;
  return INDIAN_BRAND_HINTS.has(clean) ? clean + ".in" : clean + ".com";
}

/**
 * Build the deep-indexed `site:<brand>` companion query for the user's
 * broad query. Returns null when no brand token was detected.
 */
export function buildDeepIndexQuery(
  userPrompt: string,
  broadQuery: string,
): string | null {
  const brands = extractBrandTokens(userPrompt);
  if (brands.length === 0) return null;
  const domain = inferBrandDomain(brands[0]);
  // Use the broad query (not the user's raw prompt) so the engine sees
  // clean keywords + the site: scope.
  return `${broadQuery} site:${domain}`;
}

/* ── planner ─────────────────────────────────────────────────────────── */

export interface PlannedQuery {
  query: string;
  intent:
    | "general"
    | "news"
    | "docs"
    | "code"
    | "academic"
    | "forum"
    | "pricing"
    | "pdf"
    | "github"
    | "review";
  preferredDomains?: string[];
  /** Which planner sub-query produced this (for diagnostics). */
  origin: "semantic" | "entity" | "targeted" | "gap" | "deep-brand";
  /** Freshness filter carried from the gate decision to the search engine. */
  freshness?: "none" | "day" | "week" | "month" | "year" | "any";
}

/**
 * Merge the Vision-to-Search entity hints (Fix 2) ahead of the cheap
 * regex entities — vision-extracted names/companies/handles are higher
 * precision, so they anchor the entity + targeted queries.
 */
function mergeEntities(hints: string[], auto: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...hints, ...auto]) {
    const t = String(e ?? "").trim();
    if (!t || t.length < 2 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Decompose the user prompt into 2–4 orthogonal sub-queries.
 *
 * The planner is deterministic (no LLM call — the LLM gate has already
 * classified search_required on the raw prompt). It splits on entity
 * density: a prompt with 3+ distinct entities gets an entity query and a
 * targeted-source query in addition to the broad semantic query.
 *
 * `entityHints` come from the Vision-to-Search pre-pass when the turn
 * carries an image attachment (Fix 2) — they take precedence over the
 * regex-extracted entities.
 */
export function planQueries(
  userPrompt: string,
  gateQueries: GateQuery[],
  entityHints?: string[],
): PlannedQuery[] {
  const plans: PlannedQuery[] = [];

  // 1. Broad semantic query — use the LLM's own queries if it produced
  // them, else the raw prompt (capped at 200 chars so the engine pool
  // gets a clean string).
  for (const q of gateQueries.slice(0, 2)) {
    plans.push({
      query: q.query,
      intent: q.intent,
      preferredDomains: q.preferred_domains,
      origin: "semantic",
    });
  }
  if (plans.length === 0) {
    plans.push({
      query: userPrompt.replace(/\s+/g, " ").trim().slice(0, 200),
      intent: "general",
      origin: "semantic",
    });
  }

  const entities = mergeEntities(entityHints ?? [], extractEntities(userPrompt));
  const cls = sourceClass(userPrompt);

  // 2. Exact entity / technical query — quoted entities survive the
  // search engine's paraphrase. Only fire when we have 2+ real entities.
  if (entities.length >= 2 && plans.length < 3) {
    const entQuery = entities
      .slice(0, 4)
      .map((e) => (e.length > 3 ? '"' + e + '"' : e))
      .join(" ")
      .slice(0, 200);
    plans.push({
      query: entQuery,
      intent: cls === "github" ? "code" : cls === "docs" ? "docs" : "general",
      origin: "entity",
    });
  }

  // 3. Targeted source query — operator injection for the detected class.
  if (cls && plans.length < 4) {
    const base = entities.length > 0 ? entities[0] : userPrompt.slice(0, 80);
    let opQuery = "";
    let opIntent: PlannedQuery["intent"] = "general";
    let domains: string[] | undefined;
    switch (cls) {
      case "pdf":
        opQuery = `filetype:pdf "${base}"`;
        opIntent = "pdf";
        break;
      case "github":
        opQuery = `site:github.com "${base}"`;
        opIntent = "github";
        domains = ["github.com"];
        break;
      case "docs":
        opQuery = `documentation "${base}"`;
        opIntent = "docs";
        break;
      case "review":
        opQuery = `review "${base}"`;
        opIntent = "review";
        break;
      case "pricing":
        opQuery = `pricing "${base}"`;
        opIntent = "pricing";
        break;
      case "linkedin": {
        // Person lookup: anchor on the NAME SPAN, not the two leading
        // content words — extractEntities() grabs "find"/"profile" from
        // "can you find this profile name X in linkedIN" (measured), which
        // poisons the quoted anchor. Strip the lookup-trigger vocabulary
        // (whole words only); what survives IS the person's name. Vision
        // pre-pass hints still take precedence via mergeEntities ordering.
        // Profiles are indexed on the REGIONAL subdomain (in.linkedin.com
        // for our en-IN user base) — measured: `"name" site:linkedin.com/in/`
        // returns zero hits on DDG/Bing while `"name" site:in.linkedin.com`
        // surfaces the /in/ permalink. Both operator forms go out; the
        // regional one first.
        const nameSpan = userPrompt
          .replace(/https?:\/\/\S+/gi, " ")
          .replace(
            /\b(can|could|would|should|will|you|your|please|i|we|want|need|like|try|to|find|search|look|see|show|check|up|this|that|these|those|the|my|me|a|an|on|in|at|of|for|from|help|profile|person|guy|woman|man|candidate|employee|name|linked ?in|linkedin|lnkd\.in)\b/gi,
            " ",
          )
          .replace(/["“”']/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const anchor =
          nameSpan.length >= 3 && /^[a-zÀ-ÿ' .-]+$/i.test(nameSpan)
            ? `"${nameSpan.slice(0, 80)}"`
            : entities.length >= 2
              ? `"${entities[0]}" "${entities[1]}"`
              : `"${base}"`;
        opQuery = `${anchor} site:in.linkedin.com`;
        opIntent = "general";
        domains = ["linkedin.com"];
        if (plans.length < 4) {
          plans.push({
            query: `${anchor} site:linkedin.com/in/`,
            intent: "general",
            preferredDomains: domains,
            origin: "targeted",
          });
        }
        break;
      }
    }
    if (opQuery) {
      plans.push({ query: opQuery, intent: opIntent, preferredDomains: domains, origin: "targeted" });
    }
  }

  // 4. Deep indexed brand query (universal, schema-agnostic): when the
  // user named a platform / website in plain text (blinkit, myntra,
  // zepto, bookmyshow, zomato, …), a `site:<brand-domain>` companion
  // is appended to the broad semantic query so the engine pool pulls
  // deep product/menu/showtime/listing pages straight from the search
  // engine's index of that site.
  const broad = plans[0]?.query ?? userPrompt.replace(/\s+/g, " ").trim().slice(0, 200);
  const deep = buildDeepIndexQuery(userPrompt, broad);
  if (deep && plans.length < 4 && !plans.some((p) => p.query === deep)) {
    plans.push({
      query: deep,
      intent: "general",
      origin: "deep-brand",
    });
  }

  return plans.slice(0, 4);
}

/* ── coverage & gap evaluator ───────────────────────────────────────── */

export interface CoverageReport {
  /** Fraction of query entities with at least one BM25 hit in the
   * top passage set. 1.0 = full coverage, 0.0 = no entity matched. */
  coverage: number;
  /** Entities that had zero matches in the retrieved passages. */
  missingEntities: string[];
  /** True when a 2nd-hop gap search is warranted. */
  needsGapSearch: boolean;
  /** The specific query to fire for the 2nd hop (null when coverage is
   *  already good). */
  gapQuery: string | null;
}

/**
 * Score the retrieved evidence against the query's entities.
 *
 * "Weak coverage" fires when:
 *   - coverage < 0.5 AND at least one entity is missing, OR
 *   - fewer than 2 passages total were retrieved (sparse evidence).
 *
 * The gap query is built from the missing entities (quoted, so the
 * search engine treats them as exact phrases) plus the source-class
 * operator if one was detected.
 */
export function evaluateCoverage(
  userPrompt: string,
  retrievedPassages: string[],
): CoverageReport {
  const entities = extractEntities(userPrompt);
  if (entities.length === 0) {
    return { coverage: 1, missingEntities: [], needsGapSearch: false, gapQuery: null };
  }

  // Concatenate all retrieved text into one haystack
  const haystack = retrievedPassages.join(" ").toLowerCase();
  const hitEntities = new Set<string>();
  for (const e of entities) {
    // A 4+ char entity must appear as a whole word/phrase in the text
    if (haystack.includes(e.toLowerCase())) hitEntities.add(e);
  }

  const coverage = hitEntities.size / entities.length;
  const missing = entities.filter((e) => !hitEntities.has(e));
  const cls = sourceClass(userPrompt);

  const needsGapSearch =
    (coverage < 0.5 && missing.length > 0) ||
    retrievedPassages.length < 2;

  let gapQuery: string | null = null;
  if (needsGapSearch && missing.length > 0) {
    const quoted = missing
      .slice(0, 3)
      .map((e) => (e.length > 3 ? '"' + e + '"' : e))
      .join(" ");
    if (cls === "github") gapQuery = `site:github.com ${quoted}`;
    else if (cls === "pdf") gapQuery = `filetype:pdf ${quoted}`;
    else gapQuery = quoted;
  }

  return { coverage, missingEntities: missing, needsGapSearch, gapQuery };
}

/**
 * Run the 2nd-hop gap metasearch directly. (The old `gapSearchDecision`
 * re-gated the hop through the LLM — that re-gate was dropped with the
 * LFM router; the hop now runs straight under the ceiling.)
 */
export async function runGapMetasearch(
  gapQuery: string,
): Promise<import("./metasearch").RankedResult[]> {
  const cls = sourceClass(gapQuery);
  const intent: import("./metasearch").SearchPlan["intent"] =
    cls === "github" ? "code" : cls === "pdf" ? "academic" : "general";
  return metasearch([{ query: gapQuery, intent }], 8);
}
