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

// ── dual-endpoint classifier ───────────────────────────────────────────
// Primary: the fast, warm LFM2.5-1.2B router on :8791 (the Decision
// Engine's own llama-server). It is a non-thinking instruct model, so it
// answers the 4-line JSON verdict in ~50ms and never burns its budget on
// reasoning_content. Secondary: the main thinking model on :8080 (a
// fallback when the router is busy/unreachable).
const FAST_ENDPOINT =
  process.env.WEB_SEARCH_LFM_FAST_ENDPOINT ??
  "http://127.0.0.1:8791/v1/chat/completions";
const LLM_ENDPOINT =
  process.env.WEB_SEARCH_LLM_ENDPOINT ??
  process.env.LLM_API_URL ??
  "http://127.0.0.1:8080/v1/chat/completions";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "no-key";

/** 60-second ceiling for a single classifier endpoint (cold-start queue). */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Per-endpoint ceiling for the CLASSIFIER call. The LFM2.5-1.2B router is a
 * non-thinking instruct model that answers the 4-line JSON verdict in ~50ms
 * warm; 15s is 300× that and comfortably covers a cold-load. The main-model
 * fallback is a thinking model (Qwen on :8080) and may need more headroom.
 */
const FAST_CLASSIFIER_TIMEOUT_MS = 15_000;
const MAIN_CLASSIFIER_TIMEOUT_MS = 30_000;

/**
 * A thinking model (Qwen on :8080) can spend its entire output budget inside
 * `reasoning_content` and return `message.content === null` — even with
 * `response_format: json_object` requested. Passing `reasoning_effort: "none"`
 * (exactly what lib/server/titles/generate.ts does) forces the model to emit
 * the JSON directly in `content`. We also send `chat_template_kwargs` so
 * backends that only honour the chat-template knob stay thinking-free.
 */
const THINKING_OFF_BODY = {
  reasoning_effort: "none",
  chat_template_kwargs: { enable_thinking: false },
} as const;

/* ── trivial greeting short-circuit (the ONLY regex that survives) ───── */

const TRIVIAL_GREETINGS = new Set([
  "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "thx",
  "ok", "okay", "cool", "nice", "got it", "sounds good", "bye", "goodbye",
]);

function isTrivialGreeting(prompt: string): boolean {
  return TRIVIAL_GREETINGS.has(prompt.trim().toLowerCase());
}

/**
 * Prompt-aware "is this a real research question?" heuristic.
 *
 * A real question is: more than 4 words, OR contains a question mark, OR
 * references a URL / a version number / a proper-noun-looking entity. This is
 * what stops the content:null trap from silently dropping a genuine research
 * prompt: when the LLM fails AND the prompt is a real question, we fall back
 * to a rule-based SEARCH plan (never a silent no-search). Only short
 * chitchat under a failed LLM returns no-search.
 */
function isSubstantivePrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length === 0) return false;
  const words = p.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 4) return true;
  if (/[?]/.test(p)) return true;
  if (extractPromptUrls(p).length > 0) return true;
  if (/\b\d+\.\d+\b|version\b/i.test(p)) return true;
  // Proper-noun / entity signal: two or more capitalised words, or a known
  // domain marker (a place, product, or person name that must be verified).
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
 * Call a single classifier endpoint and parse the JSON decision.
 *
 * Thinking-model safety: the body always carries `reasoning_effort: "none"`
 * (+ `chat_template_kwargs.enable_thinking: false`). This matters on the main
 * model (:8080), which otherwise burns its whole budget into
 * `reasoning_content` and returns `content: null`. Even with thinking off, a
 * backend can still dump the JSON inside `reasoning_content`, so we recover
 * from BOTH `content` and `reasoning_content`.
 *
 * Returns a parsed SearchDecision on success, or null on any of: non-200,
 * timeout, unparseable JSON, or an empty-content + empty-reasoning failure.
 * The caller (runLfmGate) decides the prompt-aware fallback.
 */
async function callLlmEndpoint(
  endpoint: string,
  ctx: LfmGateContext,
  timeoutMs: number,
): Promise<SearchDecision | null> {
  let content: string;
  let reasoning: string;
  try {
    const res = await fetch(endpoint, {
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
        ...THINKING_OFF_BODY,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn({ endpoint: endpoint.slice(0, 40), status: res.status }, "classifier non-200");
      return null;
    }
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    content = typeof msg.content === "string" ? msg.content : "";
    reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
  } catch (e) {
    log.warn(
      { endpoint: endpoint.slice(0, 40), err: (e as Error).message, timeoutMs },
      "classifier unreachable / timeout",
    );
    return null;
  }

  // 1) Try the primary `content` field first.
  const fromContent = parseDecisionField(content, ctx);
  if (fromContent) return fromContent;
  // 2) Recover a JSON verdict that the model tucked into reasoning_content.
  if (reasoning.trim()) {
    const fromReasoning = parseDecisionField(reasoning, ctx);
    if (fromReasoning) {
      log.warn({ endpoint: endpoint.slice(0, 40) }, "recovered JSON from reasoning_content");
      return fromReasoning;
    }
  }
  log.warn(
    { endpoint: endpoint.slice(0, 40), content: content.slice(0, 120), reasoning: reasoning.slice(0, 120) },
    "classifier produced no parseable JSON verdict",
  );
  return null;
}

/** Parse + schema-validate a single model field as a SearchDecision. */
function parseDecisionField(raw: string, ctx: LfmGateContext): SearchDecision | null {
  if (!raw || raw.trim() === "") return null;
  const candidates = [stripAndRepair(raw), raw.trim()];
  for (const cand of candidates) {
    try {
      const parsed = SearchDecisionSchemaCompat.safeParse(JSON.parse(cand));
      if (parsed.success) {
        // Explicit URLs in the prompt always warrant extraction even if the
        // model said otherwise.
        const urls = extractPromptUrls(ctx.userPrompt);
        let decision = parsed.data;
        if (urls.length > 0 && !decision.search_required) {
          decision = { ...decision, search_required: true };
        }
        if (urls.length > 0) {
          const existing = new Set(decision.queries.map((q) => q.query));
          for (const u of urls) {
            if (!existing.has(u)) decision.queries.push({ query: u, intent: "general" });
          }
        }
        return decision;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Run the two-stage classifier: fast LFM2.5 router first, main model second.
 * Returns a SearchDecision, or null when BOTH endpoints fail to produce a
 * valid JSON verdict (genuine model failure / total unreachability).
 */
export async function callLlm(ctx: LfmGateContext): Promise<SearchDecision | null> {
  // 1) Fast, warm LFM2.5-1.2B router — the intended primary authority.
  const fast = await callLlmEndpoint(FAST_ENDPOINT, ctx, FAST_CLASSIFIER_TIMEOUT_MS);
  if (fast) return fast;
  // 2) Fallback to the main (thinking) model when the router is busy/down.
  const main = await callLlmEndpoint(LLM_ENDPOINT, ctx, MAIN_CLASSIFIER_TIMEOUT_MS);
  if (main) return main;
  return null;
}

/* ── public API ────────────────────────────────────────────────────────── */

export async function runLfmGate(ctx: LfmGateContext): Promise<LfmDecision> {
  // Test / CI escape hatch: unit tests that pin the Decision-Engine pipeline
  // (chatEngine.test.ts) run without a live LLM classifier. When the flag is
  // set, skip the network LLM call entirely and let the deterministic rules
  // decide — real prompts become a search, trivial greetings become no-search.
  // This keeps the pure pipeline test deterministic and fast.
  if (process.env.WEB_SEARCH_LFM_DISABLED === "1") {
    const plan = isSubstantivePrompt(ctx.userPrompt) ? rulesBasedPlan(ctx) : noSearchPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "WEB_SEARCH_LFM_DISABLED → deterministic rule plan");
    return plan;
  }

  // Fast path: trivial greeting → no LLM call, zero tokens.
  if (isTrivialGreeting(ctx.userPrompt)) {
    const plan = noSearchPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "trivial greeting → skip");
    return plan;
  }

  const t0 = performance.now();
  const decision = await callLlm(ctx);
  if (decision) {
    // Explicit URLs are already forced into the plan by parseDecisionField;
    // surface the outcome as an LLM-sourced decision.
    const finalDecision: SearchDecision = { ...decision };
    return {
      decision: finalDecision,
      source: "lfm",
      lfmMs: Math.round(performance.now() - t0),
    };
  }

  // ── Prompt-aware failure fallback (the thinking-model content:null guard) ─
  // Both classifier endpoints failed to produce a valid JSON verdict (genuine
  // model failure / timeout / null content). The fallback depends on the
  // prompt's shape:
  //   • A real question (>4 words, or ?, or URL, or version, or a proper
  //     noun) → RULE-BASED SEARCH plan. We must NEVER silently drop a genuine
  //     research question just because the classifier hiccuped.
  //   • Short chitchat that isn't in the trivial set but isn't a real
  //     question → no-search plan (safe to skip the web on "thanks", "ok").
  if (isSubstantivePrompt(ctx.userPrompt)) {
    const plan = rulesBasedPlan(ctx);
    log.warn(
      { prompt: ctx.userPrompt.slice(0, 80) },
      "classifier failed on a substantive prompt → rule-based SEARCH fallback",
    );
    return plan;
  }

  // Non-substantive prompt + failed LLM: a no-search plan is the safe, cheap
  // answer (the main model answers from its own knowledge).
  const plan = noSearchPlan(ctx);
  log.warn({ prompt: ctx.userPrompt.slice(0, 80) }, "classifier failed, non-substantive prompt → no-search");
  return plan;
}
