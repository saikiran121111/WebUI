import { z } from "zod";

export const SearchDecisionSchema = z
  .object({
    search_required: z.boolean(),
    reason: z.string(),
    // §11.10: "realtime" is the tightest class — facts that change
    // minute-to-minute (prices, scores, status pages, "right now" state).
    // Retrieval treats it as live_required (cache is never consulted) with
    // a 5-minute retention window on write.
    freshness: z.enum(["none", "day", "week", "month", "year", "realtime", "any"]),
    depth: z.enum(["quick", "standard", "deep"]),
    queries: z.array(
      z.object({
        query: z.string(),
        intent: z.enum(["general", "news", "docs", "code", "academic", "forum"]),
        preferred_domains: z.array(z.string()).optional(),
      }),
    ),
  })
  // search_required=true needs ≥1 query; a no-search verdict is allowed to
  // carry an empty queries array (the pipeline never reads it on that path).
  // (2026-11-04 audit fix: the predicate was inverted — it rejected the
  // valid false+empty case and accepted the invalid true+empty one; the
  // Compat schema below always had this right.)
  .refine((d) => !d.search_required || d.queries.length > 0, {
    message: "search_required=true requires at least one query",
  });

export type SearchDecision = z.infer<typeof SearchDecisionSchema>;

/** Legacy freshness values normalized to the new set on parse. */
function normalizeFreshness(f: string): SearchDecision["freshness"] {
  switch (f) {
    case "current": return "day";
    case "recent": return "month";
    default: return f as SearchDecision["freshness"];
  }
}

/**
 * §11.11 retrieval-mode contract. The cache READ policy for a run is
 * derived from the gate's freshness decision:
 *  - live_required  (freshness "realtime"): NEVER read the query cache;
 *    every run hits the live engine pool. Short TTL on write.
 *  - live_preferred (freshness "day"/"week"): a cache hit is only ever a
 *    short-TTL row (enforced at WRITE time by FRESH_QUERY_TTL_MS) — the
 *    5-hour cached row is never produced for these decisions.
 *  - cached_preferred: everything else; the normal TTL applies.
 * Rust mirror: `RetrievalMode` + `retrieval_mode_for_freshness` (types.rs).
 */
export type RetrievalMode = "cached_preferred" | "live_preferred" | "live_required";

export function retrievalModeForFreshness(f: string): RetrievalMode {
  if (f === "realtime") return "live_required";
  if (f === "day" || f === "week") return "live_preferred";
  return "cached_preferred";
}

/**
 * Backward-compatible parser: accepts both the legacy 3-value freshness
 * (none/recent/current) and the new 6-value set. Old cache entries and
 * old model outputs are still valid.
 *
 * `intent` is intentionally parsed as a free string first, then coerced
 * to the canonical enum (unknown values → "general"). The gate model
 * occasionally emits free-form intent labels like "restaurant
 * recommendation"; coercing instead of rejecting keeps an otherwise
 * valid decision usable instead of failing the schema.
 */
export const SearchDecisionSchemaCompat = z
  .object({
    search_required: z.boolean(),
    reason: z.string(),
    freshness: z.string(),
    depth: z.enum(["quick", "standard", "deep"]),
    queries: z.array(
      z.object({
        query: z.string(),
        intent: z.string(),
        preferred_domains: z.array(z.string()).optional(),
      }),
    ),
  })
  .refine((d) => !d.search_required || d.queries.length > 0, {
    message: "search_required=true requires at least one query",
  })
  .transform((d): SearchDecision => ({
    ...d,
    freshness: normalizeFreshness(d.freshness),
    queries: d.queries.map((q) => ({
      ...q,
      intent: coerceIntent(q.intent),
    })),
  }));

/**
 * Map any intent label the router emits to the canonical enum.
 * Unknown values fall back to "general" (the broadest, safest pool).
 */
export function coerceIntent(raw: string): SearchDecision["queries"][number]["intent"] {
  const known: SearchDecision["queries"][number]["intent"][] = [
    "general", "news", "docs", "code", "academic", "forum",
  ];
  const lower = raw.toLowerCase().trim();
  for (const k of known) {
    if (lower === k || lower.startsWith(k)) return k;
  }
  // Fuzzy matches for common off-enum labels the gate model emits.
  if (lower.includes("news") || lower.includes("current") || lower.includes("breaking"))
    return "news";
  if (lower.includes("doc") || lower.includes("manual") || lower.includes("reference"))
    return "docs";
  if (lower.includes("code") || lower.includes("program") || lower.includes("bug"))
    return "code";
  if (lower.includes("acad") || lower.includes("research") || lower.includes("science"))
    return "academic";
  if (lower.includes("forum") || lower.includes("community") || lower.includes("reddit"))
    return "forum";
  return "general";
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  publishedDate?: string;
  rank: number;
}

export interface EvidencePassage {
  sourceId: string; // "S1", "S2", ...
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
  passageText: string;
  bm25Score: number;
}

/** A normalized result from ANY search source, after URL cleanup + dedup. */
export interface NormalizedResult {
  url: string;
  canonical: string;
  title: string;
  snippet: string;
  engine: string;
  publishedDate?: string;
  domain: string;
  /**
   * §19 provenance stamp — how this candidate entered the pool. Stamped at
   * the single merge/normalization points (metasearch fuse, Stage-0 direct
   * targets); downstream ranking reads it but never rewrites it.
   *  - "search": surfaced by an engine (SERP / vertical / news / fallback)
   *  - "user": the URL came from the user's own prompt (direct-target hop)
   *  - "retrieval": entered via an already-approved fetch (link expansion)
   *  - "config": injected by operator configuration (preferred domains)
   */
  origin?: "search" | "user" | "retrieval" | "config";
}

export interface RankedResult extends NormalizedResult {
  /** RRF score — higher = better. */
  rrf: number;
  /** Which engines surfaced this URL (for corroboration display). */
  engines: string[];
  /** Rank in each engine that returned this result. */
  engineRanks: Record<string, number>;
}

export interface EvidencePacket {
  sourceId: string;
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
  extraction: "direct" | "jina-fallback" | "snippet-only";
  passages: EvidencePassage[];
  /**
   * Stress-test classification of THIS packet, set by extractUrl().
   * One of the canonical categories:
   *   SUCCESS_DIRECT, SUCCESS_ADAPTER, SUCCESS_METADATA,
   *   SUCCESS_JINA_FALLBACK, SUCCESS_SNIPPET_FALLBACK,
   *   SUCCESS_BROWSER, SUCCESS_REDIRECTED (landed on a different
   *   registrable site; url/domain carry the final site),
   *   FAIL_SILENT_BOT_BLOCK, FAIL_SILENT_LOGIN_WALL,
   *   FAIL_EMPTY_JS_SHELL, FAIL_NETWORK_OR_CRASH
   * Absent on packets that pre-date the stress-test upgrade.
   */
  classification?: string;
}

/** The exact context the search gate accepts. */
export interface SearchGateContext {
  userPrompt: string;
  /** A few preceding turns so a bare "what's new?" gets context. */
  history?: { role: string; content: string }[];
  /**
   * True when the turn carries an image/screenshot attachment. Enables the
   * Stage 0 image+lookup-intent bypass and pairs with the vision entity
   * pre-pass (Vision-to-Search) in the chat route.
   */
  hasImageAttachment?: boolean;
  /**
   * Part-10 APPROVED PARITY DEVIATION (attachment-aware gate): the CURRENT
   * turn carries attachment evidence (`attachment_ref` blocks — the same
   * flag the retrieval stage keys off). Consulted ONLY by the Stage-0
   * attachment-local suppression rule; absent/false ⇒ behavior is
   * byte-identical to the pre-deviation parity baseline. Mirrors the Rust
   * SearchGateContext field of the same name.
   */
  hasAttachmentEvidence?: boolean;
  /**
   * Part-10 APPROVED PARITY DEVIATION (universal search pre-gate): the
   * runtime date ("YYYY-MM-DD") the gate model should reason against.
   * NEVER hardcoded — when absent the gate falls back to the real clock
   * (`new Date()`), so staleness questions are judged against the actual
   * present; tests inject a fixed date so they never couple to the wall
   * clock. Mirrors the Rust SearchGateContext `current_date` field.
   */
  currentDate?: string;
  /**
   * Image data URLs attached to the user's turn (when hasImageAttachment).
   * Consumed by the Vision-to-Search entity pre-pass before query planning.
   */
  imageDataUrls?: string[];
  /**
   * Task-scope audit (2026-11-02, brief #1/#3/#6): the server-derived
   * operational scope for this turn (targets, intent, verified hosts).
   * Produced by foldTaskScope over the conversation's user turns — NEVER
   * by the model: gate/tool arguments cannot widen this contract.
   * Absent ⇒ callers derive from the prompt alone. Mirrors the Rust
   * SearchGateContext `scope` field.
   */
  scope?: import("../decision/task-scope").TaskScope;
}

export interface SearchGateResult {
  decision: SearchDecision;
  /**
   * Which authority produced the decision + query plan:
   *   "deterministic" — STAGE 0 hard bypass: the message names a URL, a
   *                  known domain/shortener, or an unambiguous web/freshness
   *                  intent (or an image + lookup intent). 0 ms, no LLM call.
   *   "main-model"  — the main LLM (settings.json llm_api_url). The ONLY
   *                  model authority: it decides for itself and writes
   *                  keyword-form, entity-anchored queries.
   *   "rules"       — deterministic emergency fallback (model unreachable).
   */
  source: "deterministic" | "main-model" | "rules";
  /** Milliseconds spent in the gate (0 when Stage 0 or rules short-circuited). */
  gateMs: number;
}
