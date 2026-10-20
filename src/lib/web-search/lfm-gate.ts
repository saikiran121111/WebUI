/**
 * Mandatory LFM decision gate.
 *
 * The contained decision-engine worker (:8790, LFM2.5-1.2B) runs a single
 * classification whose output is the ONLY thing that can authorize a web
 * search on this project. The main model never bypasses it:
 *
 *   1. Deterministic short-circuit: an explicit trigger phrase forces
 *      search_required=true regardless of LFM availability (fast path,
 *      zero tokens).
 *   2. LFM call → JSON in SearchDecisionSchema.
 *   3. Malformed JSON: strip fences + repair once; if still invalid →
 *      rule-based fallback plan (never a blank one).
 *   4. Hard 2500ms timeout → same rule-based fallback.
 */
import { childLogger } from "@/lib/server/logger";
import {
  LfmDecision,
  LfmGateContext,
  SearchDecision,
  SearchDecisionSchema,
} from "./types";

const log = childLogger("web-search/lfm-gate");

// The decision-engine worker on :8790 proxies LLM calls to the local
// Strata backend (llama.cpp OpenAI-compatible). When that worker is not
// running, fall back to hitting Strata directly on :8080 — the LFM model
// classification uses temperature 0 + JSON-only prompt so it's safe on
// either backend (the main qwen model handles it fine at 1.2B-equivalent
// prompt cost).
const LLM_ENDPOINT =
  process.env.WEB_SEARCH_LLM_ENDPOINT ??
  process.env.LLM_API_URL ??
  "http://127.0.0.1:8080/v1/chat/completions";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "no-key";

/**
 * Phrases that force a search even if the LLM path is unavailable.
 * Checked case-insensitively against the first 300 characters.
 */
const TRIGGER_PATTERNS: RegExp[] = [
  /search (the|my) (web|internet)\b/i,
  /\blatest\b/i,
  /\bwhat(?:'s| is) (new|current)\b/i,
  /\bc(urrent|urrent) (price|status|version|release)/i,
  /\bcurrent (price|status|version|release)/i,
  /\bnews (about|on|regarding|for)/i,
  /\brecent(ly)? (announced|released|launched|reported)/i,
  /\bwhat (was|are) (the|my) (news|latest)/i,
  /as of (today|now|this (week|month|year|day))/i,
  /\b(announced|released|launched|updated) (today|this (week|month|year|day)|recently)\b/i,
  /\bwho (won|took|earned|received) (the|an?) (last|most (recent|new))\b/i,
  /\b(current|newest)( (price|stock|exchange rate|rate|temperature|population|version|release|update))?\b/i,
  /\b(what|who|which|when)\s+(is|are|was|were|will)\s+(the|a|an)?\s*(newest|latest|current)\b/i,
];

/**
 * Phrases that strongly suggest NO web search is needed (deterministic
 * no-search short-circuit) — saves a full LLM call for the most common
 * static-knowledge cases: algorithms, math, CS concepts, history, science
 * fundamentals, "explain X" / "what is X" with a well-known noun.
 */
const NO_SEARCH_PATTERNS: RegExp[] = [
  /\bexplain\b.*\b(binary search|quick sort|quicksort|merge sort|heap sort|dijkstra|a\*|astar|dynamic programming|dp|recursion|stack|queue|linked list|tree|graph|hash table|hash map|b tree|trie|bit)\b/i,
  /\bwhat (is|are|was|were)\b.*\b(algorithm|complexity|big-?o|time complexity|space complexity|recursion|inversion)\b/i,
  /\bhow does\b.*\b(work|function|work in)\b/i,
  /\bdefine\b.*\b(the|a|an)?\b.*\b(term|concept|theory|law|principle)\b/i,
  /\b(derive|prove|show)\b\b.*\b(the|that|why)\b/i,
  /\bhistory of\b.*\b(the|a|an)?\b.*\b(ancient|medieval|classical|russian|greek|roman|egyptian|chinese|indian)\b/i,
  /\bwhat (is|are)\b.*\b(water|gravity|light|electricity|magnetism|photosynthesis|cellular respiration|dna|rna|protein|atom|molecule|electron|proton|neutron)\b/i,
];

/**
 * The exact system prompt the LLM sees. Compact, deterministic, and it
 * demands only the JSON — no preamble, no reasoning.
 */
const LLM_SYSTEM_PROMPT = `You are a search-routing classifier.
Given the user's question, decide whether a live web search is required to
answer it accurately, and produce the search queries.

Answer with ONLY valid JSON matching:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"recent"|"current",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Rules:
- search_required=true ONLY when the answer depends on facts that change,
  are time-specific, or are not in your training data. Static knowledge
  (algorithms, math, history, concepts, general "how" questions) → false.
- freshness: "current" if the question is about today/this-week; "recent"
  if the last month or quarter matters; "none" otherwise.
- depth: "quick" for a single fact, "standard" for a short comparison,
  "deep" for a multi-source research question.
- At most 5 queries. Each must be concrete, natural-language search phrasing
  (not keywords). preferred_domains is optional and for well-known domains
  only (wikipedia.org, github.com, developer.mozilla.org, arxiv.org, ...).
Do NOT add anything else to your output.`;

/* ── deterministic short-circuit ─────────────────────────────────────────── */

function triggerHit(prompt: string): boolean {
  const head = prompt.slice(0, 300).toLowerCase();
  return TRIGGER_PATTERNS.some((re) => re.test(head));
}

function noSearchHit(prompt: string): boolean {
  const head = prompt.slice(0, 300).toLowerCase();
  return NO_SEARCH_PATTERNS.some((re) => re.test(head));
}

/** Build a sensible default plan from the raw prompt when the LLM fails. */
export function rulesBasedPlan(ctx: LfmGateContext): LfmDecision {
  const p = ctx.userPrompt.trim();
  const hasTimeSignal = /latest|recent|new|current|today|this (week|month|year|quarter)/i.test(p);
  const hasVersion = /\bv?\d+\.\d+|version \d+/i.test(p);
  return {
    decision: {
      search_required: true,
      reason: "rule-based fallback: time/version signal detected",
      freshness: hasTimeSignal ? "current" : hasVersion ? "recent" : "none",
      depth: "standard",
      queries: [
        {
          query: p.replace(/\s+/g, " ").trim().slice(0, 200),
          intent: hasTimeSignal ? "news" : "general",
        },
      ],
    },
    source: "rules",
    lfmMs: 0,
  };
}

/** No-search rule fallback — when static knowledge clearly suffices. */
function noSearchPlan(ctx: LfmGateContext): LfmDecision {
  return {
    decision: {
      search_required: false,
      reason: "rule-based: static knowledge sufficient (no time/version signal)",
      freshness: "none",
      depth: "quick",
      queries: [],
    },
    source: "rules",
    lfmMs: 0,
  };
}

/* ── LLM call ───────────────────────────────────────────────────────────── */

function buildLlmMessages(ctx: LfmGateContext): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [
    { role: "system", content: LLM_SYSTEM_PROMPT },
  ];
  if (ctx.history?.length) {
    // Cap the context so the router stays cheap and fast.
    for (const m of ctx.history.slice(-4)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  msgs.push({ role: "user", content: ctx.userPrompt.slice(0, 1000) });
  return msgs;
}

function stripAndRepair(raw: string): string {
  // Remove markdown fences if the model wrapped the JSON, strip
  // any reasoning prefix up to the first {.
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const braceStart = s.indexOf("{");
  if (braceStart > 0) s = s.slice(braceStart);
  return s;
}

/**
 * Call the contained LLM worker and parse the JSON decision.
 * Falls back to the rule-based plan on any failure path.
 */
async function callLlm(ctx: LfmGateContext, timeoutMs = 2500): Promise<LfmDecision | null> {
  const t0 = performance.now();
  let raw: string;
  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY,
      },
      body: JSON.stringify({
        model: "default",
        messages: buildLlmMessages(ctx),
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "llm engine non-200 → rule fallback");
      return null;
    }
    const data: any = await res.json();
    raw = data?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    log.warn({ err: (e as Error).message }, "llm engine unreachable → rule fallback");
    return null;
  }

  const cleaned = stripAndRepair(raw);
  const parsed = SearchDecisionSchema.safeParse(JSON.parse(cleaned));
  if (!parsed.success) {
    // One repair pass: re-try JSON.parse on the raw unmodified string.
    try {
      const reparsed = SearchDecisionSchema.safeParse(JSON.parse(raw.trim()));
      if (reparsed.success) {
        return {
          decision: reparsed.data,
          source: "lfm",
          lfmMs: Math.round(performance.now() - t0),
        };
      }
    } catch {
      /* fall through */
    }
    log.warn({ raw: raw.slice(0, 300) }, "schema mismatch → rule fallback");
    return null;
  }
  return { decision: parsed.data, source: "lfm", lfmMs: Math.round(performance.now() - t0) };
}

/* ── public API ──────────────────────────────────────────────────────────── */

export async function runLfmGate(ctx: LfmGateContext): Promise<LfmDecision> {
  // Fast path: deterministic trigger → no LLM call, zero tokens.
  if (triggerHit(ctx.userPrompt)) {
    const plan = rulesBasedPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 80) }, "trigger hit → forced search");
    return plan;
  }

  // No-search fast path: static-knowledge question → answer without web.
  if (noSearchHit(ctx.userPrompt)) {
    const plan = noSearchPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 80) }, "no-search rule hit → skip");
    return plan;
  }

  const llm = await callLlm(ctx);
  if (llm) return llm;

  // No trigger phrase AND no LLM decision: the LLM timed out or failed, so
  // fall back to the rule-based plan for this prompt's shape.
  return rulesBasedPlan(ctx);
}
