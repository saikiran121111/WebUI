/**
 * SEARCH-GATE — main-model-only edition (renamed from lfm-gate.ts 2026-10-23).
 *
 * The decision is made by exactly ONE model authority: the main model from
 * settings.json (`llm_api_url`, `reasoning_effort: "none"`) — never a
 * separate LFM/small model or extra port. On top of the model verdict the
 * gate has a deterministic STAGE 0 HARD BYPASS: a message that names a URL,
 * a known domain/shortener, or an unambiguous web/freshness intent MUST
 * search without paying any LLM latency (0 ms).
 *
 *   0. Hard bypass: URL / known-domain / web-intent / image+lookup-intent
 *      → search_required=true, reason "deterministic_url_or_intent", 0 ms.
 *   1. Trivial 1-2 word greetings ("hi", "hello", "thanks") → no-search
 *      short-circuit (zero tokens, zero risk).
 *   2. Main-model gate (one JSON call, 35s ceiling): {search_required,
 *      reason, freshness, depth, queries[]}.
 *   3. Main model unreachable / unparseable → NO-SEARCH (the conservative
 *      policy from 2026-10-22: never force a junk search the model didn't
 *      ask for), unless Stage 0 already fired.
 *
 * Historical: the LFM2.5-1.2B router (:8791) was removed from this gate on
 * 2026-10-22; the file itself (lib/web-search/lfm-gate.ts) was deleted on
 * 2026-10-23 and replaced by this search-gate.ts. Progress stage renamed
 * web:lfm → web:gate; old stage/field names stay readable (back-compat
 * readers) in lib/progress/turnProgress.ts and lib/types.ts.
 */
import { childLogger } from "@/lib/server/logger";
import { llmApiUrl, llmApiKey } from "@/lib/server/settings";
import {
  SearchGateResult,
  SearchGateContext,
  SearchDecision,
} from "./types";

const log = childLogger("web-search/search-gate");

/**
 * Live endpoint resolution: WEB_SEARCH_LLM_ENDPOINT (explicit override) or the
 * shared settings.json/env/fallback chain — settings.json wins so a UI edit
 * reaches the web-search pipeline without a server restart. This is the ONLY
 * model the gate may call (no LFM port, no secondary gateway).
 */
function endpoint(): string {
  return process.env.WEB_SEARCH_LLM_ENDPOINT ?? llmApiUrl();
}

/**
 * Ceiling for the AUTHORITATIVE main-model gate call. It emits a full
 * decision + query plan (~150 tokens measured) so it needs more headroom
 * than a boolean check. Measured warm latency on the main slot is ~2.5-5s.
 */
const MAIN_GATE_TIMEOUT_MS = 35_000;
const MAIN_GATE_MAX_TOKENS = 320;

const GATE_JSON_SCHEMA = {
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
 * Trivial prompts — a match skips the LLM call entirely (zero latency,
 * zero tokens). Exact match after stripping trailing punctuation, plus one
 * optional chit-chat filler peel ("By the way which model are you" →
 * "which model are you").
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

const TRIVIAL_FILLER_PREFIX = /^(?:by the way|so|anyway|then|oh|hmm|hi|hey|hello|thanks|thank you)\s+/i;

function isTrivialPrompt(prompt: string): boolean {
  let p = prompt.trim().toLowerCase();
  p = p.replace(/[.!?…\s]+$/, "");
  if (TRIVIAL_EXACT.has(p)) return true;
  const peeled = p.replace(TRIVIAL_FILLER_PREFIX, "");
  if (peeled !== p && TRIVIAL_EXACT.has(peeled)) return true;
  return false;
}

/** Detect an explicit http:// or https:// URL in the user prompt. */
export function extractPromptUrls(prompt: string): string[] {
  const m = prompt.match(/https?:\/\/[^\s"'<>[\]]+/gi);
  return m ? [...new Set(m)] : [];
}

/* ── STAGE 0: deterministic hard bypass (0 ms, no LLM call) ──────────── */

/**
 * The user's message is unambiguously about the live web. Three detectors:
 *
 *   A. URL / known domain / shortener   — any http(s):// or www. URL, or a
 *      bare known name (youtu.be, youtube.com, maps.app.goo.gl, goo.gl,
 *      bit.ly, t.co, lnkd.in, redd.it, amzn.to, linkedin.com, reddit.com,
 *      x.com, instagram.com), or a bare domain-shaped token ending in a
 *      known TLD (.gov, .gov.in, .nic.in, .com, .org, .in, .io, .net, .co).
 *   B. Explicit web/freshness intent    — search, look up, watch, video,
 *      location, maps, linkedin, reddit, who won, latest, current, today,
 *      this year's digits (e.g. 2026), price, jobs, hiring.
 *   C. Image attachment + lookup intent — a screenshot plus person/place/
 *      company lookup words (search, linkedin, profile, who is, find, guy,
 *      person, company, location, where is, product).
 *
 * When any fires the gate answers {search_required: true, reason:
 * "deterministic_url_or_intent"} in 0 ms — the model never gets to veto
 * "open the link the user literally pasted".
 */
const KNOWN_SITE_TOKEN_RE =
  /(?:^|[^\w./-])(youtu\.be|youtube\.com|maps\.app\.goo\.gl|goo\.gl|bit\.ly|t\.co|lnkd\.in|redd\.it|amzn\.to|linkedin\.com|reddit\.com|x\.com|instagram\.com)(?:$|[^\w./-])/i;

const DOMAIN_TLD_TOKEN_RE =
  /(?:^|[^\w./-])[\w-]+(?:\.[\w-]+)*\.(?:gov|gov\.in|nic\.in|com|org|io|net|co|uk|edu)(?:$|[^\w.-])/i;

const WWW_TOKEN_RE = /(?:^|[^\w./-])www\.[\w-]+/i;

const WEB_INTENT_RE =
  /(?:\b(?:search|watch|video|location|maps|linkedin|reddit|latest|current|today|price|jobs|hiring|20(?:2[4-9]))\b|\blook\s?up\b|\bwho\s+won\b)/i;

/** Lookup-intent words that only count when an image is attached. */
const IMAGE_LOOKUP_INTENT_RE =
  /(?:\b(?:search|linkedin|profile|find|guy|person|company|location|product)\b|\bwho\s*'?s?\s+is\b|\bwhere\s+is\b|\bwhat\s+is\s+this\b)/i;

export interface HardBypassHit {
  matched: "url" | "known_site" | "web_intent" | "image_intent";
}

/** Returns the bypass verdict (queries pre-filled from the URLs/entities)
 *  or null when the message needs the model to decide. */
export function deterministicHardBypass(
  ctx: SearchGateContext,
): { decision: SearchDecision; hit: HardBypassHit } | null {
  const p = ctx.userPrompt.trim();
  if (!p) return null;

  let hit: HardBypassHit | null = null;
  const urls = extractPromptUrls(p);

  if (urls.length > 0) hit = { matched: "url" };
  else if (KNOWN_SITE_TOKEN_RE.test(p) || DOMAIN_TLD_TOKEN_RE.test(p) || WWW_TOKEN_RE.test(p)) hit = { matched: "known_site" };
  else if (WEB_INTENT_RE.test(p)) hit = { matched: "web_intent" };
  else if (ctx.hasImageAttachment && IMAGE_LOOKUP_INTENT_RE.test(p)) hit = { matched: "image_intent" };
  if (!hit) return null;

  const queries: SearchDecision["queries"] = [];
  for (const u of urls.slice(0, 4)) queries.push({ query: u, intent: "general" });

  // Keyword-form companion query: strip fillers + the URL itself so the
  // metasearch pool still learns WHAT to look for around the link.
  const filler = new Set([
    "tell", "me", "what", "is", "the", "a", "an", "i", "want", "to", "so",
    "you", "can", "could", "please", "how", "about", "in", "on", "at", "by",
    "for", "from", "with", "that", "this", "these", "those", "there", "here",
    "would", "like", "need", "look", "find", "show", "give", "get", "best",
    "top", "good", "and", "it", "its", "of", "up",
  ]);
  const keywords = p
    .replace(/https?:\/\/[^\s"'<>[\]]+/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !filler.has(w))
    .slice(0, 8)
    .join(" ");
  if (keywords.length > 3) queries.push({ query: keywords, intent: "general" });
  if (queries.length === 0) {
    queries.push({ query: p.replace(/\s+/g, " ").trim().slice(0, 300), intent: "general" });
  }

  const isNewsy = /\b(latest|current|today|20(?:2[4-9])|who\s+won|price|jobs|hiring)\b/i.test(p);
  return {
    hit,
    decision: {
      search_required: true,
      reason: "deterministic_url_or_intent",
      freshness: isNewsy ? "week" : "any",
      depth: urls.length > 0 ? "deep" : "standard",
      queries,
    },
  };
}

/* ── deterministic fallback plans (emergency only) ───────────────────── */

export function rulesBasedPlan(ctx: SearchGateContext): SearchGateResult {
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
    gateMs: 0,
  };
}

function noSearchPlan(reason = "trivial prompt — no web content needed"): SearchGateResult {
  return {
    decision: {
      search_required: false,
      reason,
      freshness: "none",
      depth: "quick",
      queries: [],
    },
    source: "rules",
    gateMs: 0,
  };
}

/* ── LLM call (main model ONLY) ───────────────────────────────────────── */

/**
 * Thinking-model safety: the body always carries `reasoning_effort: "none"`
 * (THINKING_OFF_BODY) so a thinking backend cannot burn its whole budget
 * into `reasoning_content` and return `content: null`. We still recover a
 * JSON verdict from BOTH fields.
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

function buildMainGateMessages(ctx: SearchGateContext): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [
    { role: "system", content: MAIN_GATE_SYSTEM_PROMPT },
  ];
  if (ctx.history?.length) {
    for (const m of ctx.history.slice(-4)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  const prompt = ctx.hasImageAttachment
    ? `${ctx.userPrompt.slice(0, 2000)}\n\n(The user also attached an image/screenshot to this message.)`
    : ctx.userPrompt.slice(0, 2000);
  msgs.push({ role: "user", content: prompt });
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
 * timeout, unparseable JSON, or an empty-content + empty-reasoning failure.
 */
async function mainModelGate(ctx: SearchGateContext): Promise<SearchDecision | null> {
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
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + llmApiKey(),
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
 * answer is a first-class outcome — not a failure. Explicit prompt URLs are
 * still force-added.
 */
function parseMainGateJson(raw: string, ctx: SearchGateContext): SearchDecision | null {
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
 * just the decision. `runSearchGate` is the public API that also reports
 * which authority decided.
 */
export async function callLlm(ctx: SearchGateContext): Promise<SearchDecision | null> {
  const main = await mainModelGate(ctx);
  if (main) return main;
  return null;
}

/* ── public API ────────────────────────────────────────────────────────── */

/** Test/CI escape hatch check — the flag was renamed WEB_SEARCH_LFM_DISABLED
 *  → WEB_SEARCH_GATE_DISABLED; the old env name keeps working so existing
 *  unit tests never break. */
export function gateDisabledByEnv(): boolean {
  return (
    process.env.WEB_SEARCH_GATE_DISABLED === "1" ||
    process.env.WEB_SEARCH_LFM_DISABLED === "1"
  );
}

/**
 * THE gate. Stage 0 (deterministic hard bypass) → trivial skip → main model.
 *
 * Precedence:
 *   0. hard bypass (URL / known domain / web intent / image+intent) →
 *      search, 0 ms, source "deterministic", reason "deterministic_url_or_intent"
 *   1. trivial greeting / assistant-identity prompt → no-search, zero tokens
 *   2. main model says yes/no → that verdict, full stop
 *   3. main model unreachable / unparseable → NO-SEARCH, full stop.
 */
export async function runSearchGate(ctx: SearchGateContext): Promise<SearchGateResult> {
  // Test / CI escape hatch: skip the network call entirely.
  if (gateDisabledByEnv()) {
    const bypass = deterministicHardBypass(ctx);
    const plan: SearchGateResult = bypass
      ? { decision: bypass.decision, source: "deterministic", gateMs: 0 }
      : isTrivialPrompt(ctx.userPrompt)
        ? noSearchPlan()
        : rulesBasedPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "search gate disabled → deterministic plan");
    return plan;
  }

  // Stage 0: hard bypass — a literal link / known site / live-intent word
  // never waits on (or loses to) a model verdict. 0 ms, zero tokens.
  const bypass = deterministicHardBypass(ctx);
  if (bypass) {
    log.info(
      { matched: bypass.hit.matched, prompt: ctx.userPrompt.slice(0, 60) },
      "search gate STAGE 0 hard bypass → search",
    );
    return { decision: bypass.decision, source: "deterministic", gateMs: 0 };
  }

  // Fast path: trivial prompt → no LLM call, zero tokens.
  if (isTrivialPrompt(ctx.userPrompt)) {
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "trivial prompt → skip (no search, zero latency)");
    return noSearchPlan();
  }

  const t0 = performance.now();
  const main = await mainModelGate(ctx);
  if (main) {
    const out: SearchGateResult = {
      decision: { ...main },
      source: "main-model",
      gateMs: Math.round(performance.now() - t0),
    };
    log.info(
      { source: out.source, search_required: out.decision.search_required, gateMs: out.gateMs },
      "search gate verdict (main model)",
    );
    return out;
  }

  // Main model failed → no-search, no forced search (the conservative
  // no-junk-search policy; Stage 0 already had its chance above).
  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80), gateMs: Math.round(performance.now() - t0) },
    "main model unreachable — no-search (the model answers from its own knowledge)",
  );
  return noSearchPlan("search gate: main model unreachable — answering from knowledge");
}

/**
 * Regression-test surface: the main-gate messages are exported so tests can
 * assert on what the classifier actually sees.
 */
export function buildMainGateMessagesForTest(ctx: SearchGateContext): { role: string; content: string }[] {
  return buildMainGateMessages(ctx);
}
