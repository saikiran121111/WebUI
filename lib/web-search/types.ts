import { z } from "zod";

export const SearchDecisionSchema = z
  .object({
    search_required: z.boolean(),
    reason: z.string(),
    freshness: z.enum(["none", "day", "week", "month", "year", "any"]),
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
  .refine((d) => d.search_required || d.queries.length > 0, {
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
 * Backward-compatible parser: accepts both the legacy 3-value freshness
 * (none/recent/current) and the new 6-value set. Old cache entries and
 * old model outputs are still valid.
 *
 * `intent` is intentionally parsed as a free string first, then coerced
 * to the canonical enum (unknown values → "general"). The small LFM
 * router on :8791 occasionally emits free-form intent labels like
 * "restaurant recommendation"; coercing instead of rejecting keeps the
 * fast path usable rather than falling through to :8080 for ~5s.
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
  // Fuzzy matches for common off-enum labels the LFM router emits.
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
   *   FAIL_SILENT_BOT_BLOCK, FAIL_SILENT_LOGIN_WALL,
   *   FAIL_EMPTY_JS_SHELL, FAIL_NETWORK_OR_CRASH
   * Absent on packets that pre-date the stress-test upgrade.
   */
  classification?: string;
}

/** The exact context the LFM gate accepts. */
export interface LfmGateContext {
  userPrompt: string;
  /** A few preceding turns so a bare "what's new?" gets context. */
  history?: { role: string; content: string }[];
}

export interface LfmDecision {
  decision: SearchDecision;
  /**
   * Which authority produced the decision + query plan:
   *   "main-model" — the main LLM on :8080. AUTHORITATIVE: it decides for
   *                  itself and writes keyword-form, entity-anchored
   *                  queries (measured 100% on scripts/eval-search-gate.mjs).
   *   "lfm"        — the LFM2.5-1.2B router on :8791. Fallback path, used
   *                  only when the main model is unreachable: it measured
   *                  55% (13 FP / 7 FN) and must never veto the main model.
   *   "rules"      — deterministic emergency fallback (all endpoints down).
   */
  source: "main-model" | "lfm" | "rules";
  /** Milliseconds spent in the gate (0 when rules short-circuited). */
  lfmMs: number;
  /** The informational LFM2.5 verdict, when it answered (null = unreachable). */
  lfmVerdict?: boolean | null;
  /** Whether the informational LFM verdict matched the authoritative one. */
  agreement?: "agree" | "disagree" | "lfm-unavailable";
}
