import { z } from "zod";

export const SearchDecisionSchema = z.object({
  search_required: z.boolean(),
  reason: z.string(),
  freshness: z.enum(["none", "recent", "current"]),
  depth: z.enum(["quick", "standard", "deep"]),
  queries: z.array(
    z.object({
      query: z.string(),
      intent: z.enum(["general", "news", "docs", "code", "academic", "forum"]),
      preferred_domains: z.array(z.string()).optional(),
    }),
  ).max(5),
});

export type SearchDecision = z.infer<typeof SearchDecisionSchema>;

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
