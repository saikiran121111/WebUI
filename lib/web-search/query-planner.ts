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
 *   4. Task-Scope Query — when the turn carries a server-derived task
 *      scope (lib/decision/task-scope.ts), the target's VERIFIED host
 *      gets a `site:<host>` companion so engines pull deep pages from
 *      their index of the site the user actually named; an UNRESOLVED
 *      target instead gets a bounded discovery query on its bare phrase
 *      — never a guessed domain. (Task-scope audit 2026-11-02, brief
 *      #4: the old brand-token/inferBrandDomain path fabricated
 *      `site:what.com`, `blinkitcom.com`, and `foo.com` for
 *      `foo.community`.)
 *
 * After extraction + BM25, the Coverage & Gap Evaluator scores how well
 * the retrieved evidence covers the query's entities. If coverage is
 * weak OR a key entity has zero lexical hits, one fast 2nd-hop targeted
 * search fires (the LLM gate is re-run with the missing entity as a
 * constrained query, so the main model never bypasses the gate).
 */
import type { SearchPlan } from "./metasearch";
import type { SearchGateContext, SearchDecision } from "./types";
import { metasearch, stripUrlPlans } from "./metasearch";
import { tokenize } from "./reranker";
import type { TaskScope } from "../decision/task-scope";

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
export function sourceClass(prompt: string): string | null {
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

/**
 * Strong entities ONLY: the strict ENTITY_PATTERNS with NO loose
 * content-word fallback. The loose `tokenize()` words extractEntities
 * appends are fine for coverage SCORING but poisoned query CONSTRUCTION
 * (task-scope audit 2026-11-02, brief #4): sentence-initial "What"
 * became `site:what.com`-class queries, "price" became entities[0] →
 * `pricing "price"`, and quoting every generic content word produced
 * over-constrained zero-hit SERPs. Mirrors Rust `strong_entities`.
 */
function strongEntities(prompt: string): string[] {
  const out: string[] = [];
  const head = prompt.slice(0, 600);
  for (const re of ENTITY_PATTERNS) {
    const m = head.match(re);
    if (m) out.push(...m.map((s) => s.trim()));
  }
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
 * Strip the wrapping quote characters a quoted-phrase entity carries
 * (ENTITY_PATTERNS matches `"…"` WITH the quote characters) so
 * re-quoting never yields `""…""`.
 */
function stripQuotes(e: string): string {
  return e.replace(/^["“”']|["“”']$/g, "").trim();
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
  /** Which planner sub-query produced this (for diagnostics).
   *  "preferred" is emitted by the P4 planner law (planner-law.ts) when
   *  a domain law (allowed/preferred) needs a site-scoped companion.
   *  "scope" is the task-scope companion (audit 2026-11-02, brief #4):
   *  a VERIFIED target host's site: query, or a bare-phrase discovery
   *  query for an unresolved target — it replaced the "deep-brand"
   *  origin whose domain was a fabricated guess. */
  origin: "semantic" | "entity" | "targeted" | "gap" | "scope" | "preferred";
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
 * Generic action/descriptor words that must NEVER anchor a quoted
 * targeted query on their own: a quoted `"price"` or `"order"` returns
 * junk (the `pricing "price"` regression, brief #4 bug 2). Vision hints
 * and quoted-phrase entities can surface these, so the targeted-step
 * base selection skips them and falls back to the keyword gate query.
 * Mirrored verbatim in Rust (query_planner.rs `GENERIC_WORDS`).
 */
const GENERIC_QUERY_WORDS = new Set([
  "price", "prices", "pricing", "cost", "costs", "book", "booking",
  "buy", "order", "orders", "search", "find", "check", "look",
  "latest", "current", "official", "site", "website", "docs",
  "documentation", "review", "reviews", "news", "near", "nearby",
  "weather", "delivery", "menu", "product", "products", "ticket",
  "tickets", "showtime", "showtimes", "profile",
]);

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
 *
 * `scope` is the server-derived task scope (lib/decision/task-scope.ts;
 * audit 2026-11-02, brief #3/#4/#6): a RESOLVED target's verified host
 * gets a `site:` companion on the broad query, an UNRESOLVED target
 * gets a bounded discovery query on its bare phrase — never a guessed
 * domain. Scope plans are inserted right after the first semantic plan
 * so the `slice(0, 4)` tail-drop can never starve them. The model
 * never sees or widens this contract. Mirrors Rust `plan_queries`.
 */
export function planQueries(
  userPrompt: string,
  gateQueries: GateQuery[],
  entityHints?: string[],
  scope?: TaskScope,
): PlannedQuery[] {
  const plans: PlannedQuery[] = [];

  // 1. Broad semantic query — use the LLM's own queries if it produced
  // them, else the raw prompt (capped at 200 chars so the engine pool
  // gets a clean string). URL-shaped gate queries are dropped: the
  // pipeline's Stage-0 direct-target fetch reads the linked page in
  // parallel, so the engine pool only needs the keyword form.
  const keywordGateQueries = stripUrlPlans(
    gateQueries.map((q) => ({ query: q.query, intent: q.intent as SearchPlan["intent"], preferredDomains: q.preferred_domains })),
  );
  for (const q of keywordGateQueries.slice(0, 2)) {
    plans.push({
      query: q.query,
      intent: q.intent,
      preferredDomains: q.preferredDomains,
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

  // 1b. Task-scope queries (audit 2026-11-02, brief #3/#4/#6): the scope
  // contract — and ONLY the contract — decides what gets a site:
  // companion. NO brand tokens, NO domain inference, NO brand lists.
  // A resolved target's verified host rides the broad query; an
  // unresolved target gets a bounded discovery query on its bare quoted
  // phrase (discovery to RESOLVE the destination, capped at 2). The
  // ambiguous state gets nothing here — ambiguity routes to a
  // clarification upstream in the scope contract.
  if (scope) {
    const broad =
      plans[0]?.query ?? userPrompt.replace(/\s+/g, " ").trim().slice(0, 200);
    const scopePlans: PlannedQuery[] = [];
    for (const t of scope.targets) {
      if (scopePlans.length >= 2) break;
      if (t.state === "resolved" && t.host) {
        scopePlans.push({
          query: `${broad} site:${t.host}`.slice(0, 200),
          intent: "general",
          preferredDomains: [t.host],
          origin: "scope",
        });
      } else if (t.state === "unresolved" && t.phrase) {
        const phrase = stripQuotes(t.phrase);
        if (phrase) {
          scopePlans.push({
            query: `"${phrase}"`.slice(0, 200),
            intent: "general",
            origin: "scope",
          });
        }
      }
    }
    // Insert right after the first semantic plan: the plan cap drops
    // from the tail, so scope companions survive the 4-query ceiling.
    if (scopePlans.length > 0) plans.splice(1, 0, ...scopePlans);
  }

  const strong = mergeEntities(entityHints ?? [], strongEntities(userPrompt));
  const cls = sourceClass(userPrompt);

  // 2. Exact entity / technical query — quoted STRONG entities survive
  // the search engine's paraphrase. Only fires with 2+ strict-pattern
  // entities; the loose content words were removed from construction
  // (quoting them produced over-constrained zero-hit SERPs, brief #4).
  if (strong.length >= 2 && plans.length < 3) {
    const entQuery = strong
      .slice(0, 4)
      .map((e) => `"${stripQuotes(e)}"`)
      .filter((q) => q.length > 2)
      .join(" ")
      .slice(0, 200);
    plans.push({
      query: entQuery,
      intent: cls === "github" ? "code" : cls === "docs" ? "docs" : "general",
      origin: "entity",
    });
  }

  // 3. Targeted source query — operator injection for the detected class.
  // The anchor is the first STRONG entity that is not a generic action
  // word (the `pricing "price"` regression, brief #4 bug 2); else the
  // unquoted keyword gate query; else raw prompt words. Quoting is
  // decided once here — never per operator branch.
  if (cls && plans.length < 4) {
    const nonGeneric = strong.find(
      (e) => !GENERIC_QUERY_WORDS.has(stripQuotes(e).toLowerCase()),
    );
    let base: string;
    let anchor: string;
    if (nonGeneric) {
      base = stripQuotes(nonGeneric);
      anchor = `"${base}"`;
    } else if (keywordGateQueries.length > 0) {
      base = keywordGateQueries[0].query;
      anchor = base;
    } else {
      base = userPrompt.replace(/\s+/g, " ").trim().slice(0, 80);
      anchor = base;
    }
    let opQuery = "";
    let opIntent: PlannedQuery["intent"] = "general";
    let domains: string[] | undefined;
    switch (cls) {
      case "pdf":
        opQuery = `filetype:pdf ${anchor}`;
        opIntent = "pdf";
        break;
      case "github":
        opQuery = `site:github.com ${anchor}`;
        opIntent = "github";
        domains = ["github.com"];
        break;
      case "docs":
        opQuery = `documentation ${anchor}`;
        opIntent = "docs";
        break;
      case "review":
        opQuery = `review ${anchor}`;
        opIntent = "review";
        break;
      case "pricing":
        opQuery = `pricing ${anchor}`;
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
        const personAnchor =
          nameSpan.length >= 3 && /^[a-zÀ-ÿ' .-]+$/i.test(nameSpan)
            ? `"${nameSpan.slice(0, 80)}"`
            : strong.length >= 2
              ? `"${stripQuotes(strong[0])}" "${stripQuotes(strong[1])}"`
              : anchor;
        opQuery = `${personAnchor} site:in.linkedin.com`;
        opIntent = "general";
        domains = ["linkedin.com"];
        if (plans.length < 4) {
          plans.push({
            query: `${personAnchor} site:linkedin.com/in/`,
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

  // (Step 4 was the deep-brand query — DELETED by the task-scope audit
  // 2026-11-02, brief #4: extractBrandTokens + inferBrandDomain
  // fabricated domains — `site:what.com` from a sentence-initial
  // "What", `blinkitcom.com` from the dot-strip-before-dot-test,
  // `order.com` for "Zepto", `foo.com` for "foo.community". The
  // scope step (1b) above replaces it with VERIFIED hosts only.)

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
/* ── answer-unit law (universal research-depth audit 2026-11-05) ─────
 * For an ENUMERATIVE ask ("which/what … does X support/offer/include …")
 * the answer units are NAMED IDENTIFIERS — an external catalog the user
 * does not already have. Query-word substring hits on topical text are
 * NOT coverage of such a unit: the retrieved passages must contain at
 * least one identifier-shaped token the user did not already supply.
 * Grammar + token-shape only (no entity/brand tables). When no identifier
 * is present the evaluator errs toward FIRING recovery: an extra bounded
 * wave is cheap, a falsely-complete answer is the audited failure.
 */
const ENUMERATIVE_ASK_RE =
  /\b(?:which|what)\b[^.?!\n]{0,50}?\b(?:does|do|did|can|will|could)\s+(?!(?:this|that|these|those|it|its|the|a|an|my|our|his|her|their|your|he|she|they|we)\b)[^.?!]{0,40}?\b(?:supports?|offer(?:s|ed|ing)?|provide[sd]?|providing|include[sd]?|including|integrat(?:e|es|ed|ing)|feature[sd]?|list(?:s|ed)?|accept(?:s|ed)?)\b/i;

// Identifier-shaped answer tokens: hyphen/dot-joined with a digit
// (Boreal-X17, GPT-4), internal caps (CamelCase product tokens), or a
// capitalized name followed by a number (Llama 3). Plain prose hyphenates
// ("state-of-the-art") intentionally do NOT count — they must not fake
// "an identifier was found" and suppress recovery.
const IDENTIFIER_RES: RegExp[] = [
  /\b[A-Za-z][A-Za-z0-9]*[-.][A-Za-z0-9]*\d[A-Za-z0-9]*\b/g,
  /\b[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g,
  /\b[A-Z][a-z]{2,} \d[\w.]*/g,
];

function hasNovelIdentifier(passages: string[], userPrompt: string): boolean {
  const promptLow = userPrompt.toLowerCase();
  for (const text of passages) {
    // URLs scrubbed first: domain tokens would masquerade as identifiers.
    const scrubbed = text.replace(/https?:\/\/\S+/g, " ");
    for (const re of IDENTIFIER_RES) {
      for (const m of scrubbed.matchAll(re)) {
        if (!promptLow.includes(m[0].toLowerCase())) return true;
      }
    }
  }
  return false;
}

// Function-word filter for the prompt-derived gap query (vocabulary, not
// entity knowledge). Used when needsGapSearch fires but every prompt
// entity already matched — recovery must still be dispatchable.
const GAP_STOPWORDS = new Set([
  "which", "what", "when", "where", "who", "whose", "why", "how",
  "does", "do", "did", "can", "could", "would", "should", "will", "shall",
  "is", "are", "was", "were", "be", "been", "being", "the", "a", "an",
  "for", "of", "in", "on", "at", "to", "and", "or", "with", "about",
  "from", "tell", "me", "please", "give", "show", "list", "any", "all",
]);

function sourceOperator(cls: string | null): string {
  if (cls === "github") return "site:github.com ";
  if (cls === "pdf") return "filetype:pdf ";
  return "";
}

export function evaluateCoverage(
  userPrompt: string,
  retrievedPassages: string[],
): CoverageReport {
  const entities = extractEntities(userPrompt);
  const cls = sourceClass(userPrompt);
  if (entities.length === 0) {
    // Actionability law (audit B): whenever recovery is warranted the
    // caller must get a dispatchable query — needsGapSearch and gapQuery
    // are NEVER decoupled. Sparse evidence with no entities still gets a
    // prompt-derived recovery query instead of a silent stall.
    const sparse = retrievedPassages.length < 2;
    return {
      coverage: 1,
      missingEntities: [],
      needsGapSearch: sparse,
      gapQuery: sparse ? sourceOperator(cls) + userPrompt.trim() : null,
    };
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

  // Answer-unit law: topical entity hits are not answer coverage.
  const answerGap =
    ENUMERATIVE_ASK_RE.test(userPrompt) &&
    !hasNovelIdentifier(retrievedPassages, userPrompt);

  const needsGapSearch =
    (coverage < 0.5 && missing.length > 0) ||
    retrievedPassages.length < 2 ||
    answerGap;

  let gapQuery: string | null = null;
  if (needsGapSearch) {
    let core: string;
    if (missing.length > 0) {
      core = missing
        .slice(0, 3)
        .map((e) => (e.length > 3 ? '"' + e + '"' : e))
        .join(" ");
    } else {
      // Every entity matched but the ANSWER unit is missing: derive the
      // recovery query from the user's own content words — never a
      // canned phrase list.
      const words = userPrompt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !GAP_STOPWORDS.has(w));
      core = words.length > 0 ? words.join(" ") : userPrompt.trim();
    }
    gapQuery = sourceOperator(cls) + core;
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
