/**
 * Web-search decision gate.
 *
 * AUTHORITY MODEL (measured 2026-10-21, scripts/eval-search-gate.mjs over
 * 44 labeled scenarios): the MAIN model on :8080 decides whether a web
 * search is needed AND writes the search queries itself — 100% accuracy
 * with keyword-form, entity-anchored queries. The LFM2.5-1.2B router on
 * :8791 scored 55% (13 false positives / 7 false negatives — it searched
 * for a pure LeetCode algorithm prompt and refused live-price questions),
 * so it is now INFORMATIONAL ONLY: it runs in parallel for telemetry and
 * acts as the fallback authority when the main model is unreachable. A
 * "no" from the 1.2B router can never veto a "yes" from the main model.
 *
 *   1. Trivial 1-2 word greetings ("hi", "hello", "thanks") → no-search
 *      short-circuit (zero tokens, zero risk).
 *   2. Explicit URL in the prompt → force search_required=true and
 *      guarantee that URL is in the plan.
 *   3. Main-model gate (one JSON call, 35s ceiling): the model answers
 *      {search_required, reason, freshness, depth, queries[]} for itself.
 *   4. Informational LFM2.5 Stage-1 runs in parallel (bounded so a cold
 *      router can never add gate latency); disagreement is logged.
 *   5. Main model unreachable/unparseable → LFM two-stage fallback
 *      (Stage-1 boolean → Stage-2 plan).
 *   6. Both authorities failed → rule-based fallback: a substantive
 *      prompt gets a search plan, never a silent drop.
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

/**
 * llama.cpp `json_schema` grammar that enforces the exact SearchDecision
 * shape. The 1.2B LFM router on :8791 is too small to reliably produce
 * valid JSON without grammar enforcement — passing this to llama-server's
 * `response_format.json_schema` makes the output structurally valid by
 * construction (no post-hoc repair needed). The top-level `json_schema`
 * key is what llama.cpp's structured-output mode reads.
 *
 * Two-stage design (correction 3):
 *   Stage 1 — single-field `{"search_required": boolean}` with
 *             `max_tokens: 16`. Because the 1.2B model only has to emit a
 *             single boolean (no query-generation bias), it accurately
 *             classifies greetings, chitchat, and pure coding/math as
 *             `{"search_required": false}`.
 *   Stage 2 — run ONLY when Stage 1 says true: full SearchDecision schema
 *             with intent/freshness/depth/queries (max_tokens: 180).
 */
const STAGE1_SCHEMA = {
  type: "object",
  properties: {
    search_required: { type: "boolean" },
  },
  required: ["search_required"],
} as const;

const STAGE2_SCHEMA = {
  type: "object",
  properties: {
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
  required: ["reason", "freshness", "depth", "queries"],
} as const;

/** Legacy full schema (kept for reference and for :8080 fallback path). */
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

/**
 * Module-level singleton: the auto-warmup of the :8791 LFM router fires
 * at most once per process. When the initial fetch to :8791 fails with
 * ECONNREFUSED (the router hasn't been started yet — standalone CLI
 * scripts don't trigger instrumentation.ts), we spawn the worker via
 * warmupDecisionEngine() and retry the request.
 *
 * `warmupDecisionEngine` is fire-and-forget (it calls
 * `ensureWorker()` which polls /health for up to ~4 minutes). We wrap
 * it in a singleton promise so concurrent gate calls don't spawn
 * multiple workers.
 */
let warmupInFlight: Promise<void> | null = null;

async function triggerAutoWarmup(): Promise<void> {
  if (warmupInFlight) { await warmupInFlight; return; }
  warmupInFlight = (async () => {
    try {
      // Dynamic import so the warmup is only loaded when needed (not on
      // every trivial-greeting short-circuit). The module side-effects
      // (spawning the worker) happen inside warmupDecisionEngine.
      const { warmupDecisionEngine } = await import("@/lib/decision/client");
      warmupDecisionEngine();
      log.info("auto-warmup triggered for :8791 LFM router");
      // Give the worker up to 30s to come up.
      await new Promise((r) => setTimeout(r, 30_000));
    } catch {
      /* engine unavailable — fall through to :8080 / rules */
    } finally {
      warmupInFlight = null;
    }
  })();
  await warmupInFlight;
}

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
 * Ceiling for the AUTHORITATIVE main-model gate call. It emits a full
 * decision + query plan (~150 tokens measured) so it needs more headroom
 * than the single-boolean LFM check. Measured warm latency on :8080 is
 * ~2.5-5s (eval avg 3.3s), which is the price of a 100% correct gate —
 * the previous 0.48s LFM-only gate cost 45% of its scenarios.
 */
const MAIN_GATE_TIMEOUT_MS = 35_000;
const MAIN_GATE_MAX_TOKENS = 320;

/**
 * The informational LFM2.5 check may never delay the authoritative verdict:
 * once the main model has answered, we give the router this much extra time
 * to report its verdict for telemetry, then move on without it.
 */
const LFM_TELEMETRY_GRACE_MS = 3_000;

function delayMs(ms: number): Promise<never | null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

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
/**
 * Prompt-aware "is this a real research question?" heuristic — used ONLY
 * as the emergency fallback when both classifier endpoints are unreachable.
 *
 * Correction 3: the naive `words.length > 4` rule is removed. A 5-word
 * non-search sentence ("Hey there how are you" = 5 words) must NOT force
 * a search when the model is unreachable. Real question signals only:
 *   - explicit URL
 *   - version number / "version" keyword
 *   - question mark
 *   - two or more consecutive capitalised proper nouns (an entity signal)
 */
function isSubstantivePrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length === 0) return false;
  if (extractPromptUrls(p).length > 0) return true;
  if (/\b\d+\.\d+\b|version\b/i.test(p)) return true;
  if (/[?]/.test(p)) return true;
  // Proper-noun / entity signal: two or more capitalised words.
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

/**
 * Minimal Stage-1 system prompt: asks ONLY the single boolean question.
 * No query-generation instructions, no freshness/depth/queries fields —
 * this removes the bias toward `search_required: true` that the full
 * LLM_SYSTEM_PROMPT introduces. The 1.2B model can reliably classify
 * greetings, chitchat, and pure coding/math as `false` when the only
 * thing it has to decide is one boolean.
 */
const STAGE1_SYSTEM_PROMPT = `You are a search-routing classifier.
Given the user's message, decide whether a live web search is required to
answer it accurately.

Answer with ONLY valid JSON: {"search_required": boolean}

Rules:
- search_required = true ONLY when the answer depends on facts that change
  over time (news, prices, versions, releases, weather, sports, current
  events), or the user explicitly references a URL, a specific document,
  or a product with versioned attributes.
- search_required = false for: greetings, chitchat, "how does X work"
  explanations with no time-specific constraint, algorithms, math proofs,
  well-known scientific concepts, history before 2020, coding concepts
  with no version constraint.
Do NOT add anything else to your output.`;

function buildStage1Messages(ctx: LfmGateContext): { role: string; content: string }[] {
  return [
    { role: "system", content: STAGE1_SYSTEM_PROMPT },
    { role: "user", content: ctx.userPrompt.slice(0, 2000) },
  ];
}

/* ── AUTHORITATIVE main-model gate ────────────────────────────────────── */

/**
 * The main model decides for ITSELF: it knows its own knowledge boundaries
 * ("do I actually remember the exact statement of that problem / the
 * current price of that stock?"), which a 1.2B router cannot model, and it
 * writes the queries in the keyword form search engines actually match.
 *
 * This exact prompt scored 100% (22/22 search + 22/22 no-search) on the
 * 44-scenario eval in scripts/eval-search-gate.mjs, against the LFM2.5
 * router's 55%. Keep it in sync with MAIN_SYSTEM_PROMPT in that script so
 * the eval keeps measuring the prompt that actually ships.
 */
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
  knowledge: greetings, chitchat, coding problems and algorithm questions
  you know (including well-known competitive-programming problems), math,
  writing, translation, explanations of concepts, static facts, and library
  APIs you are confident about.
- search_required = true when the answer depends on facts that change over
  time (news, prices, stock/crypto rates, weather, sports results, releases,
  product availability, local places/businesses, current events), OR when
  the user asks about a specific entity, problem, version, or document that
  you CANNOT recall with confidence. If you are unsure whether you actually
  know the exact details of a specific named thing, search.
- If the message contains an explicit URL, search_required = true.

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
    // the answer gets; 3 turns / 300 chars keeps the gate call cheap.
    for (const m of ctx.history.slice(-3)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  msgs.push({ role: "user", content: ctx.userPrompt.slice(0, 2000) });
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
 * Call a single classifier endpoint and parse the JSON decision.
 *
 * Thinking-model safety: the body always carries `reasoning_effort: "none"`
 * (+ `chat_template_kwargs.enable_thinking: false`). This matters on the main
 * model (:8080), which otherwise burns its whole budget into
 * `reasoning_content` and returns `content: null`. Even with thinking off, a
 * backend can still dump the JSON inside `reasoning_content`, so we recover
 * from BOTH `content` and `reasoning_content`.
 *
 * For the fast LFM2.5-1.2B router on :8791, we additionally pass
 * `json_schema` grammar to enforce the exact SearchDecision shape — the
 * 1.2B model is too small to produce reliable JSON without it.
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

  // Build the request body. For :8791 we pass grammar enforcement;
  // for :8080 we pass only thinking-off.
  const isFast = endpoint === FAST_ENDPOINT;
  const body: Record<string, unknown> = {
    model: "default",
    messages: buildLlmMessages(ctx),
    temperature: 0,
    ...THINKING_OFF_BODY,
  };
  if (isFast) {
    body.response_format = {
      type: "json_object",
      json_schema: LFM_JSON_SCHEMA,
    };
    // Top-level json_schema is also read by llama.cpp's structured-output path.
    (body as Record<string, unknown>).json_schema = LFM_JSON_SCHEMA;
    // Strict generation params for the 1.2B router.
    body.max_tokens = 180;
    body.top_k = 1;
    body.top_p = 1.0;
    // seed is intentionally omitted so each call is fresh.
  } else {
    body.response_format = { type: "json_object" };
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY,
      },
      body: JSON.stringify(body),
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
  } catch (e: unknown) {
    const err = e as { code?: string; cause?: { code?: string }; message: string };
    const code = err.code ?? err.cause?.code ?? "";
    const isConnRefused = code === "ECONNREFUSED" || err.message.includes("ECONNREFUSED");
    // Only auto-warmup when :8791 is unreachable on a cold start.
    if (isFast && isConnRefused && warmupInFlight === null) {
      log.warn({ endpoint: endpoint.slice(0, 40), code }, "ECONNREFUSED on :8791 — triggering auto-warmup");
      await triggerAutoWarmup();
      // Retry once after warmup.
      try {
        const retryRes = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + LLM_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!retryRes.ok) {
          log.warn({ endpoint: endpoint.slice(0, 40), status: retryRes.status }, "classifier non-200 after warmup");
          return null;
        }
        const data: any = await retryRes.json();
        const msg = data?.choices?.[0]?.message ?? {};
        content = typeof msg.content === "string" ? msg.content : "";
        reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
      } catch {
        log.warn({ endpoint: endpoint.slice(0, 40) }, "classifier unreachable after warmup retry");
        return null;
      }
    } else {
      log.warn(
        { endpoint: endpoint.slice(0, 40), err: err.message, timeoutMs },
        "classifier unreachable / timeout",
      );
      return null;
    }
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
 * Fire a single LLM request and return the raw `message.content` +
 * `message.reasoning_content` fields (plus null on any network failure).
 *
 * For :8791 we always include `json_schema` grammar in the body.
 * The caller decides which schema (STAGE1_SCHEMA or STAGE2_SCHEMA) to pass
 * via the `schema` parameter.
 *
 * Returns `{ content, reasoning }` on success, or null on any of:
 * non-200, timeout, ECONNREFUSED (auto-warmup already attempted).
 */
async function fireLlmRequest(
  endpoint: string,
  ctx: LfmGateContext,
  timeoutMs: number,
  schema: Record<string, unknown>,
  maxTokens: number,
  messages?: { role: string; content: string }[],
  opts: { awaitWarmup?: boolean } = {},
): Promise<{ content: string; reasoning: string } | null> {
  const awaitWarmup = opts.awaitWarmup !== false;
  const isFast = endpoint === FAST_ENDPOINT;
  const body: Record<string, unknown> = {
    model: "default",
    messages: messages ?? buildLlmMessages(ctx),
    temperature: 0,
    ...THINKING_OFF_BODY,
  };
  if (isFast) {
    body.response_format = { type: "json_object", json_schema: schema };
    (body as Record<string, unknown>).json_schema = schema;
    body.max_tokens = maxTokens;
    body.top_k = 1;
    body.top_p = 1.0;
  } else {
    body.response_format = { type: "json_object" };
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + LLM_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn({ endpoint: endpoint.slice(0, 40), status: res.status }, "classifier non-200");
      return null;
    }
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      content: typeof msg.content === "string" ? msg.content : "",
      reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
    };
  } catch (e: unknown) {
    const err = e as { code?: string; cause?: { code?: string }; message: string };
    const code = err.code ?? err.cause?.code ?? "";
    const isConnRefused = code === "ECONNREFUSED" || err.message.includes("ECONNREFUSED");
    if (isFast && isConnRefused && warmupInFlight === null) {
      log.warn({ endpoint: endpoint.slice(0, 40), code }, "ECONNREFUSED on :8791 — triggering auto-warmup");
      if (!awaitWarmup) {
        // Informational call: kick the router warm for FUTURE turns but
        // never block the authoritative path on a 30s model load.
        void triggerAutoWarmup();
        return null;
      }
      await triggerAutoWarmup();
      // One retry after warmup.
      try {
        const retryRes = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + LLM_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!retryRes.ok) return null;
        const data: any = await retryRes.json();
        const msg = data?.choices?.[0]?.message ?? {};
        return {
          content: typeof msg.content === "string" ? msg.content : "",
          reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
        };
      } catch {
        return null;
      }
    }
    log.warn({ endpoint: endpoint.slice(0, 40), err: err.message, timeoutMs }, "classifier unreachable / timeout");
    return null;
  }
}

/**
 * Stage 1: ask the router for a single boolean verdict.
 *
 * The 1.2B model answers `{"search_required": true|false}` in <200ms
 * when the schema constrains it to one field — no query-generation
 * instructions biasing it toward `true`.
 *
 * Returns `true` (search needed), `false` (no search), or `null`
 * (router unreachable / no parseable answer — caller falls back to :8080).
 */
async function stage1SearchCheck(
  ctx: LfmGateContext,
  opts: { informational?: boolean } = {},
): Promise<boolean | null> {
  const informational = opts.informational === true;
  // Use the minimal Stage-1 prompt (single boolean, no query-generation
  // bias) for the fast router.
  const stage1Msgs = buildStage1Messages(ctx);
  // Informational calls must NEVER add latency to the authoritative path:
  // a cold :8791 would otherwise sit inside a 30s auto-warmup before the
  // main model's verdict could be used. Warm it in the background instead.
  const fast = await fireLlmRequest(
    FAST_ENDPOINT, ctx, FAST_CLASSIFIER_TIMEOUT_MS, STAGE1_SCHEMA, 16, stage1Msgs,
    { awaitWarmup: !informational },
  );
  const fromFast = readStage1Verdict(fast);
  if (fromFast !== null) return fromFast;
  // The informational call stops at the router — the :8080 retry that the
  // legacy path below performs would just duplicate the authoritative
  // main-model gate call that is already in flight.
  if (informational) return null;
  // Legacy two-stage path: fall back to the main model for Stage 1.
  const main = await fireLlmRequest(LLM_ENDPOINT, ctx, MAIN_CLASSIFIER_TIMEOUT_MS, STAGE1_SCHEMA, 16, stage1Msgs);
  return readStage1Verdict(main);
}

/** Pull the `search_required` boolean out of a Stage-1 response. */
function readStage1Verdict(
  res: { content: string; reasoning: string } | null,
): boolean | null {
  if (!res) return null;
  for (const raw of [res.content, res.reasoning]) {
    if (!raw || raw.trim() === "") continue;
    for (const c of [stripAndRepair(raw), raw.trim()]) {
      try {
        const parsed = JSON.parse(c);
        if (typeof parsed?.search_required === "boolean") return parsed.search_required;
      } catch { /* try next candidate */ }
    }
  }
  return null;
}

/**
 * Stage 2: generate the full search plan (queries, intent, freshness,
 * depth). ONLY called when Stage 1 returned `search_required: true`.
 *
 * Returns a full SearchDecision, or null when the router is unreachable
 * or the JSON is malformed.
 */
async function stage2SearchPlan(
  ctx: LfmGateContext,
): Promise<SearchDecision | null> {
  const fast = await fireLlmRequest(FAST_ENDPOINT, ctx, FAST_CLASSIFIER_TIMEOUT_MS, STAGE2_SCHEMA, 180);
  if (fast) {
    for (const raw of [fast.content, fast.reasoning]) {
      if (!raw || raw.trim() === "") continue;
      const cands = [stripAndRepair(raw), raw.trim()];
      for (const c of cands) {
        try {
          const parsed = JSON.parse(c);
          // Build a full SearchDecision from the Stage 2 shape.
          const decision: SearchDecision = {
            search_required: true,
            reason: parsed.reason ?? "stage-2 plan",
            freshness: (["none", "day", "week", "month", "year", "any"].includes(parsed.freshness) ? parsed.freshness : "any") as SearchDecision["freshness"],
            depth: (["quick", "standard", "deep"].includes(parsed.depth) ? parsed.depth : "standard") as SearchDecision["depth"],
            queries: Array.isArray(parsed.queries)
              ? parsed.queries.map((q: any) => ({
                  query: String(q?.query ?? ""),
                  intent: (["general", "news", "docs", "code", "academic", "forum"].includes(q?.intent) ? q.intent : "general") as SearchDecision["queries"][number]["intent"],
                  ...(Array.isArray(q?.preferred_domains) ? { preferred_domains: q.preferred_domains } : {}),
                })).filter((q: any) => q.query.length > 0)
              : [],
          };
          // Explicit URLs in the prompt always warrant extraction.
          const urls = extractPromptUrls(ctx.userPrompt);
          if (urls.length > 0) {
            const existing = new Set(decision.queries.map((q) => q.query));
            for (const u of urls) {
              if (!existing.has(u)) decision.queries.push({ query: u, intent: "general" });
            }
          }
          if (decision.queries.length === 0) decision.queries.push({ query: ctx.userPrompt.slice(0, 300), intent: "general" });
          return decision;
        } catch { /* try next candidate */ }
      }
    }
  }
  // Fall back to the main model for Stage 2.
  const main = await fireLlmRequest(LLM_ENDPOINT, ctx, MAIN_CLASSIFIER_TIMEOUT_MS, STAGE2_SCHEMA, 180);
  if (main) {
    for (const raw of [main.content, main.reasoning]) {
      if (!raw || raw.trim() === "") continue;
      const cands = [stripAndRepair(raw), raw.trim()];
      for (const c of cands) {
        try {
          const parsed = JSON.parse(c);
          const decision: SearchDecision = {
            search_required: true,
            reason: parsed.reason ?? "stage-2 plan (main model)",
            freshness: "any",
            depth: "standard",
            queries: Array.isArray(parsed.queries)
              ? parsed.queries.map((q: any) => ({
                  query: String(q?.query ?? ""),
                  intent: "general" as const,
                  ...(Array.isArray(q?.preferred_domains) ? { preferred_domains: q.preferred_domains } : {}),
                })).filter((q: any) => q.query.length > 0)
              : [{ query: ctx.userPrompt.slice(0, 300), intent: "general" as const }],
          };
          return decision;
        } catch { /* try next */ }
      }
    }
  }
  // Both endpoints failed → rule-based fallback (never a silent no-search).
  const rulePlan = rulesBasedPlan(ctx);
  return rulePlan.decision;
}

/**
 * The AUTHORITATIVE gate: one main-model call that returns the verdict and
 * the query plan together. Returns null when :8080 is unreachable or its
 * JSON is unparseable (the caller then uses the LFM fallback chain).
 */
async function mainModelGate(ctx: LfmGateContext): Promise<SearchDecision | null> {
  const res = await fireLlmRequest(
    LLM_ENDPOINT,
    ctx,
    MAIN_GATE_TIMEOUT_MS,
    LFM_JSON_SCHEMA,
    MAIN_GATE_MAX_TOKENS,
    buildMainGateMessages(ctx),
  );
  if (!res) return null;
  for (const raw of [res.content, res.reasoning]) {
    const decision = parseMainGateJson(raw, ctx);
    if (decision) return decision;
  }
  log.warn(
    { content: res.content.slice(0, 120), reasoning: res.reasoning.slice(0, 120) },
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

interface GateOutcome {
  decision: SearchDecision | null;
  source: LfmDecision["source"];
  lfmVerdict: boolean | null;
  agreement?: LfmDecision["agreement"];
}

/**
 * The gate, with authority + agreement telemetry.
 *
 * Precedence: main model (authoritative) → LFM2.5 router (fallback, only
 * when the main model is unreachable) → deterministic rules. The router's
 * Stage-1 verdict is collected in parallel and NEVER gates the outcome
 * when the main model answered — disagreement is logged, main wins. That
 * ordering is the fix for both reported failure modes: the router
 * green-lighting a pure LeetCode algorithm prompt (garbage sources) and
 * the router vetoing a search the main model actually needed.
 */
async function gateWithTelemetry(ctx: LfmGateContext): Promise<GateOutcome> {
  const t0 = performance.now();

  // Informational router check, in flight while the main model thinks.
  const lfmPromise = stage1SearchCheck(ctx, { informational: true }).catch(() => null);

  const mainDecision = await mainModelGate(ctx);

  if (mainDecision) {
    // Bounded so a cold/slow :8791 can never add gate latency.
    const lfmVerdict = await Promise.race([lfmPromise, delayMs(LFM_TELEMETRY_GRACE_MS)]);
    const agreement: LfmDecision["agreement"] =
      lfmVerdict === null
        ? "lfm-unavailable"
        : lfmVerdict === mainDecision.search_required
          ? "agree"
          : "disagree";
    if (agreement === "disagree") {
      log.warn(
        { lfmVerdict, mainVerdict: mainDecision.search_required, prompt: ctx.userPrompt.slice(0, 80) },
        "LFM router (55% measured) disagreed with the main model — main model verdict is authoritative",
      );
    }
    log.info(
      {
        gateMs: Math.round(performance.now() - t0),
        search_required: mainDecision.search_required,
        lfmVerdict,
        agreement,
        queries: mainDecision.queries.map((q) => q.query.slice(0, 60)),
      },
      "main-model gate decided",
    );
    return { decision: mainDecision, source: "main-model", lfmVerdict, agreement };
  }

  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80), ms: Math.round(performance.now() - t0) },
    "main-model gate unreachable → LFM two-stage fallback",
  );
  const lfmVerdict = await lfmPromise;

  if (lfmVerdict === false) {
    return {
      decision: {
        search_required: false,
        reason: "lfm stage-1: no live web content needed",
        freshness: "none",
        depth: "quick",
        queries: [],
      },
      source: "lfm",
      lfmVerdict,
    };
  }

  if (lfmVerdict === true) {
    const plan = await stage2SearchPlan(ctx);
    if (plan) {
      log.info({ gateMs: Math.round(performance.now() - t0) }, "lfm stage-2: fallback plan generated");
      return { decision: plan, source: "lfm", lfmVerdict };
    }
  }

  // Both authorities failed. Prompt shape decides (the content:null guard):
  // a substantive prompt must never be silently dropped.
  if (isSubstantivePrompt(ctx.userPrompt)) {
    log.warn(
      { prompt: ctx.userPrompt.slice(0, 80) },
      "both gate authorities failed on a substantive prompt → rule-based SEARCH fallback",
    );
    return { decision: rulesBasedPlan(ctx).decision, source: "rules", lfmVerdict };
  }
  return { decision: null, source: "rules", lfmVerdict };
}

/**
 * Back-compatible entry point (kept for external callers/exports): returns
 * just the decision. `runLfmGate` is the public API that also reports
 * which authority decided.
 */
export async function callLlm(ctx: LfmGateContext): Promise<SearchDecision | null> {
  return (await gateWithTelemetry(ctx)).decision;
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
  const gate = await gateWithTelemetry(ctx);

  if (gate.decision) {
    const out: LfmDecision = {
      decision: { ...gate.decision },
      source: gate.source,
      lfmMs: Math.round(performance.now() - t0),
      lfmVerdict: gate.lfmVerdict,
      agreement: gate.agreement,
    };
    log.info(
      {
        source: out.source,
        search_required: out.decision.search_required,
        lfmVerdict: out.lfmVerdict,
        agreement: out.agreement,
        gateMs: out.lfmMs,
      },
      "search gate verdict",
    );
    return out;
  }

  // Non-substantive prompt + every authority failed: a no-search plan is the
  // safe, cheap answer (the main model answers from its own knowledge).
  const plan = noSearchPlan(ctx);
  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80) },
    "all gate authorities failed, non-substantive prompt → no-search",
  );
  return plan;
}
