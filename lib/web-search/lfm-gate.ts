/**
 * Web-search gate — main-model-only edition (2026-10-22).
 *
 * The decision is made by exactly ONE authority: the main model on :8080,
 * asked "do YOU need live web data to answer the latest message, and if so
 * write the queries". That is the whole gate:
 *
 *   1. Trivial 1-2 word greetings ("hi", "hello", "thanks") → no-search
 *      short-circuit (zero tokens, zero risk).
 *   2. Explicit URL in the prompt → force search_required=true and
 *      guarantee that URL is in the plan.
 *   3. Main-model gate (one JSON call, 35s ceiling): {search_required,
 *      reason, freshness, depth, queries[]}.
 *   4. Main model unreachable / unparseable → rule-based fallback: a
 *      substantive prompt gets a search plan (never a silent drop), a
 *      trivial one gets no-search.
 *
 * The LFM2.5-1.2B router (:8791) is NO LONGER part of this gate. It is a
 * weak decider (55% on the 44-scenario eval) and its "when to search" calls
 * keep misfiring on chit-chat follow-ups ("what are you doing?" after a
 * shopping thread became an "Honor 200 5G — Current events" search). The
 * user's decision: leave it to the main model — if it needs the internet it
 * goes; if not, it doesn't. No second router, no deterministic escalation,
 * no verification adjudication of the gate itself.
 *
 * Historical note: the deleted LFM stage-1/stage-2 fallback chain and the
 * "deterministic follow-up escalation" (isContextFollowUp /
 * followUpSearchPlan) lived here until 2026-10-22. Their shape pins moved
 * to __tests__/web-search/main-gate.test.ts, which now tests the rule-based
 * no-escalation behavior directly.
 */
import { childLogger } from "@/lib/server/logger";
import {
  LfmDecision,
  LfmGateContext,
  SearchDecision,
  SearchDecisionSchemaCompat,
} from "./types";

const log = childLogger("web-search/lfm-gate");

const LLM_ENDPOINT =
  process.env.WEB_SEARCH_LLM_ENDPOINT ??
  process.env.LLM_API_URL ??
  "http://127.0.0.1:8080/v1/chat/completions";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "no-key";

/**
 * Ceiling for the AUTHORITATIVE main-model gate call. It emits a full
 * decision + query plan (~150 tokens measured) so it needs more headroom
 * than a boolean check. Measured warm latency on :8080 is ~2.5-5s — the
 * price of a gate the main model writes for itself.
 */
const MAIN_GATE_TIMEOUT_MS = 35_000;
const MAIN_GATE_MAX_TOKENS = 320;

/**
 * The full SearchDecision schema (legacy name kept: llama.cpp's structured
 * output reads the top-level `json_schema`, the 1.2B router is gone but the
 * :8080 endpoint still accepts `response_format`).
 */
const LFM_JSON_SCHEMA = {
  type: "object",
  properties: {
    search_required: { type: "boolean" },
    reason: { type: "string" },
    freshness: { type: "string", enum: ["none", "day", "week", "month", "year", "any"] },
    depth: { type: "string", enum: ["quick", "standard", "deep"] },
    queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          intent: { type: "string", enum: ["general", "news", "docs", "code", "academic", "forum"] },
          preferred_domains: { type: "array", items: { type: "string" } },
        },
        required: ["query", "intent"],
      },
    },
  },
  required: ["search_required", "reason", "freshness", "depth", "queries"],
} as const;

/* ── trivial prompt short-circuit (the ONLY regex that survives) ─────── */

/**
 * Trivial prompts — the ONLY deterministic layer in the gate. A match skips
 * the LLM call entirely (zero latency, zero tokens).
 *
 * Two shapes:
 *   1. exact-match after stripping trailing punctuation: "hi", "thanks",
 *      "which model are you", "who are you", ...
 *   2. prefix-match (length ≤ 48): "By the way which model are you" hits
 *      because it ends with "which model are you" and starts with the
 *      chit-chat filler "By the way ...".
 *
 * The prefix rule covers the real bug the user hit on 2026-10-22:
 * "By the way which model are you" (a pure assistant-identity question with
 * the chit-chat filler "By the way" in front) fired a full web search of
 * "Which Model You — Web research" and answered with "I'm Qwen" after
 * burning 10 junk sources. The filler prefix must not push a simple
 * identity question past the cheap layer.
 */
const TRIVIAL_EXACT = new Set([
  // greetings
  "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "thx",
  "ok", "okay", "cool", "nice", "got it", "sounds good", "bye", "goodbye",
  // assistant-identity / pure chit-chat
  "what are you doing", "what are you up to",
  "which model are you", "what model are you", "who are you",
  "who made you", "who created you", "what are you", "are you alive",
  "how do you work", "how are you", "what can you do",
]);

/**
 * Chit-chat fillers that may PREPEND an identity question without changing
 * its meaning. "By the way which model are you" is still "which model are
 * you" — the filler never adds research value.
 */
const TRIVIAL_FILLER_PREFIX = /^(?:by the way|so|anyway|then|oh|hmm|hi|hey|hello|thanks|thank you)\s+/i;

function isTrivialPrompt(prompt: string): boolean {
  let p = prompt.trim().toLowerCase();
  // Strip trailing punctuation/whitespace so "hi!" == "hi".
  p = p.replace(/[.!?…\s]+$/, "");
  if (TRIVIAL_EXACT.has(p)) return true;
  // Peel one chit-chat filler off the front ("By the way which model are you"
  // → "which model are you") and re-test. One peel is enough: stacking two
  // fillers is not a real pattern the user actually writes.
  const peeled = p.replace(TRIVIAL_FILLER_PREFIX, "");
  if (peeled !== p && TRIVIAL_EXACT.has(peeled)) return true;
  return false;
}

/**
 * "Is this a real research question?" heuristic — documentation only.
 *
 * Historically this decided the emergency rule-based SEARCH fallback. The
 * user's 2026-10-22 decision removed that fallback: when the main model is
 * unreachable, the turn gets NO search and the model answers from its own
 * knowledge (a forced junk search on a casual turn is the failure this
 * project has now seen three times). Kept in this file as the shape
 * reference for the conservative-no-search policy.
 */
export function isSubstantivePrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length === 0) return false;
  if (extractPromptUrls(p).length > 0) return true;
  if (/\b\d+\.\d+\b|version\b/i.test(p)) return true;
  if (/\?[^\w]/.test(p)) return true;
  const proper = p.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  if (proper.length > 0) return true;
  return false;
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
      reason: "rule-based fallback: main model unreachable",
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
      reason: "trivial prompt — no web content needed",
      freshness: "none",
      depth: "quick",
      queries: [],
    },
    source: "rules",
    lfmMs: 0,
  };
}

/* ── LLM call ─────────────────────────────────────────────────────────── */

/**
 * Thinking-model safety: the body always carries `reasoning_effort: "none"`
 * so a thinking backend cannot burn its whole budget into
 * `reasoning_content` and return `content: null`. We still recover a JSON
 * verdict from BOTH fields.
 */
import { THINKING_OFF_BODY } from "./llm-json";

const MAIN_GATE_SYSTEM_PROMPT = `You are the search router for your own answering pipeline.
Decide whether YOU need live web data to answer the user's latest message
accurately, and — if yes — write the web search queries.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Decision rules (check yourself honestly):
- search_required = false when you can answer reliably from your own
  knowledge: greetings, chitchat, questions about the ASSISTANT ITSELF
  ("what are you doing", "which model are you", "who are you"), coding
  problems and algorithm questions you know, math, writing, translation,
  explanations of concepts, static facts, and library APIs you are
  confident about. For assistant chitchat / static knowledge answer
  {"search_required": false, "reason": "assistant chitchat or static
  knowledge", "freshness": "none", "depth": "quick", "queries": []}.
- search_required = true when the answer depends on facts that change over
  time (news, prices, stock/crypto rates, weather, sports results,
  releases, product availability, local places/businesses, current
  events), OR when the user asks about a specific entity, problem,
  version, or document that you CANNOT recall with confidence. If you are
  unsure whether you actually know the exact details of a specific named
  thing, search.
- If the message contains an explicit URL, search_required = true.
- The conversation history above is part of the request. A FOLLOW-UP turn
  that asks for a direct LINK/URL or "where to buy|watch|read|apply|
  download", or for the CURRENT availability/stock/price/open-closed
  status of something earlier in the conversation, or for details/reviews
  of an entity you recommended: search_required = true — you cannot know
  whether a page is still live or in stock, and you must never write the
  link yourself. Resolve "it / this / that" against the history first.
- A NEW, unrelated question ("what are you doing?", a chit-chat follow-up,
  a personal question about the assistant) is NOT a follow-up on the
  conversation's entities: answer it from your own knowledge, no search.

Query rules (only when search_required = true):
- 2-4 queries. KEYWORD FORM, not full sentences. Never paste the user's
  question verbatim; never write a query that is only stopwords or generic
  phrasing.
- Anchor every query on the concrete entities of the request (names,
  numbers, products, places) plus at most one topic word.
- Example good: ["NVIDIA stock price", "NVDA share price today"].
  Example bad: ["What is the minimum number of cuts needed to partition
  the string so that each part is a palindrome"].
- Use the user's exact terminology for proper nouns and version numbers.
- On follow-up turns, anchor every query on the RESOLVED entity name in
  exact quotes: ["Honor 200 5G" site:amazon.in, "Honor 200 5G" price buy
  India] — the site: form when the user or the conversation has named the
  store/platform, the topic form ("price buy", "apply", "reviews open")
  otherwise.
- Set preferred_domains when an authoritative source is obvious.
- freshness = "any" unless the fact is explicitly live (breaking news,
  today's price/weather/score). depth: "quick" single fact, "standard"
  comparison, "deep" multi-source research.
Do NOT add anything else to your output.`;

function buildMainGateMessages(ctx: LfmGateContext): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [
    { role: "system", content: MAIN_GATE_SYSTEM_PROMPT },
  ];
  if (ctx.history?.length) {
    // Follow-up turns ("and its price today?") need the same history view
    // the answer gets; 4 turns / 300 chars keeps the gate call cheap.
    for (const m of ctx.history.slice(-4)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  msgs.push({ role: "user", content: ctx.userPrompt.slice(0, 2000) });
  return msgs;
}

function stripAndRepair(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const braceStart = s.indexOf("{");
  if (braceStart > 0) s = s.slice(braceStart);
  return s;
}

/**
 * Call the main-model gate endpoint and parse the JSON decision.
 * Returns a parsed SearchDecision on success, or null on any of: non-200,
 * timeout, unparseable JSON, or an empty-content + empty-reasoning
 * failure. The caller (runLfmGate) then falls back to the rules.
 */
async function mainModelGate(ctx: LfmGateContext): Promise<SearchDecision | null> {
  const body: Record<string, unknown> = {
    model: "default",
    messages: buildMainGateMessages(ctx),
    temperature: 0,
    ...THINKING_OFF_BODY,
    max_tokens: MAIN_GATE_MAX_TOKENS,
  };

  let content = "";
  let reasoning = "";
  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MAIN_GATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "gate non-200");
      return null;
    }
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    content = typeof msg.content === "string" ? msg.content : "";
    reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
  } catch (e: unknown) {
    const err = e as { message: string };
    log.warn({ err: err.message, timeoutMs: MAIN_GATE_TIMEOUT_MS }, "gate unreachable / timeout");
    return null;
  }

  for (const raw of [content, reasoning]) {
    const decision = parseMainGateJson(raw, ctx);
    if (decision) return decision;
  }
  log.warn(
    { content: content.slice(0, 120), reasoning: reasoning.slice(0, 120) },
    "main-model gate produced no parseable verdict",
  );
  return null;
}

/**
 * Parse the main model's combined verdict+plan. A `search_required: false`
 * answer is a first-class outcome (the model knows it can answer from its
 * own context) — not a failure. Explicit prompt URLs are still force-added.
 */
function parseMainGateJson(raw: string, ctx: LfmGateContext): SearchDecision | null {
  if (!raw || raw.trim() === "") return null;
  for (const cand of [stripAndRepair(raw), raw.trim()]) {
    try {
      const parsed = JSON.parse(cand);
      if (typeof parsed?.search_required !== "boolean") continue;

      if (!parsed.search_required) {
        return {
          search_required: false,
          reason: String(parsed.reason ?? "main model: no live web content needed").slice(0, 300),
          freshness: "none",
          depth: "quick",
          queries: [],
        };
      }

      const queries: SearchDecision["queries"] = Array.isArray(parsed.queries)
        ? parsed.queries
            .map((q: any) => ({
              query: String(q?.query ?? "").trim(),
              intent: (["general", "news", "docs", "code", "academic", "forum"].includes(q?.intent)
                ? q.intent
                : "general") as SearchDecision["queries"][number]["intent"],
              ...(Array.isArray(q?.preferred_domains) ? { preferred_domains: q.preferred_domains } : {}),
            }))
            .filter((q: SearchDecision["queries"][number]) => q.query.length > 0)
        : [];

      const urls = extractPromptUrls(ctx.userPrompt);
      for (const u of urls) {
        if (!queries.some((q) => q.query === u)) queries.push({ query: u, intent: "general" });
      }
      // A "yes" with no usable queries still has to search — keep the
      // prompt-derived query as the last resort (the per-result lexical
      // floor in metasearch() keeps it from surfacing junk).
      if (queries.length === 0) {
        queries.push({ query: ctx.userPrompt.replace(/\s+/g, " ").trim().slice(0, 300), intent: "general" });
      }

      return {
        search_required: true,
        reason: String(parsed.reason ?? "main model: live web content needed").slice(0, 300),
        freshness: (["none", "day", "week", "month", "year", "any"].includes(parsed.freshness)
          ? parsed.freshness
          : "any") as SearchDecision["freshness"],
        depth: (["quick", "standard", "deep"].includes(parsed.depth)
          ? parsed.depth
          : "standard") as SearchDecision["depth"],
        queries,
      };
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Back-compatible entry point (kept for external callers/exports): returns
 * just the decision. `runLfmGate` is the public API that also reports
 * which authority decided.
 */
export async function callLlm(ctx: LfmGateContext): Promise<SearchDecision | null> {
  const main = await mainModelGate(ctx);
  if (main) return main;
  // Main model failed: the user's decision is NO search-forcing fallback —
  // a turn the main model could not gate is answered from its own knowledge.
  return null;
}

/* ── public API ────────────────────────────────────────────────────────── */

/**
 * THE gate. One authority (the main model), no fallback search.
 *
 * Precedence (the user's 2026-10-22 decision — "leave it to the main
 * model; if it doesn't need the internet, it doesn't search"):
 *   1. trivial greeting / assistant-identity prompt → no-search, zero tokens
 *   2. main model says yes/no → that verdict, full stop
 *   3. main model unreachable / unparseable → NO-SEARCH, full stop. The
 *      answer is made from the model's own knowledge; a forced search here
 *      is exactly what produced the junk-source + apology turns.
 */
export async function runLfmGate(ctx: LfmGateContext): Promise<LfmDecision> {
  // Test / CI escape hatch: unit tests that pin the pipeline (chatEngine.
  // test.ts) run without a live LLM. When the flag is set, skip the network
  // call entirely — trivial prompts no-search, everything else searches from
  // its own prompt (the rules plan is the ONLY place rules may still win,
  // and it never runs in production).
  if (process.env.WEB_SEARCH_LFM_DISABLED === "1") {
    const plan = isTrivialPrompt(ctx.userPrompt)
      ? noSearchPlan(ctx)
      : rulesBasedPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "WEB_SEARCH_LFM_DISABLED → deterministic plan");
    return plan;
  }

  // Fast path: trivial prompt → no LLM call, zero tokens.
  if (isTrivialPrompt(ctx.userPrompt)) {
    const plan = noSearchPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "trivial prompt → skip (no search, zero latency)");
    return plan;
  }

  const t0 = performance.now();
  const main = await mainModelGate(ctx);
  if (main) {
    const out: LfmDecision = {
      decision: { ...main },
      source: "main-model",
      lfmMs: Math.round(performance.now() - t0),
    };
    log.info(
      {
        source: out.source,
        search_required: out.decision.search_required,
        gateMs: out.lfmMs,
      },
      "search gate verdict (main model)",
    );
    return out;
  }

  // Main model failed → no-search, no regex fallback, no forced search.
  const plan = noSearchPlan(ctx);
  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80), gateMs: Math.round(performance.now() - t0) },
    "main model unreachable — no-search (the model answers from its own knowledge)",
  );
  return plan;
}

/**
 * Re-exported for the legacy compatibility surface: the old LFM stage-1
 * message builder is gone (the router itself is gone). The main-gate
 * messages are exported instead so regression tests can assert on what
 * the classifier actually sees.
 */
export function buildMainGateMessagesForTest(ctx: LfmGateContext): { role: string; content: string }[] {
  return buildMainGateMessages(ctx);
}
