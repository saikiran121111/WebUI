/**
 * SEARCH-BY-DEFAULT gate — search_required = true is the DEFAULT for any
 * non-trivial prompt; the model gets to veto a search ONLY for the two
 * narrow classes of self-contained prompts. No domain whitelists, no
 * narrow keyword lists.
 *
 * Decision flow:
 *   0. Hard bypass (URL / known-domain / web-intent / image+intent) →
 *      search, 0 ms.
 *   1. Trivial 1-2 word greetings → NO-SEARCH (zero tokens, zero risk).
 *   2. Main-model gate (one JSON call, 35s ceiling): the model says
 *      search_required=true unless the prompt is strictly
 *      (a) pure conversational filler, OR
 *      (b) a self-contained offline code/math/text transformation where
 *          the user supplied 100% of the input AND mentioned zero
 *          external brands, websites, people, places, products, events
 *          or facts.
 *      Whenever ANY proper noun, brand, website, product, movie,
 *      restaurant, location, URL, or factual question appears → ALWAYS
 *      search. This inversion is encoded in the system prompt below and
 *      in the parser: a model `search_required=false` verdict is
 *      RE-VERIFIED against the "external entity present" heuristic, and
 *      overturned to `true` when a proper noun / brand / URL /
 *      time-sensitive fact is detected in the prompt.
 *   3. Main model unreachable / unparseable → SEARCH-BY-DEFAULT:
 *      `rulesBasedPlan()` (search_required=true), NOT a no-search
 *      fallback. The gate errs on the side of running a search rather
 *      than missing live facts — a junk search is far cheaper than a
 *      confidently wrong answer.
 *
 * Authority is exactly ONE model (the main model from settings.json);
 * no separate LFM / secondary router. Historical note: the LFM2.5-1.2B
 * router (:8791) was removed 2026-10-22; lfm-gate.ts was deleted 2026-10-23
 * and replaced by this file.
 */
import { childLogger } from "@/lib/server/logger";
import { llmApiUrl, llmApiKey } from "@/lib/server/settings";
import {
  SearchGateResult,
  SearchGateContext,
  SearchDecision,
} from "./types";
import { detectUrlsAndDomains, detectPromptUrls, type DetectedUrl } from "./url-detector";

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
  // tldts-based detector: catches full URLs AND bare domains (skiran.dev,
  // lite.ego.app, rbi.org.in) across all 1,440+ IANA TLDs with a
  // code-filename guard so "app.ts" is never mistaken for a domain.
  return detectPromptUrls(prompt);
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
  /** tldts-detected URLs/bare-domains (normalised https:// form). */
  detected: DetectedUrl[];
}

/** Returns the bypass verdict (queries pre-filled from the URLs/entities)
 *  or null when the message needs the model to decide. */
export function deterministicHardBypass(
  ctx: SearchGateContext,
): { decision: SearchDecision; hit: HardBypassHit } | null {
  const p = ctx.userPrompt.trim();
  if (!p) return null;

  const detected = detectUrlsAndDomains(p);
  let hit: HardBypassHit | null = null;

  if (detected.length > 0) hit = { matched: "url", detected };
  else if (WEB_INTENT_RE.test(p)) hit = { matched: "web_intent", detected: [] };
  else if (ctx.hasImageAttachment && IMAGE_LOOKUP_INTENT_RE.test(p)) hit = { matched: "image_intent", detected: [] };
  if (!hit) return null;

  const queries: SearchDecision["queries"] = [];
  // Keyword form first: search engines index pages, not URL strings — a
  // URL-as-query returns the domain's homepage (or nothing). The pipeline's
  // Stage-0 direct-target fetch reads the prompt's own URLs in parallel,
  // so the keyword query is all the engine pool needs to learn what to
  // look for around the link.
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

  // URL plans: kept as last queries (cache-key continuity) — metasearch()
  // drops URL-shaped plans from the engine pool; the pipeline's Stage-0
  // direct-target fetch is what actually reads the linked page.
  if (hit.detected.length > 0) {
    for (const d of hit.detected.slice(0, 4)) {
      if (!queries.some((q) => q.query === d.url)) {
        queries.push({ query: d.url, intent: "general" });
      }
    }
  }
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
      depth: hit.detected.length > 0 ? "deep" : "standard",
      queries,
    },
  };
}

/* ── external-entity detector (the search-by-default re-verify) ───────── */

/**
 * Deterministic "external entity present" check. Under the search-by-default
 * policy a model `search_required=false` verdict is only honored when the
 * prompt contains NONE of: a URL, a known-site token, a domain-shaped
 * token, a proper-noun phrase (2+ consecutive capitalized words), a
 * version number, a time-sensitivity signal, or an attached image with
 * lookup intent. If any of these fire, the verdict is overturned to
 * search_required=true by the parser (see parseMainGateJson), so a lazy
 * "I can answer from memory" answer can never suppress a live-facts
 * lookup for Blinkit / Myntra / a local business / any proper noun.
 */
export function promptHasExternalEntity(prompt: string): boolean {
  const p = prompt ?? "";
  if (p.trim().length === 0) return false;
  // 1. Explicit URL or bare domain (tldts-based, all 1,440+ TLDs)
  if (detectUrlsAndDomains(p).length > 0) return true;
  // 3. Proper-noun phrase: two consecutive capitalized words ("Blinkit deal",
  //    "BookMyShow movie", "NVIDIA stock"). One capitalized word at
  //    sentence start is NOT enough (English sentences start capitalized);
  //    two in a row is a strong proper-noun signal.
  const properNounPhrase = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/.test(p);
  if (properNounPhrase) return true;
  // 4. Version numbers / model numbers (v1.2.3, 15.2, 3090, RTX 4090, ...)
  if (/\bv?\d+\.\d+(?:\.\d+)?\b/.test(p) || /\b[A-Z]{2,}\s?\d{2,4}\b/.test(p)) return true;
  // 5. Time-sensitivity signal (prices, "today", "current", a specific
  //    year digit)
  if (/\b(today|current|latest|recent|20(?:[012]\d))\b/i.test(p)) return true;
  // 6. Proper-noun-ish single capitalized token of 4+ chars that is not
  //    the sentence's first word. Heuristic: a capitalized word appearing
  //    after position 4 in the prompt.
  const nonLeadingCap = p.slice(4).match(/\b[A-Z][a-z]{3,}\b/);
  if (nonLeadingCap) return true;
  return false;
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
      // SEARCH-BY-DEFAULT: the rules fallback always searches. The no-
      // search path is reserved for the trivial-greeting short-circuit
      // above — a junk search is far cheaper than a confidently-wrong
      // live-facts answer.
      search_required: true,
      reason: "rule-based search-by-default plan (main model unreachable)",
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
SEARCH-BY-DEFAULT POLICY: answer search_required = true for essentially
every real question. The ONLY prompts that get search_required = false are
exactly these two:
  (a) Pure conversational filler / greetings / thanks / assistant chitchat
      ("hi", "hello", "thank you", "which model are you") — no external
      facts are being asked about.
  (b) A completely self-contained offline task (code, math, text
      transformation) where the user supplied 100% of the input AND the
      task mentions zero external brands, websites, people, places,
      products, events, versions, prices, or facts from the world.
If ANY proper noun, brand name, website, product, movie, restaurant,
location, company, person, version number, price, or factual question
appears — including a Blinkit/Myntra/Zepto/BookMyShow/Zomato style
platform name, a local business, or a niche tool — search_required MUST
be true. When in doubt between "I might know" and "I don't know exactly",
ALWAYS search: the user would rather have a verified answer than a
confident guess.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Decision rules (search-first):
- search_required = true for: news, prices, stock/crypto rates, weather,
  sports results, releases, product availability, local places/businesses,
  current events, restaurant menus, movie showtimes, job listings,
  anything about a specific named entity you are not 100% sure of,
  any explicit URL, any follow-up that asks for a LINK/URL or the CURRENT
  availability/stock/price/open-closed status of something in the
  conversation, or details/reviews of an entity you recommended.
- The conversation history is part of the request: resolve "it / this /
  that" against it before deciding.
- A NEW, unrelated chit-chat turn about the ASSISTANT itself (not about
  a world fact) is the only follow-up that may be no-search.

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
  // Strip thinking/reasoning blocks some backends embed in the payload —
  // terminated or truncated (a thinking model cut off mid-think by
  // max_tokens leaves an orphan open tag; consume to end of output).
  s = s.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/gi, "");
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
    // Extra thinking-disables for backends that use a different flag name.
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
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
  // Silent fallback: the caller (runSearchGate) routes to rulesBasedPlan.
  // No WARN log here — an unparseable verdict from a small local model is
  // expected noise, not an error worth dumping to the terminal.
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
        // Search-by-default re-verify: the model may only veto a search
        // for genuinely self-contained prompts. If the prompt carries an
        // external entity (URL, brand, proper noun, version, time signal,
        // image+lookup intent), the "I can answer from memory" answer is
        // overturned — this is what makes the gate search-by-default in
        // practice, not just in the system prompt.
        const vetoAllowed =
          !promptHasExternalEntity(ctx.userPrompt) &&
          !(ctx.hasImageAttachment && IMAGE_LOOKUP_INTENT_RE.test(ctx.userPrompt));
        if (!vetoAllowed) {
          const urls = extractPromptUrls(ctx.userPrompt);
          const queries: SearchDecision["queries"] = urls.map(
            (u) => ({ query: u, intent: "general" as const }),
          );
          if (queries.length === 0) {
            queries.push({
              query: ctx.userPrompt.replace(/\s+/g, " ").trim().slice(0, 300),
              intent: "general",
            });
          }
          return {
            search_required: true,
            reason: "search-by-default: model veto overturned (external entity present)",
            freshness: "any",
            depth: "standard",
            queries,
          };
        }
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
 * THE gate. SEARCH-BY-DEFAULT policy.
 *
 * Precedence:
 *   0. hard bypass (URL / known domain / web intent / image+intent) →
 *      search, 0 ms, source "deterministic", reason "deterministic_url_or_intent"
 *   1. trivial greeting / assistant-identity prompt → no-search, zero tokens
 *   2. main model verdict, re-verified against promptHasExternalEntity —
 *      a model `false` is flipped to `true` whenever an external entity
 *      (brand, URL, proper noun, version, time signal, image+intent) is
 *      present.
 *   3. main model unreachable / unparseable → SEARCH-BY-DEFAULT rules
 *      plan (a junk search is far cheaper than a confidently-wrong
 *      offline answer).
 */
export async function runSearchGate(ctx: SearchGateContext): Promise<SearchGateResult> {
  // Search-by-default override (the Part 1 mandate): unless the prompt is
  // a trivial 1-2 word greeting/chit-chat, the gate NEVER returns
  // search_required=false — a junk search is far cheaper than a
  // confidently-wrong answer on live facts (prices, stock, showtimes,
  // local businesses, versions). The model's role narrows to writing the
  // queries, not to vetoing the search.
  const searchByDefault = !isTrivialPrompt(ctx.userPrompt);

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
    let decision = main;
    // Search-by-default re-verify: a model "no" only holds when the
    // prompt is truly self-contained (no URL / brand / proper noun /
    // version / time signal / image+lookup intent).
    if (!main.search_required && promptHasExternalEntity(ctx.userPrompt)) {
      decision = {
        ...main,
        search_required: true,
        reason: "search-by-default: external entity in prompt — search even though the model vetoed",
        depth: "standard",
        queries: main.queries.length > 0 ? main.queries : buildFallbackQueries(ctx.userPrompt),
      };
    }
    const out: SearchGateResult = {
      decision,
      source: "main-model",
      gateMs: Math.round(performance.now() - t0),
    };
    log.info(
      {
        source: out.source,
        search_required: out.decision.search_required,
        gateMs: out.gateMs,
        overridden: main.search_required !== out.decision.search_required,
      },
      "search gate verdict (main model)",
    );
    return out;
  }

  // Main model failed → SEARCH-BY-DEFAULT: rules-based plan (search
  // required), NOT a no-search fallback. The gate errs on the side of
  // running a search rather than missing live facts.
  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80), gateMs: Math.round(performance.now() - t0) },
    "main model unreachable — search-by-default rules plan",
  );
  return rulesBasedPlan(ctx);
}

/**
 * Build a minimal keyword-form query list from the prompt when the model
 * was unreachable or returned none. Used by the search-by-default
 * override and by rulesBasedPlan.
 */
function buildFallbackQueries(prompt: string): SearchDecision["queries"] {
  const urls = extractPromptUrls(prompt);
  const out: SearchDecision["queries"] = urls.slice(0, 3).map((u) => ({ query: u, intent: "general" }));
  const hasTimeSignal = /latest|recent|new|current|today|this (week|month|year|quarter)/i.test(prompt);
  out.unshift({
    query: prompt.replace(/\s+/g, " ").trim().slice(0, 300),
    intent: (hasTimeSignal ? "news" : "general") as SearchDecision["queries"][number]["intent"],
  });
  return out;
}

/**
 * Regression-test surface: the main-gate messages are exported so tests can
 * assert on what the classifier actually sees.
 */
export function buildMainGateMessagesForTest(ctx: SearchGateContext): { role: string; content: string }[] {
  return buildMainGateMessages(ctx);
}
