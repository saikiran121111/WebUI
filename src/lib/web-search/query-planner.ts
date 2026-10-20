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
 *
 * After extraction + BM25, the Coverage & Gap Evaluator scores how well
 * the retrieved evidence covers the query's entities. If coverage is
 * weak OR a key entity has zero lexical hits, one fast 2nd-hop targeted
 * search fires (the LLM gate is re-run with the missing entity as a
 * constrained query, so the main model never bypasses the gate).
 */
import type { SearchPlan } from "./metasearch";
import type { LfmGateContext, LfmDecision, SearchDecision } from "./types";
import { runLfmGate } from "./lfm-gate";
import { metasearch } from "./metasearch";
import { tokenize } from "./reranker";

type LfmQuery = SearchDecision["queries"][number];

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
  if (/\bsite\s*:\s*github\.com\b|github|repo(sitory)?\s+(page)?\b/.test(p)) return "github";
  if (/\bdocs?\b|documentation|manual|guide|reference|readme/.test(p)) return "docs";
  if (/\breview|rating|versus|vs\b|comparison|benchmark/.test(p)) return "review";
  if (/\bpricing|price|cost|plans?|subscription\b/.test(p)) return "pricing";
  return null;
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
  origin: "semantic" | "entity" | "targeted" | "gap";
  /** Freshness filter carried from the LFM decision to the search engine. */
  freshness?: "none" | "day" | "week" | "month" | "year" | "any";
}

/**
 * Decompose the user prompt into 2–4 orthogonal sub-queries.
 *
 * The planner is deterministic (no LLM call — the LLM gate has already
 * classified search_required on the raw prompt). It splits on entity
 * density: a prompt with 3+ distinct entities gets an entity query and a
 * targeted-source query in addition to the broad semantic query.
 */
export function planQueries(
  userPrompt: string,
  lfmQueries: LfmQuery[],
): PlannedQuery[] {
  const plans: PlannedQuery[] = [];

  // 1. Broad semantic query — use the LLM's own queries if it produced
  // them, else the raw prompt (capped at 200 chars so the engine pool
  // gets a clean string).
  for (const q of lfmQueries.slice(0, 2)) {
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

  const entities = extractEntities(userPrompt);
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
    }
    if (opQuery) {
      plans.push({ query: opQuery, intent: opIntent, preferredDomains: domains, origin: "targeted" });
    }
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
 * Run the LLM gate against a gap query so the 2nd hop stays inside the
 * gate's policy (the main model can't bypass the LLM gate even on a
 * follow-up targeted search). Returns the gate decision, which the
 * pipeline will use to fire `metasearch` on the gap query only.
 */
export async function gapSearchDecision(
  gapQuery: string,
  userPrompt: string,
): Promise<LfmDecision> {
  return runLfmGate({ userPrompt: userPrompt + " " + gapQuery });
}

/**
 * Convenience: run the gap search's metasearch directly (already
 * validated by the LLM gate upstream).
 */
export async function runGapMetasearch(
  gapQuery: string,
): Promise<import("./metasearch").RankedResult[]> {
  const cls = sourceClass(gapQuery);
  const intent: import("./metasearch").SearchPlan["intent"] =
    cls === "github" ? "code" : cls === "pdf" ? "academic" : "general";
  return metasearch([{ query: gapQuery, intent }], 8);
}
