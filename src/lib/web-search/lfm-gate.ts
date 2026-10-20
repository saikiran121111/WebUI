/**
 * Mandatory LFM decision gate.
 *
 * The LLM router is the ONLY authority that can authorize or deny a web
 * search on this project. Deterministic rules are emergency fallbacks
 * ONLY — fired when the local LLM server is completely unreachable after
 * the full 60-second timeout window.
 *
 *   1. Trivial 1-2 word greetings ("hi", "hello", "thanks") → no-search
 *      short-circuit (zero tokens, zero risk).
 *   2. Explicit URL in the prompt → force search_required=true and
 *      guarantee that URL is in the plan.
 *   3. LLM call (60s timeout) → JSON in SearchDecisionSchemaCompat.
 *   4. Malformed JSON: strip fences + repair once; if still invalid →
 *      rule-based fallback plan (never a blank one).
 *   5. 60s LLM timeout → rule-based fallback plan.
 */
import { childLogger } from "@/lib/server/logger";
import {
  LfmDecision,
  LfmGateContext,
  SearchDecision,
  SearchDecisionSchemaCompat,
} from "./types";

const log = childLogger("web-search/lfm-gate");

// The local Strata backend (llama.cpp OpenAI-compatible) may queue
// requests when the model is cold-starting. Never abort the LFM call
// at <30s — 60s is the minimum sane window for a 1.2B model to
// finish a classification.
const LLM_ENDPOINT =
  process.env.WEB_SEARCH_LLM_ENDPOINT ??
  process.env.LLM_API_URL ??
  "http://127.0.0.1:8080/v1/chat/completions";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "no-key";

/** 60-second ceiling: local LLM servers queue + cold-load; 2.5s was far too aggressive. */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Ceiling for the CLASSIFIER call only. The classifier is a 1.2B model at
 * temperature 0 answering a 4-line JSON verdict — 45s is 30× longer than a
 * warm 5s call. 60s existed for cold-start queues, but combined with the
 * rule-based fallback (which forces search_required=true on ANY non-200,
 * timeout, or invalid JSON) it turns a flaky inference slot into a forced
 * web search on ordinary chat. 30s keeps the generous cold-start window
 * while bounding worst-case latency on the hot path.
 */
const CLASSIFIER_TIMEOUT_MS = 30_000;

/* ── trivial greeting short-circuit (the ONLY regex that survives) ───── */

const TRIVIAL_GREETINGS = new Set([
  "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "thx",
  "ok", "okay", "cool", "nice", "got it", "sounds good", "bye", "goodbye",
]);

function isTrivialGreeting(prompt: string): boolean {
  return TRIVIAL_GREETINGS.has(prompt.trim().toLowerCase());
}

/** Detect an explicit http:// or https:// URL in the user prompt. */
export function extractPromptUrls(prompt: string): string[] {
  const m = prompt.match(/https?:\/\/[^\s"'<>[\]]+/gi);
  return m ? [...new Set(m)] : [];
}

/* ── deterministic fallback plans (emergency only) ───────────────────── */

export function rulesBasedPlan(ctx: LfmGateContext): LfmDecision {
  const p = ctx.userPrompt.trim();
  const hasTimeSignal = /latest|recent|new|current|today|this (week|month|year|quarter)/i.test(p);
  const hasVersion = /\bv?\d+\.\d+|version \d+/i.test(p);
  const urls = extractPromptUrls(p);
  const queries: SearchDecision["queries"] = [
    {
      query: p.replace(/\s+/g, " ").trim().slice(0, 300),
      intent: (hasTimeSignal ? "news" : "general") as SearchDecision["queries"][number]["intent"],
    },
  ];
  for (const u of urls.slice(0, 3)) {
    queries.push({ query: u, intent: "general" });
  }
  return {
    decision: {
      search_required: true,
      reason: "rule-based fallback: LLM unreachable after 60s",
      freshness: hasTimeSignal ? "day" : hasVersion ? "month" : "any",
      depth: "standard",
      queries,
    },
    source: "rules",
    lfmMs: 0,
  };
}

function noSearchPlan(ctx: LfmGateContext): LfmDecision {
  void ctx;
  return {
    decision: {
      search_required: false,
      reason: "trivial greeting — no web content needed",
      freshness: "none",
      depth: "quick",
      queries: [],
    },
    source: "rules",
    lfmMs: 0,
  };
}

/* ── LLM call ─────────────────────────────────────────────────────────── */

function buildLlmMessages(ctx: LfmGateContext): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [
    { role: "system", content: LLM_SYSTEM_PROMPT },
  ];
  if (ctx.history?.length) {
    // The last 3 turns give the router enough context to decide without
    // flooding the prompt; 300-char cap per turn keeps it cheap.
    for (const m of ctx.history.slice(-3)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  msgs.push({ role: "user", content: ctx.userPrompt.slice(0, 2000) });
  return msgs;
}

/**
 * The exact system prompt the LLM sees. Compact, deterministic, and it
 * demands only the JSON — no preamble, no reasoning.
 *
 * The LLM must produce:
 *   1. shouldSearch (search_required): true when live facts are needed
 *   2. searchDepth: quick / standard / deep
 *   3. queries: 2-5 high-recall queries generated from the prompt + history
 *   4. freshness: day / week / month / year / any
 */
const LLM_SYSTEM_PROMPT = `You are a search-routing classifier.
Given the user's question (and recent conversation history), decide whether a
live web search is required to answer it accurately, and produce the search
queries.

Answer with ONLY valid JSON matching:
{"search_required": boolean, "reason": string,
 "freshness": "day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Rules:
- search_required=true when the answer depends on facts that change over time
  (news, prices, versions, releases, weather, sports scores, current events)
  OR when the user explicitly references a URL, a specific document, or a
  product with versioned attributes.
- search_required=false ONLY for static knowledge: algorithms, math proofs,
  well-known scientific concepts, history before 2020, general "how X works"
  explanations, coding concepts with no time-specific version constraint.
- freshness: "any" by DEFAULT for all queries EXCEPT when the user
  explicitly asks for breaking news, "today/this week/latest release",
  live sports scores, current weather, or current stock/crypto prices.
  Never use "day"/"week"/"month" for local places, product recommendations,
  jobs, reviews, or evergreen knowledge — a 30-day filter drops 99% of
  relevant pages on those query types.
- depth: "quick" for a single fact; "standard" for a short comparison;
  "deep" for a multi-source research question.
- 2-5 queries. Each must be a natural-language search phrasing (not keywords).
  Use the user's own terminology for proper nouns / version numbers — do not
  paraphrase them. Include the user's full question as one query verbatim
  (so search engines match the exact phrasing).
- If the user's prompt contains an explicit URL (http:// or https://), include
  that URL as one of the queries with intent "general".
Do NOT add anything else to your output.`;

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
 * Call the local LLM and parse the JSON decision.
 * 30-second timeout: 60s existed for cold-start queues, but the rule-based
 * fallback (search_required=true) fires on ANY timeout/non-200/invalid
 * JSON — so a stalled inference slot silently forced web searches on
 * ordinary chat. 30s keeps a generous cold-start window while bounding
 * hot-path latency. The fallback stays a rule-based plan, NOT a
 * no-search default.
 */
export async function callLlm(
  ctx: LfmGateContext,
  timeoutMs: number = CLASSIFIER_TIMEOUT_MS,
): Promise<LfmDecision | null> {
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
    if (typeof raw !== "string" || raw.trim() === "") {
      // A thinking model can return null/empty content even when the call
      // itself succeeded (the reason is in reasoning_content, not content).
      // Without this guard, JSON.parse("") falls through to the rule-based
      // fallback, which forces search_required=true — i.e. the gate silently
      // denies the LLM's no-search verdicts.
      log.warn({ content: raw, finishReason: data?.choices?.[0]?.finish_reason }, "llm returned empty content");
      return null;
    }
  } catch (e) {
    log.warn(
      { err: (e as Error).message, timeoutMs },
      "llm engine unreachable after timeout → rule fallback",
    );
    return null;
  }

  const cleaned = stripAndRepair(raw);
  let parsed = SearchDecisionSchemaCompat.safeParse(JSON.parse(cleaned));
  if (parsed.success) {
    const decision = parsed.data;
    // Force search_required=true when the prompt has an explicit URL —
    // even if the LLM said otherwise (URLs always warrant extraction).
    const urls = extractPromptUrls(ctx.userPrompt);
    const finalDecision: SearchDecision =
      urls.length > 0 && !decision.search_required
        ? { ...decision, search_required: true }
        : decision;
    // Ensure the URL queries are present
    if (urls.length > 0) {
      const existing = new Set(finalDecision.queries.map((q) => q.query));
      for (const u of urls) {
        if (!existing.has(u)) {
          finalDecision.queries.push({ query: u, intent: "general" });
        }
      }
    }
    return {
      decision: finalDecision,
      source: "lfm",
      lfmMs: Math.round(performance.now() - t0),
    };
  }

  // One repair pass: re-try JSON.parse on the raw unmodified string.
  try {
    const reparsed = SearchDecisionSchemaCompat.safeParse(JSON.parse(raw.trim()));
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

/* ── public API ────────────────────────────────────────────────────────── */

export async function runLfmGate(ctx: LfmGateContext): Promise<LfmDecision> {
  // Fast path: trivial greeting → no LLM call, zero tokens.
  if (isTrivialGreeting(ctx.userPrompt)) {
    const plan = noSearchPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "trivial greeting → skip");
    return plan;
  }

  const llm = await callLlm(ctx);
  if (llm) {
    // Explicit URLs always force search — the LLM may have said no-search
    // but a URL in the prompt is a hard constraint: extract it in full.
    const urls = extractPromptUrls(ctx.userPrompt);
    if (urls.length > 0 && !llm.decision.search_required) {
      log.info({ urls }, "explicit URL detected → forcing search");
      llm.decision.search_required = true;
      for (const u of urls) {
        if (!llm.decision.queries.some((q) => q.query === u)) {
          llm.decision.queries.push({ query: u, intent: "general" });
        }
      }
    }
    return llm;
  }

  // No LLM decision: fall back to the rule-based plan. This path is only
  // reached when the local LLM server is unreachable after the full 60s.
  const plan = rulesBasedPlan(ctx);
  log.warn({ prompt: ctx.userPrompt.slice(0, 80) }, "rule-based fallback (LLM unavailable)");
  return plan;
}
