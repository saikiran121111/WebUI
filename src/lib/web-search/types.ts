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
        intent: z.enum(["general", "news", "docs", "code", "academic", "forum"]),
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
  }));

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
  source: "lfm" | "rules";
  /** Milliseconds spent in the LFM call (0 when rules short-circuited). */
  lfmMs: number;
}
